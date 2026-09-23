const DINGTALK_LOGIN_FAILURE =
  /旧版登录态已无法由当前认证服务刷新|invalidParameter\.authCode\.notFound/u;
const PROFILE = /profile:\s*\\*"([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)\\*"/u;

export function summarizeDashboardErrors(errors) {
  const messages = [];
  let dingtalkLoginFailure = false;
  for (const error of errors) {
    if (DINGTALK_LOGIN_FAILURE.test(error)) {
      if (dingtalkLoginFailure) continue;
      dingtalkLoginFailure = true;
      const profile = error.match(PROFILE)?.[1];
      messages.push(profile
        ? `钉钉授权已失效。请在本机运行 dws auth login --profile "${profile}" 重新授权；钉钉消息和待办暂未刷新。`
        : "钉钉授权已失效。请在本机运行 dws auth login 重新授权；钉钉消息和待办暂未刷新。");
      continue;
    }
    const compact = String(error).replace(/\s+/gu, " ").trim();
    if (compact) messages.push(compact.length > 180
      ? `${compact.slice(0, 177)}…`
      : compact);
  }
  const visible = messages.slice(0, 3);
  if (messages.length > visible.length) {
    visible.push(`另有 ${messages.length - visible.length} 项异常`);
  }
  return visible;
}
