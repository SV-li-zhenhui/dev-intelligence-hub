const SAFE_KIND = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const UNKNOWN_EXECUTOR_RESULT = Object.freeze({
  status: "error",
  error: Object.freeze({
    code: "CONFIRMATION_EXECUTOR_NOT_CONFIGURED",
    trust: "unknown",
  }),
});

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function executorEntries(value) {
  if (!isPlainRecord(value)) {
    throw new TypeError("executors must be a plain data record");
  }
  const entries = [];
  for (const kind of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, kind);
    if (
      typeof kind !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("executors must be a plain data record");
    }
    if (!SAFE_KIND.test(kind)) {
      throw new TypeError("confirmation executor kind is invalid");
    }
    entries.push([kind, descriptor.value]);
  }
  return entries;
}

function methodDescriptor(value, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  let owner = value;
  while (
    owner !== null &&
    owner !== Object.prototype &&
    owner !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function normalizeExecutor(kind, value) {
  const execute = methodDescriptor(value, "execute");
  const reconcile = methodDescriptor(value, "reconcile");
  if (
    !execute ||
    !("value" in execute) ||
    typeof execute.value !== "function" ||
    !reconcile ||
    !("value" in reconcile) ||
    typeof reconcile.value !== "function"
  ) {
    throw new TypeError(
      `executor for ${kind} must provide execute and reconcile`,
    );
  }
  return Object.freeze({
    receiver: value,
    execute: execute.value,
    reconcile: reconcile.value,
  });
}

function normalizeExecutors(value) {
  return new Map(
    executorEntries(value).map(([kind, executor]) => [
      kind,
      normalizeExecutor(kind, executor),
    ]),
  );
}

function routeKind(value) {
  if (value === null || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  return descriptor?.enumerable && "value" in descriptor
    ? descriptor.value
    : null;
}

export class ConfirmationExecutorRouter {
  #executors;

  constructor({ executors } = {}) {
    this.#executors = normalizeExecutors(executors);
    Object.freeze(this);
  }

  execute(...args) {
    return this.#invoke("execute", args);
  }

  reconcile(...args) {
    return this.#invoke("reconcile", args);
  }

  #invoke(method, args) {
    const executor = this.#executors.get(routeKind(args[0]));
    if (!executor) return UNKNOWN_EXECUTOR_RESULT;
    return Reflect.apply(executor[method], executor.receiver, args);
  }
}
