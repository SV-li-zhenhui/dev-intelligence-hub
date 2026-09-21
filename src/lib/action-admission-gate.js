import { OperationQueue } from "./operation-queue.js";

const CONFIGURATION_DIGEST = /^[a-f0-9]{64}$/;
const ADMISSION_MODES = new Set(["ready"]);
const CUTOVER_MODES = new Set(["boot_safe", "ready"]);
const RECONCILIATION_MODES = new Set([
  "boot_safe",
  "ready",
  "restart_required",
  "unknown",
]);

export class ActionAdmissionGateError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ActionAdmissionGateError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function blocked(mode) {
  if (mode === "restart_required") {
    return new ActionAdmissionGateError(
      "RUNTIME_RESTART_REQUIRED",
      "活动配置已更新，必须重启服务后才能接纳新动作",
      409,
    );
  }
  if (mode === "boot_safe") {
    return new ActionAdmissionGateError(
      "RUNTIME_CONFIGURATION_NOT_READY",
      "版本化配置尚未初始化，当前运行时不能接纳普通动作",
      503,
    );
  }
  return new ActionAdmissionGateError(
    "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
    "运行时配置状态无法确认，重启并完成恢复前不能接纳新动作",
    503,
  );
}

function cutoverProtocolError() {
  return new ActionAdmissionGateError(
    "RUNTIME_CUTOVER_PROTOCOL_ERROR",
    "配置切换没有报告可信的持久化结果",
    503,
  );
}

function normalizeBinding(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("configuration binding is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("configurationDigest")
  ) {
    throw new TypeError("configuration binding is invalid");
  }
  const version = Object.getOwnPropertyDescriptor(value, "version");
  const digest = Object.getOwnPropertyDescriptor(value, "configurationDigest");
  if (
    !version?.enumerable ||
    !("value" in version) ||
    !Number.isSafeInteger(version.value) ||
    version.value < 1 ||
    !digest?.enumerable ||
    !("value" in digest) ||
    typeof digest.value !== "string" ||
    !CONFIGURATION_DIGEST.test(digest.value)
  ) {
    throw new TypeError("configuration binding is invalid");
  }
  return Object.freeze({
    version: version.value,
    configurationDigest: digest.value,
  });
}

function sameBinding(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.version === right.version &&
      left.configurationDigest === right.configurationDigest)
  );
}

function resolvedMode(storedActive, runtimeEffective) {
  if (storedActive === null && runtimeEffective === null) return "boot_safe";
  if (sameBinding(storedActive, runtimeEffective)) return "ready";
  if (storedActive !== null && runtimeEffective !== null) {
    return "restart_required";
  }
  return "unknown";
}

export class ActionAdmissionGate {
  #queue;
  #mode = "unbound";
  #storedActive = null;
  #runtimeEffective = null;

  constructor({ operationQueue = new OperationQueue() } = {}) {
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("action admission operationQueue is invalid");
    }
    this.#queue = operationQueue;
    Object.freeze(this);
  }

  bindEffective(value) {
    if (this.#mode !== "unbound") {
      throw new TypeError("runtime configuration is already bound");
    }
    const binding = normalizeBinding(value, { nullable: true });
    this.#storedActive = binding;
    this.#runtimeEffective = binding;
    this.#mode = binding === null ? "boot_safe" : "ready";
    return this.readStatus();
  }

  readStatus() {
    return Object.freeze({
      mode: this.#mode,
      storedActive: this.#storedActive,
      runtimeEffective: this.#runtimeEffective,
    });
  }

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("action admission operation must be a function");
    }
    return this.#queue.enqueue(() => {
      if (!ADMISSION_MODES.has(this.#mode)) throw blocked(this.#mode);
      return operation();
    });
  }

  cutover(operation) {
    return this.#runCutover(operation, CUTOVER_MODES);
  }

  reconcileCutover(operation) {
    return this.#runCutover(operation, RECONCILIATION_MODES);
  }

  #runCutover(operation, allowedModes) {
    if (typeof operation !== "function") {
      throw new TypeError("configuration cutover operation must be a function");
    }
    return this.#queue.enqueue(async () => {
      if (!allowedModes.has(this.#mode)) throw blocked(this.#mode);
      const previousStoredActive = this.#storedActive;
      this.#mode = "cutover";
      let acceptingSettlement = true;
      let settlement = null;
      let committedBinding = null;
      const settle = (decision, binding = null) => {
        if (!acceptingSettlement || settlement !== null) {
          throw new TypeError("configuration cutover is already settled");
        }
        settlement = decision;
        committedBinding = binding;
      };
      const control = Object.freeze({
        commit: (binding) => settle("commit", normalizeBinding(binding)),
        abort: () => settle("abort"),
        markUnknown: () => settle("unknown"),
      });

      let result;
      let operationError = null;
      try {
        result = await operation(control);
      } catch (error) {
        operationError = error;
      } finally {
        acceptingSettlement = false;
      }

      const missingSettlement = settlement === null;
      if (missingSettlement) settlement = "unknown";
      if (settlement === "commit") {
        this.#storedActive = committedBinding;
        this.#mode = sameBinding(committedBinding, this.#runtimeEffective)
          ? "ready"
          : "restart_required";
      } else if (settlement === "abort") {
        this.#storedActive = previousStoredActive;
        this.#mode = resolvedMode(this.#storedActive, this.#runtimeEffective);
      } else {
        this.#mode = "unknown";
      }

      if (operationError) throw operationError;
      if (missingSettlement) throw cutoverProtocolError();
      return result;
    });
  }
}
