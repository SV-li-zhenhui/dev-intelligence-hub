import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

const SHA256 = /^[a-f0-9]{64}$/;
const BACKUP_ID = /^backup-[a-f0-9]{64}$/;
const ACTIVATION_ID = /^restore-activation-[a-f0-9]{64}$/;
const FAILURE_CODE = /^RESTORE_ACTIVATION_[A-Z_]{1,96}$/;
const PHASES = new Set([
  "prepared",
  "candidate-ready",
  "active-moved",
  "candidate-activated",
  "rollback-required",
]);

export class RestoreActivationRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreActivationRecordError";
    this.code = "INVALID_RESTORE_ACTIVATION_RECORD";
  }
}

function invalid(message) {
  throw new RestoreActivationRecordError(message);
}

function dataRecord(value, expectedKeys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} must be a plain data record`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    invalid(`${name} fields are invalid`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${name} fields are invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function isoTimestamp(value, name) {
  if (typeof value !== "string") invalid(`${name} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function fingerprint(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const record = dataRecord(
    value,
    ["digest", "fileCount", "directoryCount", "totalBytes"],
    name,
  );
  if (!SHA256.test(record.digest)) invalid(`${name}.digest is invalid`);
  for (const key of ["fileCount", "directoryCount", "totalBytes"]) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) {
      invalid(`${name}.${key} is invalid`);
    }
  }
  return Object.freeze({
    digest: record.digest,
    fileCount: record.fileCount,
    directoryCount: record.directoryCount,
    totalBytes: record.totalBytes,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function journalPayload(value) {
  const record = dataRecord(
    value,
    [
      "activationId",
      "backupId",
      "requestedAt",
      "phase",
      "hadActive",
      "previousFingerprint",
      "candidateFingerprint",
      "failureCode",
    ],
    "restore activation journal payload",
  );
  if (!ACTIVATION_ID.test(record.activationId)) invalid("activationId is invalid");
  if (!BACKUP_ID.test(record.backupId)) invalid("backupId is invalid");
  isoTimestamp(record.requestedAt, "requestedAt");
  if (!PHASES.has(record.phase)) invalid("phase is invalid");
  if (typeof record.hadActive !== "boolean") invalid("hadActive is invalid");
  const previousFingerprint = fingerprint(
    record.previousFingerprint,
    "previousFingerprint",
    { nullable: true },
  );
  const candidateFingerprint = fingerprint(
    record.candidateFingerprint,
    "candidateFingerprint",
    { nullable: true },
  );
  if (record.hadActive !== (previousFingerprint !== null)) {
    invalid("previousFingerprint does not match hadActive");
  }
  if (
    record.phase === "prepared" ? candidateFingerprint !== null : candidateFingerprint === null
  ) {
    invalid("candidateFingerprint does not match phase");
  }
  if (
    record.phase === "rollback-required"
      ? typeof record.failureCode !== "string" || !FAILURE_CODE.test(record.failureCode)
      : record.failureCode !== null
  ) {
    invalid("failureCode does not match phase");
  }
  return Object.freeze({
    activationId: record.activationId,
    backupId: record.backupId,
    requestedAt: record.requestedAt,
    phase: record.phase,
    hadActive: record.hadActive,
    previousFingerprint,
    candidateFingerprint,
    failureCode: record.failureCode,
  });
}

export function createRestoreActivationJournal(value) {
  const payload = journalPayload(value);
  const journalDigest = sha256(JSON.stringify(payload));
  return Object.freeze({
    schemaVersion: 1,
    ...payload,
    journalDigest,
  });
}

export function normalizeRestoreActivationJournal(value) {
  const record = dataRecord(
    value,
    [
      "schemaVersion",
      "activationId",
      "backupId",
      "requestedAt",
      "phase",
      "hadActive",
      "previousFingerprint",
      "candidateFingerprint",
      "failureCode",
      "journalDigest",
    ],
    "restore activation journal",
  );
  if (record.schemaVersion !== 1 || !SHA256.test(record.journalDigest)) {
    invalid("restore activation journal metadata is invalid");
  }
  const normalized = createRestoreActivationJournal({
    activationId: record.activationId,
    backupId: record.backupId,
    requestedAt: record.requestedAt,
    phase: record.phase,
    hadActive: record.hadActive,
    previousFingerprint: record.previousFingerprint,
    candidateFingerprint: record.candidateFingerprint,
    failureCode: record.failureCode,
  });
  if (normalized.journalDigest !== record.journalDigest) {
    invalid("restore activation journal digest is invalid");
  }
  return normalized;
}

function receiptPayload(value) {
  const record = dataRecord(
    value,
    ["activationId", "backupId", "activatedAt", "activeFingerprint"],
    "restore activation receipt payload",
  );
  if (!ACTIVATION_ID.test(record.activationId)) invalid("activationId is invalid");
  if (!BACKUP_ID.test(record.backupId)) invalid("backupId is invalid");
  isoTimestamp(record.activatedAt, "activatedAt");
  return Object.freeze({
    activationId: record.activationId,
    backupId: record.backupId,
    activatedAt: record.activatedAt,
    activeFingerprint: fingerprint(record.activeFingerprint, "activeFingerprint"),
  });
}

export function createRestoreActivationReceipt(value) {
  const payload = receiptPayload(value);
  return Object.freeze({
    schemaVersion: 1,
    ...payload,
    status: "activated",
    receiptDigest: sha256(JSON.stringify(payload)),
  });
}

export function normalizeRestoreActivationReceipt(value) {
  const record = dataRecord(
    value,
    [
      "schemaVersion",
      "activationId",
      "backupId",
      "activatedAt",
      "activeFingerprint",
      "status",
      "receiptDigest",
    ],
    "restore activation receipt",
  );
  if (
    record.schemaVersion !== 1 ||
    record.status !== "activated" ||
    !SHA256.test(record.receiptDigest)
  ) {
    invalid("restore activation receipt metadata is invalid");
  }
  const normalized = createRestoreActivationReceipt({
    activationId: record.activationId,
    backupId: record.backupId,
    activatedAt: record.activatedAt,
    activeFingerprint: record.activeFingerprint,
  });
  if (normalized.receiptDigest !== record.receiptDigest) {
    invalid("restore activation receipt digest is invalid");
  }
  return normalized;
}
