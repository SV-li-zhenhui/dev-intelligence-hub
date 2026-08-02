import {
  codeJobIdForGrant,
  normalizeCodeJobGrant,
} from "../domain/code-job-contract.js";
import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import {
  codeJobConfirmationIdForProposal,
  createCodeActionProposalConfirmationPlan,
} from "../domain/code-action-proposal-confirmation.js";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  cloneWorkProposalValue,
  isTerminalWorkProposalStatus,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { WorkProposalRunnerService } from "./work-proposal-runner.js";

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const INVALIDATION_REASONS = new Set([
  "work_item_superseded",
  "authorization_changed",
]);
const AUTHORIZATION_ERROR_CODES = new Set([
  "INVALID_CODE_JOB_AUTHORITY",
  "WORK_INTENT_POLICY_DENIED",
]);
const ACTIVE_PROPOSAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter(
    (status) => !isTerminalWorkProposalStatus(status),
  ),
);
const REQUIRED_CONFIRMATION_KEYS = Object.freeze([
  "id",
  "kind",
  "status",
  "queueRevision",
  "itemRevision",
  "requestedBy",
  "actor",
  "target",
  "display",
  "displayedPayloadDigest",
  "approvalBindingDigest",
  "retryable",
]);
const OPTIONAL_CONFIRMATION_KEYS = new Set([
  "receipt",
  "failure",
  "rejection",
  "invalidation",
]);
const JOB_KEYS_WITHOUT_UNCERTAINTY = Object.freeze([
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
const JOB_KEYS = Object.freeze([
  ...JOB_KEYS_WITHOUT_UNCERTAINTY,
  "uncertainty",
]);
const JOB_PROGRESS_KEYS = new Set([
  "turn",
  "pendingActionType",
  "observationCount",
  "latestObservation",
  "terminalResult",
  "memoryProjection",
  "pause",
  "uncertainty",
]);
const LEGACY_JOB_KEYS = Object.freeze(
  JOB_KEYS_WITHOUT_UNCERTAINTY.filter(
    (key) => !JOB_PROGRESS_KEYS.has(key),
  ),
);
const CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
  "completed",
  "failed",
  "fenced",
]);
const ACTIVE_CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
]);
const TERMINAL_CODE_JOB_STATUSES = new Set(["completed", "failed", "fenced"]);
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
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/;
const FACTORY_KEYS = new Set([
  "enabled",
  "runner",
  "confirmationProducer",
  "codeJobReader",
  "grantFactory",
  "clock",
  "pollIntervalMs",
  "leaseDurationMs",
  "handlerTimeoutMs",
  "retryBaseMs",
  "retryMaxMs",
  "defaultBatchLimit",
]);

function invalidProposal(message = "代码工作提案处理失败") {
  return workProposalError("INVALID_CODE_ACTION_PROPOSAL", message);
}

function invalidConfirmation(message = "代码任务确认结果无效") {
  return workProposalError("INVALID_CODE_ACTION_CONFIRMATION", message);
}

function invalidJob(message = "代码任务结果无效") {
  return workProposalError("INVALID_CODE_JOB_RESULT", message);
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(value, new TypeError("clock is invalid"));
}

function sameValue(left, right) {
  try {
    return (
      JSON.stringify(cloneWorkProposalValue(left)) ===
      JSON.stringify(cloneWorkProposalValue(right))
    );
  } catch {
    return false;
  }
}

function boundedReference(
  value,
  error,
  { minimumBytes = 1, maximumBytes = 256 } = {},
) {
  const size = typeof value === "string" ? Buffer.byteLength(value, "utf8") : -1;
  if (
    typeof value !== "string" ||
    size < minimumBytes ||
    size > maximumBytes ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw error;
  }
  return value;
}

function normalizedStoredProposal(value, error) {
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    error,
  );
  const proposal = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    normalizeWorkProposalDigest(value.contentDigest, error) !==
    proposal.contentDigest
  ) {
    throw error;
  }
  return proposal;
}

