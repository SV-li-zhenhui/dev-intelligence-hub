function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncateUtf8(value, maximumBytes) {
  const encoder = new TextEncoder();
  const text = String(value || "");
  if (encoder.encode(text).length <= maximumBytes) return text;
  let result = "";
  for (const character of text) {
    if (encoder.encode(result + character).length > maximumBytes) break;
    result += character;
  }
  return result;
}

const WORK_TYPE_LABELS = Object.freeze({
  pull_request: "PR Review / 推进",
  development: "开发实现",
  testing: "测试验证",
  requirements: "需求梳理",
  general: "中枢协调拆分",
});

function option(value, selected) {
  return `<option value="${value}"${selected === value ? " selected" : ""}>${WORK_TYPE_LABELS[value]}</option>`;
}

function invalidGitHubWorkUrl() {
  return new TypeError("GitHub PR 或 Issue 地址无效");
}

export function githubWorkItemFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw invalidGitHubWorkUrl();
  }
  if (
    url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
    url.username || url.password
  ) {
    throw invalidGitHubWorkUrl();
  }
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)\/?$/u,
  );
  if (!match) throw invalidGitHubWorkUrl();
  const [, owner, repository, resource, numberText] = match;
  if ([owner, repository].some((segment) =>
    segment === "." || segment === ".." || segment.length > 100
  )) {
    throw invalidGitHubWorkUrl();
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) throw invalidGitHubWorkUrl();
  const repo = `${owner}/${repository}`;
  const kind = resource === "pull" ? "pull_request" : "issue";
  return {
    id: `github:${kind === "pull_request" ? "pr" : "issue"}:${repo}#${number}`,
    kind,
    repo,
    number,
    title: `${repo} #${number}`,
    url: `https://github.com/${repo}/${resource}/${number}`,
    summary: "由你通过 GitHub 地址人工加入日常任务",
  };
}

export function manualHistoricalWorkMarkup(result = null) {
  if (result) {
    return `<section class="section manual-historical-work" data-manual-historical-work-result>
      <div class="section-heading"><h2>已加入日常任务</h2><span>OWNER OVERRIDE</span></div>
      <p>${escapeHtml(result.source || "GitHub 任务")} 已进入共享任务图，将由 ${escapeHtml(result.target || "配置的岗位")} 领取。</p>
      <small>工作项 ${escapeHtml(result.workItemId || "正在接入台账")} · 请求 ${escapeHtml(result.requestId)}</small>
      <button type="button" class="secondary-button" data-manual-historical-work-reset>继续添加</button>
    </section>`;
  }
  return `<section class="section manual-historical-work">
    <div class="section-heading"><h2>人工加入历史任务</h2><span>OWNER OVERRIDE</span></div>
    <p>自动范围外的 GitHub PR 或 Issue 可以显式加入日常任务；这不会扩大自动扫描范围。</p>
    <form data-manual-historical-work>
      <label class="manual-historical-work-source">GitHub 地址
        <input name="sourceUrl" type="url" required autocomplete="url" placeholder="https://github.com/org/repo/pull/123 或 /issues/123">
      </label>
      <label>交付类型
        <select name="workType">
          ${option("pull_request", "pull_request")}
          ${option("development")}
          ${option("testing")}
          ${option("requirements")}
          ${option("general")}
        </select>
      </label>
      <label>优先级
        <select name="priority">
          <option value="normal">普通</option>
          <option value="high" selected>高</option>
          <option value="urgent">紧急</option>
        </select>
      </label>
      <button class="refresh-button" type="submit">加入日常任务</button>
      <p class="manual-work-assignment-status" data-manual-historical-work-status aria-live="polite"></p>
    </form>
  </section>`;
}

