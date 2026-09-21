import { escapeHtml } from "./view-format.js";

const RECOVERY_PRESENTATION = Object.freeze({
  MAINTENANCE_ACTIVE: Object.freeze({
    title: "维护操作仍在进行",
    guidance: "等待备份或恢复完成后重新检查；不要重启服务或重复提交操作。",
  }),
});
const EXTERNAL_ACTION_LABELS = Object.freeze({
  "github.pull-request-comment": "PR 评论",
  "github.work-proposal-review": "PR Review",
  "github.pull-request-review": "PR Review",
  "github.pull-request-update-branch": "更新 PR 分支",
  "github.pull-request-push": "推送受控提交",
  "github.pull-request-merge": "合并 PR",
});
const PROBE_FAILURE_PRESENTATION = Object.freeze({
  OUTPUT_LIMIT_EXCEEDED: Object.freeze({
    title: "健康检查结果超出安全上限",
    guidance: "保持岗位暂停并保留服务日志；确认异常记录数量后再重新检查。",
  }),
  PROBE_FAILED: Object.freeze({
    title: "健康检查执行失败",
    guidance: "保持岗位暂停，查看受管服务日志定位该探针，再重新检查。",
  }),
  PROBE_MISSING: Object.freeze({
    title: "必要健康检查缺失",
    guidance: "核对当前运行版本与配置，使用受管重启加载完整运行时后重新检查。",
  }),
  PROBE_RESULT_INVALID: Object.freeze({
    title: "健康检查返回无效结果",
    guidance: "保持岗位暂停并保留服务日志；不要绕过该检查继续接收工作。",
  }),
  PROBE_TIMEOUT: Object.freeze({
    title: "健康检查超时",
    guidance: "先重新检查一次；若持续超时，保持岗位暂停并查看受管服务日志。",
  }),
});
const RESOURCE_LABELS = Object.freeze({
  data_volume: "数据卷",
});

function list(items, render, emptyText) {
  return items.length > 0
    ? `<ul>${items.map((item) => `<li>${render(item)}</li>`).join("")}</ul>`
    : `<p class="system-status-empty">${escapeHtml(emptyText)}</p>`;
}

function statusTone(ready) {
  return ready === true ? "healthy" : "blocked";
}

