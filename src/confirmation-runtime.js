import path from "node:path";
import { createGitHubActionExecutor } from "./adapters/github-action-adapter.js";
import { projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { StateStore } from "./lib/state-store.js";
import { ConfirmationQueue } from "./services/confirmation-queue.js";

const GUARD_NAME = "mydashboard-confirmation-queue-v1";
const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const TOKEN_VALUE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const NETWORK_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
const USER_QUEUE_METHODS = [
  "next",
  "get",
  "approve",
  "retry",
  "reject",
];
const PRODUCER_QUEUE_METHODS = ["enqueue", "get", "invalidate"];
const GITHUB_ACTION_CONFIG_KEYS = new Set([
  "enabled",
  "actorAccountId",
  "tokenEnv",
  "ghCommand",
  "networkEnv",
  "timeoutMs",
]);

export class ConfirmationRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfirmationRuntimeError";
    this.code = code;
  }
}

function invalidConfig(message = "外部确认运行配置无效") {
  return new ConfirmationRuntimeError(
    "INVALID_CONFIRMATION_RUNTIME_CONFIG",
    message,
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record, name) {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) throw invalidConfig();
  return descriptor.value;
}

function normalizeNetworkEnv(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value)) throw invalidConfig("GitHub 网络环境配置无效");

  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !NETWORK_ENV_KEYS.has(key)) {
      throw invalidConfig("GitHub 网络环境包含不受支持的变量");
    }
    const entry = dataProperty(value, key);
    if (
      typeof entry !== "string" ||
      INVALID_CONTROL.test(entry) ||
      Buffer.byteLength(entry, "utf8") > 4_096
    ) {
      throw invalidConfig("GitHub 网络环境变量值无效");
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function configuredToken(environment, name) {
  if (!environment || typeof environment !== "object") {
    throw invalidConfig("运行环境无效");
  }
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !TOKEN_VALUE.test(descriptor.value)
  ) {
    throw invalidConfig(`环境变量 ${name} 未提供有效的 GitHub 凭据`);
  }
  return descriptor.value;
}

function normalizeEnabledConfig(config) {
  if (!isPlainRecord(config)) throw invalidConfig();
  const githubActions = dataProperty(config, "githubActions");
  if (githubActions === undefined) return null;
  if (!isPlainRecord(githubActions)) throw invalidConfig();

  if (
    Reflect.ownKeys(githubActions).some(
      (key) => typeof key !== "string" || !GITHUB_ACTION_CONFIG_KEYS.has(key),
    )
  ) {
    throw invalidConfig(
      "GitHub 动作配置包含不受支持的字段；凭据只能通过 tokenEnv 提供",
    );
  }

  const enabled = dataProperty(githubActions, "enabled");
  if (enabled === false || enabled === undefined) return null;
  if (enabled !== true) throw invalidConfig();

  const actorAccountId = dataProperty(githubActions, "actorAccountId");
  if (
    typeof actorAccountId !== "string" ||
    !GITHUB_LOGIN.test(actorAccountId)
  ) {
    throw invalidConfig("GitHub 写入账号无效");
  }

  const tokenEnv = dataProperty(githubActions, "tokenEnv");
  if (
    typeof tokenEnv !== "string" ||
    !TOKEN_ENV_NAME.test(tokenEnv) ||
    tokenEnv === "__PROTO__"
  ) {
    throw invalidConfig("GitHub 凭据环境变量名无效");
  }
  const ghCommand = dataProperty(githubActions, "ghCommand");
  if (
    typeof ghCommand !== "string" ||
    !path.isAbsolute(ghCommand) ||
    INVALID_CONTROL.test(ghCommand) ||
    Buffer.byteLength(ghCommand, "utf8") > 1_024
  ) {
    throw invalidConfig("ghCommand 必须是显式绝对路径");
  }
  const timeoutMs = dataProperty(githubActions, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000)
  ) {
    throw invalidConfig("GitHub 动作超时时间无效");
  }

  return Object.freeze({
    actorAccountId,
    ghCommand,
    tokenEnv,
    networkEnv: normalizeNetworkEnv(dataProperty(githubActions, "networkEnv")),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function validateDependencies(dependencies) {
  if (!isPlainRecord(dependencies)) {
    throw new TypeError("dependencies must be a plain object");
  }
  const defaults = {
    createExecutor: createGitHubActionExecutor,
    createGuard: (options) => new ProcessExclusiveGuard(options),
    createOperationQueue: () => new OperationQueue(),
    createQueue: (options) => new ConfirmationQueue(options),
    createStore: (dataDirectory) => new StateStore(dataDirectory),
  };
  const result = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const configuredFactory = dataProperty(dependencies, name);
    const candidate =
      configuredFactory === undefined ? fallback : configuredFactory;
    if (typeof candidate !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
    result[name] = candidate;
  }
  return result;
}

function runtimeDataDirectory(dependencies) {
  const value = dataProperty(dependencies, "dataDirectory");
  if (value === undefined) return path.join(projectRoot, "data");
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw invalidConfig("确认队列数据目录必须是绝对路径");
  }
  return path.resolve(value);
}

function assertPort(value, methods, name) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  return value;
}

function createQueueFacade(queue, methods) {
  const facade = {};
  for (const method of methods) {
    const delegate = queue[method].bind(queue);
    facade[method] = (...args) => delegate(...args);
  }
  return Object.freeze(facade);
}

function closeOnce(guard) {
  let result;
  return () => {
    if (!result) result = Promise.resolve().then(() => guard.close());
    return result;
  };
}

export async function createConfirmationRuntime(config, dependencies = {}) {
  const enabledConfig = normalizeEnabledConfig(config);
  if (!enabledConfig) return null;

  const factories = validateDependencies(dependencies);
  const configuredEnvironment = dataProperty(dependencies, "env");
  const environment =
    configuredEnvironment === undefined ? process.env : configuredEnvironment;
  const token = configuredToken(environment, enabledConfig.tokenEnv);
  const dataDirectory = runtimeDataDirectory(dependencies);
  const configuredStore = dataProperty(dependencies, "store");
  const store = assertPort(
    configuredStore === undefined
      ? factories.createStore(dataDirectory)
      : configuredStore,
    ["read", "write"],
    "store",
  );
  const operationQueue = assertPort(
    factories.createOperationQueue(),
    ["enqueue"],
    "operationQueue",
  );
  const executor = assertPort(
    factories.createExecutor({
      ghCommand: enabledConfig.ghCommand,
      token,
      env: environment,
      networkEnv: enabledConfig.networkEnv,
      ...(enabledConfig.timeoutMs === undefined
        ? {}
        : { timeoutMs: enabledConfig.timeoutMs }),
    }),
    ["execute", "reconcile"],
    "executor",
  );
  const guard = assertPort(
    factories.createGuard({ name: GUARD_NAME }),
    ["acquire", "run", "close"],
    "guard",
  );
  const close = closeOnce(guard);

  try {
    const queue = assertPort(
      factories.createQueue({
        store,
        executor,
        operationQueue,
        exclusiveLease: guard,
      }),
      [
        "recover",
        ...new Set([...USER_QUEUE_METHODS, ...PRODUCER_QUEUE_METHODS]),
      ],
      "queue",
    );
    await guard.acquire();
    await queue.recover();
    return Object.freeze({
      queue: createQueueFacade(queue, USER_QUEUE_METHODS),
      producerQueue: createQueueFacade(queue, PRODUCER_QUEUE_METHODS),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup error; the operating-system guard still fails closed.
    }
    throw error;
  }
}
