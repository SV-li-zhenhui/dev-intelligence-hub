import nodePath from "node:path";

import {
  normalizeWorkspacePath,
  validateWorkspaceId,
} from "./code-execution-policy.js";
import { normalizeWorkflowRoutingConfig } from "./workflow-router.js";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "../lib/canonical-json-digest.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_OBJECT_FIELDS = 4_096;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SAFE_GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_REFERENCE = /(?:Env|Ref)$/;
const SECRET_VALUE =
  /(?:^|\s)(?:bearer\s+|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const URL_USERINFO = /:\/\/[^/@\s:]+:[^/@\s]+@/;

function isTrustedWindowsGitImplementation(value) {
  if (process.platform !== "win32") return true;
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return (
    /^[a-z]:\//u.test(normalized) &&
    /\/mingw(?:32|64)\/bin\/git\.exe$/u.test(normalized)
  );
}

const TOP_LEVEL_FIELDS = Object.freeze([
  "port",
  "refreshMinutes",
  "browserPollSeconds",
  "githubLogin",
  "trackedRepositories",
  "prResponsibility",
  "codeExecutor",
  "changePackages",
  "githubActions",
  "workflowRouting",
  "workCoordination",
  "memory",
  "brain",
  "brainProviders",
  "employees",
  "dingtalk",
]);

const LEGACY_BRAIN_FIELDS = Object.freeze([
  "enabled",
  "provider",
  "model",
  "baseUrl",
  "timeoutMs",
  "numCtx",
  "contextTokens",
  "maxAssessmentsPerRefresh",
]);
const PROVIDER_FIELDS = Object.freeze([
  "kind",
  "baseUrl",
  "apiKeyEnv",
  "protocol",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "contextTokens",
  "remote",
]);
const ROLE_FIELDS = Object.freeze([
  "name",
  "mission",
  "enabled",
  "scheduleMinutes",
  "initialPaused",
  "workerId",
  "permissions",
  "brain",
]);
const INTENT_TYPES = new Set([
  "ask_user",
  "wait_condition",
  "propose_github_review",
  "propose_code_action",
  "handoff",
  "complete",
  "orchestrate",
  "submit_delivery",
]);
const DATA_CLASSES = Object.freeze(["requirements", "code", "memory"]);
const CAPABILITIES = new Set([
  "coordination",
  "requirements",
  "pr-review",
  "development",
  "testing",
]);
const CODE_OPERATIONS = new Set(["inspect", "modify", "verify"]);
const NETWORK_ENV_FIELDS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export class ConfigurationContractError extends Error {
  constructor(message = "配置文档无效", { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigurationContractError";
    this.code = "INVALID_CONFIGURATION_DOCUMENT";
    this.statusCode = 400;
  }
}

function invalid(path, detail = "无效", cause) {
  const location = path || "configuration";
  return new ConfigurationContractError(`${location} ${detail}`, { cause });
}

function secretField(name) {
  if (SECRET_REFERENCE.test(name)) return false;
  const normalized = name.replaceAll(/[-_]/g, "").toLowerCase();
  if (normalized.endsWith("tokens")) return false;
  return /(?:token|apikey|password|passwd|secret|credential|privatekey|accesskey|authorization)$/.test(
    normalized,
  );
}

function cloneSafeData(value, path, ancestors, depth) {
  if (depth > MAX_DEPTH) throw invalid(path, "嵌套过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw invalid(path);
    return value;
  }
  if (typeof value === "string") {
    if (
      INVALID_TEXT_CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > 64 * 1024 ||
      SECRET_VALUE.test(value) ||
      URL_USERINFO.test(value)
    ) {
      throw invalid(path, "包含不允许的文本或凭据值");
    }
    return value;
  }
  if (typeof value !== "object") throw invalid(path);
  if (ancestors.has(value)) throw invalid(path, "包含循环引用");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_ARRAY_ITEMS
      ) {
        throw invalid(path);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw invalid(path, "必须是无附加字段的稠密数组");
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw invalid(`${path}[${index}]`, "必须是数据字段");
        }
        result.push(
          cloneSafeData(
            descriptor.value,
            `${path}[${index}]`,
            ancestors,
            depth + 1,
          ),
        );
      }
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalid(path, "必须使用普通对象原型");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_OBJECT_FIELDS) throw invalid(path, "字段过多");
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw invalid(path, "包含危险键、Symbol 或访问器");
      }
      if (secretField(key)) {
        throw invalid(`${path}.${key}`, "不得保存实际凭据");
      }
      result[key] = cloneSafeData(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
        depth + 1,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function safeDocumentClone(value) {
  const cloned = cloneSafeData(value, "configuration", new Set(), 0);
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > MAX_DOCUMENT_BYTES) {
    throw invalid("configuration", "超过容量上限");
  }
  return cloned;
}

function fields(value, path, allowed, required = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path);
  }
  const actual = Object.keys(value);
  const allowedSet = new Set(allowed);
  if (
    actual.some((name) => !allowedSet.has(name)) ||
    required.some((name) => !Object.hasOwn(value, name))
  ) {
    throw invalid(path, "包含未知字段或缺少必需字段");
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw invalid(path);
  return value;
}

function integer(value, path, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(path);
  }
  return value;
}

