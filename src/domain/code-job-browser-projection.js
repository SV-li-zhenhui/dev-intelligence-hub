import { CODE_JOB_STATUSES } from "./code-job-vocabulary.js";

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/;
const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CLONE_ENTRIES = 5_000;
const MAX_CLONE_DEPTH = 16;
const MAX_CLONE_STRING_BYTES = 32 * 1024;
const CODE_ACTION_TYPES = new Set([
  "list_files",
  "read_text",
  "search_text",
  "write_text",
  "run_profile",
  "complete",
]);
const CODE_OBSERVATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);

const CODE_JOB_STATUS_SET = new Set(CODE_JOB_STATUSES);
const ACTIVE_CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
]);
const TERMINAL_CODE_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "fenced",
]);

const PROJECTION_KEYS_WITHOUT_UNCERTAINTY = Object.freeze([
  "jobId",
  "status",
  "revision",
  "proposalId",
  "proposalContentDigest",
  "grantDigest",
  "requestedBy",
  "subject",
  "repository",
  "workspaceId",
  "operation",
  "objective",
  "acceptanceCriteria",
  "evidence",
  "summary",
  "reason",
  "allowedActions",
  "writablePaths",
  "requiredProfiles",
  "turn",
  "pendingActionType",
  "observationCount",
  "latestObservation",
  "terminalResult",
  "memoryProjection",
  "pause",
  "createdAt",
  "updatedAt",
]);
const PROJECTION_KEYS = Object.freeze([
  ...PROJECTION_KEYS_WITHOUT_UNCERTAINTY,
  "uncertainty",
]);
const PROGRESS_KEYS = new Set([
  "turn",
  "pendingActionType",
  "observationCount",
  "latestObservation",
  "terminalResult",
  "memoryProjection",
  "pause",
  "uncertainty",
]);
const LEGACY_PROJECTION_KEYS = Object.freeze(
  PROJECTION_KEYS_WITHOUT_UNCERTAINTY.filter(
    (key) => !PROGRESS_KEYS.has(key),
  ),
);

