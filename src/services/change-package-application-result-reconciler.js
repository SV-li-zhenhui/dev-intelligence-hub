import { digestValue } from "../domain/code-executor-contract.js";

const MAX_ITEMS = 1_000;
const MAX_BARRIER_CYCLES = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const CONFIRMATION_ID = /^confirmation-change-package-apply-[a-f0-9]{64}$/;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const RECEIPT_ID = /^change-package-application-[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SOURCE_ITEM_KEYS = Object.freeze([
  "confirmationId",
  "approvalBindingDigest",
  "requestedBy",
  "job",
  "packageId",
  "packageDigest",
  "workspaceId",
  "itemRevision",
  "createdAt",
  "updatedAt",
  "queueStatus",
  "executionOutcome",
  "receipt",
  "failure",
  "rejectedAt",
]);
const QUEUE_STATUSES = new Set([
  "pending",
  "executing",
  "rejected",
  "stale",
  "failed",
  "completed",
]);
const STATUS_PROJECTION = new Map([
  ["pending", "pending"],
  ["executing", "applying"],
  ["rejected", "rejected"],
  ["stale", "stale"],
  ["failed", "failed"],
]);
const EMPTY_SOURCE_DIGEST = digestValue({ sourceRevision: 0, items: [] });

export class ChangePackageApplicationResultReconcilerError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "ChangePackageApplicationResultReconcilerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function reconcilerError(code, message, statusCode = 502) {
  return new ChangePackageApplicationResultReconcilerError(
    code,
    message,
    statusCode,
  );
}

function invalidSource() {
  return reconcilerError(
    "CHANGE_PACKAGE_APPLICATION_RESULT_SOURCE_INVALID",
    "变更包应用结果来源无效",
  );
}

function invalidResult() {
  return reconcilerError(
    "CHANGE_PACKAGE_APPLICATION_RESULT_INVALID",
    "变更包应用核验结果无效",
  );
}

function resultUnavailable() {
  return reconcilerError(
    "CHANGE_PACKAGE_APPLICATION_RESULT_UNAVAILABLE",
    "变更包应用核验结果暂不可用",
    503,
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function objectFields(value, expected, error) {
  if (!isPlainObject(value)) throw error;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw error;
  }
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    fields.set(key, descriptor.value);
  }
  return fields;
}

function arrayValues(value, maximum, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value, maximumBytes, pattern, error) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

function safeInteger(value, minimum, error) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw error;
  }
  return value;
}

function timestamp(value, error) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw error;
  }
  return value;
}

function normalizeRequestedBy(value, error) {
  const fields = objectFields(value, ["roleId", "workItemId"], error);
  return {
    roleId: boundedText(fields.get("roleId"), 128, SAFE_ID, error),
    workItemId: boundedText(fields.get("workItemId"), 256, null, error),
  };
}

function normalizeJob(value, error) {
  const fields = objectFields(value, ["id", "revision", "recordDigest"], error);
  return {
    id: boundedText(fields.get("id"), 128, SAFE_ID, error),
    revision: safeInteger(fields.get("revision"), 1, error),
    recordDigest: boundedText(fields.get("recordDigest"), 64, SHA256, error),
  };
}

function expectedReceiptId(confirmationId, approvalBindingDigest) {
  return `change-package-application-${digestValue({
    confirmationId,
    approvalBindingDigest,
  })}`;
}

function normalizeReceipt(value, confirmationId, approvalBindingDigest, error) {
  if (value === null) return null;
  const fields = objectFields(value, ["id", "createdAt"], error);
  const id = boundedText(fields.get("id"), 91, RECEIPT_ID, error);
  if (id !== expectedReceiptId(confirmationId, approvalBindingDigest)) {
    throw error;
  }
  return { id, createdAt: timestamp(fields.get("createdAt"), error) };
}

function normalizeFailure(value, error) {
  if (value === null) return null;
  const fields = objectFields(
    value,
    ["code", "outcome", "retryable", "at"],
    error,
  );
  const code = boundedText(fields.get("code"), 64, ERROR_CODE, error);
  const outcome = fields.get("outcome");
  const retryable = fields.get("retryable");
  if (
    !new Set(["absent", "unknown"]).has(outcome) ||
    typeof retryable !== "boolean" ||
    retryable !== (outcome === "absent")
  ) {
    throw error;
  }
  return { code, outcome, retryable, at: timestamp(fields.get("at"), error) };
}