function text(value, path, maximumBytes, { empty = false, pattern } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(path);
  }
  return value;
}

function optional(source, name, normalize) {
  return Object.hasOwn(source, name) ? { [name]: normalize(source[name]) } : {};
}

function uniqueArray(value, path, maximum, normalize, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalid(path);
  }
  const result = value.map((entry, index) =>
    normalize(entry, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) throw invalid(path, "包含重复项");
  return result;
}

function namedMap(value, path, normalize, { maximum = 256 } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path);
  }
  fields(value, path, Object.keys(value));
  const entries = Object.entries(value);
  if (entries.length > maximum) throw invalid(path, "条目过多");
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, entry]) => [name, normalize(entry, `${path}.${name}`, name)]),
  );
}

function safeId(value, path, pattern = SAFE_ID) {
  return text(value, path, 128, { pattern });
}

function envReference(value, path) {
  return text(value, path, 128, { pattern: SAFE_ENV_NAME });
}

function endpoint(value, path) {
  const raw = text(value, path, 2_048);
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw invalid(path, "URL 无效", cause);
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalid(path, "URL 边界无效");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback && url.protocol !== "https:") {
    throw invalid(path, "远程端点必须使用 HTTPS");
  }
  return { value: raw, remote: !loopback };
}

function normalizeLegacyBrain(value, path, { partial = false } = {}) {
  const required = partial ? [] : ["enabled", "provider", "model", "baseUrl"];
  const config = fields(value, path, LEGACY_BRAIN_FIELDS, required);
  const normalized = {
    ...optional(config, "enabled", (entry) => boolean(entry, `${path}.enabled`)),
    ...optional(config, "provider", (entry) => {
      const provider = safeId(entry, `${path}.provider`);
      if (provider !== "ollama") throw invalid(`${path}.provider`);
      return provider;
    }),
    ...optional(config, "model", (entry) => text(entry, `${path}.model`, 256)),
    ...optional(config, "baseUrl", (entry) => endpoint(entry, `${path}.baseUrl`).value),
  };
  for (const name of [
    "timeoutMs",
    "numCtx",
    "contextTokens",
    "maxAssessmentsPerRefresh",
  ]) {
    Object.assign(
      normalized,
      optional(config, name, (entry) =>
        integer(entry, `${path}.${name}`, 1, 2 ** 31 - 1),
      ),
    );
  }
  return normalized;
}

function normalizeRemoteData(value, path) {
  const config = fields(value, path, DATA_CLASSES, DATA_CLASSES);
  return Object.fromEntries(
    DATA_CLASSES.map((name) => [name, boolean(config[name], `${path}.${name}`)]),
  );
}

function normalizeAssignedBrain(value, path) {
  const config = fields(
    value,
    path,
    ["provider", "model", "remoteData"],
    ["provider", "model", "remoteData"],
  );
  return {
    provider: safeId(config.provider, `${path}.provider`),
    model: text(config.model, `${path}.model`, 256),
    remoteData: normalizeRemoteData(config.remoteData, `${path}.remoteData`),
  };
}

function normalizeProvider(value, path, id) {
  safeId(id, path);
  const config = fields(value, path, PROVIDER_FIELDS, ["kind"]);
  const kind = text(config.kind, `${path}.kind`, 64);
  if (!new Set(["ollama", "openai-compatible"]).has(kind)) {
    throw invalid(`${path}.kind`);
  }
  if (!Object.hasOwn(config, "baseUrl")) {
    throw invalid(`${path}.baseUrl`, "缺少必需字段");
  }
  const target = endpoint(config.baseUrl, `${path}.baseUrl`);
  if (config.remote === false && target.remote) {
    throw invalid(`${path}.remote`, "不得弱化远程端点分类");
  }
  if (kind === "openai-compatible" && !Object.hasOwn(config, "apiKeyEnv")) {
    throw invalid(`${path}.apiKeyEnv`, "缺少凭据环境变量引用");
  }
  if (kind === "ollama" && Object.hasOwn(config, "apiKeyEnv")) {
    throw invalid(`${path}.apiKeyEnv`);
  }
  if (kind === "ollama" && Object.hasOwn(config, "protocol")) {
    throw invalid(`${path}.protocol`);
  }
  const protocol = Object.hasOwn(config, "protocol")
    ? text(config.protocol, `${path}.protocol`, 64)
    : null;
  if (
    protocol !== null &&
    !new Set(["chat-completions", "responses"]).has(protocol)
  ) {
    throw invalid(`${path}.protocol`);
  }
  const normalized = {
    kind,
    baseUrl: target.value,
    ...optional(config, "apiKeyEnv", (entry) =>
      envReference(entry, `${path}.apiKeyEnv`),
    ),
    ...(protocol === null ? {} : { protocol }),
  };
  const limits = protocol === null
    ? {
        timeoutMs: [1, 2 * 1024 * 1024],
        maxResponseBytes: [1, 2 * 1024 * 1024],
        maxRequestBytes: [1, 2 * 1024 * 1024],
      }
    : protocol === "responses"
      ? {
          timeoutMs: [1_000, 3_600_000],
          maxResponseBytes: [1_024, 1024 * 1024],
          maxRequestBytes: [1_024, 1024 * 1024],
        }
      : {
          timeoutMs: [10, 120_000],
          maxResponseBytes: [1_024, 1024 * 1024],
          maxRequestBytes: [1_024, 2 * 1024 * 1024],
        };
  for (const [name, [minimum, maximum]] of Object.entries(limits)) {
    Object.assign(
      normalized,
      optional(config, name, (entry) =>
        integer(entry, `${path}.${name}`, minimum, maximum),
      ),
    );
  }
  if (kind === "openai-compatible" && Object.hasOwn(config, "contextTokens")) {
    throw invalid(`${path}.contextTokens`);
  }
  Object.assign(
    normalized,
    optional(config, "contextTokens", (entry) =>
      integer(entry, `${path}.contextTokens`, 1_024, 128 * 1_024),
    ),
    optional(config, "remote", (entry) => boolean(entry, `${path}.remote`)),
  );
  return normalized;
}

