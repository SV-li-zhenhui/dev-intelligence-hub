import { types } from "node:util";

const INPUT_FIELDS = Object.freeze([
  "itemId",
  "expectedRevision",
  "expectedInputDigest",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function retryError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function invalidInput() {
  return retryError(
    "OWNER_WORK_RETRY_INVALID",
    "所有者决策重试请求无效",
    400,
  );
}

function ineligible() {
  return retryError(
    "OWNER_WORK_RETRY_INELIGIBLE",
    "工作项不允许执行所有者决策重试",
    409,
  );
}

function dataFields(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactInput(value) {
  let fields;
  try {
    fields = dataFields(value);
  } catch {
    throw invalidInput();
  }
  if (
    !fields ||
    fields.size !== INPUT_FIELDS.length ||
    INPUT_FIELDS.some((field) => !fields.has(field))
  ) {
    throw invalidInput();
  }
  const itemId = fields.get("itemId");
  const expectedRevision = fields.get("expectedRevision");
  const expectedInputDigest = fields.get("expectedInputDigest");
  if (
    typeof itemId !== "string" ||
    !itemId.trim() ||
    CONTROL_CHARACTERS.test(itemId) ||
    Buffer.byteLength(itemId, "utf8") > 192 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    typeof expectedInputDigest !== "string" ||
    !SHA256.test(expectedInputDigest)
  ) {
    throw invalidInput();
  }
  return { itemId, expectedRevision, expectedInputDigest };
}

function required(fields, field) {
  if (!fields.has(field)) throw ineligible();
  return fields.get(field);
}

function plainArray(value) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw ineligible();
  }
  return value.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw ineligible();
    return descriptor.value;
  });
}

function sourceIsCurrentlyBound(rawSource, itemInputDigest) {
  const source = dataFields(rawSource);
  if (!source || required(source, "kind") !== "pull_request") return false;
  const inputRevision = required(source, "inputRevision");
  const activeRevision = required(source, "activeRevision");
  if (
    !Number.isSafeInteger(inputRevision) ||
    inputRevision < 1 ||
    activeRevision !== inputRevision ||
    required(source, "pendingRevision") !== null ||
    required(source, "pending") !== null
  ) {
    return false;
  }

  const current = dataFields(required(source, "current"));
  if (!current) return false;
  const eventId = required(current, "eventId");
  if (
    typeof eventId !== "string" ||
    !eventId.trim() ||
    Buffer.byteLength(eventId, "utf8") > 192 ||
    required(current, "inputDigest") !== itemInputDigest
  ) {
    return false;
  }
  const event = dataFields(required(current, "event"));
  if (!event || required(event, "eventId") !== eventId) return false;

  return plainArray(required(source, "bindings")).some((rawBinding) => {
    const binding = dataFields(rawBinding);
    return Boolean(
      binding &&
      required(binding, "eventId") === eventId &&
      required(binding, "inputRevision") === activeRevision,
    );
  });
}

function eligibleItem(value, input) {
  let item;
  try {
    item = dataFields(value);
    if (!item) throw ineligible();
    const itemId = required(item, "itemId");
    const revision = required(item, "revision");
    const inputDigest = required(item, "inputDigest");
    if (
      itemId !== input.itemId ||
      revision !== input.expectedRevision ||
      inputDigest !== input.expectedInputDigest
    ) {
      throw retryError(
        "OWNER_WORK_RETRY_STALE",
        "工作项 revision 或输入绑定已变化",
        409,
      );
    }
    if (
      !SHA256.test(inputDigest) ||
      required(item, "kind") !== "source_root" ||
      required(item, "status") !== "blocked" ||
      required(item, "statusReason") !== "decision_attempts_exhausted" ||
      required(item, "ownerId") !== null ||
      required(item, "leaseId") !== null ||
      required(item, "leaseUntil") !== null ||
      required(item, "activeIntentId") !== null ||
      required(item, "decisionContext") !== null ||
      required(item, "sourceQuarantine") !== null ||
      !sourceIsCurrentlyBound(required(item, "source"), inputDigest)
    ) {
      throw ineligible();
    }
    const attempt = required(item, "attempt");
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw ineligible();
    return { attempt };
  } catch (error) {
    if (error?.code?.startsWith("OWNER_WORK_RETRY_")) throw error;
    throw ineligible();
  }
}

function checkedTransitionResult(value, input, expectedAttempt) {
  try {
    const result = dataFields(value);
    if (
      !result ||
      required(result, "itemId") !== input.itemId ||
      required(result, "inputDigest") !== input.expectedInputDigest ||
      required(result, "status") !== "queued" ||
      required(result, "revision") !== input.expectedRevision + 1 ||
      required(result, "ownerId") !== null ||
      required(result, "leaseId") !== null ||
      required(result, "leaseUntil") !== null ||
      required(result, "activeIntentId") !== null ||
      required(result, "decisionContext") !== null ||
      required(result, "attempt") !== expectedAttempt
    ) {
      throw new Error("invalid transition result");
    }
    return structuredClone(value);
  } catch {
    throw retryError(
      "OWNER_WORK_RETRY_RESULT_INVALID",
      "所有者决策重试结果无效",
      500,
    );
  }
}

export class OwnerWorkRetryService {
  #readItem;
  #transition;

  constructor({ ledger } = {}) {
    if (
      !ledger ||
      typeof ledger.readItemForReconciliation !== "function" ||
      typeof ledger.transition !== "function"
    ) {
      throw new TypeError(
        "OwnerWorkRetryService requires readItemForReconciliation and transition",
      );
    }
    this.#readItem = ledger.readItemForReconciliation.bind(ledger);
    this.#transition = ledger.transition.bind(ledger);
  }

  async retryDecisionExhaustion(rawInput) {
    const input = exactInput(rawInput);
    const item = await this.#readItem({ itemId: input.itemId });
    if (item === null) {
      throw retryError(
        "OWNER_WORK_RETRY_NOT_FOUND",
        "工作项不存在",
        404,
      );
    }
    const { attempt } = eligibleItem(item, input);
    const result = await this.#transition({
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      leaseId: null,
      toStatus: "queued",
      actorId: "owner:local",
      reason: "owner_retry_decision_exhaustion",
      details: { code: "decision_attempts_exhausted" },
    });
    return checkedTransitionResult(result, input, attempt);
  }
}