function validQueueState(item, error) {
  const {
    queueStatus,
    executionOutcome,
    receipt,
    failure,
    rejectedAt,
    updatedAt,
  } = item;
  if (queueStatus === "pending") {
    if (
      executionOutcome !== null ||
      receipt !== null ||
      failure !== null ||
      rejectedAt !== null
    ) throw error;
    return;
  }
  if (queueStatus === "executing") {
    if (
      executionOutcome !== "unknown" ||
      receipt !== null ||
      failure !== null ||
      rejectedAt !== null
    ) throw error;
    return;
  }
  if (queueStatus === "rejected") {
    if (
      executionOutcome !== null ||
      receipt !== null ||
      failure !== null ||
      rejectedAt === null ||
      rejectedAt !== updatedAt
    ) throw error;
    return;
  }
  if (queueStatus === "stale") {
    if (
      !new Set([null, "stale", "absent"]).has(executionOutcome) ||
      receipt !== null ||
      failure !== null ||
      rejectedAt !== null
    ) throw error;
    return;
  }
  if (queueStatus === "failed") {
    if (
      !new Set(["absent", "unknown"]).has(executionOutcome) ||
      receipt !== null ||
      failure === null ||
      rejectedAt !== null ||
      failure.outcome !== executionOutcome ||
      failure.at !== updatedAt
    ) throw error;
    return;
  }
  if (
    !new Set(["applied", "already"]).has(executionOutcome) ||
    receipt === null ||
    failure !== null ||
    rejectedAt !== null ||
    Date.parse(receipt.createdAt) > Date.parse(updatedAt)
  ) {
    throw error;
  }
}

function normalizeSourceItem(value, sourceRevision, error) {
  const fields = objectFields(value, SOURCE_ITEM_KEYS, error);
  const confirmationId = boundedText(
    fields.get("confirmationId"),
    128,
    CONFIRMATION_ID,
    error,
  );
  const approvalBindingDigest = boundedText(
    fields.get("approvalBindingDigest"),
    64,
    SHA256,
    error,
  );
  const packageId = boundedText(fields.get("packageId"), 79, PACKAGE_ID, error);
  const packageDigest = boundedText(
    fields.get("packageDigest"),
    64,
    SHA256,
    error,
  );
  if (packageId !== `change-package-${packageDigest}`) throw error;
  const createdAt = timestamp(fields.get("createdAt"), error);
  const updatedAt = timestamp(fields.get("updatedAt"), error);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) throw error;
  const queueStatus = fields.get("queueStatus");
  if (!QUEUE_STATUSES.has(queueStatus)) throw error;
  const item = {
    confirmationId,
    approvalBindingDigest,
    requestedBy: normalizeRequestedBy(fields.get("requestedBy"), error),
    job: normalizeJob(fields.get("job"), error),
    packageId,
    packageDigest,
    workspaceId: boundedText(fields.get("workspaceId"), 128, SAFE_ID, error),
    itemRevision: safeInteger(fields.get("itemRevision"), 1, error),
    createdAt,
    updatedAt,
    queueStatus,
    executionOutcome: fields.get("executionOutcome"),
    receipt: normalizeReceipt(
      fields.get("receipt"),
      confirmationId,
      approvalBindingDigest,
      error,
    ),
    failure: normalizeFailure(fields.get("failure"), error),
    rejectedAt: fields.get("rejectedAt") === null
      ? null
      : timestamp(fields.get("rejectedAt"), error),
  };
  if (item.itemRevision > sourceRevision) throw error;
  validQueueState(item, error);
  return item;
}

function normalizeCheckpoint(value) {
  const error = invalidSource();
  const fields = objectFields(
    value,
    ["sourceRevision", "sourceSnapshotDigest"],
    error,
  );
  const sourceRevision = safeInteger(fields.get("sourceRevision"), 0, error);
  const sourceSnapshotDigest = boundedText(
    fields.get("sourceSnapshotDigest"),
    64,
    SHA256,
    error,
  );
  if (sourceRevision === 0 && sourceSnapshotDigest !== EMPTY_SOURCE_DIGEST) {
    throw error;
  }
  return { sourceRevision, sourceSnapshotDigest };
}

function normalizeSnapshot(value, checkpoint) {
  const error = invalidSource();
  const fields = objectFields(
    value,
    ["sourceRevision", "unchanged", "snapshotDigest", "items"],
    error,
  );
  const sourceRevision = safeInteger(fields.get("sourceRevision"), 0, error);
  const unchanged = fields.get("unchanged");
  const snapshotDigest = boundedText(
    fields.get("snapshotDigest"),
    64,
    SHA256,
    error,
  );
  if (typeof unchanged !== "boolean") throw error;
  const rawItems = arrayValues(fields.get("items"), MAX_ITEMS, error);
  if (unchanged) {
    if (
      sourceRevision !== checkpoint.sourceRevision ||
      snapshotDigest !== checkpoint.sourceSnapshotDigest ||
      rawItems.length !== 0
    ) {
      throw error;
    }
    return { sourceRevision, unchanged, snapshotDigest, items: [] };
  }
  if (
    sourceRevision <= checkpoint.sourceRevision ||
    snapshotDigest === checkpoint.sourceSnapshotDigest
  ) {
    throw error;
  }
  const items = rawItems.map((item) =>
    normalizeSourceItem(item, sourceRevision, error),
  );
  if (
    items.some(
      (item, index) =>
        index > 0 &&
        items[index - 1].confirmationId.localeCompare(item.confirmationId) >= 0,
    ) ||
    snapshotDigest !== digestValue({ sourceRevision, items })
  ) {
    throw error;
  }
  return { sourceRevision, unchanged, snapshotDigest, items };
}

