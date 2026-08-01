import { createWorkflowView } from "./workflow-view.js";

const content = document.querySelector("#content");
const refreshButton = document.querySelector("#refresh-button");
const lastUpdated = document.querySelector("#last-updated");
const sourceHealth = document.querySelector("#source-health");
const statusBanner = document.querySelector("#status-banner");
const dialog = document.querySelector("#detail-dialog");
const dialogContent = document.querySelector("#dialog-content");
const confirmationDialog = document.querySelector("#confirmation-dialog");
const confirmationContent = document.querySelector("#confirmation-content");
const pageTitle = document.querySelector("#page-title");

let dashboard = null;
let currentView = "overview";
let itemIndex = new Map();
let jobIndex = new Map();
let memoryResults = [];
let memoryQuery = "";
let memoryLoaded = false;
let requestSequence = 0;
let lastAppliedRequest = 0;
let confirmationRequestSequence = 0;
let lastAppliedConfirmationRequest = 0;
let confirmationQueueState = {
  available: false,
  queueRevision: 0,
  pendingCount: 0,
  item: null,
};
let confirmationQueueLoaded = false;
let activeExternalConfirmation = null;
let activeConfirmationKey = "";
const deferredConfirmations = new Set();

const viewTitles = {
  overview: "今天需要你推动什么",
  prs: "Pull Requests",
  issues: "分配给我的 Issues",
  versions: "版本与里程碑",
  signals: "钉钉中的行动信号",
  employees: "你的数字员工",
  memory: "搜索做过的事情",
  workflow: "工作流指挥",
};

