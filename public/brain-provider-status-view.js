import { escapeHtml } from "./view-format.js";

const STATE_PRESENTATION = Object.freeze({
  available: Object.freeze({
    tone: "available",
    label: "能力可用",
    summary: "CLI 已安装且受支持，文件式登录可安全代理。",
    guidance: "Codex CLI 大脑可以使用当前 Windows 用户的登录状态。",
  }),
  file_login_unavailable: Object.freeze({
    tone: "attention",
    label: "登录不可用",
    summary: "CLI 已就绪，但没有发现可代理的文件式登录。",
    guidance: "请使用运行 MyDashboard 的同一 Windows 用户执行 codex login，然后重新检查。",
  }),
  unsafe_source: Object.freeze({
    tone: "blocked",
    label: "登录源不安全",
    summary: "系统拒绝读取当前 Codex 登录文件。",
    guidance: "请检查文件所有者、ACL 或链接；修复后再重新检查。",
  }),
  broker_blocked: Object.freeze({
    tone: "blocked",
    label: "凭据代理已封闭",
    summary: "本次进程中的安全边界已关闭，CLI 登录不会继续使用。",
    guidance: "请重启 MyDashboard；若仍失败，再检查本机登录文件权限。",
  }),
  cli_unavailable: Object.freeze({
    tone: "blocked",
    label: "CLI 不可用",
    summary: "系统无法安全启动受支持的 Codex CLI。",
    guidance: "请安装项目支持的 Codex CLI，并确保服务进程可以发现它。",
  }),
});

function shell({ body, tone = "pending", role = "status" }) {
  return `<section class="brain-provider-status-card status-${tone}" aria-labelledby="brain-provider-status-title">
    <div class="brain-provider-status-heading">
      <div>
        <p class="eyebrow">LOCAL CLI / LOGIN BROKER</p>
        <h2 id="brain-provider-status-title">Codex CLI 大脑能力</h2>
      </div>
    </div>
    <div class="brain-provider-status-body" role="${role}" aria-live="polite">${body}</div>
  </section>`;
}

export function renderBrainProviderStatus({
  state = null,
  loading = false,
  error = "",
  pendingRestart = false,
} = {}) {
  if (loading && state === null) {
    return shell({
      body: "<p>正在检查 Codex CLI 与文件式登录能力…</p>",
    });
  }

  if (state === null) {
    const message = error || "尚未读取 Codex CLI 大脑能力。";
    return shell({
      tone: "blocked",
      role: error ? "alert" : "status",
      body: `<p>${escapeHtml(message)}</p>
        <button type="button" class="secondary-button" data-brain-provider-status-reload>重新检查</button>`,
    });
  }

  const presentation = Object.hasOwn(STATE_PRESENTATION, state?.state)
    ? STATE_PRESENTATION[state.state]
    : null;
  if (!presentation) {
    return shell({
      tone: "blocked",
      role: "alert",
      body: `<p>服务返回了无法识别的 Codex CLI 能力状态。</p>
        <button type="button" class="secondary-button" data-brain-provider-status-reload>重新检查</button>`,
    });
  }

  return shell({
    tone: presentation.tone,
    role: error ? "alert" : "status",
    body: `${pendingRestart
      ? '<p class="brain-provider-status-notice">已保存，重启后生效</p>'
      : ""}
      ${error ? `<p class="brain-provider-status-error">${escapeHtml(error)}</p>` : ""}
      <div class="brain-provider-status-heading">
        <div>
          <strong>${presentation.label}</strong>
          <p>${presentation.summary}</p>
        </div>
        <button type="button" class="secondary-button" data-brain-provider-status-reload ${loading ? "disabled" : ""}>${loading ? "检查中…" : "重新检查"}</button>
      </div>
      <dl class="brain-provider-status-facts">
        <div><dt>CLI</dt><dd>${state.cliAvailable === true ? "可用" : "不可用"}</dd></div>
        <div><dt>文件式登录</dt><dd>${state.fileLoginAvailable === true ? "可用" : "不可用"}</dd></div>
      </dl>
      <p class="brain-provider-status-guidance">${presentation.guidance}</p>`,
  });
}
