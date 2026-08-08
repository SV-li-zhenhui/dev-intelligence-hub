import { escapeHtml } from "./view-format.js";

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
        <span>${ready ? "可接收工作" : "暂不接收新工作"}</span>
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
        <h3>恢复阻断</h3>
        ${list(
          recoveryBlockers,
          (item) => `<code>${escapeHtml(item.probeId)}</code> · ${escapeHtml(item.code)}`,
          "没有恢复阻断。",
        )}
      </section>
      <section class="system-status-card">
        <h3>结果未知的外部动作</h3>
        ${list(
          unknownActions,
          (item) => `<code>${escapeHtml(item.probeId)}</code> · ${escapeHtml(item.actionType)}`,
          "没有结果未知的外部动作。",
        )}
      </section>
      <section class="system-status-card">
        <h3>容量告警</h3>
        ${list(
          capacityWarnings,
          (item) => `${escapeHtml(item.resource)} · ${escapeHtml(item.severity)} · ${escapeHtml(finitePercent(item.usedPercent))}`,
          "没有容量告警。",
        )}
      </section>
      <section class="system-status-card">
        <h3>探针故障</h3>
        ${list(
          probeFailures,
          (item) => `<code>${escapeHtml(item.probeId)}</code> · ${escapeHtml(item.code)}`,
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