export function manualWorkAssignmentMarkup(item, result = null) {
  if (!item || !["pull_request", "issue"].includes(item.kind)) return "";
  if (result) {
    return `<section class="manual-work-assignment" data-manual-work-assignment-result>
      <h3>已分配工作</h3>
      <p>请求已进入共享任务图，将由 ${escapeHtml(result.target || "配置的岗位")} 领取。</p>
      <small>工作项 ${escapeHtml(result.workItemId || "正在接入台账")} · 请求 ${escapeHtml(result.requestId)}</small>
    </section>`;
  }
  const selected = item.kind === "pull_request" ? "pull_request" : "requirements";
  return `<section class="manual-work-assignment">
    <h3>手动分配工作</h3>
    <p>创建真实共享任务；岗位权限、代码执行和 GitHub 写入仍受现有门禁约束。</p>
    <form data-manual-work-assignment>
      <label>交付类型
        <select name="workType">
          ${item.kind === "pull_request" ? option("pull_request", selected) : ""}
          ${option("development", selected)}
          ${option("testing", selected)}
          ${option("requirements", selected)}
          ${option("general", selected)}
        </select>
      </label>
      <label>优先级
        <select name="priority">
          <option value="normal">普通</option>
          <option value="high" selected>高</option>
          <option value="urgent">紧急</option>
        </select>
      </label>
      <button class="refresh-button" type="submit">创建并分配</button>
      <p class="manual-work-assignment-status" data-manual-work-assignment-status aria-live="polite"></p>
    </form>
  </section>`;
}

export function ownerWorkRequestForItem(
  item,
  { workType, priority, requestId, responsiblePerson = null },
) {
  if (!item || !["pull_request", "issue"].includes(item.kind)) {
    throw new TypeError("GitHub work item is required");
  }
  if (!Object.hasOwn(WORK_TYPE_LABELS, workType)) {
    throw new TypeError("workType is invalid");
  }
  const source = item.url || (
    item.repo && item.number
      ? `https://github.com/${item.repo}/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`
      : ""
  );
  const assignedLogin = responsiblePerson?.login
    ? String(responsiblePerson.login)
    : "";
  const title = truncateUtf8(
    `${WORK_TYPE_LABELS[workType]}${assignedLogin ? `（负责人 @${assignedLogin}）` : ""}：${item.title || `${item.repo} #${item.number}`}`,
    256,
  );
  const description = truncateUtf8([
    `请处理 GitHub ${item.kind === "pull_request" ? "PR" : "Issue"}：${item.repo || ""} #${item.number || ""}。`,
    source ? `原始地址：${source}` : "",
    item.summary ? `当前摘要：${item.summary}` : `当前标题：${item.title || ""}`,
    assignedLogin
      ? `${workType === "testing" ? "指定测试负责人" : "指定负责人"}：@${assignedLogin}（${responsiblePerson.product || "未分类版本"}）。`
      : "",
    "基于来源的最新事实完成所选交付，并在共享任务图中留下可验证结果。",
  ].filter(Boolean).join("\n"), 12 * 1024);
  const request = {
    schemaVersion:
      item.kind === "pull_request" && workType === "pull_request" && !assignedLogin
        ? 2
        : item.kind === "issue"
        ? 6
        : assignedLogin ? workType === "testing" ? 3 : 4 : 1,
    requestId,
    workType,
    priority,
    title,
    description,
    acceptanceCriteria: [
      "核对来源 GitHub 项目的最新状态与上下文",
      `提交可验证的${WORK_TYPE_LABELS[workType]}结果`,
      ...(assignedLogin
        ? [`${WORK_TYPE_LABELS[workType]}结果明确交付给 @${assignedLogin}`]
        : []),
    ],
  };
  if ([2, 3, 4].includes(request.schemaVersion)) {
    request.pullRequest = { repository: item.repo, number: item.number };
  }
  if (request.schemaVersion === 6) {
    request.issue = { repository: item.repo, number: item.number };
  }
  if ([3, 4].includes(request.schemaVersion)) {
    request.responsiblePerson = {
      login: assignedLogin,
      product: String(responsiblePerson.product || "general"),
    };
  }
  return request;
}

export function createManualWorkAssignmentAttempts(createRequestId = () => crypto.randomUUID()) {
  const pending = new Map();
  return {
    requestFor(item, { workType, priority }) {
      const key = JSON.stringify([item.kind, item.repo, item.number, workType, priority]);
      if (!pending.has(key)) {
        pending.set(key, ownerWorkRequestForItem(item, {
          workType, priority, requestId: createRequestId(),
        }));
      }
      // Keep the whole payload, not only the ID: refreshed titles/summaries
      // must not conflict with the server's durable idempotency binding.
      return structuredClone(pending.get(key));
    },
    complete(requestId) {
      for (const [key, request] of pending) {
        if (request.requestId === requestId) pending.delete(key);
      }
    },
  };
}