function normalizeHandlerInput(value) {
  const error = invalidProposal();
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "attempt", "downstreamRef"],
    error,
  );
  if (!ACTIVE_PROPOSAL_STATUSES.has(value.status)) throw error;
  return {
    proposal: normalizedStoredProposal(value.proposal, error),
    status: value.status,
    attempt: safeWorkProposalInteger(value.attempt, "attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef:
      value.downstreamRef === null
        ? null
        : boundedReference(value.downstreamRef, error),
  };
}

function normalizeFailure(value, error) {
  assertWorkProposalExactKeys(
    value,
    ["code", "outcome", "retryable", "at"],
    error,
  );
  if (
    typeof value.code !== "string" ||
    !FAILURE_CODE.test(value.code) ||
    !["absent", "unknown"].includes(value.outcome) ||
    typeof value.retryable !== "boolean" ||
    value.retryable !== (value.outcome === "absent")
  ) {
    throw error;
  }
  return {
    code: value.code,
    outcome: value.outcome,
    retryable: value.retryable,
    at: normalizeWorkProposalTimestamp(value.at, error),
  };
}

function normalizeReceipt(value, error) {
  assertWorkProposalExactKeys(value, ["id", "createdAt"], error);
  return {
    id: boundedReference(value.id, error),
    createdAt: normalizeWorkProposalTimestamp(value.createdAt, error),
  };
}

function validateOptionalConfirmationFields(item, keys, expected, error) {
  const optional = keys.filter((key) => OPTIONAL_CONFIRMATION_KEYS.has(key));
  const allowed = {
    pending: [],
    executing: [],
    completed: ["receipt"],
    failed: ["failure"],
    stale: ["invalidation"],
    rejected: ["rejection"],
  }[item.status];
  if (optional.some((key) => !allowed.includes(key))) throw error;
  if (
    (item.status === "completed" && !optional.includes("receipt")) ||
    (item.status === "failed" && !optional.includes("failure")) ||
    (item.status === "rejected" && !optional.includes("rejection")) ||
    (item.status !== "failed" && item.retryable)
  ) {
    throw error;
  }
  if (item.status === "rejected") {
    assertWorkProposalExactKeys(
      item.rejection,
      ["requestId", "reason", "at"],
      error,
    );
    if (!REQUEST_ID.test(boundedReference(item.rejection.requestId, error))) {
      throw error;
    }
    boundedReference(item.rejection.reason, error, {
      minimumBytes: 0,
      maximumBytes: 1_024,
    });
    normalizeWorkProposalTimestamp(item.rejection.at, error);
  }
  if (item.status === "stale" && item.invalidation !== undefined) {
    assertWorkProposalExactKeys(
      item.invalidation,
      ["reason", "requestedBy", "approvalBindingDigest", "at"],
      error,
    );
    if (
      !INVALIDATION_REASONS.has(item.invalidation.reason) ||
      !sameValue(item.invalidation.requestedBy, expected.requestedBy) ||
      normalizeWorkProposalDigest(
        item.invalidation.approvalBindingDigest,
        error,
      ) !== expected.approvalBindingDigest
    ) {
      throw error;
    }
    normalizeWorkProposalTimestamp(item.invalidation.at, error);
  }
}