function finitePercent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.max(0, Math.min(100, value))}%`
    : "未知";
}

function issue({ title, guidance, diagnostic }) {
  return `<div class="system-status-issue">
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(guidance)}</span>
    <code>诊断：${escapeHtml(diagnostic)}</code>
  </div>`;
}

function recoveryIssue(item) {
  const presentation = Object.hasOwn(RECOVERY_PRESENTATION, item.code)
    ? RECOVERY_PRESENTATION[item.code]
    : {
        title: "恢复流程尚未完成",
        guidance: "保持岗位暂停，按恢复与备份运维流程核对状态；不要直接编辑数据文件。",
      };
  return issue({
    ...presentation,
    diagnostic: `${item.probeId} · ${item.code}`,
  });
}

function externalActionIssue(item) {
  const label = Object.hasOwn(EXTERNAL_ACTION_LABELS, item.actionType)
    ? EXTERNAL_ACTION_LABELS[item.actionType]
    : "外部动作";
  return issue({
    title: `${label}结果尚未确认`,
    guidance: "不要手动重试。保持相关岗位暂停，等待系统只读对账；持续存在时保留日志与动作证据。",
    diagnostic: `${item.probeId} · ${item.actionType}`,
  });
}

function capacityIssue(item) {
  const resource = Object.hasOwn(RESOURCE_LABELS, item.resource)
    ? RESOURCE_LABELS[item.resource]
    : "存储资源";
  const critical = item.severity === "critical";
  return issue({
    title: `${resource}已使用 ${finitePercent(item.usedPercent)}`,
    guidance: critical
      ? "立即释放空间后重新检查；优先转移已验证备份，不要递归删除项目、数据或恢复目录。"
      : "尽快安排释放空间；先验证备份副本，再删除精确指定的旧文件。",
    diagnostic: `${item.probeId} · ${item.resource} · ${item.severity}`,
  });
}

function probeFailureIssue(item) {
  const presentation = Object.hasOwn(PROBE_FAILURE_PRESENTATION, item.code)
    ? PROBE_FAILURE_PRESENTATION[item.code]
    : {
        title: "健康检查异常",
        guidance: "保持岗位暂停并查看受管服务日志，确认原因后再重新检查。",
      };
  return issue({
    ...presentation,
    diagnostic: `${item.probeId} · ${item.code}`,
  });
}

function pullRequestWindowLabel(window) {
  if (window?.mode === "rolling") return `近 ${window.days} 天`;
  if (window?.mode === "fixed") {
    return `${window.fromInclusive} 至 ${window.untilExclusive}（${window.timeZone}）`;
  }
  if (window?.mode === "unlimited") return "不限更新时间";
  return "未知";
}

export function renderSystemStatus({
  state = null,
  loading = false,
  error = "",
  operationPending = false,
  notice = "",
} = {}) {
  if (state === null) {
    return `<section class="system-status-panel">
      <div class="empty" role="${error ? "alert" : "status"}">${escapeHtml(
        error || (loading ? "正在读取系统状态…" : "尚未读取系统状态"),
      )}</div>
      <button type="button" class="secondary-button" data-system-status-reload ${loading ? "disabled" : ""}>重新读取</button>
    </section>`;
  }
  const liveness = state.liveness || {};
  const readiness = state.readiness || {};
  const maintenance = state.maintenance || {};
  const backups = state.backups || {};
  const pullRequestDiscovery = state.pullRequestDiscovery || {};
  const recoveryBlockers = Array.isArray(readiness.recoveryBlockers)
    ? readiness.recoveryBlockers
    : [];
  const unknownActions = Array.isArray(readiness.unknownExternalActions)
    ? readiness.unknownExternalActions
    : [];
  const capacityWarnings = Array.isArray(readiness.capacityWarnings)
    ? readiness.capacityWarnings
    : [];
  const probeFailures = Array.isArray(readiness.probeFailures)
    ? readiness.probeFailures
    : [];
  const ready = readiness.ready === true;
  const backupItems = Array.isArray(backups.items) ? backups.items : [];

  return `<div class="system-status-panel">
    ${notice ? `<p class="system-status-notice" role="status">${escapeHtml(notice)}</p>` : ""}
    ${error ? `<p class="system-status-error" role="alert">${escapeHtml(error)}</p>` : ""}
    <section class="system-status-summary status-${statusTone(ready)}" aria-labelledby="system-status-summary-title">
      <div class="section-heading">
        <h2 id="system-status-summary-title">运行与恢复状态</h2>
        <div class="system-status-summary-actions">
          <span>${ready ? "可接收工作" : "暂不接收新工作"}</span>
          <button type="button" class="secondary-button" data-system-status-reload ${loading ? "disabled" : ""}>${loading ? "检查中…" : "重新检查"}</button>
        </div>
      </div>
      <dl class="system-status-metrics">
        <div><dt>Liveness</dt><dd>${liveness.live === true ? "在线" : "离线"}</dd></div>
        <div><dt>Readiness</dt><dd>${ready ? "就绪" : "未就绪"}</dd></div>
        <div><dt>维护门</dt><dd>${escapeHtml(maintenance.mode || "未知")}</dd></div>
        <div><dt>在途操作</dt><dd>${escapeHtml(maintenance.activeOperations ?? "未知")}</dd></div>
      </dl>
      <p class="system-status-checked">检查时间：${escapeHtml(readiness.checkedAt || "未知")}</p>
    </section>
    <div class="system-status-grid">
      <section class="system-status-card">
        <h3>PR 自动发现</h3>
        <dl class="system-status-metrics">
          <div><dt>最近刷新</dt><dd>${escapeHtml(pullRequestDiscovery.refreshedAt || "尚无快照")}</dd></div>
          <div><dt>搜索结果</dt><dd>${pullRequestDiscovery.available !== true ? "不可用" : pullRequestDiscovery.enabled !== true ? "已禁用" : pullRequestDiscovery.complete === true && pullRequestDiscovery.stale !== true ? "完整" : "不完整或陈旧"}</dd></div>
          <div><dt>更新时间范围</dt><dd>${escapeHtml(pullRequestWindowLabel(pullRequestDiscovery.effectiveUpdatedWindow))}</dd></div>
          <div><dt>范围起点</dt><dd>${escapeHtml(pullRequestDiscovery.effectiveUpdatedWindow?.fromInclusive || "无")}</dd></div>
        </dl>
      </section>
      <section class="system-status-card">
        <h3>恢复阻断</h3>
        ${list(
          recoveryBlockers,
          recoveryIssue,
          "没有恢复阻断。",
        )}
      </section>
      <section class="system-status-card">
        <h3>结果未知的外部动作</h3>
        ${list(
          unknownActions,
          externalActionIssue,
          "没有结果未知的外部动作。",
        )}
      </section>
      <section class="system-status-card">
        <h3>容量告警</h3>
        ${list(
          capacityWarnings,
          capacityIssue,
          "没有容量告警。",
        )}
      </section>
      <section class="system-status-card">
        <h3>探针故障</h3>
        ${list(
          probeFailures,
          probeFailureIssue,
          "所有探针均已返回。",
        )}
      </section>
    </div>
    <section class="system-status-backups" aria-labelledby="system-backups-title">
      <div class="section-heading">
        <div>
          <h2 id="system-backups-title">一致性备份</h2>
          <p>创建前会关闭新写入并排空在途工作；恢复只落到独立目录，不会静默替换当前数据。</p>
        </div>
        <button type="button" data-system-backup-create ${operationPending || maintenance.mode !== "open" ? "disabled" : ""}>${operationPending ? "正在创建…" : "创建备份"}</button>
      </div>
      ${list(
        backupItems,
        (item) => `<strong>${escapeHtml(item.backupId || "未知备份")}</strong><span>${escapeHtml(item.createdAt || "时间未知")} · ${escapeHtml(item.fileCount ?? 0)} 个文件 · ${escapeHtml(item.totalBytes ?? 0)} 字节</span>`,
        backups.available === false ? "备份能力尚未启用。" : "尚无已验证备份。",
      )}
    </section>
  </div>`;
}