const workflowView = createWorkflowView({
  onChange() {
    if (dashboard && currentView === "workflow") render();
  },
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function relativeTime(value) {
  if (!value) return "未知时间";
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (Math.abs(seconds) < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function kindLabel(item) {
  return {
    pull_request: "PR",
    issue: "ISSUE",
    mention: "@ME",
    todo: "TODO",
    conversation: "CHAT",
  }[item.kind] || item.kind.toUpperCase();
}

function actionStateLabel(value) {
  return {
    action_now: "现在轮到我",
    waiting_other: "等待别人",
    historical: "历史清理",
    uncertain: "需要确认",
  }[value] || value;
}

function nextActorLabel(value) {
  return {
    me: "我",
    author: "PR 作者",
    reviewer: "审核人",
    merge_owner: "合并负责人",
    ci: "自动检查",
    none: "无需行动",
    other: "其他人",
    unknown: "待确认",
  }[value] || value;
}

function employeeStateLabel(value) {
  return {
    disabled: "未启用",
    paused: "已暂停",
    observing: "主动观察中",
    working: "正在工作",
    waiting_user: "等待你确认",
    degraded: "部分能力异常",
  }[value] || value || "未知";
}

function jobStateLabel(value) {
  return {
    queued: "等待处理",
    running: "分析中",
    retry_wait: "等待重试",
    ready: "方案已就绪",
    ready_for_human: "等待你确认",
    confirmation_enqueue_pending: "正在加入确认队列",
    confirmation_invalidation_pending: "正在安全失效旧确认",
    waiting_confirmation: "等待发布确认",
    waiting_retry_confirmation: "等待重试确认",
    published: "已发布",
    accepted: "你已接受",
    rejected: "你已驳回",
    blocked: "处理受阻",
    superseded: "已被新状态替代",
  }[value] || value || "未知";
}

function reviewVerdictLabel(value) {
  return {
    approve: "建议通过",
    comment: "建议评论",
    request_changes: "建议修改",
    none: "内部推进方案",
  }[value] || value || "未形成结论";
}

function uniqueItems(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function pullRequestGroups() {
  const groups = dashboard.groups || {};
  const legacy = uniqueItems([
    ...(groups.reviewRequested || []),
    ...(groups.myPullRequests || []),
  ]);
  return {
    actionNow:
      groups.actionNow ||
      legacy.filter((item) => !item.actionState && item.score >= 80),
    waitingOther:
      groups.waitingOther ||
      legacy.filter((item) => !item.actionState && item.score < 80),
    uncertain: groups.uncertainPullRequests || [],
    historical: groups.historicalPullRequests || [],
  };
}

function workItem(item) {
  itemIndex.set(item.id, item);
  let priorityClass = "";
  if (item.score >= 90) priorityClass = "urgent";
  else if (item.score >= 80) priorityClass = "attention";

  const reason = item.reasons?.[0] || "持续跟踪";
  let reasonClass = "";
  if (/失败|逾期|冲突|修改/.test(reason)) reasonClass = "danger";
  else if (item.actionState === "waiting_other") reasonClass = "waiting";
  else if (item.actionState === "historical") reasonClass = "historical";
  else if (item.actionState === "uncertain") reasonClass = "uncertain";
  const source = item.repo
    ? `${escapeHtml(item.repo)} #${item.number}`
    : escapeHtml(item.context || kindLabel(item));
  return `
    <button class="work-item" data-item-id="${escapeHtml(item.id)}">
      <span class="priority ${priorityClass}">${item.score ?? "—"}</span>
      <span class="item-copy">
        <span class="item-title">${escapeHtml(item.title)}</span>
        <span class="item-meta">
          <span>${kindLabel(item)}</span>
          <span>${source}</span>
          <span>${relativeTime(item.updatedAt)}</span>
        </span>
      </span>
      <span class="reason ${reasonClass}">${escapeHtml(reason)}</span>
    </button>`;
}

function section(title, items, emptyText, caption = "") {
  return `
    <section class="section">
      <div class="section-heading">
        <h2>${escapeHtml(title)}</h2>
        <span>${caption || `${items.length} ITEMS`}</span>
      </div>
      ${
        items.length
          ? `<div class="work-list">${items.map(workItem).join("")}</div>`
          : `<div class="empty">${escapeHtml(emptyText)}</div>`
      }
    </section>`;
}

function metrics(counts) {
  return `
    <section class="metrics" aria-label="工作量概览">
      <div class="metric"><strong>${counts.actionNow ?? counts.urgent}</strong><span>现在轮到你</span></div>
      <div class="metric"><strong>${counts.waitingOther ?? 0}</strong><span>等待别人</span></div>
      <div class="metric"><strong>${counts.uncertainPullRequests ?? 0}</strong><span>需要你确认</span></div>
      <div class="metric"><strong>${counts.issues}</strong><span>分配给你的 Issues</span></div>
    </section>`;
}

function employeeJob(job) {
  jobIndex.set(job.id, job);
  const summary = job.summary || job.triggerReason || job.error || "等待员工处理";
  return `
    <button class="employee-job" data-job-id="${escapeHtml(job.id)}">
      <span class="employee-job-main">
        <strong>${escapeHtml(job.repo || "未知仓库")} #${escapeHtml(job.number ?? "?")} · ${escapeHtml(job.title || "未命名 PR")}</strong>
        <span>${escapeHtml(summary)}</span>
      </span>
      <span class="status-pill status-${escapeHtml(job.status)}">${escapeHtml(jobStateLabel(job.status))}</span>
    </button>`;
}

function employeePanel({ expanded = false } = {}) {
  const employee = dashboard.employee;
  if (!employee?.role) {
    return `<section class="section employee-panel">
      <div class="section-heading"><h2>PR 推进员工</h2><span>尚未连接</span></div>
      <div class="empty">服务重启后将加载主动员工。</div>
    </section>`;
  }
  const { role } = employee;
  const activeJob = employee.jobs.find((job) => job.status === "running");
  const recentJobs = expanded ? employee.jobs : employee.jobs.slice(0, 3);
  const brain = role.brain?.provider
    ? `${role.brain.provider} / ${role.brain.model || "默认模型"}${role.brain.remoteCodeContext ? " · 代码上下文将发送到远程服务" : ""}`
    : "未配置大脑";
  const lastRun = role.lastRun;
  const activity = activeJob
    ? `正在分析 ${activeJob.repo} #${activeJob.number}：${activeJob.triggerReason}`
    : lastRun?.summary || "等待第一次主动巡查";
  const pendingConfirmationCount = confirmationQueueState.available
    ? confirmationQueueState.pendingCount
    : employee.confirmationQueue?.length || 0;
  return `
    <section class="section employee-panel" aria-labelledby="pr-employee-title">
      <div class="employee-heading">
        <div>
          <p class="eyebrow">DIGITAL EMPLOYEE / PR</p>
          <h2 id="pr-employee-title">${escapeHtml(role.name)}</h2>
        </div>
        <span class="status-pill status-${escapeHtml(role.state)}">${escapeHtml(employeeStateLabel(role.state))}</span>
      </div>
      <p class="employee-mission">${escapeHtml(role.mission)}</p>
      <dl class="employee-summary">
        <div><dt>为什么启动</dt><dd>${escapeHtml(lastRun?.trigger || "等待事件")}${lastRun?.at ? ` · ${relativeTime(lastRun.at)}` : ""}</dd></div>
        <div><dt>正在做什么</dt><dd>${escapeHtml(activity)}</dd></div>
        <div><dt>当前大脑</dt><dd>${escapeHtml(brain)}</dd></div>
        <div><dt>等待你确认</dt><dd>${pendingConfirmationCount} 条待确认动作</dd></div>
      </dl>
      ${role.lastError ? `<p class="employee-error">${escapeHtml(role.lastError)}</p>` : ""}
      <div class="employee-actions">
        <button class="refresh-button" data-employee-run ${role.paused ? "disabled" : ""}>立即巡查</button>
        <button class="secondary-button" data-employee-control="${role.paused ? "resume" : "pause"}">${role.paused ? "恢复员工" : "暂停员工"}</button>
      </div>
      ${
        recentJobs.length
          ? `<div class="employee-jobs">${recentJobs.map(employeeJob).join("")}</div>`
          : `<div class="empty">员工正在持续观察，尚未发现需要启动的新作业。</div>`
      }
    </section>`;
}

function memoryRows() {
  if (!memoryLoaded) return '<div class="empty">正在读取本地记忆…</div>';
  if (!memoryResults.length) {
    return '<div class="empty">没有找到匹配的员工记忆。</div>';
  }
  return `<div class="memory-list">${memoryResults
    .map(
      (memory) => `
        <article class="memory-item">
          <div class="memory-heading">
            <strong>${escapeHtml(memory.title || "未命名记录")}</strong>
            <span>${relativeTime(memory.createdAt)}</span>
          </div>
          <p>${escapeHtml(memory.summary || "")}</p>
          <span>${escapeHtml(memory.repository || "")} ${memory.number ? `#${memory.number}` : ""} · ${escapeHtml(memory.event || "observation")}</span>
          ${memory.sourceUrl ? `<a href="${escapeHtml(memory.sourceUrl)}" target="_blank" rel="noreferrer">打开来源 →</a>` : ""}
        </article>`,
    )
    .join("")}</div>`;
}

function memoryView() {
  return `<section class="section memory-section">
    <div class="section-heading"><h2>本地员工记忆</h2><span>${memoryResults.length} RESULTS</span></div>
    <form class="memory-search" id="memory-search-form">
      <label for="memory-query">搜索 PR、仓库、问题或处理结论</label>
      <div><input id="memory-query" name="query" value="${escapeHtml(memoryQuery)}" autocomplete="off" /><button class="refresh-button" type="submit">搜索</button></div>
    </form>
    ${memoryRows()}
  </section>`;
}

function versionRows(items) {
  if (!items.length) return '<div class="empty">当前跟踪仓库没有开放里程碑或发布记录。</div>';
  return items
    .map((item) => {
      const total = (item.openIssues || 0) + (item.closedIssues || 0);
      const progress = total ? Math.round((item.closedIssues / total) * 100) : 0;
      const date = item.dueAt
        ? `截止 ${new Date(item.dueAt).toLocaleDateString("zh-CN")}`
        : item.publishedAt
          ? `发布于 ${new Date(item.publishedAt).toLocaleDateString("zh-CN")}`
          : "无日期";
      return `
        <a class="version-row" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
          <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.repo)} · ${date}</span></div>
          <div class="progress" aria-label="完成 ${progress}%"><i style="width:${progress}%"></i></div>
          <div>${item.type === "milestone" ? `${item.closedIssues}/${total}` : escapeHtml(item.tag || "Release")}</div>
        </a>`;
    })
    .join("");
}

function overviewView() {
  const prs = pullRequestGroups();
  return [
    metrics(dashboard.counts),
    employeePanel(),
    section(
      "现在轮到我",
      prs.actionNow.slice(0, 7),
      "当前没有明确轮到你处理的 PR。",
      `${prs.actionNow.length} TOTAL · 在 Pull Requests 查看全部`,
    ),
    prs.uncertain.length
      ? section(
          "需要我确认",
          prs.uncertain,
          "",
          `${prs.uncertain.length} ITEMS · 将逐条弹窗确认`,
        )
      : "",
    `<div class="two-column">
      ${section("等待别人", prs.waitingOther.slice(0, 6), "当前没有等待他人的 PR。", `${prs.waitingOther.length} TOTAL`)}
      ${section("分配给我的 Issues", dashboard.groups.myIssues.slice(0, 6), "没有分配给你的开放 Issue。", `${dashboard.groups.myIssues.length} TOTAL · 在 Issues 查看全部`)}
    </div>`,
  ].join("");
}

function versionsView() {
  return `<section class="section">
    <div class="section-heading"><h2>跟踪版本</h2><span>${dashboard.groups.versions.length} RECORDS · 最新创建/发布在前</span></div>
    <div>${versionRows(dashboard.groups.versions)}</div>
  </section>`;
}

function render() {
  if (!dashboard) return;
  itemIndex = new Map();
  jobIndex = new Map();
  pageTitle.textContent = viewTitles[currentView];
  const views = {
    overview: overviewView,
    prs: () => {
      const prs = pullRequestGroups();
      return (
        section("现在轮到我", prs.actionNow, "当前没有明确轮到你处理的 PR。") +
        section("等待别人", prs.waitingOther, "当前没有等待他人的 PR。") +
        section("需要确认", prs.uncertain, "当前没有需要你确认归属的 PR。") +
        section(
          "历史待清理",
          prs.historical,
          "当前没有长期未活动、需要清理的 PR。",
        )
      );
    },
    issues: () =>
      section("开放 Issues", dashboard.groups.myIssues, "没有分配给你的开放 Issue。"),
    versions: versionsView,
    signals: () =>
      section("钉钉行动信号", dashboard.groups.dingtalk, "当前没有 @我、待办或未读会话。"),
    employees: () => employeePanel({ expanded: true }),
    memory: memoryView,
    workflow: () => workflowView.render(),
  };
  content.innerHTML = views[currentView]();
  content.querySelectorAll("[data-item-id]").forEach((button) => {
      button.addEventListener("click", () => showDetail(itemIndex.get(button.dataset.itemId)));
  });
  content.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () =>
      showEmployeeJob(jobIndex.get(button.dataset.jobId)),
    );
  });
  content.querySelector("[data-employee-control]")?.addEventListener(
    "click",
    handleEmployeeControl,
  );
  content.querySelector("[data-employee-run]")?.addEventListener(
    "click",
    handleEmployeeRun,
  );
  content.querySelector("#memory-search-form")?.addEventListener(
    "submit",
    handleMemorySearch,
  );
  workflowView.bind(content);
}

function detailRows(item) {
  const fields = [
    ["来源", item.repo || item.context || "钉钉"],
    ["编号", item.number ? `#${item.number}` : null],
    ["优先级", `${item.score} · ${(item.reasons || []).join("、")}`],
    ["责任状态", actionStateLabel(item.actionState)],
    ["下一位行动人", nextActorLabel(item.nextActor)],
    ["下一步", item.nextAction],
    ["作者", item.author],
    ["我的审核结论", item.myReviewState],
    ["我的审核提交", item.myReviewCommitOid],
    ["当前提交", item.headRefOid],
    ["审核", item.reviewDecision],
    ["CI", item.ciStatus],
    ["合并状态", item.mergeStateStatus],
    ["里程碑", item.milestone],
    ["标签", item.labels?.join("、")],
    ["更新时间", item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN") : null],
  ].filter(([, value]) => value);
  return fields.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function brainAssessment(item) {
  if (!item.brainAssessment) return "";
  const assessment = item.brainAssessment;
  return `
    <aside class="brain-assessment">
      <strong>大脑建议（仍需你确认）</strong>
      <p>${escapeHtml(assessment.recommendedAction || "暂无建议")}</p>
      <span>建议归类：${escapeHtml(actionStateLabel(assessment.classification))} · 置信度 ${Math.round((assessment.confidence || 0) * 100)}%</span>
    </aside>`;
}

function listMarkup(items) {
  if (!items?.length) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function showEmployeeJob(job) {
  if (!job) return;
  const review = job.reviewBody
    ? `<section class="review-preview">
        <strong>${escapeHtml(reviewVerdictLabel(job.reviewVerdict))}</strong>
        <pre>${escapeHtml(job.reviewBody)}</pre>
      </section>`
    : "";
  dialogContent.innerHTML = `
    <article class="detail employee-detail">
      <p class="eyebrow">PR EMPLOYEE / ${escapeHtml(jobStateLabel(job.status))}</p>
      <h2>${escapeHtml(job.repo)} #${job.number} · ${escapeHtml(job.title)}</h2>
      <p>${escapeHtml(job.summary || job.triggerReason || job.error || "")}</p>
      <h3>依据</h3>
      ${listMarkup(job.evidence)}
      <h3>建议步骤</h3>
      ${listMarkup(job.steps)}
      ${review}
      <dl class="detail-grid">
        <dt>触发原因</dt><dd>${escapeHtml(job.triggerReason || "")}</dd>
        <dt>当前 Head</dt><dd>${escapeHtml(job.headRefOid || "")}</dd>
        <dt>岗位大脑</dt><dd>${escapeHtml(job.brain?.provider || "")} / ${escapeHtml(job.brain?.model || "未记录")}</dd>
        <dt>状态</dt><dd>${escapeHtml(jobStateLabel(job.status))}</dd>
      </dl>
      ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">在 GitHub 中打开 →</a>` : ""}
    </article>`;
  dialog.showModal();
}

function applyDashboard(nextDashboard, sequence) {
  if (!nextDashboard || sequence < lastAppliedRequest) return false;
  lastAppliedRequest = sequence;
  dashboard = nextDashboard;
  updateChrome();
  render();
  return true;
}

function applyConfirmationQueue(nextState, sequence = ++confirmationRequestSequence) {
  if (!nextState || sequence < lastAppliedConfirmationRequest) return false;
  lastAppliedConfirmationRequest = sequence;
  confirmationQueueState = {
    available: Boolean(nextState.available),
    queueRevision: nextState.queueRevision || 0,
    pendingCount: nextState.pendingCount || 0,
    item: nextState.item || null,
  };
  confirmationQueueLoaded = true;
  return true;
}

function invalidateConfirmationQueueSnapshot() {
  lastAppliedConfirmationRequest = ++confirmationRequestSequence;
  confirmationQueueLoaded = false;
  confirmationQueueState = {
    available: false,
    queueRevision: 0,
    pendingCount: 0,
    item: null,
  };
}

async function handleEmployeeControl(event) {
  const button = event.currentTarget;
  const command = button.dataset.employeeControl;
  button.disabled = true;
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/employees/pr-reviewer/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        command,
        expectedRevision: dashboard.employee.role.revision,
      }),
    });
    if (!response.ok) throw new Error(`员工控制失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
  }
}

async function handleEmployeeRun(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "巡查中…";
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/employees/pr-reviewer/run", {
      method: "POST",
      headers: { "x-mydashboard-action": "1" },
    });
    if (!response.ok) throw new Error(`主动巡查失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    await refreshConfirmationQueue({ showConfirmation: false });
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
    button.textContent = "立即巡查";
  }
}

async function loadMemories(query = "") {
  memoryQuery = query;
  const response = await fetch(
    `/api/memory/search?q=${encodeURIComponent(query)}&limit=50`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`记忆搜索失败（${response.status}）`);
  const result = await response.json();
  memoryResults = result.items || [];
  memoryLoaded = true;
  if (currentView === "memory") render();
}

async function handleMemorySearch(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await loadMemories(new FormData(form).get("query") || "");
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    submit.disabled = false;
  }
}

function showDetail(item) {
  if (!item) return;
  dialogContent.innerHTML = `
    <article class="detail">
      <p class="eyebrow">${kindLabel(item)} / EVIDENCE</p>
      <h2>${escapeHtml(item.title)}</h2>
      ${brainAssessment(item)}
      <dl class="detail-grid">${detailRows(item)}</dl>
      ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">在来源中打开 →</a>` : ""}
    </article>`;
  dialog.showModal();
}

function confirmationKey(kind, item) {
  return `${kind}\u0000${item.id}\u0000${item.headRefOid || ""}`;
}

function pendingConfirmations() {
  if (!confirmationQueueLoaded) return [];
  const externalActions = confirmationQueueState.item
    ? [
        {
          kind: "external_action",
          item: confirmationQueueState.item,
          key: `external\u0000${confirmationQueueState.item.id}\u0000${confirmationQueueState.item.approvalBindingDigest}`,
        },
      ]
    : [];
  const responsibilities = pullRequestGroups().uncertain.map((item) => ({
    kind: "responsibility",
    item,
    key: confirmationKey("responsibility", item),
  }));
  const legacyReviewDrafts = confirmationQueueState.available
    ? []
    : (dashboard.employee?.confirmationQueue || []).map((job) => ({
        kind: "review_draft",
        job,
        key: confirmationKey("review", job),
      }));
  return [...externalActions, ...responsibilities, ...legacyReviewDrafts].filter(
    (entry) => !deferredConfirmations.has(entry.key),
  );
}

function showResponsibilityConfirmation(entry, remaining) {
  const { item } = entry;
  confirmationContent.innerHTML = `
    <article class="confirmation">
      <p class="eyebrow">CONFIRMATION QUEUE / ${remaining} LEFT</p>
      <h2>这条 PR 现在轮到谁？</h2>
      <p class="confirmation-title">${escapeHtml(item.repo)} #${item.number} · ${escapeHtml(item.title)}</p>
      <p class="confirmation-reason">${escapeHtml(item.actionReasons?.[0] || "现有事实不足以可靠判断责任归属。")}</p>
      ${brainAssessment(item)}
      <div class="confirmation-actions" data-confirmation-id="${escapeHtml(item.id)}" data-head-ref-oid="${escapeHtml(item.headRefOid)}">
        <button data-decision="action_now">现在轮到我</button>
        <button data-decision="waiting_other">等待别人</button>
        <button data-decision="historical">归入历史清理</button>
        <button class="secondary" data-decision="later">稍后再问</button>
      </div>
      <p class="confirmation-note">确认只保存在本机，并绑定当前提交；出现新提交后会重新判断。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleConfirmation);
}

function reviewEventLabel(value) {
  return {
    APPROVE: "Approve",
    REQUEST_CHANGES: "Request changes",
    COMMENT: "Comment Review",
  }[value] || value || "未知动作";
}

function showExternalActionConfirmation(entry, remaining) {
  const item = structuredClone(entry.item);
  activeExternalConfirmation = item;
  const payload = item.display?.payload || {};
  const actor = payload.actor || item.actor || {};
  const target = payload.target || item.target || {};
  const action = payload.action || {};
  const operation = item.retryable ? "retry" : "approve";
  const actionLabel = item.retryable
    ? "确认并重试发布到 GitHub"
    : item.display?.actionLabel || "确认并发布到 GitHub";
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation">
      <p class="eyebrow">EXTERNAL ACTION / ${remaining} LEFT</p>
      <h2>${escapeHtml(item.display?.title || "确认外部动作")}</h2>
      <p class="confirmation-reason">${escapeHtml(item.display?.summary || "确认后将执行外部写入")}</p>
      <dl class="detail-grid confirmation-grid">
        <dt>执行账号</dt><dd>${escapeHtml(actor.accountId || "未指定")}</dd>
        <dt>目标</dt><dd>${escapeHtml(target.resourceId || "未知")}</dd>
        <dt>绑定 Head</dt><dd><code>${escapeHtml(target.version || "未知")}</code></dd>
        <dt>Review 类型</dt><dd>${escapeHtml(reviewEventLabel(action.reviewEvent))}</dd>
      </dl>
      <div class="review-preview">
        <strong>将发布的完整正文</strong>
        <pre>${escapeHtml(action.body || "没有正文")}</pre>
      </div>
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="${operation}">${escapeHtml(actionLabel)}</button>
        <button class="secondary" data-external-operation="reject">驳回，不发布</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">只有点击“${escapeHtml(actionLabel)}”才会写入 GitHub；动作、账号和 Head 均与本次展示内容绑定。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showReviewDraftConfirmation(entry, remaining) {
  const { job } = entry;
  confirmationContent.innerHTML = `
    <article class="confirmation review-confirmation">
      <p class="eyebrow">LOCAL REVIEW / ${remaining} LEFT</p>
      <h2>PR 推进员工准备了一份本地评审草稿</h2>
      <p class="confirmation-title">${escapeHtml(job.repo)} #${job.number} · ${escapeHtml(job.title)}</p>
      <p class="confirmation-reason">${escapeHtml(job.summary || job.triggerReason || "")}</p>
      <div class="review-preview">
        <strong>${escapeHtml(reviewVerdictLabel(job.reviewVerdict))}</strong>
        <pre>${escapeHtml(job.reviewBody || "没有生成评审正文")}</pre>
      </div>
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(job.evidence)}
      <div class="confirmation-actions" data-review-job-id="${escapeHtml(job.id)}" data-head-ref-oid="${escapeHtml(job.headRefOid)}">
        <button data-review-decision="accept">接受草稿</button>
        <button class="secondary" data-review-decision="reject">驳回草稿</button>
        <button class="secondary wide" data-review-decision="later">稍后再看</button>
      </div>
      <p class="confirmation-note">当前未启用 GitHub 外部动作。接受或驳回只记录在本机，不会发布 GitHub Review。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleReviewDraftDecision);
}

function showNextConfirmation() {
  if (!dashboard || confirmationDialog.open || dialog.open) return;
  const pending = pendingConfirmations();
  const [entry] = pending;
  if (!entry) return;
  activeConfirmationKey = entry.key;
  if (entry.kind === "external_action") {
    showExternalActionConfirmation(entry, pending.length);
  } else if (entry.kind === "review_draft") {
    activeExternalConfirmation = null;
    showReviewDraftConfirmation(entry, pending.length);
  } else {
    activeExternalConfirmation = null;
    showResponsibilityConfirmation(entry, pending.length);
  }
  confirmationDialog.showModal();
}

async function handleConfirmation(event) {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  const itemId = button.closest("[data-confirmation-id]").dataset.confirmationId;
  const headRefOid = button.closest("[data-confirmation-id]").dataset.headRefOid;
  const decision = button.dataset.decision;
  if (decision === "later") {
    deferredConfirmations.add(activeConfirmationKey);
    activeConfirmationKey = "";
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
    return;
  }

  confirmationContent.querySelectorAll("button").forEach((candidate) => {
    candidate.disabled = true;
  });
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/pr-responsibility/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({ id: itemId, actionState: decision, headRefOid }),
    });
    if (response.status === 409) {
      applyDashboard(await fetchDashboard(), sequence);
      confirmationDialog.close();
      statusBanner.hidden = false;
      statusBanner.textContent = "PR 已出现新提交，请根据最新事实重新确认。";
      queueMicrotask(showNextConfirmation);
      return;
    }
    if (!response.ok) throw new Error(`确认保存失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    activeConfirmationKey = "";
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    confirmationContent.querySelectorAll("button").forEach((candidate) => {
      candidate.disabled = false;
    });
  }
}