function normalizeConfirmationItem(value, expected) {
  const error = invalidConfirmation();
  const entries = workProposalDataEntries(value, error);
  const keys = entries.map(([key]) => key);
  if (
    REQUIRED_CONFIRMATION_KEYS.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !REQUIRED_CONFIRMATION_KEYS.includes(key) &&
        !OPTIONAL_CONFIRMATION_KEYS.has(key),
    )
  ) {
    throw error;
  }
  const item = cloneWorkProposalValue(Object.fromEntries(entries));
  if (
    item.id !== expected.id ||
    item.kind !== expected.kind ||
    !CONFIRMATION_STATUSES.has(item.status) ||
    !Number.isSafeInteger(item.queueRevision) ||
    item.queueRevision < 1 ||
    !Number.isSafeInteger(item.itemRevision) ||
    item.itemRevision < 1 ||
    !sameValue(item.requestedBy, expected.requestedBy) ||
    !sameValue(item.actor, expected.actor) ||
    !sameValue(item.target, expected.target) ||
    !sameValue(item.display, expected.display) ||
    normalizeWorkProposalDigest(item.displayedPayloadDigest, error) !==
      expected.displayedPayloadDigest ||
    normalizeWorkProposalDigest(item.approvalBindingDigest, error) !==
      expected.approvalBindingDigest ||
    typeof item.retryable !== "boolean"
  ) {
    throw error;
  }
  validateOptionalConfirmationFields(item, keys, expected, error);
  const failure =
    item.status === "failed" ? normalizeFailure(item.failure, error) : null;
  if (failure && item.retryable !== failure.retryable) throw error;
  return {
    ...item,
    receipt:
      item.status === "completed"
        ? normalizeReceipt(item.receipt, error)
        : null,
    failure,
  };
}

function normalizeOwnedConfirmationItem(value, proposal, confirmationId) {
  const error = invalidConfirmation("旧代码任务确认绑定无效");
  const entries = workProposalDataEntries(value, error);
  const projected = cloneWorkProposalValue(Object.fromEntries(entries));
  const embeddedAction = projected.display?.payload?.action;
  let expected;
  try {
    expected = normalizeConfirmationPlan({
      id: projected.id,
      kind: projected.kind,
      requestedBy: projected.requestedBy,
      actor: projected.actor,
      target: projected.target,
      action: embeddedAction,
      display: projected.display,
    });
  } catch {
    throw error;
  }
  const item = normalizeConfirmationItem(projected, expected);
  assertWorkProposalExactKeys(expected.action, ["type", "grant"], error);
  if (
    item.id !== confirmationId ||
    item.kind !== "local.code-job-create" ||
    expected.action.type !== "create_code_job" ||
    !sameValue(item.requestedBy, proposal.requestedBy) ||
    !sameValue(item.actor, {
      provider: "local-code",
      accountId: "controlled-code-executor",
    }) ||
    !sameValue(item.target, {
      provider: "local-code",
      resourceId: proposal.binding.workspaceId,
      version: proposal.contentDigest,
    })
  ) {
    throw error;
  }
  let grant;
  try {
    grant = normalizeCodeJobGrant(expected.action.grant);
  } catch {
    throw error;
  }
  const proposalBinding = {
    proposalId: proposal.proposalId,
    contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion,
    requestedBy: proposal.requestedBy,
    source: proposal.source,
    subject: proposal.binding.subject,
    repository: proposal.binding.repository,
    workspaceId: proposal.binding.workspaceId,
    operation: proposal.payload.operation,
    objective: proposal.payload.objective,
    acceptanceCriteria: proposal.payload.acceptanceCriteria,
    evidence: proposal.payload.evidence,
    summary: proposal.payload.summary,
    reason: proposal.payload.reason,
  };
  const grantBinding = Object.fromEntries(
    Object.keys(proposalBinding).map((key) => [key, grant[key]]),
  );
  if (!sameValue(grantBinding, proposalBinding)) throw error;
  return item;
}

function nextAttemptAt(clock, pollIntervalMs) {
  return new Date(
    Date.parse(normalizeClock(clock)) + pollIntervalMs,
  ).toISOString();
}

function active(status, downstreamRef, clock, pollIntervalMs) {
  return {
    status,
    downstreamRef,
    nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
  };
}

function terminal(status, summary, item, evidence = []) {
  return {
    status,
    summary,
    evidence: [`confirmation:${item.id}`, ...evidence],
  };
}