function invalidProjection() {
  return new TypeError("Code job browser projection is invalid");
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

function assertExactKeys(value, expected, error) {
  const keys = dataEntries(value, error).map(([key]) => key);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function arrayValues(value, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
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

function cloneProjectionValue(
  value,
  error,
  context = { depth: 0, entries: { count: 0 }, ancestors: new Set() },
) {
  context.entries.count += 1;
  if (
    context.entries.count > MAX_CLONE_ENTRIES ||
    context.depth > MAX_CLONE_DEPTH
  ) {
    throw error;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (
      INVALID_TEXT_CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_CLONE_STRING_BYTES
    ) {
      throw error;
    }
    return value;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    context.ancestors.has(value)
  ) {
    throw error;
  }
  context.ancestors.add(value);
  const child = {
    depth: context.depth + 1,
    entries: context.entries,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      return arrayValues(value, error).map((entry) =>
        cloneProjectionValue(entry, error, child),
      );
    }
    const result = {};
    for (const [key, entry] of dataEntries(value, error)) {
      if (Buffer.byteLength(key, "utf8") > 128) throw error;
      result[key] = cloneProjectionValue(entry, error, child);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

function boundedText(
  value,
  error,
  { minimumBytes = 1, maximumBytes = 256 } = {},
) {
  const bytes = typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : -1;
  if (
    typeof value !== "string" ||
    INVALID_TEXT_CONTROL.test(value) ||
    bytes < minimumBytes ||
    bytes > maximumBytes
  ) {
    throw error;
  }
  return value;
}

function safeInteger(value, minimum, maximum, error) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw error;
  }
  return value;
}

function normalizeTimestamp(value, error) {
  let timestamp;
  try {
    timestamp = value instanceof Date ? value.toISOString() : value;
  } catch {
    throw error;
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw error;
  }
  return timestamp;
}

function hasExactKeys(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

function normalizeOptionalRecord(value, keys, error) {
  if (value === null) return null;
  assertExactKeys(value, keys, error);
  return cloneProjectionValue(value, error);
}

function projectionShape(suppliedKeys) {
  if (hasExactKeys(suppliedKeys, LEGACY_PROJECTION_KEYS)) return "legacy";
  if (hasExactKeys(suppliedKeys, PROJECTION_KEYS_WITHOUT_UNCERTAINTY)) {
    return "withoutUncertainty";
  }
  return "current";
}

function expectedProjectionKeys(shape) {
  if (shape === "legacy") return LEGACY_PROJECTION_KEYS;
  if (shape === "withoutUncertainty") {
    return PROJECTION_KEYS_WITHOUT_UNCERTAINTY;
  }
  return PROJECTION_KEYS;
}

function withLegacyProgress(value, shape, error) {
  if (shape === "legacy") {
    return {
      ...cloneProjectionValue(value, error),
      turn: 0,
      pendingActionType: null,
      observationCount: 0,
      latestObservation: null,
      terminalResult: null,
      memoryProjection: null,
      pause: null,
      uncertainty: null,
    };
  }
  if (shape === "withoutUncertainty") {
    return {
      ...cloneProjectionValue(value, error),
      uncertainty: value.status === "unknown"
        ? {
            from: "pausing",
            code: "LEGACY_ACTION_RESULT_UNKNOWN",
            message:
              value.pause?.reason ??
              "Legacy unknown action requires reconciliation",
            at: value.pause?.at ?? value.updatedAt,
          }
        : null,
    };
  }
  return cloneProjectionValue(value, error);
}

function normalizeProgress(projection, error) {
  const createdAt = normalizeTimestamp(projection.createdAt, error);
  const updatedAt = normalizeTimestamp(projection.updatedAt, error);
  const turn = safeInteger(projection.turn, 0, 128, error);
  const observationCount = safeInteger(
    projection.observationCount,
    0,
    128,
    error,
  );
  const pendingActionType = projection.pendingActionType;
  if (
    pendingActionType !== null &&
    !CODE_ACTION_TYPES.has(pendingActionType)
  ) {
    throw error;
  }

  const latestObservation = normalizeOptionalRecord(
    projection.latestObservation,
    ["actionType", "status", "recordedAt"],
    error,
  );
  if (
    latestObservation !== null &&
    (!CODE_ACTION_TYPES.has(latestObservation.actionType) ||
      !CODE_OBSERVATION_STATUSES.has(latestObservation.status))
  ) {
    throw error;
  }
  const latestRecordedAt = latestObservation === null
    ? null
    : normalizeTimestamp(latestObservation.recordedAt, error);

  const terminalResult = normalizeOptionalRecord(
    projection.terminalResult,
    ["kind", "recordedAt"],
    error,
  );
  const terminalRecordedAt = terminalResult === null
    ? null
    : normalizeTimestamp(terminalResult.recordedAt, error);

  const memoryProjection = normalizeOptionalRecord(
    projection.memoryProjection,
    ["recordId", "projectedAt"],
    error,
  );
  const memoryProjectedAt = memoryProjection === null
    ? null
    : normalizeTimestamp(memoryProjection.projectedAt, error);
  if (
    memoryProjection !== null &&
    (typeof memoryProjection.recordId !== "string" ||
      !MEMORY_RECORD_ID.test(memoryProjection.recordId))
  ) {
    throw error;
  }

  const pause = normalizeOptionalRecord(
    projection.pause,
    ["reason", "at"],
    error,
  );
  const pausedAt = pause === null
    ? null
    : normalizeTimestamp(pause.at, error);
  if (
    pause !== null &&
    (typeof pause.reason !== "string" ||
      Buffer.byteLength(pause.reason, "utf8") > 2_048)
  ) {
    throw error;
  }

  const uncertainty = normalizeOptionalRecord(
    projection.uncertainty,
    ["from", "code", "message", "at"],
    error,
  );
  const uncertaintyAt = uncertainty === null
    ? null
    : normalizeTimestamp(uncertainty.at, error);
  if (
    uncertainty !== null &&
    (!["active", "pausing"].includes(uncertainty.from) ||
      typeof uncertainty.code !== "string" ||
      !FAILURE_CODE.test(uncertainty.code))
  ) {
    throw error;
  }
  if (uncertainty !== null) {
    boundedText(uncertainty.message, error, {
      maximumBytes: 2_048,
    });
  }

  return {
    createdAt,
    updatedAt,
    turn,
    observationCount,
    pendingActionType,
    latestObservation,
    latestRecordedAt,
    terminalResult,
    terminalRecordedAt,
    memoryProjection,
    memoryProjectedAt,
    pause,
    pausedAt,
    uncertainty,
    uncertaintyAt,
  };
}

function assertProjectionLifecycle(projection, progress, error) {
  const {
    createdAt,
    updatedAt,
    turn,
    observationCount,
    pendingActionType,
    latestObservation,
    latestRecordedAt,
    terminalResult,
    terminalRecordedAt,
    memoryProjection,
    memoryProjectedAt,
    pause,
    pausedAt,
    uncertainty,
    uncertaintyAt,
  } = progress;
  if (
    !CODE_JOB_STATUS_SET.has(projection.status) ||
    !Number.isSafeInteger(projection.revision) ||
    projection.revision < 1 ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    observationCount !== turn ||
    (latestObservation === null) !== (observationCount === 0) ||
    (latestRecordedAt !== null &&
      (Date.parse(latestRecordedAt) < Date.parse(createdAt) ||
        Date.parse(latestRecordedAt) > Date.parse(updatedAt))) ||
    (projection.status === "queued" &&
      (updatedAt !== createdAt ||
        turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (projection.status === "starting" &&
      (turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (["active", "pausing", "unknown", "paused"].includes(
      projection.status,
    ) && (terminalResult !== null || memoryProjection !== null)) ||
    (!["pausing", "unknown", "paused"].includes(projection.status) &&
      pause !== null) ||
    (["pausing", "paused"].includes(projection.status) && pause === null) ||
    (projection.status === "unknown") !== (uncertainty !== null) ||
    (uncertainty?.from === "active" && pause !== null) ||
    (uncertainty?.from === "pausing" && pause === null) ||
    (projection.status === "unknown" && pendingActionType === null) ||
    (pausedAt !== null &&
      (Date.parse(pausedAt) < Date.parse(createdAt) ||
        Date.parse(pausedAt) > Date.parse(updatedAt))) ||
    (uncertaintyAt !== null &&
      (Date.parse(uncertaintyAt) < Date.parse(createdAt) ||
        Date.parse(uncertaintyAt) > Date.parse(updatedAt))) ||
    (TERMINAL_CODE_JOB_STATUSES.has(projection.status) &&
      (terminalResult?.kind !== projection.status ||
        pendingActionType !== null ||
        pause !== null)) ||
    (ACTIVE_CODE_JOB_STATUSES.has(projection.status) &&
      terminalResult !== null) ||
    (terminalRecordedAt !== null &&
      (Date.parse(terminalRecordedAt) < Date.parse(createdAt) ||
        Date.parse(terminalRecordedAt) > Date.parse(updatedAt))) ||
    (memoryProjectedAt !== null &&
      (Date.parse(memoryProjectedAt) < Date.parse(createdAt) ||
        Date.parse(memoryProjectedAt) > Date.parse(updatedAt)))
  ) {
    throw error;
  }
}

export function normalizeCodeJobBrowserProjection(
  value,
  error = invalidProjection(),
) {
  const suppliedKeys = dataEntries(value, error).map(([key]) => key);
  const shape = projectionShape(suppliedKeys);
  assertExactKeys(value, expectedProjectionKeys(shape), error);
  const projection = withLegacyProgress(value, shape, error);
  const progress = normalizeProgress(projection, error);
  assertProjectionLifecycle(projection, progress, error);
  return projection;
}

export function isActiveCodeJobBrowserStatus(value) {
  return ACTIVE_CODE_JOB_STATUSES.has(value);
}

function projectBrowserFields(source, progress) {
  const grant = source.grant;
  return {
    jobId: source.jobId,
    status: source.status,
    revision: source.revision,
    proposalId: source.proposal.proposalId,
    proposalContentDigest: source.proposal.contentDigest,
    grantDigest: grant.grantDigest,
    requestedBy: grant.requestedBy,
    subject: grant.subject,
    repository: grant.repository,
    workspaceId: grant.workspaceId,
    operation: grant.operation,
    objective: grant.objective,
    acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence,
    summary: grant.summary,
    reason: grant.reason,
    allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths,
    requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
    ...progress,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function validateProjectedCodeJob(projection) {
  normalizeCodeJobBrowserProjection(projection);
  return structuredClone(projection);
}

export function projectNormalizedCodeJobForBrowser(job) {
  const execution = job.execution;
  return validateProjectedCodeJob(
    projectBrowserFields(job, {
      turn: execution.turn,
      pendingActionType: execution.pendingAction?.action.type ?? null,
      observationCount: execution.observations.length,
      latestObservation: execution.observations.length === 0
        ? null
        : {
            actionType: execution.observations.at(-1).actionType,
            status: execution.observations.at(-1).status,
            recordedAt: execution.observations.at(-1).recordedAt,
          },
      terminalResult: execution.result === null
        ? null
        : {
            kind: execution.result.kind,
            recordedAt: execution.result.recordedAt,
          },
      memoryProjection: execution.memoryProjection === null
        ? null
        : {
            recordId: execution.memoryProjection.memoryRecordId,
            projectedAt: execution.memoryProjection.projectedAt,
          },
      pause: execution.pause === null
        ? null
        : {
            reason: execution.pause.reason,
            at: execution.pause.at,
          },
      uncertainty: execution.uncertainty === null
        ? null
        : {
            from: execution.uncertainty.from,
            code: execution.uncertainty.code,
            message: execution.uncertainty.message,
            at: execution.uncertainty.at,
          },
    }),
  );
}

export function projectArchivedCodeJobForBrowser(tombstone) {
  return validateProjectedCodeJob(
    projectBrowserFields(tombstone, {
      turn: tombstone.outcome.turn,
      pendingActionType: null,
      observationCount: tombstone.outcome.observationCount,
      latestObservation: tombstone.outcome.latestObservation,
      terminalResult: tombstone.outcome.terminalResult,
      memoryProjection: {
        recordId: tombstone.outcome.memoryProjection.memoryRecordId,
        projectedAt: tombstone.outcome.memoryProjection.projectedAt,
      },
      pause: null,
      uncertainty: null,
    }),
  );
}