async function handleExternalConfirmation(event) {
  const button = event.target.closest("[data-external-operation]");
  if (!button) return;
  const operation = button.dataset.externalOperation;
  if (operation === "later") {
    deferredConfirmations.add(activeConfirmationKey);
    activeConfirmationKey = "";
    activeExternalConfirmation = null;
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
    return;
  }
  const item = activeExternalConfirmation;
  if (!item || !["approve", "retry", "reject"].includes(operation)) return;
  confirmationContent.querySelectorAll("button").forEach((candidate) => {
    candidate.disabled = true;
  });
  try {
    const response = await fetch(
      `/api/confirmations/${encodeURIComponent(item.id)}/${operation}`,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        expectedQueueRevision: item.queueRevision,
        expectedItemRevision: item.itemRevision,
        displayedPayloadDigest: item.displayedPayloadDigest,
        approvalBindingDigest: item.approvalBindingDigest,
        ...(operation === "reject" ? { reason: "用户在确认弹框中驳回" } : {}),
      }),
      },
    );
    if (response.status === 409) {
      invalidateConfirmationQueueSnapshot();
      confirmationDialog.close();
      statusBanner.hidden = false;
      statusBanner.textContent = "确认内容或目标状态已经变化，请查看最新内容后重新确认。";
      activeExternalConfirmation = null;
      activeConfirmationKey = "";
      try {
        await refreshConfirmationQueue({ showConfirmation: false });
        const sequence = ++requestSequence;
        const nextDashboard = await fetchDashboard();
        if (nextDashboard) applyDashboard(nextDashboard, sequence);
        queueMicrotask(showNextConfirmation);
      } catch (error) {
        statusBanner.textContent = `${error.message}。成功读取最新确认内容前不会再次弹出。`;
      }
      return;
    }
    if (!response.ok) throw new Error(`外部动作确认失败（${response.status}）`);
    const result = await response.json();
    applyConfirmationQueue({ available: true, ...result.next });
    activeConfirmationKey = "";
    activeExternalConfirmation = null;
    confirmationDialog.close();
    await load({ showConfirmation: false });
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    confirmationContent.querySelectorAll("button").forEach((candidate) => {
      candidate.disabled = false;
    });
  }
}