function normalizeRole(value, path, id) {
  safeId(id, path, SAFE_ROLE_ID);
  if (id === "pr-reviewer") throw invalid(path, "保留岗位 ID 不可复用");
  const config = fields(value, path, ROLE_FIELDS, [
    "name",
    "mission",
    "enabled",
    "scheduleMinutes",
    "initialPaused",
    "permissions",
    "brain",
  ]);
  const permissions = fields(
    config.permissions,
    `${path}.permissions`,
    ["allowedIntents"],
    ["allowedIntents"],
  );
  return {
    name: text(config.name, `${path}.name`, 256),
    mission: text(config.mission, `${path}.mission`, 4_096),
    enabled: boolean(config.enabled, `${path}.enabled`),
    scheduleMinutes: integer(
      config.scheduleMinutes,
      `${path}.scheduleMinutes`,
      0,
      24 * 60,
    ),
    initialPaused: boolean(config.initialPaused, `${path}.initialPaused`),
    ...optional(config, "workerId", (entry) =>
      safeId(entry, `${path}.workerId`, SAFE_ROLE_ID),
    ),
    permissions: {
      allowedIntents: uniqueArray(
        permissions.allowedIntents,
        `${path}.permissions.allowedIntents`,
        INTENT_TYPES.size,
        (entry, entryPath) => {
          const intent = text(entry, entryPath, 64);
          if (!INTENT_TYPES.has(intent)) throw invalid(entryPath);
          return intent;
        },
        1,
      ),
    },
    brain: normalizeAssignedBrain(config.brain, `${path}.brain`),
  };
}

function normalizePrReviewer(value, path) {
  const allowed = [
    "enabled",
    "name",
    "initialPaused",
    "policyVersion",
    "tickMinutes",
    "maxJobsPerTick",
    "maxAttempts",
    "retryMinutes",
    "maxPatchCharacters",
    "memoryLimit",
    "memoryOutboxLimit",
    "jobLimit",
    "allowRemoteCodeContext",
    "brain",
  ];
  const config = fields(value, path, allowed, [
    "enabled",
    "name",
    "initialPaused",
    "policyVersion",
    "tickMinutes",
    "maxJobsPerTick",
    "maxAttempts",
    "retryMinutes",
    "maxPatchCharacters",
    "memoryLimit",
    "memoryOutboxLimit",
    "jobLimit",
    "allowRemoteCodeContext",
    "brain",
  ]);
  return {
    enabled: boolean(config.enabled, `${path}.enabled`),
    name: text(config.name, `${path}.name`, 256),
    initialPaused: boolean(config.initialPaused, `${path}.initialPaused`),
    policyVersion: integer(config.policyVersion, `${path}.policyVersion`, 1, 1_000_000),
    tickMinutes: integer(config.tickMinutes, `${path}.tickMinutes`, 1, 24 * 60),
    maxJobsPerTick: integer(config.maxJobsPerTick, `${path}.maxJobsPerTick`, 1, 1_000),
    maxAttempts: integer(config.maxAttempts, `${path}.maxAttempts`, 1, 100),
    retryMinutes: uniqueArray(
      config.retryMinutes,
      `${path}.retryMinutes`,
      32,
      (entry, entryPath) => integer(entry, entryPath, 1, 30 * 24 * 60),
      1,
    ),
    maxPatchCharacters: integer(
      config.maxPatchCharacters,
      `${path}.maxPatchCharacters`,
      1,
      10_000_000,
    ),
    memoryLimit: integer(config.memoryLimit, `${path}.memoryLimit`, 1, 1_000_000),
    memoryOutboxLimit: integer(
      config.memoryOutboxLimit,
      `${path}.memoryOutboxLimit`,
      1,
      100_000,
    ),
    jobLimit: integer(config.jobLimit, `${path}.jobLimit`, 1, 1_000_000),
    allowRemoteCodeContext: boolean(
      config.allowRemoteCodeContext,
      `${path}.allowRemoteCodeContext`,
    ),
    brain: normalizeLegacyBrain(config.brain, `${path}.brain`, { partial: true }),
  };
}

function normalizeEmployees(value) {
  const config = fields(
    value,
    "employees",
    ["prReviewer", "roles"],
    ["prReviewer", "roles"],
  );
  return {
    prReviewer: normalizePrReviewer(config.prReviewer, "employees.prReviewer"),
    roles: namedMap(config.roles, "employees.roles", normalizeRole),
  };
}

