import { randomBytes } from "node:crypto";

const MODES = new Set(["open", "closing", "closed"]);
const TOKEN = /^quiescence-[a-f0-9]{64}$/u;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000;

export class OperationalQuiescenceError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = "OperationalQuiescenceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function unavailable(mode) {
  return new OperationalQuiescenceError(
    "SYSTEM_QUIESCING",
    mode === "closed" ? "系统正在执行一致性维护" : "系统正在排空运行中操作",
  );
}

function invalidToken() {
  return new OperationalQuiescenceError(
    "QUIESCENCE_TOKEN_INVALID",
    "全局维护令牌无效",
    409,
  );
}

export class OperationalQuiescenceGate {
  #mode = "open";
  #activeOperations = 0;
  #token = null;
  #drainPromise = null;
  #resolveDrain = null;
  #drainTimeoutMs;

  constructor({ drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
    if (
      !Number.isSafeInteger(drainTimeoutMs) ||
      drainTimeoutMs < 1 ||
      drainTimeoutMs > MAX_DRAIN_TIMEOUT_MS
    ) {
      throw new TypeError("drainTimeoutMs must be a bounded positive integer");
    }
    this.#drainTimeoutMs = drainTimeoutMs;
    Object.freeze(this);
  }

  readStatus() {
    if (!MODES.has(this.#mode)) throw new TypeError("quiescence mode is invalid");
    return Object.freeze({
      mode: this.#mode,
      activeOperations: this.#activeOperations,
    });
  }

  async run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    if (this.#mode !== "open") throw unavailable(this.#mode);
    this.#activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0 && this.#resolveDrain !== null) {
        const resolve = this.#resolveDrain;
        this.#resolveDrain = null;
        this.#drainPromise = null;
        resolve();
      }
    }
  }

  async enter() {
    if (this.#mode !== "open") {
      throw new OperationalQuiescenceError(
        "QUIESCENCE_ALREADY_ACTIVE",
        "全局维护已经开始",
        409,
      );
    }
    this.#mode = "closing";
    if (this.#activeOperations > 0) {
      let rejectDrain;
      const drainPromise = new Promise((resolve, reject) => {
        this.#resolveDrain = resolve;
        rejectDrain = reject;
      });
      this.#drainPromise = drainPromise;
      const timeout = setTimeout(() => {
        if (this.#mode !== "closing" || this.#drainPromise !== drainPromise) {
          return;
        }
        this.#mode = "open";
        this.#resolveDrain = null;
        this.#drainPromise = null;
        rejectDrain(new OperationalQuiescenceError(
          "QUIESCENCE_DRAIN_TIMEOUT",
          "系统未能在期限内排空运行中操作",
        ));
      }, this.#drainTimeoutMs);
      try {
        await drainPromise;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.#token = `quiescence-${randomBytes(32).toString("hex")}`;
    this.#mode = "closed";
    return this.#token;
  }

  leave(token) {
    if (this.#mode !== "closed" || typeof token !== "string" ||
        !TOKEN.test(token) || token !== this.#token) {
      throw invalidToken();
    }
    this.#token = null;
    this.#mode = "open";
    return this.readStatus();
  }
}