async function handleReviewDraftDecision(event) {
  const button = event.target.closest("[data-review-decision]");
  if (!button) return;
  const container = button.closest("[data-review-job-id]");
  const decision = button.dataset.reviewDecision;
  if (decision === "later") {
    deferredConfirmations.add(activeConfirmationKey);
    activeConfirmationKey = "";
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
    return;
  }
  confirmationContent.querySelectorAll("button").forEach((candidate) => {
    candidate.disabled = true;
  });
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/pr-review-jobs/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        id: container.dataset.reviewJobId,
        decision,
        headRefOid: container.dataset.headRefOid,
        expectedRevision: dashboard.employee.role.revision,
      }),
    });
    if (response.status === 409) {
      const nextDashboard = await fetchDashboard();
      if (nextDashboard) applyDashboard(nextDashboard, sequence);
      confirmationDialog.close();
      statusBanner.hidden = false;
      statusBanner.textContent = "员工草稿对应的 PR 已更新，请查看最新结果。";
      activeConfirmationKey = "";
      queueMicrotask(showNextConfirmation);
      return;
    }
    if (!response.ok) throw new Error(`草稿确认失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    activeConfirmationKey = "";
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    confirmationContent.querySelectorAll("button").forEach((candidate) => {
      candidate.disabled = false;
    });
  }
}

function updateChrome() {
  const brain = dashboard.meta.brain || {};
  const errors = [
    ...(dashboard.meta.errors || []),
    ...(brain.errors || []).map((error) => `大脑: ${error}`),
    ...(dashboard.employee?.role?.lastError
      ? [`PR 员工: ${dashboard.employee.role.lastError}`]
      : []),
  ];
  const brainLabel = brain.enabled
    ? `${brain.provider || "AI"} / ${brain.model || "未配置模型"}`
    : "确定性规则";
  lastUpdated.textContent = `更新于 ${relativeTime(dashboard.meta.refreshedAt)} · ${dashboard.meta.durationMs} ms`;
  sourceHealth.classList.toggle("error", errors.length > 0);
  sourceHealth.innerHTML = `
    <span class="pulse"></span>
    <div>
      <strong>${errors.length ? "部分能力异常" : "指挥中枢已连接"}</strong>
      <span>${dashboard.meta.sources.github} GitHub · ${dashboard.meta.sources.dingtalk} 钉钉 · ${escapeHtml(brainLabel)}</span>
    </div>`;
  statusBanner.hidden = errors.length === 0;
  statusBanner.textContent = errors.length
    ? `部分数据未能刷新：${errors.join("；")}`
    : "";
}

async function fetchDashboard() {
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取失败（${response.status}）`);
  return response.json();
}

