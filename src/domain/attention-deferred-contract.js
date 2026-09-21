export const MAX_DEFERRED_ATTENTION_ITEMS = 32;

const EXTERNAL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const INTERNAL_ID = /^attention-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class AttentionDeferredError extends Error {
  constructor(message = "稍后处理列表无效") {
    super(message);
    this.name = "AttentionDeferredError";
    this.code = "INVALID_ATTENTION_DEFERRED";
    this.statusCode = 400;
  }
}

function invalidDeferred(message) {
  return new AttentionDeferredError(message);
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function allowedData(value, allowed, error) {
  const entries = dataEntries(value, error);
  if (entries.some(([key]) => !allowed.includes(key))) throw error;
  return new Map(entries);
}

function exactData(value, expected, error) {
  const entries = dataEntries(value, error);
  const keys = entries.map(([key]) => key);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return new Map(entries);
}

function arrayValues(value, maximumLength, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function exactText(value, pattern, error) {
  if (typeof value !== "string" || !pattern.test(value)) throw error;
  return value;
}

function externalEntry(value, error) {
  const entries = exactData(
    value,
    ["id", "approvalBindingDigest"],
    error,
  );
  return {
    id: exactText(entries.get("id"), EXTERNAL_ID, error),
    approvalBindingDigest: exactText(
      entries.get("approvalBindingDigest"),
      SHA256,
      error,
    ),
  };
}

function internalEntry(value, error) {
  const entries = exactData(value, ["requestId", "contentDigest"], error);
  return {
    requestId: exactText(entries.get("requestId"), INTERNAL_ID, error),
    contentDigest: exactText(entries.get("contentDigest"), SHA256, error),
  };
}

function normalizeEntries(value, normalizeEntry, bindingKey, error) {
  const entries = arrayValues(value, MAX_DEFERRED_ATTENTION_ITEMS, error).map(
    (entry) => normalizeEntry(entry, error),
  );
  const bindings = new Set();
  for (const entry of entries) {
    const key = bindingKey(entry);
    if (bindings.has(key)) throw error;
    bindings.add(key);
  }
  return entries;
}

function normalizeSourceOptions(value, normalizeEntry, bindingKey) {
  const error = invalidDeferred("稍后处理绑定列表无效");
  const options = value === undefined ? {} : value;
  const entries = allowedData(options, ["deferred"], error);
  return {
    deferred: entries.has("deferred")
      ? normalizeEntries(
          entries.get("deferred"),
          normalizeEntry,
          bindingKey,
          error,
        )
      : [],
  };
}

export function normalizeExternalDeferredOptions(value) {
  return normalizeSourceOptions(
    value,
    externalEntry,
    (entry) => `${entry.id}\u0000${entry.approvalBindingDigest}`,
  );
}

export function normalizeInternalDeferredOptions(value) {
  return normalizeSourceOptions(
    value,
    internalEntry,
    (entry) => `${entry.requestId}\u0000${entry.contentDigest}`,
  );
}

export function normalizeUnifiedDeferredOptions(value) {
  const error = invalidDeferred("统一稍后处理列表无效");
  const options = value === undefined ? {} : value;
  const entries = allowedData(options, ["external", "internal"], error);
  const external = normalizeEntries(
    entries.get("external") ?? [],
    externalEntry,
    (entry) => `${entry.id}\u0000${entry.approvalBindingDigest}`,
    error,
  );
  const internal = normalizeEntries(
    entries.get("internal") ?? [],
    internalEntry,
    (entry) => `${entry.requestId}\u0000${entry.contentDigest}`,
    error,
  );
  if (external.length + internal.length > MAX_DEFERRED_ATTENTION_ITEMS) {
    throw error;
  }
  return { external, internal };
}
