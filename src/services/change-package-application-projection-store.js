import { digestValue } from "../domain/code-executor-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";

export const CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY =
  "change-package-application-projections";
const STATE_KEY = CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY;
const MAX_ENTRIES = 1_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONFIRMATION_ID = /^confirmation-change-package-apply-[a-f0-9]{64}$/;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const RECEIPT_ID = /^change-package-application-[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STATUSES = new Set([
  "pending",
  "applying",
  "rejected",
  "stale",
  "failed",
  "applied",
  "already",
]);
const TERMINAL_STATUSES = new Set(["rejected", "stale", "applied", "already"]);
const ENTRY_KEYS = Object.freeze([
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
  "status",
  "receipt",
  "failure",
  "rejectedAt",
]);
const EMPTY_SOURCE_DIGEST = digestValue({ sourceRevision: 0, items: [] });

export class ChangePackageApplicationProjectionStoreError extends Error {
  constructor(code, message, statusCode = 500, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChangePackageApplicationProjectionStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function projectionError(code, message, statusCode, cause) {
  return new ChangePackageApplicationProjectionStoreError(
    code,
    message,
    statusCode,
    { cause },
  );
}

function sourceConflict(cause) {
  return projectionError(
    "CHANGE_PACKAGE_APPLICATION_PROJECTION_SOURCE_CONFLICT",
    "变更包应用投影来源冲突",
    409,
    cause,
  );
}

function stateCorrupted(cause) {
  return projectionError(
    "CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED",
    "变更包应用投影持久化状态损坏",
    500,
    cause,
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

function normalizeEntry(value, error) {
  const fields = objectFields(value, ENTRY_KEYS, error);
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
  const status = fields.get("status");
  if (!STATUSES.has(status)) throw error;
  const receipt = normalizeReceipt(
    fields.get("receipt"),
    confirmationId,
    approvalBindingDigest,
    error,
  );
  const failure = normalizeFailure(fields.get("failure"), error);
  const rejectedAt = fields.get("rejectedAt") === null
    ? null
    : timestamp(fields.get("rejectedAt"), error);
  if (
    (status === "rejected" &&
      (rejectedAt === null || receipt !== null || failure !== null)) ||
    (status === "failed" &&
      (failure === null || receipt !== null || rejectedAt !== null)) ||
    (new Set(["applied", "already"]).has(status) &&
      (receipt === null || failure !== null || rejectedAt !== null)) ||
    (new Set(["pending", "applying", "stale"]).has(status) &&
      (receipt !== null || failure !== null || rejectedAt !== null))
  ) {
    throw error;
  }
  if (
    (rejectedAt !== null && Date.parse(rejectedAt) > Date.parse(updatedAt)) ||
    (failure !== null && Date.parse(failure.at) > Date.parse(updatedAt))
  ) {
    throw error;
  }
  return {
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
    status,
    receipt,
    failure,
    rejectedAt,
  };
}

function normalizeEntries(value, error) {
  const entries = arrayValues(value, MAX_ENTRIES, error)
    .map((entry) => normalizeEntry(entry, error))
    .sort((left, right) => left.confirmationId.localeCompare(right.confirmationId));
  if (
    new Set(entries.map(({ confirmationId }) => confirmationId)).size !==
    entries.length
  ) {
    throw error;
  }
  return entries;
}

function defaultState() {
  return {
    schemaVersion: 1,
    revision: 0,
    sourceRevision: 0,
    sourceSnapshotDigest: EMPTY_SOURCE_DIGEST,
    entries: [],
  };
}

function normalizeState(value) {
  try {
    const error = new TypeError("projection state is invalid");
    const fields = objectFields(
      value,
      [
        "schemaVersion",
        "revision",
        "sourceRevision",
        "sourceSnapshotDigest",
        "entries",
      ],
      error,
    );
    const revision = safeInteger(fields.get("revision"), 0, error);
    const sourceRevision = safeInteger(fields.get("sourceRevision"), 0, error);
    const sourceSnapshotDigest = boundedText(
      fields.get("sourceSnapshotDigest"),
      64,
      SHA256,
      error,
    );
    const entries = normalizeEntries(fields.get("entries"), error);
    if (
      fields.get("schemaVersion") !== 1 ||
      revision > sourceRevision ||
      (revision === 0) !== (sourceRevision === 0) ||
      entries.some(({ itemRevision }) => itemRevision > sourceRevision) ||
      (sourceRevision === 0 &&
        (sourceSnapshotDigest !== EMPTY_SOURCE_DIGEST || entries.length !== 0))
    ) {
      throw error;
    }
    return deepFreeze({
      schemaVersion: 1,
      revision,
      sourceRevision,
      sourceSnapshotDigest,
      entries,
    });
  } catch (cause) {
    if (
      cause instanceof ChangePackageApplicationProjectionStoreError &&
      cause.code === "CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED"
    ) {
      throw cause;
    }
    throw stateCorrupted(cause);
  }
}

export function normalizeChangePackageApplicationProjectionPersistedState(
  value,
) {
  return normalizeState(value);
}

function normalizeSnapshot(value) {
  const error = sourceConflict();
  const fields = objectFields(
    value,
    ["sourceRevision", "sourceSnapshotDigest", "entries"],
    error,
  );
  const sourceRevision = safeInteger(fields.get("sourceRevision"), 0, error);
  const sourceSnapshotDigest = boundedText(
    fields.get("sourceSnapshotDigest"),
    64,
    SHA256,
    error,
  );
  const entries = normalizeEntries(fields.get("entries"), error);
  if (
    entries.some(({ itemRevision }) => itemRevision > sourceRevision) ||
    (sourceRevision === 0 &&
      (sourceSnapshotDigest !== EMPTY_SOURCE_DIGEST || entries.length !== 0))
  ) {
    throw error;
  }
  return deepFreeze({ sourceRevision, sourceSnapshotDigest, entries });
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

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameValue(left, right) {
  return digestValue(left) === digestValue(right);
}

function sameBinding(left, right) {
  return (
    left.confirmationId === right.confirmationId &&
    left.approvalBindingDigest === right.approvalBindingDigest &&
    sameValue(left.requestedBy, right.requestedBy) &&
    sameValue(left.job, right.job) &&
    left.packageId === right.packageId &&
    left.packageDigest === right.packageDigest &&
    left.workspaceId === right.workspaceId &&
    left.createdAt === right.createdAt
  );
}

function reachableStatus(previous, next) {
  if (TERMINAL_STATUSES.has(previous)) return false;
  if (previous === next) return true;
  if (previous === "applying") {
    return new Set(["failed", "stale", "applied", "already"]).has(next);
  }
  if (previous === "failed") {
    return new Set([
      "applying",
      "rejected",
      "stale",
      "applied",
      "already",
    ]).has(next);
  }
  return new Set([
    "applying",
    "rejected",
    "stale",
    "failed",
    "applied",
    "already",
  ]).has(next);
}

function assertSnapshotAdvance(state, snapshot, conflict = sourceConflict) {
  if (snapshot.sourceRevision < state.sourceRevision) throw conflict();
  if (snapshot.sourceRevision === state.sourceRevision) {
    if (
      snapshot.sourceSnapshotDigest !== state.sourceSnapshotDigest ||
      !sameValue(snapshot.entries, state.entries)
    ) {
      throw conflict();
    }
    return false;
  }
  if (snapshot.sourceSnapshotDigest === state.sourceSnapshotDigest) {
    throw conflict();
  }
  const incoming = new Map(
    snapshot.entries.map((entry) => [entry.confirmationId, entry]),
  );
  for (const previous of state.entries) {
    const next = incoming.get(previous.confirmationId);
    if (
      !next ||
      !sameBinding(previous, next) ||
      next.itemRevision < previous.itemRevision ||
      Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
      (next.itemRevision === previous.itemRevision && !sameValue(previous, next)) ||
      (next.itemRevision > previous.itemRevision &&
        !reachableStatus(previous.status, next.status))
    ) {
      throw conflict();
    }
  }
  return true;
}

function assertDurableAdvance(previous, next) {
  if (next.revision < previous.revision) throw stateCorrupted();
  if (next.revision === previous.revision) {
    if (!sameValue(previous, next)) throw stateCorrupted();
    return;
  }
  if (
    next.sourceRevision <= previous.sourceRevision ||
    !assertSnapshotAdvance(previous, next, stateCorrupted)
  ) {
    throw stateCorrupted();
  }
}

function summary(state) {
  return deepFreeze({
    revision: state.revision,
    sourceRevision: state.sourceRevision,
    sourceSnapshotDigest: state.sourceSnapshotDigest,
    entryCount: state.entries.length,
  });
}

function checkpoint(state) {
  return deepFreeze({
    sourceRevision: state.sourceRevision,
    sourceSnapshotDigest: state.sourceSnapshotDigest,
  });
}

function publicEntry(entry) {
  return deepFreeze({
    status: entry.status,
    confirmationId: entry.confirmationId,
    requestedBy: { ...entry.requestedBy },
    job: { ...entry.job },
    packageId: entry.packageId,
    packageDigest: entry.packageDigest,
    workspaceId: entry.workspaceId,
    itemRevision: entry.itemRevision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.receipt === null ? {} : { receipt: { ...entry.receipt } }),
    ...(entry.failure === null ? {} : { failure: { ...entry.failure } }),
    ...(entry.rejectedAt === null ? {} : { rejectedAt: entry.rejectedAt }),
  });
}

function latest(entries) {
  return entries.reduce((selected, candidate) => {
    if (selected === null) return candidate;
    const byCreation = Date.parse(candidate.createdAt) - Date.parse(selected.createdAt);
    if (byCreation !== 0) return byCreation > 0 ? candidate : selected;
    return candidate.confirmationId > selected.confirmationId ? candidate : selected;
  }, null);
}

function normalizeLookupId(value, pattern, name) {
  const error = new TypeError(`${name} is invalid`);
  return boundedText(value, 128, pattern, error);
}

export class ChangePackageApplicationProjectionStore {
  #store;
  #exclusiveLease;
  #operationQueue;
  #state = deepFreeze(defaultState());
  #ready = false;
  #hasAnchor = false;

  constructor({ store, exclusiveLease, operationQueue = new OperationQueue() } = {}) {
    this.#store = bindPort(store, ["read", "write"], "store");
    this.#exclusiveLease = bindPort(exclusiveLease, ["run"], "exclusiveLease");
    this.#operationQueue = bindPort(operationQueue, ["enqueue"], "operationQueue");
  }

  reader() {
    return Object.freeze({
      getForJob: this.getForJob.bind(this),
      getForPackage: this.getForPackage.bind(this),
      getSummary: this.getSummary.bind(this),
    });
  }

  recover() {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#ready = false;
        await this.#reload();
        this.#ready = true;
        return summary(this.#state);
      }),
    );
  }

  async applySnapshot(value) {
    const snapshot = normalizeSnapshot(value);
    return this.#run(async () => {
      if (!assertSnapshotAdvance(this.#state, snapshot)) {
        return summary(this.#state);
      }
      const next = normalizeState({
        schemaVersion: 1,
        revision: this.#state.revision + 1,
        sourceRevision: snapshot.sourceRevision,
        sourceSnapshotDigest: snapshot.sourceSnapshotDigest,
        entries: snapshot.entries,
      });
      await this.#store.write(STATE_KEY, next);
      this.#state = next;
      this.#hasAnchor = true;
      return summary(next);
    });
  }

  getCheckpoint() {
    return this.#run(async () => checkpoint(this.#state));
  }

  getSummary() {
    return this.#run(async () => summary(this.#state));
  }

  async getForJob(jobIdValue) {
    const jobId = normalizeLookupId(jobIdValue, SAFE_ID, "jobId");
    return this.#run(async () => {
      const entry = latest(
        this.#state.entries.filter(({ job }) => job.id === jobId),
      );
      return entry === null ? deepFreeze({ status: "not_requested" }) : publicEntry(entry);
    });
  }

  async getForPackage(packageIdValue) {
    const packageId = normalizeLookupId(packageIdValue, PACKAGE_ID, "packageId");
    return this.#run(async () => {
      const entry = latest(
        this.#state.entries.filter((candidate) => candidate.packageId === packageId),
      );
      return entry === null ? deepFreeze({ status: "not_requested" }) : publicEntry(entry);
    });
  }

  #run(operation) {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#assertReady();
        await this.#reload();
        return operation();
      }),
    );
  }

  async #reload() {
    try {
      const loaded = await this.#store.read(STATE_KEY, defaultState());
      const next = normalizeState(loaded);
      if (this.#hasAnchor) assertDurableAdvance(this.#state, next);
      this.#state = next;
      this.#hasAnchor = true;
    } catch (error) {
      if (
        error instanceof ChangePackageApplicationProjectionStoreError &&
        error.code === "CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED"
      ) {
        this.#ready = false;
      }
      throw error;
    }
  }

  #assertReady() {
    if (!this.#ready) {
      throw projectionError(
        "CHANGE_PACKAGE_APPLICATION_PROJECTION_NOT_READY",
        "变更包应用投影尚未完成恢复",
        503,
      );
    }
  }
}