async function fetchConfirmationQueue() {
  const response = await fetch("/api/confirmations/next", { cache: "no-store" });
  if (!response.ok) throw new Error(`读取确认队列失败（${response.status}）`);
  return response.json();
}

async function refreshConfirmationQueue({ showConfirmation = true } = {}) {
  const sequence = ++confirmationRequestSequence;
  const nextState = await fetchConfirmationQueue();
  const applied = applyConfirmationQueue(nextState, sequence);
  if (applied && dashboard) render();
  if (showConfirmation) queueMicrotask(showNextConfirmation);
  return applied;
}

async function load({ showConfirmation = true } = {}) {
  const sequence = ++requestSequence;
  const confirmationSequence = ++confirmationRequestSequence;
  try {
    const [nextDashboard, nextConfirmationQueue] = await Promise.all([
      fetchDashboard(),
      fetchConfirmationQueue(),
    ]);
    applyConfirmationQueue(nextConfirmationQueue, confirmationSequence);
    if (!nextDashboard) {
      content.innerHTML = '<div class="empty">正在建立第一次数据快照，请稍候…</div>';
      return;
    }
    applyDashboard(nextDashboard, sequence);
    if (currentView === "workflow") await workflowView.load();
    if (showConfirmation) queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = `${error.message}。页面会自动重试。`;
  }
}

