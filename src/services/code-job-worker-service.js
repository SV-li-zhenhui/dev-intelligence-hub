import { digestValue } from "../domain/code-executor-contract.js";
import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { packCodeJobBrainContext } from "./code-job-context-packer.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const RUNNABLE_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "fenced"]);
const EXECUTOR_TERMINAL_ACTIONS = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);
const AUTHORITY_ERROR_CODES = new Set(["INVALID_CODE_JOB_AUTHORITY"]);
const FENCING_EXECUTOR_CODES = new Set([
  "CODE_JOB_AUTHORITY_PROTOCOL_ERROR",
  "CODE_JOB_ADMISSION_MISSING",
  "CODE_JOB_AUDIT_RESULT_INVALID",
  "CODE_JOB_EXECUTOR_RESULT_INVALID",
  "CODE_JOB_PENDING_ACTION_MISSING",
  "CODE_JOB_SESSION_BINDING_INVALID",
  "CODE_JOB_SESSION_DIVERGED",
  "CODE_JOB_SESSION_NOT_ACTIVE",
  "CODE_JOB_WORKSPACE_DIVERGED",
  "EXECUTOR_STATE_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "SESSION_NOT_FOUND",
  "WORKSPACE_NOT_CONFIGURED",
  "PROFILE_CONFIG_CHANGED",
  "SOURCE_REVISION_CHANGED",
  "REPLAY_ARTIFACT_INVALID",
  "REPLAY_DIVERGED",
]);
const RESTART_REQUIRED_CODES = new Set(["EXECUTION_FENCED"]);
const DETERMINISTIC_FAILURE_CODES = new Set([
  "CODE_BRAIN_CONTEXT_TOO_LARGE",
  "CODE_BRAIN_CONTEXT_UNFIT",
]);
const OPERATOR_PAUSE_CODES = new Set([
  "BRAIN_PROVIDER_NOT_CONFIGURED",
  "CODE_BRAIN_ACTION_NOT_PERMITTED",
  "CODE_BRAIN_CHECKS_ALREADY_PASSED",
  "CODE_BRAIN_COMPLETION_NOT_READY",
  "CODE_BRAIN_PATH_INVALID",
  "CODE_BRAIN_ROLE_NOT_CONFIGURED",
  "CODE_BRAIN_RESPONSE_INVALID",
  "CODE_BRAIN_WRITE_NOT_PERMITTED",
  "REMOTE_DATA_NOT_AUTHORIZED",
]);
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export class CodeJobWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodeJobWorkerError";
    this.code = code;
  }
}

function workerError(code, message, options) {
  return new CodeJobWorkerError(code, message, options);
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeCycleOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !["limit", "roleId"].includes(key))
  ) {
    throw new TypeError("code job worker options are invalid");
  }
  const roleId = value.roleId ?? null;
  if (
    roleId !== null &&
    (typeof roleId !== "string" || !SAFE_ROLE_ID.test(roleId))
  ) {
    throw new TypeError("code job worker roleId is invalid");
  }
  return {
    limit: positiveInteger(value.limit ?? 10, "code job worker limit", 100),
    roleId,
  };
}

function selectCycleCandidates(
  reconcilable,
  runnable,
  limit,
  preferReconcilable,
) {
  const selected = [];
  let reconciliationIndex = 0;
  let runnableIndex = 0;
  let preferReconciliation = preferReconcilable;
  while (
    selected.length < limit &&
    (reconciliationIndex < reconcilable.length || runnableIndex < runnable.length)
  ) {
    const canReconcile = reconciliationIndex < reconcilable.length;
    const canRun = runnableIndex < runnable.length;
    if ((preferReconciliation && canReconcile) || !canRun) {
      selected.push(reconcilable[reconciliationIndex]);
      reconciliationIndex += 1;
    } else {
      selected.push(runnable[runnableIndex]);
      runnableIndex += 1;
    }
    if (canReconcile && canRun) {
      preferReconciliation = !preferReconciliation;
    }
  }
  return { selected, preferReconcilable: preferReconciliation };
}