function normalizeCodeExecutor(value) {
  const path = "codeExecutor";
  const config = fields(
    value,
    path,
    [
      "enabled",
      "docker",
      "gitCommand",
      "gitTimeoutMs",
      "workspaces",
      "profiles",
      "requiredProfilesByWorkspace",
      "brokerLimits",
      "executorLimits",
      "maxArtifactBytes",
    ],
    ["enabled"],
  );
  const enabled = boolean(config.enabled, `${path}.enabled`);
  if (
    enabled &&
    ["docker", "workspaces", "profiles", "requiredProfilesByWorkspace"].some(
      (name) => !Object.hasOwn(config, name),
    )
  ) {
    throw invalid(path, "启用后缺少执行器边界配置");
  }
  const normalized = {
    enabled,
    ...optional(config, "gitCommand", (entry) =>
      text(entry, `${path}.gitCommand`, 4_096),
    ),
    ...optional(config, "gitTimeoutMs", (entry) =>
      integer(entry, `${path}.gitTimeoutMs`, 1, 60_000),
    ),
  };
  if (Object.hasOwn(config, "docker")) {
    const docker = fields(
      config.docker,
      `${path}.docker`,
      ["executable", "host"],
      ["executable", "host"],
    );
    const host = text(docker.host, `${path}.docker.host`, 2_048);
    if (!host.startsWith("npipe://") && !host.startsWith("unix://")) {
      throw invalid(`${path}.docker.host`, "必须是本地 Docker 端点");
    }
    normalized.docker = {
      executable: text(docker.executable, `${path}.docker.executable`, 4_096),
      host,
    };
  }
  const workspaceIds = new Set();
  if (Object.hasOwn(config, "workspaces")) {
    if (!Array.isArray(config.workspaces) || config.workspaces.length > 100) {
      throw invalid(`${path}.workspaces`);
    }
    normalized.workspaces = config.workspaces.map((workspace, index) => {
      const itemPath = `${path}.workspaces[${index}]`;
      const item = fields(
        workspace,
        itemPath,
        [
          "id",
          "sourceRoot",
          "writablePaths",
          "excludePaths",
          "gitHeadSnapshot",
        ],
        ["id", "sourceRoot"],
      );
      let id;
      try {
        id = validateWorkspaceId(item.id);
      } catch (cause) {
        throw invalid(`${itemPath}.id`, "无效", cause);
      }
      if (workspaceIds.has(id)) throw invalid(`${itemPath}.id`, "重复");
      workspaceIds.add(id);
      const normalizePaths = (name) =>
        uniqueArray(
          item[name],
          `${itemPath}.${name}`,
          256,
          (entry, entryPath) => {
            try {
              return normalizeWorkspacePath(entry);
            } catch (cause) {
              throw invalid(entryPath, "不安全", cause);
            }
          },
        );
      return {
        id,
        sourceRoot: text(item.sourceRoot, `${itemPath}.sourceRoot`, 4_096),
        ...optional(item, "writablePaths", () => normalizePaths("writablePaths")),
        ...optional(item, "excludePaths", () => normalizePaths("excludePaths")),
        ...optional(item, "gitHeadSnapshot", (entry) =>
          boolean(entry, `${itemPath}.gitHeadSnapshot`),
        ),
      };
    });
    if (enabled && normalized.workspaces.length === 0) {
      throw invalid(`${path}.workspaces`, "启用后不能为空");
    }
    const usesGitHeadSnapshot = normalized.workspaces.some(
      (workspace) => workspace.gitHeadSnapshot,
    );
    if (usesGitHeadSnapshot && !Object.hasOwn(normalized, "gitCommand")) {
      throw invalid(`${path}.gitCommand`, "Git Head 快照启用后不能为空");
    }
    if (usesGitHeadSnapshot && !nodePath.isAbsolute(normalized.gitCommand)) {
      throw invalid(`${path}.gitCommand`, "Git Head 快照命令必须是绝对路径");
    }
    if (
      usesGitHeadSnapshot &&
      !isTrustedWindowsGitImplementation(normalized.gitCommand)
    ) {
      throw invalid(
        `${path}.gitCommand`,
        "Windows Git Head 快照必须直接使用 mingw64/bin/git.exe 实现",
      );
    }
  }
  const profileIds = new Set();
  if (Object.hasOwn(config, "profiles")) {
    normalized.profiles = namedMap(
      config.profiles,
      `${path}.profiles`,
      (profile, profilePath, id) => {
        safeId(id, profilePath);
        profileIds.add(id);
        const item = fields(
          profile,
          profilePath,
          ["kind", "image", "timeoutMs"],
          ["kind", "image", "timeoutMs"],
        );
        if (item.kind !== "node-test") throw invalid(`${profilePath}.kind`);
        return {
          kind: item.kind,
          image: text(item.image, `${profilePath}.image`, 1_024, {
            pattern: PINNED_IMAGE,
          }),
          timeoutMs: integer(item.timeoutMs, `${profilePath}.timeoutMs`, 1_000, 600_000),
        };
      },
      { maximum: 100 },
    );
    if (enabled && profileIds.size === 0) throw invalid(`${path}.profiles`);
  }
  if (Object.hasOwn(config, "requiredProfilesByWorkspace")) {
    normalized.requiredProfilesByWorkspace = namedMap(
      config.requiredProfilesByWorkspace,
      `${path}.requiredProfilesByWorkspace`,
      (profiles, profilesPath, workspaceId) => {
        if (!workspaceIds.has(workspaceId)) throw invalid(profilesPath);
        return uniqueArray(
          profiles,
          profilesPath,
          100,
          (profileId, profilePath) => {
            const id = safeId(profileId, profilePath);
            if (!profileIds.has(id)) throw invalid(profilePath);
            return id;
          },
          1,
        );
      },
    );
    if (
      enabled &&
      [...workspaceIds].some(
        (id) => !Object.hasOwn(normalized.requiredProfilesByWorkspace, id),
      )
    ) {
      throw invalid(`${path}.requiredProfilesByWorkspace`);
    }
  }
  const normalizeLimits = (name, allowed) => {
    const limits = fields(config[name], `${path}.${name}`, allowed);
    return Object.fromEntries(
      allowed
        .filter((key) => Object.hasOwn(limits, key))
        .map((key) => [
          key,
          integer(limits[key], `${path}.${name}.${key}`, 1, 2 ** 31 - 1),
        ]),
    );
  };
  Object.assign(
    normalized,
    optional(config, "brokerLimits", () =>
      normalizeLimits("brokerLimits", [
        "maxFiles",
        "maxDirectories",
        "maxFileBytes",
        "maxTotalBytes",
        "maxSearchMatches",
        "maxWriteBytes",
      ]),
    ),
    optional(config, "executorLimits", () =>
      normalizeLimits("executorLimits", ["maxSessions", "maxActionsPerSession"]),
    ),
    optional(config, "maxArtifactBytes", (entry) =>
      integer(entry, `${path}.maxArtifactBytes`, 1, 2 ** 31 - 1),
    ),
  );
  return normalized;
}