function confirmationFailureTransition(item, clock, pollIntervalMs) {
  if (item.failure.retryable) {
    return {
      status: "waiting_retry",
      reason: item.failure.code,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  return terminal(
    "unknown",
    "本地代码任务创建结果无法确认",
    item,
    [item.failure.code],
  );
}

function normalizeOptionalJobRecord(value, keys, error) {
  if (value === null) return null;
  assertWorkProposalExactKeys(value, keys, error);
  return cloneWorkProposalValue(value);
}

function normalizeCodeJobProjection(value, grant, receipt) {
  const error = invalidJob();
  const suppliedKeys = workProposalDataEntries(value, error).map(([key]) => key);
  const legacy =
    suppliedKeys.length === LEGACY_JOB_KEYS.length &&
    LEGACY_JOB_KEYS.every((key) => suppliedKeys.includes(key));
  const withoutUncertainty =
    suppliedKeys.length === JOB_KEYS_WITHOUT_UNCERTAINTY.length &&
    JOB_KEYS_WITHOUT_UNCERTAINTY.every((key) => suppliedKeys.includes(key));
  assertWorkProposalExactKeys(
    value,
    legacy
      ? LEGACY_JOB_KEYS
      : withoutUncertainty
        ? JOB_KEYS_WITHOUT_UNCERTAINTY
        : JOB_KEYS,
    error,
  );
  const job = {
    ...cloneWorkProposalValue(value),
    ...(legacy
      ? {
          turn: 0,
          pendingActionType: null,
          observationCount: 0,
          latestObservation: null,
          terminalResult: null,
          memoryProjection: null,
          pause: null,
          uncertainty: null,
        }
      : {}),
    ...(withoutUncertainty
      ? {
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
        }
      : {}),
  };
  const expectedJobId = codeJobIdForGrant(grant);
  const createdAt = normalizeWorkProposalTimestamp(job.createdAt, error);
  const updatedAt = normalizeWorkProposalTimestamp(job.updatedAt, error);
  const turn = safeWorkProposalInteger(job.turn, "turn", {
    minimum: 0,
    maximum: 128,
    error,
  });
  const observationCount = safeWorkProposalInteger(
    job.observationCount,
    "observationCount",
    { minimum: 0, maximum: 128, error },
  );
  const pendingActionType = job.pendingActionType;
  if (
    pendingActionType !== null &&
    !CODE_ACTION_TYPES.has(pendingActionType)
  ) {
    throw error;
  }
  const latestObservation = normalizeOptionalJobRecord(
    job.latestObservation,
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
    : normalizeWorkProposalTimestamp(latestObservation.recordedAt, error);
  const terminalResult = normalizeOptionalJobRecord(
    job.terminalResult,
    ["kind", "recordedAt"],
    error,
  );
  const terminalRecordedAt = terminalResult === null
    ? null
    : normalizeWorkProposalTimestamp(terminalResult.recordedAt, error);
  const memoryProjection = normalizeOptionalJobRecord(
    job.memoryProjection,
    ["recordId", "projectedAt"],
    error,
  );
  const memoryProjectedAt = memoryProjection === null
    ? null
    : normalizeWorkProposalTimestamp(memoryProjection.projectedAt, error);
  if (
    memoryProjection !== null &&
    (typeof memoryProjection.recordId !== "string" ||
      !MEMORY_RECORD_ID.test(memoryProjection.recordId))
  ) {
    throw error;
  }
  const pause = normalizeOptionalJobRecord(
    job.pause,
    ["reason", "at"],
    error,
  );
  const pausedAt = pause === null
    ? null
    : normalizeWorkProposalTimestamp(pause.at, error);
  if (
    pause !== null &&
    (typeof pause.reason !== "string" ||
      Buffer.byteLength(pause.reason, "utf8") > 2_048)
  ) {
    throw error;
  }
  const uncertainty = normalizeOptionalJobRecord(
    job.uncertainty,
    ["from", "code", "message", "at"],
    error,
  );
  const uncertaintyAt = uncertainty === null
    ? null
    : normalizeWorkProposalTimestamp(uncertainty.at, error);
  if (
    uncertainty !== null &&
    (!["active", "pausing"].includes(uncertainty.from) ||
      typeof uncertainty.code !== "string" ||
      !FAILURE_CODE.test(uncertainty.code))
  ) {
    throw error;
  }
  if (uncertainty !== null) {
    boundedReference(uncertainty.message, error, { maximumBytes: 2_048 });
  }
  const expected = {
    requestedBy: grant.requestedBy,
    subject: grant.subject,
    acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence,
    allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths,
    requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, job[key]]),
  );
  if (
    job.jobId !== expectedJobId ||
    receipt.id !== expectedJobId ||
    !CODE_JOB_STATUSES.has(job.status) ||
    !Number.isSafeInteger(job.revision) ||
    job.revision < 1 ||
    job.proposalId !== grant.proposalId ||
    normalizeWorkProposalDigest(job.proposalContentDigest, error) !==
      grant.contentDigest ||
    normalizeWorkProposalDigest(job.grantDigest, error) !== grant.grantDigest ||
    job.repository !== grant.repository ||
    job.workspaceId !== grant.workspaceId ||
    job.operation !== grant.operation ||
    job.objective !== grant.objective ||
    job.summary !== grant.summary ||
    job.reason !== grant.reason ||
    !sameValue(actual, expected) ||
    createdAt !== receipt.createdAt ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    observationCount !== turn ||
    (latestObservation === null) !== (observationCount === 0) ||
    (latestRecordedAt !== null &&
      (Date.parse(latestRecordedAt) < Date.parse(createdAt) ||
        Date.parse(latestRecordedAt) > Date.parse(updatedAt))) ||
    (pendingActionType !== null &&
      !grant.allowedActions.includes(pendingActionType)) ||
    (job.status === "queued" &&
      (updatedAt !== createdAt ||
        turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (job.status === "starting" &&
      (turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (["active", "pausing", "unknown", "paused"].includes(job.status) &&
      (terminalResult !== null || memoryProjection !== null)) ||
    (!["pausing", "unknown", "paused"].includes(job.status) &&
      pause !== null) ||
    (["pausing", "paused"].includes(job.status) && pause === null) ||
    (job.status === "unknown") !== (uncertainty !== null) ||
    (uncertainty?.from === "active" && pause !== null) ||
    (uncertainty?.from === "pausing" && pause === null) ||
    (job.status === "unknown" && pendingActionType === null) ||
    (pausedAt !== null &&
      (Date.parse(pausedAt) < Date.parse(createdAt) ||
        Date.parse(pausedAt) > Date.parse(updatedAt))) ||
    (uncertaintyAt !== null &&
      (Date.parse(uncertaintyAt) < Date.parse(createdAt) ||
        Date.parse(uncertaintyAt) > Date.parse(updatedAt))) ||
    (TERMINAL_CODE_JOB_STATUSES.has(job.status) &&
      (terminalResult?.kind !== job.status ||
        pendingActionType !== null ||
        pause !== null)) ||
    (ACTIVE_CODE_JOB_STATUSES.has(job.status) && terminalResult !== null) ||
    (terminalRecordedAt !== null &&
      (Date.parse(terminalRecordedAt) < Date.parse(createdAt) ||
        Date.parse(terminalRecordedAt) > Date.parse(updatedAt))) ||
    (memoryProjectedAt !== null &&
      (Date.parse(memoryProjectedAt) < Date.parse(createdAt) ||
        Date.parse(memoryProjectedAt) > Date.parse(updatedAt)))
  ) {
    throw error;
  }
  return job;
}

function factoryOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Code proposal runner options are invalid");
  }
  const entries = workProposalDataEntries(
    value,
    new TypeError("Code proposal runner options are invalid"),
  );
  if (entries.some(([key]) => !FACTORY_KEYS.has(key))) {
    throw new TypeError("Code proposal runner options are invalid");
  }
  return Object.fromEntries(entries);
}

export class CodeActionProposalHandler {
  #enqueue;
  #getConfirmation;
  #invalidateConfirmation;
  #getCodeJob;
  #createGrant;
  #clock;
  #pollIntervalMs;

  constructor({
    confirmationProducer,
    codeJobReader,
    grantFactory,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    const confirmation = requirePort(
      confirmationProducer,
      ["enqueue", "get", "invalidate"],
      "confirmationProducer",
    );
    this.#enqueue = confirmation.enqueue;
    this.#getConfirmation = confirmation.get;
    this.#invalidateConfirmation = confirmation.invalidate;
    this.#getCodeJob = requirePort(codeJobReader, ["get"], "codeJobReader").get;
    this.#createGrant = requirePort(
      grantFactory,
      ["create"],
      "grantFactory",
    ).create;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#pollIntervalMs = positiveInteger(
      pollIntervalMs,
      "pollIntervalMs",
      MAX_POLL_INTERVAL_MS,
    );
  }

  async handle(value) {
    const input = normalizeHandlerInput(value);
    let existingItem = null;
    let existingValue = null;
    if (input.downstreamRef !== null) {
      existingValue = await this.#getConfirmation(input.downstreamRef);
      existingItem = normalizeOwnedConfirmationItem(
        existingValue,
        input.proposal,
        input.downstreamRef,
      );
    }
    let authority;
    try {
      authority = await this.#createGrant(
        cloneWorkProposalValue(input.proposal),
      );
    } catch (error) {
      if (AUTHORIZATION_ERROR_CODES.has(error?.code)) {
        const owned =
          existingItem ??
          (await this.#findOwnedConfirmation(input.proposal));
        if (owned) {
          return this.#invalidateChangedAuthorization(owned, input.proposal);
        }
      }
      throw error;
    }
    const plan = createCodeActionProposalConfirmationPlan(
      input.proposal,
      authority,
    );
    const expected = normalizeConfirmationPlan(plan);
    const grant = expected.action.grant;
    const confirmationId = expected.id;
    const jobId = codeJobIdForGrant(grant);

    if (
      existingItem !== null &&
      (input.downstreamRef !== confirmationId ||
        existingItem.approvalBindingDigest !==
          expected.approvalBindingDigest)
    ) {
      return this.#invalidateChangedAuthorization(
        existingItem,
        input.proposal,
      );
    }

    if (input.status === "running") {
      return this.#pollJob(
        jobId,
        grant,
        { id: jobId, createdAt: null },
        confirmationId,
      );
    }

    if (input.status === "waiting_confirmation") {
      return this.#transitionConfirmation(
        normalizeConfirmationItem(existingValue, expected),
        grant,
      );
    }

    if (input.status === "waiting_retry" && input.downstreamRef !== null) {
      return this.#transitionConfirmation(
        normalizeConfirmationItem(existingValue, expected),
        grant,
      );
    }

    if (input.status !== "pending_delivery" && input.status !== "waiting_retry") {
      throw invalidProposal();
    }
    if (input.downstreamRef !== null) throw invalidProposal();
    let queued;
    try {
      queued = await this.#enqueue(plan);
    } catch (error) {
      if (error?.code !== "CONFIRMATION_ID_CONFLICT") throw error;
      const owned = normalizeOwnedConfirmationItem(
        await this.#getConfirmation(confirmationId),
        input.proposal,
        confirmationId,
      );
      return this.#invalidateChangedAuthorization(owned, input.proposal);
    }
    const item = normalizeConfirmationItem(queued, expected);
    return this.#transitionConfirmation(item, grant);
  }

  async #findOwnedConfirmation(proposal) {
    const id = codeJobConfirmationIdForProposal(proposal);
    let value;
    try {
      value = await this.#getConfirmation(id);
    } catch (error) {
      if (error?.code === "CONFIRMATION_NOT_FOUND") return null;
      throw error;
    }
    return normalizeOwnedConfirmationItem(value, proposal, id);
  }

  async #invalidateChangedAuthorization(item, proposal) {
    const invalidation = {
      requestedBy: proposal.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest,
      reason: "authorization_changed",
    };
    let current = item;
    if (
      item.status === "pending" ||
      (item.status === "failed" && item.failure?.retryable) ||
      item.status === "stale"
    ) {
      try {
        current = normalizeOwnedConfirmationItem(
          await this.#invalidateConfirmation(item.id, invalidation),
          proposal,
          item.id,
        );
      } catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_INVALIDATABLE") throw error;
        current = normalizeOwnedConfirmationItem(
          await this.#getConfirmation(item.id),
          proposal,
          item.id,
        );
      }
    }
    if (current.status === "pending") {
      throw invalidConfirmation("旧代码任务确认未能安全撤销");
    }
    const revoked =
      current.status === "stale" &&
      current.invalidation?.reason === "authorization_changed";
    return terminal(
      "stale",
      revoked
        ? "代码任务授权已变化，旧确认已撤销"
        : "代码任务授权已变化，旧确认结果已隔离",
      current,
      ["authorization_changed", `old_confirmation_status:${current.status}`],
    );
  }

  async #transitionConfirmation(item, grant) {
    if (["pending", "executing"].includes(item.status)) {
      return active(
        "waiting_confirmation",
        item.id,
        this.#clock,
        this.#pollIntervalMs,
      );
    }
    if (item.status === "completed") {
      return this.#pollJob(item.receipt.id, grant, item.receipt, item.id);
    }
    if (item.status === "rejected") {
      return terminal("rejected", "用户已拒绝本地代码任务", item);
    }
    if (item.status === "stale") {
      return terminal("stale", "本地代码任务提案已失效", item);
    }
    return confirmationFailureTransition(
      item,
      this.#clock,
      this.#pollIntervalMs,
    );
  }

  async #pollJob(jobId, grant, receipt, confirmationId) {
    const value = await this.#getCodeJob(jobId);
    if (value === null) throw invalidJob("已批准的本地代码任务不存在");
    const effectiveReceipt = {
      id: jobId,
      createdAt: receipt.createdAt ?? value.createdAt,
    };
    const job = normalizeCodeJobProjection(value, grant, effectiveReceipt);
    if (ACTIVE_CODE_JOB_STATUSES.has(job.status)) {
      return active(
        "running",
        confirmationId,
        this.#clock,
        this.#pollIntervalMs,
      );
    }
    const evidence = [
      `code-job:${job.jobId}`,
      `code-job-status:${job.status}`,
      ...(job.memoryProjection === null
        ? []
        : [`memory:${job.memoryProjection.recordId}`]),
    ];
    if (job.status === "completed") {
      return terminal(
        "succeeded",
        "本地代码任务已完成并通过可信检查",
        { id: confirmationId },
        evidence,
      );
    }
    if (job.status === "failed") {
      return terminal(
        "failed",
        "本地代码任务执行失败",
        { id: confirmationId },
        evidence,
      );
    }
    return terminal(
      "unknown",
      "本地代码任务因安全边界被隔离",
      { id: confirmationId },
      evidence,
    );
  }
}

export function createCodeActionProposalRunnerService(value = {}) {
  const options = factoryOptions(value);
  if (options.enabled === undefined || options.enabled === false) return null;
  if (options.enabled !== true) {
    throw new TypeError("Code proposal runner enabled flag is invalid");
  }
  const handler = new CodeActionProposalHandler({
    confirmationProducer: options.confirmationProducer,
    codeJobReader: options.codeJobReader,
    grantFactory: options.grantFactory,
    clock: options.clock,
    pollIntervalMs: options.pollIntervalMs,
  });
  return new WorkProposalRunnerService({
    runner: options.runner,
    handler,
    clock: options.clock,
    leaseDurationMs: options.leaseDurationMs,
    handlerTimeoutMs: options.handlerTimeoutMs,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    defaultBatchLimit: options.defaultBatchLimit,
  });
}