async function refresh() {
  refreshButton.disabled = true;
  refreshButton.classList.add("loading");
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: { "x-mydashboard-action": "1" },
    });
    if (!response.ok) throw new Error(`刷新失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    await refreshConfirmationQueue({ showConfirmation: false });
    if (currentView === "workflow") await workflowView.load();
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("loading");
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(".nav-item.active")?.classList.remove("active");
    button.classList.add("active");
    currentView = button.dataset.view;
    render();
    if (currentView === "memory" && !memoryLoaded) {
      loadMemories().catch((error) => {
        statusBanner.hidden = false;
        statusBanner.textContent = error.message;
      });
    }
    if (currentView === "workflow" && workflowView.needsLoad()) {
      workflowView.load();
    }
  });
});

refreshButton.addEventListener("click", refresh);
document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
document
  .querySelector(".confirmation-close")
  .addEventListener("click", () => {
    if (activeConfirmationKey) {
      deferredConfirmations.add(activeConfirmationKey);
      activeConfirmationKey = "";
    }
    activeExternalConfirmation = null;
    confirmationDialog.close();
    queueMicrotask(showNextConfirmation);
  });
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
confirmationDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  document.querySelector(".confirmation-close").click();
});
document.addEventListener("keydown", (event) => {
  if (event.target.closest?.("input, textarea, select, [contenteditable=true]")) return;
  if (/^[1-8]$/.test(event.key)) {
    document.querySelectorAll(".nav-item")[Number(event.key) - 1]?.click();
  }
});

await load();
setInterval(load, 60_000);