function normalizeChangePackages(value) {
  const path = "changePackages";
  const config = fields(
    value,
    path,
    ["enabled", "gitCommand", "gitTimeoutMs"],
    ["enabled"],
  );
  const enabled = boolean(config.enabled, `${path}.enabled`);
  if (enabled && !Object.hasOwn(config, "gitCommand")) {
    throw invalid(`${path}.gitCommand`, "启用后不能为空");
  }
  return {
    enabled,
    ...optional(config, "gitCommand", (entry) =>
      text(entry, `${path}.gitCommand`, 4_096),
    ),
    ...optional(config, "gitTimeoutMs", (entry) =>
      integer(entry, `${path}.gitTimeoutMs`, 1, 60_000),
    ),
  };
}

function normalizeGithubActions(value) {
  const path = "githubActions";
  const allowed = [
    "enabled",
    "actorAccountId",
    "tokenEnv",
    "ghCommand",
    "networkEnv",
    "timeoutMs",
  ];
  const config = fields(value, path, allowed, ["enabled"]);
  const enabled = boolean(config.enabled, `${path}.enabled`);
  if (
    enabled &&
    ["actorAccountId", "tokenEnv", "ghCommand"].some(
      (name) => !Object.hasOwn(config, name),
    )
  ) {
    throw invalid(path, "启用后缺少账号、凭据引用或固定命令");
  }
  const normalized = {
    enabled,
    ...optional(config, "actorAccountId", (entry) =>
      text(entry, `${path}.actorAccountId`, 40, {
        empty: !enabled,
        pattern: enabled ? SAFE_GITHUB_LOGIN : undefined,
      }),
    ),
    ...optional(config, "tokenEnv", (entry) =>
      envReference(entry, `${path}.tokenEnv`),
    ),
    ...optional(config, "ghCommand", (entry) =>
      text(entry, `${path}.ghCommand`, 4_096),
    ),
  };
  if (Object.hasOwn(config, "networkEnv")) {
    const environment = fields(
      config.networkEnv,
      `${path}.networkEnv`,
      [...NETWORK_ENV_FIELDS],
    );
    normalized.networkEnv = Object.fromEntries(
      Object.keys(environment)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((name) => [
          name,
          text(environment[name], `${path}.networkEnv.${name}`, 4_096),
        ]),
    );
  }
  Object.assign(
    normalized,
    optional(config, "timeoutMs", (entry) =>
      integer(entry, `${path}.timeoutMs`, 1, 600_000),
    ),
  );
  return normalized;
}