function normalizeApplicationResult(value, source) {
  const error = invalidResult();
  const fields = objectFields(
    value,
    ["confirmationId", "status", "packageId", "workspaceId", "receipt"],
    error,
  );
  const receipt = normalizeReceipt(
    fields.get("receipt"),
    source.confirmationId,
    source.approvalBindingDigest,
    error,
  );
  if (
    fields.get("confirmationId") !== source.confirmationId ||
    fields.get("status") !== "applied" ||
    fields.get("packageId") !== source.packageId ||
    fields.get("workspaceId") !== source.workspaceId ||
    receipt === null ||
    receipt.id !== source.receipt.id ||
    receipt.createdAt !== source.receipt.createdAt
  ) {
    throw error;
  }
  return true;
}

function projectionEntry(item) {
  const completed = item.queueStatus === "completed";
  return {
    confirmationId: item.confirmationId,
    approvalBindingDigest: item.approvalBindingDigest,
    requestedBy: { ...item.requestedBy },
    job: { ...item.job },
    packageId: item.packageId,
    packageDigest: item.packageDigest,
    workspaceId: item.workspaceId,
    itemRevision: item.itemRevision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: completed
      ? item.executionOutcome
      : STATUS_PROJECTION.get(item.queueStatus),
    receipt: item.receipt === null ? null : { ...item.receipt },
    failure: item.failure === null ? null : { ...item.failure },
    rejectedAt: item.rejectedAt,
  };
}

function boundMethod(value, method, name) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  let owner = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${name} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`${name} is invalid`);
}

function bindPort(value, methods, name) {
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, boundMethod(value, method, name)]),
    ),
  );
}

function constructorOptions(value) {
  return objectFields(
    value,
    ["applicationResultSource", "applicationReader", "projectionStore"],
    new TypeError("ChangePackageApplicationResultReconciler options are invalid"),
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class ChangePackageApplicationResultReconciler {
  #readSnapshot;
  #getResult;
  #getCheckpoint;
  #applySnapshot;
  #inFlight = null;

  constructor(options = {}) {
    const fields = constructorOptions(options);
    this.#readSnapshot = bindPort(
      fields.get("applicationResultSource"),
      ["readSnapshot"],
      "applicationResultSource",
    ).readSnapshot;
    this.#getResult = bindPort(
      fields.get("applicationReader"),
      ["getResult"],
      "applicationReader",
    ).getResult;
    const projections = bindPort(
      fields.get("projectionStore"),
      ["getCheckpoint", "applySnapshot"],
      "projectionStore",
    );
    this.#getCheckpoint = projections.getCheckpoint;
    this.#applySnapshot = projections.applySnapshot;
  }

  runCycle() {
    if (this.#inFlight !== null) return this.#inFlight;
    const execution = Promise.resolve().then(() => this.#run());
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async runThrough(sourceRevision) {
    if (
      !Number.isSafeInteger(sourceRevision) ||
      Object.is(sourceRevision, -0) ||
      sourceRevision < 1
    ) {
      throw new TypeError("sourceRevision must be a positive safe integer");
    }
    let previousRevision = -1;
    for (let attempt = 0; attempt < MAX_BARRIER_CYCLES; attempt += 1) {
      const result = await this.runCycle();
      if (result.sourceRevision >= sourceRevision) return result;
      if (result.sourceRevision <= previousRevision) throw resultUnavailable();
      previousRevision = result.sourceRevision;
    }
    throw resultUnavailable();
  }

  async #run() {
    const checkpoint = normalizeCheckpoint(await this.#getCheckpoint());
    let sourceValue;
    try {
      sourceValue = await this.#readSnapshot({
        afterRevision: checkpoint.sourceRevision,
      });
    } catch {
      throw invalidSource();
    }
    const source = normalizeSnapshot(sourceValue, checkpoint);
    if (source.unchanged) {
      return deepFreeze({
        status: "unchanged",
        sourceRevision: source.sourceRevision,
        sourceSnapshotDigest: source.snapshotDigest,
        entryCount: 0,
      });
    }

    for (const item of source.items) {
      if (item.queueStatus !== "completed") continue;
      let result;
      try {
        result = await this.#getResult(item.confirmationId);
      } catch {
        throw resultUnavailable();
      }
      normalizeApplicationResult(result, item);
    }

    const entries = source.items.map(projectionEntry);
    await this.#applySnapshot({
      sourceRevision: source.sourceRevision,
      sourceSnapshotDigest: source.snapshotDigest,
      entries,
    });
    return deepFreeze({
      status: "applied",
      sourceRevision: source.sourceRevision,
      sourceSnapshotDigest: source.snapshotDigest,
      entryCount: entries.length,
    });
  }
}
