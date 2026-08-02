function initialState() {
  return {
    loaded: false,
    loading: false,
    error: "",
    summary: null,
    items: [],
    timeline: [],
    codeJobsEnabled: false,
    codeJobs: [],
    codeJobsError: "",
  };
}

export function escapeWorkHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function relativeTime(value, now) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未知时间";
  const seconds = Math.round((now - Date.parse(value)) / 1_000);
  if (Math.abs(seconds) < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function statusLabel(status) {
  return {
    queued: "待领取",
    working: "判断中",
    dispatch_pending: "等待派发",
    waiting_user: "等待你答复",
    waiting_condition: "等待条件",
    waiting_external: "等待外部授权",
    retry_wait: "等待重试",
    completed: "已完成",
    blocked: "已阻塞",
  }[status] || status || "未知";
}

function targetLabel(target = {}) {
  const type = { role: "岗位", person: "人员", node: "节点" }[target.type] || "目标";
  return `${type} · ${target.id || "未指定"}`;
}

function subjectLabel(item) {
  const subject = item?.event?.subject || {};
  if (subject.repository && subject.number) {
    return `${subject.repository} #${subject.number}`;
  }
  return subject.repository || subject.id || item.assignmentId || "本地工作项";
}

function itemRows(items, now) {
  if (!items.length) {
    return '<div class="empty">尚无工作项；新的路由分派会可靠进入这里。</div>';
  }
  return `<div class="work-list">${items.map((item) => `
    <article class="work-row">
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(subjectLabel(item))}</strong>
        <span class="status-pill status-${escapeWorkHtml(item.status)}">${escapeWorkHtml(statusLabel(item.status))}</span>
      </div>
      <p>${escapeWorkHtml(targetLabel(item.currentTarget))}</p>
      <span>${escapeWorkHtml(item.event?.eventType || item.kind || "unknown")} · 尝试 ${escapeWorkHtml(item.attempt ?? 0)} 次 · ${relativeTime(item.updatedAt, now)}</span>
      ${item.statusReason ? `<small>${escapeWorkHtml(item.statusReason)}</small>` : ""}
      ${item.decisionContext ? `<small>已绑定继续处理上下文 · ${escapeWorkHtml(item.decisionContext.kind || "context")}</small>` : ""}
    </article>`).join("")}</div>`;
}

function timelineRows(entries, now) {
  if (!entries.length) {
    return '<div class="empty">尚无工作时间线。</div>';
  }
  return `<div class="work-list">${entries.map((entry) => `
    <article class="work-row work-timeline-row">
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(entry.type || "unknown")}</strong>
        <span>#${escapeWorkHtml(entry.sequence ?? "—")}</span>
      </div>
      <p>${escapeWorkHtml(entry.actorId || "system")}</p>
      <span>${escapeWorkHtml(entry.itemId || "全局事件")} · ${relativeTime(entry.at, now)}</span>
    </article>`).join("")}</div>`;
}

function codeJobStatusLabel(status) {
  return {
    queued: "已授权，等待执行",
    active: "受控执行中",
    completed: "已完成",
    failed: "执行失败",
    stale: "授权已失效",
    fenced: "需要恢复核验",
  }[status] || status || "未知";
}

function codeJobResultMarkup(result = {}) {
  const files = [
    ...(result.createdFiles || []).map((value) => `新增 ${value}`),
    ...(result.modifiedFiles || []).map((value) => `修改 ${value}`),
    ...(result.deletedFiles || []).map((value) => `删除 ${value}`),
  ];
  const profiles = (result.profiles || []).map(
    ({ id, status }) => `${id} · ${status}`,
  );
  const details = [...files, ...profiles];
  return `${result.summary ? `<small>${escapeWorkHtml(result.summary)}</small>` : ""}
    ${details.length ? `<small>${details.map(escapeWorkHtml).join(" · ")}</small>` : ""}
    ${result.manifestDigest ? `<small>manifest · ${escapeWorkHtml(result.manifestDigest)}</small>` : ""}`;
}

function codeJobRows(items, now) {
  if (!items.length) {
    return '<div class="empty">尚无已授权的本地代码任务。</div>';
  }
  return `<div class="work-list">${items.map((job) => `
    <article class="work-row code-job-row">
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(job.repository || "未知仓库")} · ${escapeWorkHtml(job.operation || "unknown")}</strong>
        <span class="status-pill status-${escapeWorkHtml(job.status)}">${escapeWorkHtml(codeJobStatusLabel(job.status))}</span>
      </div>
      <p>${escapeWorkHtml(job.roleId || job.requestedBy?.roleId || "未知岗位")} · ${escapeWorkHtml(job.workspaceId || "未知工作区")}</p>
      <span>${escapeWorkHtml(job.phase || "queued")} · ${escapeWorkHtml(job.lastActionType || "尚无动作")} · ${Number(job.turnCount) || 0} 轮 · ${relativeTime(job.updatedAt, now)}</span>
      ${job.errorCode ? `<small>${escapeWorkHtml(job.errorCode)}</small>` : ""}
      ${codeJobResultMarkup(job.result)}
    </article>`).join("")}</div>`;
}