function normalizeMemory(value) {
  const path = "memory";
  const config = fields(
    value,
    path,
    ["enabled", "maximumRecords", "maximumStateBytes", "imports", "answering"],
    ["enabled"],
  );
  const normalized = {
    enabled: boolean(config.enabled, `${path}.enabled`),
    ...optional(config, "maximumRecords", (entry) =>
      integer(entry, `${path}.maximumRecords`, 1, 10_000_000),
    ),
    ...optional(config, "maximumStateBytes", (entry) =>
      integer(entry, `${path}.maximumStateBytes`, 1_024, 2 ** 31 - 1),
    ),
  };
  if (Object.hasOwn(config, "imports")) {
    const imports = fields(
      config.imports,
      `${path}.imports`,
      ["localSessions", "git"],
      ["localSessions", "git"],
    );
    normalized.imports = {
      localSessions: boolean(imports.localSessions, `${path}.imports.localSessions`),
      git: boolean(imports.git, `${path}.imports.git`),
    };
  }
  if (Object.hasOwn(config, "answering")) {
    const answeringPath = `${path}.answering`;
    const answering = fields(
      config.answering,
      answeringPath,
      [
        "enabled",
        "maximumRecords",
        "maximumContextBytes",
        "maximumConcurrent",
        "brain",
        "localBrain",
      ],
      ["enabled"],
    );
    if (
      answering.enabled === true &&
      ["brain", "localBrain"].some((name) => !Object.hasOwn(answering, name))
    ) {
      throw invalid(answeringPath, "启用后缺少回答大脑");
    }
    normalized.answering = {
      enabled: boolean(answering.enabled, `${answeringPath}.enabled`),
      ...optional(answering, "maximumRecords", (entry) =>
        integer(entry, `${answeringPath}.maximumRecords`, 1, 1_000),
      ),
      ...optional(answering, "maximumContextBytes", (entry) =>
        integer(entry, `${answeringPath}.maximumContextBytes`, 1_024, 128 * 1_024),
      ),
      ...optional(answering, "maximumConcurrent", (entry) =>
        integer(entry, `${answeringPath}.maximumConcurrent`, 1, 16),
      ),
      ...optional(answering, "brain", (entry) =>
        normalizeAssignedBrain(entry, `${answeringPath}.brain`),
      ),
      ...optional(answering, "localBrain", (entry) =>
        normalizeAssignedBrain(entry, `${answeringPath}.localBrain`),
      ),
    };
  }
  return normalized;
}

function normalizeWorkCoordination(value, roles, workspaceIds) {
  const path = "workCoordination";
  const numericFields = [
    "tickSeconds",
    "intakeLimit",
    "workLimit",
    "dispatchLimit",
    "attentionLimit",
    "proposalLimit",
    "conditionLimit",
    "codeJobLimit",
    "codeJobMemoryLimit",
    "leaseDurationMs",
    "resolveTimeoutMs",
    "decisionTimeoutMs",
    "maxAttempts",
    "retryBaseMs",
    "retryMaxMs",
    "factMaximumAgeMs",
    "codeJobMaximumTurns",
    "codeJobObservationLimit",
  ];
  const config = fields(
    value,
    path,
    ["enabled", ...numericFields, "policy"],
    ["enabled", "policy"],
  );
  const normalized = { enabled: boolean(config.enabled, `${path}.enabled`) };
  for (const name of numericFields) {
    Object.assign(
      normalized,
      optional(config, name, (entry) =>
        integer(entry, `${path}.${name}`, 1, 2 ** 31 - 1),
      ),
    );
  }
  const policyPath = `${path}.policy`;
  const policy = fields(
    config.policy,
    policyPath,
    [
      "version",
      "capabilityRoles",
      "githubReviewRoles",
      "codeActionRoles",
      "codeOperationsByRole",
      "workspaceByRepository",
    ],
    [
      "version",
      "capabilityRoles",
      "githubReviewRoles",
      "codeActionRoles",
      "codeOperationsByRole",
      "workspaceByRepository",
    ],
  );
  const roleReference = (entry, entryPath) => {
    const roleId = safeId(entry, entryPath, SAFE_ROLE_ID);
    if (!roles.has(roleId) && roleId !== "pr-reviewer") throw invalid(entryPath);
    return roleId;
  };
  const capabilityRoles = namedMap(
    policy.capabilityRoles,
    `${policyPath}.capabilityRoles`,
    (entry, entryPath, capability) => {
      if (!CAPABILITIES.has(capability)) throw invalid(entryPath);
      return roleReference(entry, entryPath);
    },
  );
  const githubReviewRoles = uniqueArray(
    policy.githubReviewRoles,
    `${policyPath}.githubReviewRoles`,
    100,
    roleReference,
  );
  const codeActionRoles = uniqueArray(
    policy.codeActionRoles,
    `${policyPath}.codeActionRoles`,
    100,
    roleReference,
  );
  const codeRoleSet = new Set(codeActionRoles);
  const codeOperationsByRole = namedMap(
    policy.codeOperationsByRole,
    `${policyPath}.codeOperationsByRole`,
    (operations, operationsPath, roleId) => {
      if (!codeRoleSet.has(roleId)) throw invalid(operationsPath);
      return uniqueArray(
        operations,
        operationsPath,
        CODE_OPERATIONS.size,
        (operation, operationPath) => {
          const name = text(operation, operationPath, 64);
          if (!CODE_OPERATIONS.has(name)) throw invalid(operationPath);
          return name;
        },
        1,
      );
    },
  );
  const workspaceByRepository = namedMap(
    policy.workspaceByRepository,
    `${policyPath}.workspaceByRepository`,
    (workspace, workspacePath, repository) => {
      text(repository, workspacePath, 256, { pattern: SAFE_REPOSITORY });
      const workspaceId = safeId(workspace, workspacePath);
      if (!workspaceIds.has(workspaceId)) throw invalid(workspacePath);
      return workspaceId;
    },
  );
  normalized.policy = {
    version: integer(policy.version, `${policyPath}.version`, 1, 1_000_000),
    capabilityRoles,
    githubReviewRoles,
    codeActionRoles,
    codeOperationsByRole,
    workspaceByRepository,
  };
  return normalized;
}