function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function cleanText(value, maximumBytes) {
  const clean = String(value ?? "").replace(INVALID_CONTROL, " ");
  const encoded = Buffer.from(clean, "utf8");
  if (encoded.length <= maximumBytes) return clean;
  return encoded
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function safeErrorCode(error, fallback = "CODE_JOB_WORKER_FAILED") {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : fallback;
}

function requiresOperatorPause(code) {
  return OPERATOR_PAUSE_CODES.has(code) || code.startsWith("STRUCTURED_PROVIDER_");
}

function sameValue(left, right) {
  try {
    return digestValue(left) === digestValue(right);
  } catch {
    return false;
  }
}

function normalizeSemanticPath(value, { allowRoot = false } = {}) {
  try {
    return normalizeWorkspacePath(value, { allowRoot });
  } catch (cause) {
    throw workerError("CODE_BRAIN_PATH_INVALID", "Code brain selected an unsafe path", {
      cause,
    });
  }
}

function compactManifestEntry(entry, kind) {
  const result = { path: cleanText(entry?.path, 1_024) };
  if (kind === "modified") {
    if (isSha256(entry?.beforeSha256)) result.beforeSha256 = entry.beforeSha256;
    if (isSha256(entry?.afterSha256)) result.afterSha256 = entry.afterSha256;
  } else if (isSha256(entry?.sha256)) {
    result.sha256 = entry.sha256;
  }
  return result;
}

function compactExecutorResult(action, result) {
  const error = result?.error
    ? {
        code: safeErrorCode(result.error, "ACTION_FAILED"),
        message: cleanText(result.error.message, 2_048),
      }
    : null;
  if (action.type === "list_files") {
    const files = Array.isArray(result) ? result : [];
    return {
      files: files.slice(0, 500).map((entry) => cleanText(entry, 1_024)),
      truncated: files.length > 500,
      error,
    };
  }
  if (action.type === "read_text") {
    const content = cleanText(result?.content, 64 * 1_024);
    return {
      path: cleanText(result?.path ?? action.path, 1_024),
      content,
      sha256: isSha256(result?.sha256) ? result.sha256 : null,
      bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : 0,
      truncated:
        Buffer.byteLength(String(result?.content ?? ""), "utf8") >
        Buffer.byteLength(content, "utf8"),
      error,
    };
  }
  if (action.type === "search_text") {
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    return {
      matches: matches.slice(0, 200).map((entry) => ({
        path: cleanText(entry?.path, 1_024),
        line: Number.isSafeInteger(entry?.line) ? entry.line : 0,
        column: Number.isSafeInteger(entry?.column) ? entry.column : 0,
        text: cleanText(entry?.text, 2_048),
      })),
      truncated: result?.truncated === true || matches.length > 200,
      error,
    };
  }
  if (action.type === "write_text") {
    return {
      path: cleanText(result?.path ?? action.path, 1_024),
      sha256: isSha256(result?.sha256) ? result.sha256 : null,
      bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : 0,
      error,
    };
  }
  if (action.type === "run_profile") {
    return {
      exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
      signal: result?.signal == null ? null : cleanText(result.signal, 64),
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
      timedOut: result?.timedOut === true,
      stdout: cleanText(result?.stdout, 16 * 1_024),
      stderr: cleanText(result?.stderr, 16 * 1_024),
      error,
    };
  }
  const manifest = result && typeof result === "object" ? result : {};
  const compacted = {};
  for (const kind of ["created", "modified", "deleted"]) {
    const entries = Array.isArray(manifest[kind]) ? manifest[kind] : [];
    compacted[kind] = entries
      .slice(0, 200)
      .map((entry) => compactManifestEntry(entry, kind));
    compacted[`${kind}Count`] = entries.length;
  }
  compacted.truncated = ["created", "modified", "deleted"].some(
    (kind) => compacted[`${kind}Count`] > compacted[kind].length,
  );
  compacted.manifestDigest = digestValue(manifest);
  compacted.error = error;
  return compacted;
}

function observationDetail(action, response, result) {
  return {
    schemaVersion: 1,
    executor: {
      sessionStatus: response.session.status,
      sessionAttemptNumber: response.session.attempt.number,
      actionStatus: response.action.status,
      actionAttemptNumber: response.action.attemptNumber,
    },
    result: compactExecutorResult(action, result),
  };
}

function trustedObservationAction(observation) {
  const action = observation?.action;
  if (
    !action ||
    typeof action !== "object" ||
    Array.isArray(action) ||
    action.type !== observation.actionType ||
    action.actionId !== observation.actionId ||
    digestValue(action) !== observation.actionDigest
  ) {
    throw workerError(
      "CODE_JOB_OBSERVATION_INVALID",
      "Persisted code job observation is not bound to its trusted action",
    );
  }
  return action;
}

function modelObservation(observation) {
  const action = trustedObservationAction(observation);
  const result = observation.detail.result ?? {};
  let detail;
  if (action.type === "list_files") {
    detail = { path: action.path, ...result };
  } else if (action.type === "read_text") {
    detail = {
      path: action.path,
      content: cleanText(result.content, 24 * 1_024),
      truncated: result.truncated === true,
      error: result.error ?? null,
    };
  } else if (action.type === "search_text") {
    detail = {
      path: action.path,
      query: action.query,
      matches: Array.isArray(result.matches) ? result.matches.slice(0, 100) : [],
      truncated: result.truncated === true,
      error: result.error ?? null,
    };
  } else if (action.type === "write_text") {
    detail = {
      path: action.path,
      bytes: result.bytes ?? 0,
      error: result.error ?? null,
    };
  } else if (action.type === "run_profile") {
    detail = {
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs ?? 0,
      timedOut: result.timedOut === true,
      stdout: cleanText(result.stdout, 8 * 1_024),
      stderr: cleanText(result.stderr, 8 * 1_024),
      error: result.error ?? null,
    };
  } else {
    detail = {
      created: (result.created ?? []).map(({ path }) => ({ path })),
      modified: (result.modified ?? []).map(({ path }) => ({ path })),
      deleted: (result.deleted ?? []).map(({ path }) => ({ path })),
      truncated: result.truncated === true,
      error: result.error ?? null,
    };
  }
  return {
    actionType: observation.actionType,
    status: observation.status === "succeeded" ? "succeeded" : "failed",
    detail: cleanText(JSON.stringify(detail), 30 * 1_024),
  };
}

function assertSessionBinding(job, session) {
  const expectedProfiles = job.grant.requiredProfiles.map(({ id }) => id).sort();
  const actualProfiles = Array.isArray(session?.requiredProfiles)
    ? [...session.requiredProfiles].sort()
    : [];
  if (
    session?.id !== job.jobId ||
    session.workspaceId !== job.grant.workspaceId ||
    !sameValue(session.requestedBy, job.grant.requestedBy) ||
    !sameValue(actualProfiles, expectedProfiles) ||
    !isSha256(session.workspaceRevision) ||
    !Number.isSafeInteger(session.attempt?.number) ||
    session.attempt.number < 1
  ) {
    throw workerError(
      "CODE_JOB_SESSION_BINDING_INVALID",
      "Controlled executor session does not match the sealed code job",
    );
  }
  return session;
}

function successfulProfiles(job, session) {
  const result = new Set();
  for (const observation of job.execution.observations) {
    if (
      observation.actionType !== "run_profile" ||
      observation.status !== "succeeded" ||
      observation.workspaceRevision !== session.workspaceRevision
    ) {
      continue;
    }
    const action = trustedObservationAction(observation);
    if (
      observation.detail?.executor?.actionAttemptNumber === session.attempt.number &&
      job.grant.requiredProfiles.some(({ id }) => id === action.profileId)
    ) {
      result.add(action.profileId);
    }
  }
  return result;
}

function expectedWriteSha(job, path, workspaceRevision) {
  for (let index = job.execution.observations.length - 1; index >= 0; index -= 1) {
    const observation = job.execution.observations[index];
    if (
      observation.status !== "succeeded" ||
      observation.workspaceRevision !== workspaceRevision ||
      observation.actionType !== "read_text"
    ) {
      continue;
    }
    const action = trustedObservationAction(observation);
    const sha256 = observation.detail?.result?.sha256;
    if (action.path === path && isSha256(sha256)) return sha256;
  }
  return null;
}

function actionId(job, semanticAction) {
  const digest = digestValue({
    schemaVersion: 1,
    jobId: job.jobId,
    turn: job.execution.turn + 1,
    semanticAction,
  });
  return `action-${digest.slice(0, 55)}`;
}

function bindTrustedAction(job, session, semanticAction, remainingProfiles) {
  if (!job.grant.allowedActions.includes(semanticAction.type)) {
    throw workerError(
      "CODE_BRAIN_ACTION_NOT_PERMITTED",
      "Code brain selected an action outside the sealed grant",
    );
  }
  const common = {
    type: semanticAction.type,
    actionId: actionId(job, semanticAction),
    expectedWorkspaceRevision: session.workspaceRevision,
  };
  if (semanticAction.type === "list_files") {
    return {
      ...common,
      path: normalizeSemanticPath(semanticAction.path, { allowRoot: true }),
    };
  }
  if (semanticAction.type === "read_text") {
    return { ...common, path: normalizeSemanticPath(semanticAction.path) };
  }
  if (semanticAction.type === "search_text") {
    return {
      ...common,
      path: normalizeSemanticPath(semanticAction.path, { allowRoot: true }),
      query: semanticAction.query,
    };
  }
  if (semanticAction.type === "write_text") {
    const path = normalizeSemanticPath(semanticAction.path);
    const writable = job.grant.writablePaths.some(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    );
    if (!writable) {
      throw workerError(
        "CODE_BRAIN_WRITE_NOT_PERMITTED",
        "Code brain selected a path outside the sealed write scope",
      );
    }
    return {
      ...common,
      path,
      content: semanticAction.content,
      expectedSha256: expectedWriteSha(
        job,
        path,
        session.workspaceRevision,
      ),
    };
  }
  if (semanticAction.type === "run_profile") {
    if (remainingProfiles.length === 0) {
      throw workerError(
        "CODE_BRAIN_CHECKS_ALREADY_PASSED",
        "No trusted test profile remains",
      );
    }
    return { ...common, profileId: remainingProfiles[0].id };
  }
  if (remainingProfiles.length !== 0) {
    throw workerError(
      "CODE_BRAIN_COMPLETION_NOT_READY",
      "Required trusted checks have not passed",
    );
  }
  return common;
}

function terminalResult(job, action, detail, workspaceRevision) {
  const result = detail?.result ?? {};
  return {
    schemaVersion: 1,
    outcome: job.grant.summary,
    evidence: [...job.grant.evidence],
    checks: job.grant.requiredProfiles.map(({ id }) => id),
    workspaceRevision,
    manifest: result,
    completedActionId: action.actionId,
  };
}

function normalizeActionResponse(pending, response) {
  if (
    !response ||
    typeof response !== "object" ||
    response.action?.id !== pending.actionId ||
    response.action.type !== pending.action.type ||
    response.action.workspaceRevisionBefore !==
      pending.action.expectedWorkspaceRevision ||
    !EXECUTOR_TERMINAL_ACTIONS.has(response.action.status) ||
    !isSha256(response.session?.workspaceRevision)
  ) {
    throw workerError(
      "CODE_JOB_EXECUTOR_RESULT_INVALID",
      "Controlled executor returned an invalid action result",
    );
  }
  return response;
}

export class CodeJobWorkerService {
  #jobs;
  #executor;
  #brain;
  #verifyGrant;
  #queue;
  #maxTurns;
  #observationLimit;
  #runnableCursor;
  #reconcilableCursor;
  #preferReconcilable;

  constructor({
    jobStore,
    executor,
    brainDirectory,
    grantVerifier,
    operationQueue = new OperationQueue(),
    maxTurns = 64,
    observationLimit = 20,
  } = {}) {
    this.#jobs = requirePort(
      jobStore,
      [
        "listRunnable",
        "listReconcilable",
        "getForWorker",
        "claimStarting",
        "activate",
        "acknowledgeAbsentSession",
        "acknowledgeStartedSession",
        "prepareAction",
        "admitAction",
        "acknowledgeAbsentAction",
        "markActionUnknown",
        "recordObservation",
        "pause",
        "complete",
        "fail",
        "fence",
      ],
      "code job worker store",
    );
    this.#executor = requirePort(
      executor,
      [
        "start",
        "view",
        "resume",
        "perform",
        "getActionResult",
        "reconcileAction",
      ],
      "controlled code executor",
    );
    this.#brain = requirePort(brainDirectory, ["decide"], "code job brain");
    this.#verifyGrant = requirePort(
      grantVerifier,
      ["verify"],
      "code job grant verifier",
    ).verify;
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("code job worker queue is invalid");
    }
    this.#queue = operationQueue;
    this.#maxTurns = positiveInteger(maxTurns, "maxTurns", 128);
    this.#observationLimit = positiveInteger(
      observationLimit,
      "observationLimit",
      100,
    );
    this.#runnableCursor = 0;
    this.#reconcilableCursor = 0;
    this.#preferReconcilable = true;
    Object.freeze(this);
  }

  runCycle(value = {}) {
    const options = normalizeCycleOptions(value);
    return this.#queue.enqueue(() => this.#runCycle(options));
  }

  async #runCycle(options) {
    const query = {
      limit: options.limit,
      ...(options.roleId === null ? {} : { roleId: options.roleId }),
    };
    const reconcilable = await this.#jobs.listReconcilable({
      ...query,
      afterSequence: this.#reconcilableCursor,
    });
    const runnable = await this.#jobs.listRunnable({
      ...query,
      afterSequence: this.#runnableCursor,
    });
    const selection = selectCycleCandidates(
      reconcilable.items,
      runnable.items,
      options.limit,
      this.#preferReconcilable,
    );
    this.#preferReconcilable = selection.preferReconcilable;
    const selected = { items: selection.selected };
    const lastReconcilable = selected.items.findLast(
      ({ status }) => status === "unknown",
    );
    const lastRunnable = selected.items.findLast(
      ({ status }) => status !== "unknown",
    );
    if (lastReconcilable) this.#reconcilableCursor = lastReconcilable.sequence;
    if (lastRunnable) this.#runnableCursor = lastRunnable.sequence;
    const outcomes = [];
    for (const selectedJob of selected.items) {
      try {
        outcomes.push(await this.#process(selectedJob.jobId));
      } catch (error) {
        outcomes.push(await this.#handleFailure(selectedJob.jobId, error));
      }
    }
    return {
      selected: selected.items.length,
      processed: outcomes.length,
      succeeded: outcomes.filter(({ status }) => status === "completed").length,
      fenced: outcomes.filter(({ status }) => status === "fenced").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      outcomes,
    };
  }

  async #process(jobId) {
    let job = await this.#requireRunnableJob(jobId);
    if (job.status === "unknown") {
      return this.#reconcileUnknown(job);
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return { jobId, status: job.status, actionType: null };
    }

    if (job.status === "queued") {
      job = (await this.#jobs.claimStarting({
        jobId,
        expectedRevision: job.revision,
      })).job;
    }

    if (job.status === "starting") {
      await this.#verifyAuthority(job.grant);
      let session = await this.#viewOptionalSession(job.jobId);
      if (session === null) {
        await this.#verifyAuthority(job.grant);
        session = await this.#executor.start({
          sessionId: job.jobId,
          workspaceId: job.grant.workspaceId,
          requestedBy: job.grant.requestedBy,
        });
      }
      let current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      if (session.status === "interrupted") {
        await this.#verifyAuthority(job.grant);
        session = await this.#executor.resume({ sessionId: job.jobId });
      }
      current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      if (session.status === "failed") {
        return this.#finishFailed(job, session.error);
      }
      if (session.status !== "active") {
        throw workerError(
          "CODE_JOB_SESSION_NOT_ACTIVE",
          "Controlled executor did not activate the claimed session",
        );
      }
      assertSessionBinding(job, session);
      job = (await this.#jobs.activate({
        jobId,
        expectedRevision: job.revision,
        workspaceRevision: session.workspaceRevision,
      })).job;
    }

    if (job.status === "pausing") {
      if (job.execution.pause?.from === "starting") {
        return this.#reconcileStartingPause(job);
      }
      if (job.execution.pendingAction === null) {
        throw workerError(
          "CODE_JOB_PENDING_ACTION_MISSING",
          "Pausing code job lost its admitted action",
        );
      }
      return this.#continuePending(job);
    }
    if (job.status !== "active") {
      return { jobId, status: job.status, actionType: null };
    }
    if (job.execution.pendingAction !== null) {
      return this.#continuePending(job);
    }

    const durableObservation = job.execution.observations.at(-1);
    if (
      durableObservation?.actionType === "complete" &&
      durableObservation.status === "succeeded"
    ) {
      return this.#completeObservedJob(job, durableObservation);
    }

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (session.status === "completed") {
      return this.#recoverCompleted(job, session);
    }
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      session = await this.#executor.resume({ sessionId: job.jobId });
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for another action",
      );
    }
    assertSessionBinding(job, session);
    if (job.execution.workspaceRevision !== session.workspaceRevision) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Code job and controlled executor workspace revisions diverged",
      );
    }

    if (job.execution.turn >= this.#maxTurns) {
      return this.#finishFailed(job, {
        code: "CODE_JOB_TURN_LIMIT",
        message: "Code job reached its configured turn limit",
      });
    }

    const passedProfiles = successfulProfiles(job, session);
    const remainingProfiles = job.grant.requiredProfiles.filter(
      ({ id }) => !passedProfiles.has(id),
    );
    const observations = job.execution.observations
      .slice(-this.#observationLimit)
      .map(modelObservation);
    await this.#verifyAuthority(job.grant);
    const brainContext = packCodeJobBrainContext({
      task: {
        operation: job.grant.operation,
        repository: job.grant.repository,
        objective: job.grant.objective,
        acceptanceCriteria: job.grant.acceptanceCriteria,
        evidence: job.grant.evidence,
      },
      capabilities: {
        allowedActions: job.grant.allowedActions,
        writablePaths: job.grant.writablePaths,
        requiredProfilesRemaining: remainingProfiles.length,
      },
      turn: job.execution.turn + 1,
      observations,
    });
    const decision = await this.#brain.decide(
      {
        roleId: job.grant.requestedBy.roleId,
        ...brainContext,
      },
      {
        beforeGenerate: () => this.#verifyAuthority(job.grant),
      },
    );
    const action = bindTrustedAction(
      job,
      session,
      decision.action,
      remainingProfiles,
    );
    await this.#verifyAuthority(job.grant);
    job = (await this.#jobs.prepareAction({
      jobId,
      expectedRevision: job.revision,
      action,
    })).job;
    await this.#verifyAuthority(job.grant);
    return this.#performPending(job, session);
  }

  async #reconcileStartingPause(job, knownSession = null) {
    const session = knownSession ?? await this.#viewOptionalSession(job.jobId);
    if (session === null) {
      const changed = await this.#jobs.acknowledgeAbsentSession({
        jobId: job.jobId,
        expectedRevision: job.revision,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (!["active", "interrupted"].includes(session.status)) {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Admitted session start is still being reconciled",
      );
    }
    assertSessionBinding(job, session);
    const changed = await this.#jobs.acknowledgeStartedSession({
      jobId: job.jobId,
      expectedRevision: job.revision,
      workspaceRevision: session.workspaceRevision,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
    };
  }

  async #continuePending(job) {
    let authorityError = null;
    if (job.status !== "pausing") {
      try {
        await this.#verifyAuthority(job.grant);
      } catch (error) {
        authorityError = error;
      }
    }

    if (
      authorityError !== null &&
      job.execution.actionAdmission === null
    ) {
      throw authorityError;
    }

    let reconciled;
    try {
      reconciled = await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: job.execution.pendingAction.action,
      });
    } catch (error) {
      if (authorityError && error?.code === "SESSION_NOT_FOUND") {
        throw authorityError;
      }
      throw error;
    }

    if (reconciled.status === "running") {
      throw workerError(
        "CODE_JOB_ACTION_BUSY",
        "Prepared action is still running in the controlled executor",
      );
    }
    if (reconciled.status === "terminal") {
      const outcome = await this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
      if (authorityError && outcome.status !== "completed") {
        throw authorityError;
      }
      return outcome;
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid reconciliation result",
      );
    }
    if (job.status === "pausing") {
      const admission = job.execution.actionAdmission;
      if (admission === null) {
        throw workerError(
          "CODE_JOB_ADMISSION_MISSING",
          "Pausing code job lost its action admission",
        );
      }
      const changed = await this.#jobs.acknowledgeAbsentAction({
        jobId: job.jobId,
        expectedRevision: job.revision,
        actionId: admission.actionId,
        actionDigest: admission.actionDigest,
        epoch: admission.epoch,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    if (authorityError) throw authorityError;

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      session = await this.#executor.resume({ sessionId: job.jobId });
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for a prepared action",
      );
    }
    assertSessionBinding(job, session);
    return this.#performPending(job, session);
  }

  async #reconcileUnknown(job) {
    const pending = job.execution.pendingAction;
    const admission = job.execution.actionAdmission;
    if (pending === null || admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    const reconciled = await this.#executor.reconcileAction({
      sessionId: job.jobId,
      action: pending.action,
    });
    if (reconciled.status === "running") {
      return {
        jobId: job.jobId,
        status: "unknown",
        actionType: pending.action.type,
      };
    }
    if (reconciled.status === "terminal") {
      if (reconciled.action?.status === "interrupted") {
        const interrupted = normalizeActionResponse(pending, reconciled);
        assertSessionBinding(job, interrupted.session);
        if (
          interrupted.action.workspaceRevisionAfter !== null ||
          interrupted.session.workspaceRevision !==
            job.execution.workspaceRevision
        ) {
          throw workerError(
            "CODE_JOB_WORKSPACE_DIVERGED",
            "Interrupted action recovery does not match the trusted workspace",
          );
        }
        let recoveredSession = interrupted.session;
        if (recoveredSession.status === "interrupted") {
          recoveredSession = await this.#executor.resume({
            sessionId: job.jobId,
          });
          assertSessionBinding(job, recoveredSession);
        }
        if (
          recoveredSession.status !== "active" ||
          recoveredSession.workspaceRevision !== job.execution.workspaceRevision ||
          recoveredSession.attempt.number <= interrupted.action.attemptNumber
        ) {
          throw workerError(
            "CODE_JOB_SESSION_DIVERGED",
            "Interrupted action did not recover into a later trusted attempt",
          );
        }
        return this.#performPending(job, recoveredSession, {
          reconcileExisting: true,
          reconciled: { ...reconciled, session: recoveredSession },
          acceptInterrupted: true,
        });
      }
      return this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid unknown-action reconciliation",
      );
    }
    const changed = await this.#jobs.acknowledgeAbsentAction({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: admission.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: pending.action.type,
    };
  }

  async #performPending(
    job,
    session,
    {
      reconcileExisting = false,
      reconciled = null,
      acceptInterrupted = false,
    } = {},
  ) {
    const pending = job.execution.pendingAction;
    if (pending === null) {
      throw workerError(
        "CODE_JOB_PENDING_ACTION_MISSING",
        "Code job lost its prepared action before execution",
      );
    }
    if (
      !reconcileExisting &&
      pending.action.expectedWorkspaceRevision !== session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Prepared action no longer matches the controlled workspace revision",
      );
    }
    let result;
    let response;
    if (reconcileExisting) {
      const current = reconciled ?? await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: pending.action,
      });
      if (current.status === "absent") {
        throw workerError(
          "CODE_JOB_SESSION_DIVERGED",
          "Executor lost an action that was already observed",
        );
      }
      if (current.status === "running") {
        throw workerError(
          "CODE_JOB_ACTION_BUSY",
          "Prepared action is still running in the controlled executor",
        );
      }
      response = normalizeActionResponse(pending, current);
      result = current.result;
    } else {
      const fresh = await this.#jobs.getForWorker(job.jobId);
      if (
        fresh?.status !== "active" ||
        fresh.execution.pendingAction?.actionDigest !== pending.actionDigest
      ) {
        return {
          jobId: job.jobId,
          status: fresh?.status ?? "missing",
          actionType: null,
        };
      }
      job = fresh;
      await this.#verifyAuthority(job.grant);
      job = (await this.#jobs.admitAction({
        jobId: job.jobId,
        expectedRevision: job.revision,
        actionId: pending.actionId,
        actionDigest: pending.actionDigest,
      })).job;
      response = normalizeActionResponse(
        pending,
        await this.#executor.perform({
          sessionId: job.jobId,
          action: pending.action,
        }),
      );
    }
    assertSessionBinding(job, response.session);
    if (
      !reconcileExisting &&
      ["succeeded", "failed"].includes(response.action.status)
    ) {
      const audited = await this.#executor.getActionResult({
        sessionId: job.jobId,
        actionId: pending.actionId,
      });
      if (
        audited?.action?.id !== response.action.id ||
        audited.action.type !== response.action.type ||
        audited.action.status !== response.action.status ||
        audited.action.workspaceRevisionBefore !==
          pending.action.expectedWorkspaceRevision
      ) {
        throw workerError(
          "CODE_JOB_AUDIT_RESULT_INVALID",
          "Audited executor result does not match the performed action",
        );
      }
      response = { ...response, action: audited.action };
      result = audited.result;
    } else if (!reconcileExisting) {
      result = { error: response.action.error };
    }
    const status = response.action.status;
    if (
      response.action.workspaceRevisionAfter !== null &&
      response.action.workspaceRevisionAfter !== response.session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Executor action result is bound to a different workspace revision",
      );
    }
    if (status === "interrupted" && !acceptInterrupted) {
      throw workerError(
        safeErrorCode(response.action.error, "CODE_JOB_ACTION_INTERRUPTED"),
        "Controlled executor reported an uncertain action result",
      );
    }
    const detail = observationDetail(pending.action, response, result);
    const latest = await this.#jobs.getForWorker(job.jobId);
    if (
      !latest ||
      !["active", "pausing", "unknown"].includes(latest.status) ||
      latest.execution.pendingAction?.actionDigest !== pending.actionDigest
    ) {
      return {
        jobId: job.jobId,
        status: latest?.status ?? "missing",
        actionType: null,
      };
    }
    job = latest;
    const admission = latest.status === "unknown"
      ? latest.execution.actionAdmission
      : null;
    if (latest.status === "unknown" && admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    job = (await this.#jobs.recordObservation({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: pending.actionId,
      status,
      workspaceRevision: response.session.workspaceRevision,
      detail,
      ...(admission === null
        ? {}
        : {
            actionDigest: admission.actionDigest,
            epoch: admission.epoch,
          }),
    })).job;
    if (pending.action.type === "complete" && status === "succeeded") {
      job = (await this.#jobs.complete({
        jobId: job.jobId,
        expectedRevision: job.revision,
        result: terminalResult(
          job,
          pending.action,
          detail,
          response.session.workspaceRevision,
        ),
      })).job;
      return { jobId: job.jobId, status: "completed", actionType: "complete" };
    }
    return {
      jobId: job.jobId,
      status: job.status,
      actionType: pending.action.type,
    };
  }

  async #recoverCompleted(job, session) {
    assertSessionBinding(job, session);
    if (job.execution.pendingAction !== null) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion has no matching terminal action to reconcile",
      );
    }
    const observation = job.execution.observations.at(-1);
    if (
      observation?.actionType !== "complete" ||
      observation.status !== "succeeded"
    ) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion is missing its durable code job observation",
      );
    }
    return this.#completeObservedJob(job, observation);
  }

  async #completeObservedJob(job, observation) {
    trustedObservationAction(observation);
    job = (await this.#jobs.complete({
      jobId: job.jobId,
      expectedRevision: job.revision,
      result: terminalResult(
        job,
        observation.action,
        observation.detail,
        observation.workspaceRevision,
      ),
    })).job;
    return { jobId: job.jobId, status: "completed", actionType: "complete" };
  }

  async #finishFailed(job, error) {
    const result = {
      schemaVersion: 1,
      code: safeErrorCode(error),
      message: cleanText(error?.message ?? "Code job execution failed", 2_048),
    };
    const current = await this.#jobs.getForWorker(job.jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return { jobId: job.jobId, status: current?.status ?? "missing", actionType: null };
    }
    const changed = await this.#jobs.fail({
      jobId: job.jobId,
      expectedRevision: current.revision,
      result,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
      code: result.code,
    };
  }

  async #handleFailure(jobId, error) {
    const code = safeErrorCode(error);
    let current;
    try {
      current = await this.#jobs.getForWorker(jobId);
    } catch (readError) {
      return {
        jobId,
        status: "retry",
        actionType: null,
        code,
        readCode: safeErrorCode(readError),
      };
    }
    if (current?.status === "unknown") {
      return {
        jobId,
        status: "unknown",
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    const admission = current?.execution?.actionAdmission ?? null;
    const pending = current?.execution?.pendingAction ?? null;
    if (admission !== null && pending !== null) {
      try {
        const changed = await this.#jobs.markActionUnknown({
          jobId,
          expectedRevision: current.revision,
          actionId: admission.actionId,
          actionDigest: admission.actionDigest,
          epoch: admission.epoch,
          code,
          message: "受控动作结果无法确认，必须先与执行器对账",
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: pending.action.type,
          code,
        };
      } catch (unknownError) {
        const latest = await this.#jobs.getForWorker(jobId);
        return {
          jobId,
          status: latest?.status === "unknown" ? "unknown" : "retry",
          actionType: latest?.execution?.pendingAction?.action.type ?? null,
          code,
          unknownCode: safeErrorCode(unknownError),
        };
      }
    }
    if (RESTART_REQUIRED_CODES.has(code)) {
      return {
        jobId,
        status: "restart_required",
        actionType: current?.execution?.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (
      DETERMINISTIC_FAILURE_CODES.has(code) &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      return this.#finishFailed(current, error);
    }
    if (
      requiresOperatorPause(code) &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      if (["pausing", "paused"].includes(current.status)) {
        return {
          jobId,
          status: current.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      }
      try {
        const changed = await this.#jobs.pause({
          jobId,
          expectedRevision: current.revision,
          reason: `等待人工处理（${code}）`,
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      } catch (pauseError) {
        return {
          jobId,
          status: "retry",
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
          pauseCode: safeErrorCode(pauseError),
        };
      }
    }
    if (
      current &&
      ["pausing", "paused"].includes(current.status) &&
      ["CODE_JOB_REVISION_CONFLICT", "CODE_JOB_TRANSITION_CONFLICT"].includes(
        code,
      )
    ) {
      return {
        jobId,
        status: current.status,
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (AUTHORITY_ERROR_CODES.has(code) || FENCING_EXECUTOR_CODES.has(code)) {
      try {
        if (current && !TERMINAL_STATUSES.has(current.status)) {
          const changed = await this.#jobs.fence({
            jobId,
            expectedRevision: current.revision,
            result: {
              schemaVersion: 1,
              code,
              message: cleanText(error?.message ?? "Code job was fenced", 2_048),
            },
          });
          return { jobId, status: changed.job.status, actionType: null, code };
        }
        return { jobId, status: current?.status ?? "missing", actionType: null, code };
      } catch (fenceError) {
        return {
          jobId,
          status: "retry",
          actionType: null,
          code,
          fenceCode: safeErrorCode(fenceError),
        };
      }
    }
    return { jobId, status: "retry", actionType: null, code };
  }

  async #requireRunnableJob(jobId) {
    const job = await this.#jobs.getForWorker(jobId);
    if (!job) {
      throw workerError("CODE_JOB_NOT_FOUND", "Selected code job no longer exists");
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return job;
    }
    return job;
  }

  async #verifyAuthority(grant) {
    const current = await this.#verifyGrant(grant);
    if (!sameValue(current, grant)) {
      throw workerError(
        "CODE_JOB_AUTHORITY_PROTOCOL_ERROR",
        "Grant verifier returned a different code job authority",
      );
    }
    return current;
  }

  async #viewOptionalSession(sessionId) {
    try {
      return await this.#executor.view({ sessionId });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
  }

}