function count(summary, status) {
  return Number(summary?.itemCounts?.[status]) || 0;
}

export function renderWorkView(state, { now = Date.now() } = {}) {
  if (!state.loaded) {
    return '<div class="empty">正在读取员工工作台账…</div>';
  }
  if (state.error) {
    return `<section class="section work-error-state">
      <div class="section-heading"><h2>工作台账暂不可用</h2><span>READ FAILED</span></div>
      <div class="empty">${escapeWorkHtml(state.error)}。请刷新页面后重试。</div>
    </section>`;
  }
  const summary = state.summary || {};
  const waiting =
    count(summary, "waiting_user") +
    count(summary, "waiting_condition") +
    count(summary, "waiting_external") +
    count(summary, "retry_wait");
  const safeguards = summary.safeguards || {};
  return `
    <section class="work-summary" aria-label="主动工作循环状态">
      <div><span>待领取</span><strong>${count(summary, "queued")}</strong></div>
      <div><span>处理中</span><strong>${count(summary, "working") + count(summary, "dispatch_pending")}</strong></div>
      <div><span>等待</span><strong>${waiting}</strong></div>
      <div><span>阻塞</span><strong>${count(summary, "blocked")}</strong></div>
      <div><span>完成</span><strong>${count(summary, "completed")}</strong></div>
    </section>
    <div class="work-safeguards" role="note">
      <span class="status-pill ${safeguards.prEmployeePaused ? "status-paused" : "status-working"}">PR 新循环：${safeguards.prEmployeePaused ? "暂停 / 旧员工独占" : "已启用"}</span>
      <span class="status-pill ${safeguards.externalActionsEnabled ? "status-waiting_user" : "status-disabled"}">GitHub 外部写：${safeguards.externalActionsEnabled ? "逐项确认" : "关闭"}</span>
      <small>模型只生成结构化判断；代码执行和外部写入不能绕过受控执行器与确认队列。</small>
    </div>
    <div class="work-columns">
      <section class="section work-panel">
        <div class="section-heading"><h2>最近工作</h2><span>${state.items.length} ITEMS · 最新在前</span></div>
        ${itemRows(state.items, now)}
      </section>
      <section class="section work-panel">
        <div class="section-heading"><h2>审计时间线</h2><span>${state.timeline.length} EVENTS · 最新在前</span></div>
        ${timelineRows(state.timeline, now)}
      </section>
    </div>
    <section class="section work-panel code-job-panel">
      <div class="section-heading"><h2>本地代码任务</h2><span>${state.codeJobs?.length || 0} JOBS · 只读结果</span></div>
      ${state.codeJobsError
        ? `<div class="empty">代码任务暂不可读取：${escapeWorkHtml(state.codeJobsError)}</div>`
        : state.codeJobsEnabled
          ? codeJobRows(state.codeJobs || [], now)
          : '<div class="empty">受控代码任务尚未启用。</div>'}
    </section>`;
}

async function responseJson(response, label) {
  if (response.ok) return response.json();
  let detail = "";
  try {
    detail = (await response.json()).error || "";
  } catch {
    // Preserve the status when an intermediary did not return JSON.
  }
  throw new Error(`${label}失败（${response.status}）${detail ? `：${detail}` : ""}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkView({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  clock = () => Date.now(),
} = {}) {
  let state = initialState();

  function change(patch) {
    state = { ...state, ...patch };
    onChange();
  }

  async function load() {
    if (state.loading) return;
    change({ loading: true, error: "" });
    try {
      const responses = await Promise.all([
        fetchImpl("/api/work/summary", { cache: "no-store" }),
        fetchImpl("/api/work/items?limit=50&order=newest", { cache: "no-store" }),
        fetchImpl("/api/work/timeline?limit=50&order=newest", { cache: "no-store" }),
      ]);
      const codeJobsResponse = await fetchImpl(
        "/api/code/jobs?limit=50&order=newest",
        { cache: "no-store" },
      ).catch(() => null);
      const [summary, items, timeline] = await Promise.all([
        responseJson(responses[0], "读取工作摘要"),
        responseJson(responses[1], "读取工作项"),
        responseJson(responses[2], "读取工作时间线"),
      ]);
      let codeJobs = { enabled: false, items: [] };
      let codeJobsError = "";
      if (codeJobsResponse) {
        try {
          codeJobs = await responseJson(codeJobsResponse, "读取代码任务");
        } catch (error) {
          codeJobsError = errorMessage(error);
        }
      } else {
        codeJobsError = "读取代码任务失败";
      }
      change({
        loaded: true,
        loading: false,
        error: "",
        summary,
        items: items.items || [],
        timeline: timeline.items || [],
        codeJobsEnabled: codeJobs.enabled === true,
        codeJobs: codeJobs.items || [],
        codeJobsError,
      });
    } catch (error) {
      change({ loaded: true, loading: false, error: errorMessage(error) });
    }
  }

  return {
    bind() {},
    load,
    needsLoad: () => !state.loaded || Boolean(state.error),
    render: () => renderWorkView(state, { now: clock() }),
  };
}