function normalizeDingTalk(value) {
  const path = "dingtalk";
  const config = fields(
    value,
    path,
    ["enabled", "selfUserId", "notifyMinimumScore", "maxNotificationsPerRun"],
    ["enabled", "selfUserId", "notifyMinimumScore", "maxNotificationsPerRun"],
  );
  return {
    enabled: boolean(config.enabled, `${path}.enabled`),
    selfUserId: text(config.selfUserId, `${path}.selfUserId`, 128),
    notifyMinimumScore: integer(
      config.notifyMinimumScore,
      `${path}.notifyMinimumScore`,
      0,
      100,
    ),
    maxNotificationsPerRun: integer(
      config.maxNotificationsPerRun,
      `${path}.maxNotificationsPerRun`,
      1,
      1_000,
    ),
  };
}

function assertProviderReferences(document) {
  const providers = new Set(Object.keys(document.brainProviders));
  const references = [
    ["brain.provider", document.brain.provider],
    ...Object.entries(document.employees.roles).map(([id, role]) => [
      `employees.roles.${id}.brain.provider`,
      role.brain.provider,
    ]),
  ];
  if (document.memory.answering) {
    for (const name of ["brain", "localBrain"]) {
      const brain = document.memory.answering[name];
      if (brain) references.push([`memory.answering.${name}.provider`, brain.provider]);
    }
  }
  for (const [path, provider] of references) {
    if (!providers.has(provider)) throw invalid(path, "引用了未知 Provider");
  }
}

