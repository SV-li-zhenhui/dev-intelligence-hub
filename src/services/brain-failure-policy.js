const STRUCTURED_PROVIDER_FAILURE_PREFIX = "STRUCTURED_PROVIDER_";
const SHARED_OPERATOR_PAUSE_CODES = new Set([
  "BRAIN_CREDENTIAL_UNAVAILABLE",
  "BRAIN_PROVIDER_NOT_CONFIGURED",
  "REMOTE_DATA_NOT_AUTHORIZED",
]);

function attention(code, summary, remediation) {
  return Object.freeze({ code, summary, remediation });
}

const OWNER_ATTENTION_BY_CODE = new Map([
  [
    "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    attention(
      "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
      "岗位 CLI 会话进度未能安全归档",
      "保留隔离目录中的会话历史，不要删除；确认 CLI 已结束后检查会话存储并恢复该任务的原会话",
    ),
  ],
  [
    "ROLE_TASK_BRAIN_NOT_CONFIGURED",
    attention(
      "ROLE_TASK_BRAIN_NOT_CONFIGURED",
      "岗位任务大脑尚未配置",
      "在配置中心为该岗位添加并激活 taskBrain",
    ),
  ],
  [
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    attention(
      "BRAIN_PROVIDER_NOT_CONFIGURED",
      "岗位任务大脑 Provider 不可用",
      "在配置中心修正并激活 taskBrain 的 Provider",
    ),
  ],
  [
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    attention(
      "BRAIN_CREDENTIAL_UNAVAILABLE",
      "岗位任务大脑凭据不可用",
      "提供配置中引用的凭据环境变量，并在需要时重启服务",
    ),
  ],
  [
    "REMOTE_DATA_NOT_AUTHORIZED",
    attention(
      "REMOTE_DATA_NOT_AUTHORIZED",
      "岗位任务大脑缺少远程数据授权",
      "在配置中心检查 taskBrain 的远程 requirements/code 数据授权并激活",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_UNAVAILABLE",
    attention(
      "STRUCTURED_PROVIDER_UNAVAILABLE",
      "岗位任务大脑的结构化 Provider 不可用",
      "安装或修复该岗位配置的 CLI，并确认服务账户可执行",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    attention(
      "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
      "岗位任务大脑的结构化 Provider 凭据不可用",
      "为该岗位使用的 CLI 完成登录、认证或凭据配置",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    attention(
      "STRUCTURED_PROVIDER_CLEANUP_FAILED",
      "岗位任务大脑的隔离运行环境未能安全清理",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_REAP_FAILED",
    attention(
      "STRUCTURED_PROVIDER_REAP_FAILED",
      "岗位任务大脑的受监督 CLI 进程未能安全结束",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境",
    ),
  ],
]);

export function brainFailureOwnerAttention(code) {
  if (typeof code !== "string") return null;
  return OWNER_ATTENTION_BY_CODE.get(code) ?? null;
}

export function requiresBrainOperatorPause(code) {
  return (
    SHARED_OPERATOR_PAUSE_CODES.has(code) ||
    (typeof code === "string" &&
      code.startsWith(STRUCTURED_PROVIDER_FAILURE_PREFIX))
  );
}
