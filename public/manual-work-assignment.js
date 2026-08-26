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
  { workType, priority, requestId },
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
  const title = truncateUtf8(
    `${WORK_TYPE_LABELS[workType]}：${item.title || `${item.repo} #${item.number}`}`,
    256,
  );
  const description = truncateUtf8([
    `请处理 GitHub ${item.kind === "pull_request" ? "PR" : "Issue"}：${item.repo || ""} #${item.number || ""}。`,
    source ? `原始地址：${source}` : "",
    item.summary ? `当前摘要：${item.summary}` : `当前标题：${item.title || ""}`,
    "基于来源的最新事实完成所选交付，并在共享任务图中留下可验证结果。",
  ].filter(Boolean).join("\n"), 12 * 1024);
  const request = {
    schemaVersion: item.kind === "pull_request" && workType === "pull_request" ? 2 : 1,
    requestId,
    workType,
    priority,
    title,
    description,
    acceptanceCriteria: [
      "核对来源 GitHub 项目的最新状态与上下文",
      `提交可验证的${WORK_TYPE_LABELS[workType]}结果`,
    ],
  };
  if (request.schemaVersion === 2) {
    request.pullRequest = { repository: item.repo, number: item.number };
  }
  return request;
}