function assertRoutingRoleReferences(routing, roles) {
  for (const [ruleIndex, rule] of routing.rules.entries()) {
    for (const [targetIndex, target] of rule.targets.entries()) {
      if (
        target.type === "role" &&
        target.id !== "pr-reviewer" &&
        !roles.has(target.id)
      ) {
        throw invalid(
          `workflowRouting.rules[${ruleIndex}].targets[${targetIndex}].id`,
          "引用了未知岗位",
        );
      }
    }
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function normalizeConfigurationDocument(value) {
  const source = safeDocumentClone(value);
  fields(source, "configuration", TOP_LEVEL_FIELDS, TOP_LEVEL_FIELDS);
  const employees = normalizeEmployees(source.employees);
  const roles = new Set(Object.keys(employees.roles));
  const codeExecutor = normalizeCodeExecutor(source.codeExecutor);
  const workspaceIds = new Set(
    (codeExecutor.workspaces || []).map(({ id }) => id),
  );
  let workflowRouting;
  try {
    workflowRouting = normalizeWorkflowRoutingConfig(source.workflowRouting);
  } catch (cause) {
    throw invalid("workflowRouting", "无效", cause);
  }
  const document = {
    port: integer(source.port, "port", 1, 65_535),
    refreshMinutes: integer(source.refreshMinutes, "refreshMinutes", 1, 24 * 60),
    browserPollSeconds: integer(
      source.browserPollSeconds,
      "browserPollSeconds",
      1,
      24 * 60 * 60,
    ),
    githubLogin: text(source.githubLogin, "githubLogin", 40, {
      pattern: SAFE_GITHUB_LOGIN,
    }),
    trackedRepositories: uniqueArray(
      source.trackedRepositories,
      "trackedRepositories",
      1_000,
      (entry, entryPath) =>
        text(entry, entryPath, 256, { pattern: SAFE_REPOSITORY }),
      0,
    ),
    prResponsibility: (() => {
      const config = fields(
        source.prResponsibility,
        "prResponsibility",
        ["historicalAfterDays"],
        ["historicalAfterDays"],
      );
      return {
        historicalAfterDays: integer(
          config.historicalAfterDays,
          "prResponsibility.historicalAfterDays",
          0,
          10_000,
        ),
      };
    })(),
    codeExecutor,
    changePackages: normalizeChangePackages(source.changePackages),
    githubActions: normalizeGithubActions(source.githubActions),
    workflowRouting,
    workCoordination: normalizeWorkCoordination(
      source.workCoordination,
      roles,
      workspaceIds,
    ),
    memory: normalizeMemory(source.memory),
    brain: normalizeLegacyBrain(source.brain, "brain"),
    brainProviders: namedMap(
      source.brainProviders,
      "brainProviders",
      normalizeProvider,
      { maximum: 100 },
    ),
    employees,
    dingtalk: normalizeDingTalk(source.dingtalk),
  };
  assertProviderReferences(document);
  assertRoutingRoleReferences(document.workflowRouting, roles);
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_DOCUMENT_BYTES) {
    throw invalid("configuration", "超过容量上限");
  }
  return deepFreeze(document);
}

export function createSafeDisabledConfiguration(value) {
  const safe = structuredClone(normalizeConfigurationDocument(value));
  safe.trackedRepositories = [];
  safe.brain.enabled = false;
  safe.codeExecutor.enabled = false;
  safe.changePackages.enabled = false;
  safe.githubActions.enabled = false;
  safe.workflowRouting.enabled = false;
  safe.workCoordination.enabled = false;
  safe.memory.imports = { localSessions: false, git: false };
  if (safe.memory.answering) safe.memory.answering.enabled = false;
  safe.employees.prReviewer.enabled = false;
  safe.employees.prReviewer.initialPaused = true;
  for (const role of Object.values(safe.employees.roles)) {
    role.enabled = false;
    role.initialPaused = true;
  }
  safe.dingtalk.enabled = false;
  return normalizeConfigurationDocument(safe);
}

function digestNormalized(document) {
  return canonicalJsonDigest(document);
}

export function configurationDocumentDigest(value) {
  return digestNormalized(normalizeConfigurationDocument(value));
}

function equalValue(left, right) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function collectChanges(before, after, path = "", changes = []) {
  if (equalValue(before, after)) return changes;
  if (
    before === undefined ||
    after === undefined ||
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    changes.push({ path, before, after });
    return changes;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
  for (const key of keys) {
    collectChanges(
      before[key],
      after[key],
      path ? `${path}.${key}` : key,
      changes,
    );
  }
  return changes;
}

function setDirection(before, after) {
  const previous = new Set(before || []);
  const next = new Set(after || []);
  return {
    removed: [...previous].some((value) => !next.has(value)),
    added: [...next].some((value) => !previous.has(value)),
  };
}

function authorityDirection(change) {
  const { path, before, after } = change;
  const providerIdentity =
    path.startsWith("brainProviders.") &&
    (
      /\.(?:kind|baseUrl|apiKeyEnv|protocol|remote)$/.test(
        path,
      ) ||
      before?.kind !== undefined ||
      after?.kind !== undefined
    );
  if (providerIdentity) {
    return {
      tightening: before !== undefined,
      expansion: after !== undefined,
    };
  }
  if (
    path === "brain.provider" ||
    /\.(?:brain|localBrain)\.provider$/.test(path)
  ) {
    return {
      tightening: before !== undefined && before !== after,
      expansion: after !== undefined && before !== after,
    };
  }
  if (path === "trackedRepositories") {
    const direction = setDirection(before, after);
    return { tightening: direction.removed, expansion: direction.added };
  }
  if (
    path.includes(".remoteData.") ||
    /^(?:githubActions|codeExecutor|changePackages)\.enabled$/.test(path) ||
    /^employees\.roles\.[^.]+\.enabled$/.test(path) ||
    path === "employees.prReviewer.allowRemoteCodeContext"
  ) {
    return {
      tightening: before === true && after === false,
      expansion: before === false && after === true,
    };
  }
  if (
    path.endsWith(".permissions.allowedIntents") ||
    path === "workCoordination.policy.githubReviewRoles" ||
    path === "workCoordination.policy.codeActionRoles" ||
    path.includes(".codeOperationsByRole.") ||
    path.endsWith(".writablePaths")
  ) {
    const direction = setDirection(before, after);
    return { tightening: direction.removed, expansion: direction.added };
  }
  if (path.endsWith(".excludePaths")) {
    const direction = setDirection(before, after);
    return { tightening: direction.added, expansion: direction.removed };
  }
  if (path.startsWith("workCoordination.policy.workspaceByRepository.")) {
    return {
      tightening: before !== undefined,
      expansion: after !== undefined,
    };
  }
  if (/^employees\.roles\.[^.]+$/.test(path)) {
    return {
      tightening: before !== undefined && after === undefined,
      expansion: before === undefined && after !== undefined,
    };
  }
  return { tightening: false, expansion: false };
}

function requiresRestart(path) {
  return (
    path === "port" ||
    path === "githubLogin" ||
    path.startsWith("brainProviders.") ||
    path.startsWith("codeExecutor.") ||
    path.startsWith("changePackages.") ||
    path === "githubActions.enabled" ||
    path.startsWith("githubActions.actorAccountId") ||
    path.startsWith("githubActions.tokenEnv") ||
    path.startsWith("githubActions.ghCommand") ||
    path.startsWith("githubActions.networkEnv")
  );
}

export function configurationDocumentImpact(beforeValue, afterValue) {
  const before = normalizeConfigurationDocument(beforeValue);
  const after = normalizeConfigurationDocument(afterValue);
  const beforeDigest = digestNormalized(before);
  const afterDigest = digestNormalized(after);
  const categories = {
    security_tightening: new Set(),
    authority_expansion: new Set(),
    benign_claim_change: new Set(),
    restart_required: new Set(),
  };
  for (const change of collectChanges(before, after)) {
    const direction = authorityDirection(change);
    const restart = requiresRestart(change.path);
    if (direction.tightening) categories.security_tightening.add(change.path);
    if (direction.expansion) categories.authority_expansion.add(change.path);
    if (restart) categories.restart_required.add(change.path);
    if (!direction.tightening && !direction.expansion && !restart) {
      categories.benign_claim_change.add(change.path);
    }
  }
  const sorted = (values) =>
    [...values].sort((left, right) => left.localeCompare(right, "en"));
  return deepFreeze({
    changed: beforeDigest !== afterDigest,
    beforeDigest,
    afterDigest,
    security_tightening: sorted(categories.security_tightening),
    authority_expansion: sorted(categories.authority_expansion),
    benign_claim_change: sorted(categories.benign_claim_change),
    restart_required: sorted(categories.restart_required),
  });
}
