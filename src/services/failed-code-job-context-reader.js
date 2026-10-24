import { normalizeCodeJobBrowserProjection } from "../domain/code-job-browser-projection.js";
import { CODE_BRAIN_ACTION_TYPES } from "../domain/structured-code-action-contract.js";
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../domain/code-job-contract.js';
import { decodeVerificationRecoveryEvidence } from '../domain/verification-recovery-evidence.js';
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { roleContextError } from "./role-context-error.js";

const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const ACTION_TYPES = new Set(CODE_BRAIN_ACTION_TYPES);
const READONLY_ACTIONS = new Set(CODE_JOB_ACTIONS_BY_OPERATION.verify);
export const AUTOMATIC_INSPECTION_FAILURES = Object.freeze([
  "GIT_HEAD_UNAVAILABLE", "GIT_SNAPSHOT_TIMEOUT",
]);
export const VERIFICATION_RECOVERY_REASON = 'automatic_verification_preparation_settled';
export const VERIFICATION_RECOVERY_ACTOR = 'automatic-own-pr-verification-recovery';
export const AUTOMATIC_VERIFICATION_FAILURE = 'CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE';

function portMethod(port, method) {
  let owner = port;
  while (owner && (typeof owner === "object" || typeof owner === "function")) {
    const field = Object.getOwnPropertyDescriptor(owner, method);
    if (field) {
      if (!("value" in field) || typeof field.value !== "function") break;
      return field.value.bind(port);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`failed code job ${method} reader is invalid`);
}

function stale() {
  return roleContextError("ROLE_CONTEXT_CODE_JOB_STALE", "Previous code job no longer matches this task", 409);
}

function retryNote(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

// Read only the failed job named by the settled result. This is context for a
// new decision; it grants no workspace access, retry or publication authority.
export class FailedCodeJobContextReader {
  #getDetail;
  #listTimeline;

  constructor({ codeJobReader, ledger }) {
    this.#getDetail = portMethod(codeJobReader, "getDetail");
    this.#listTimeline = portMethod(ledger, "listTimeline");
  }

  async #readRetry(itemId, jobId, observedAfter, signal) {
    let cursor;
    const seen = new Set();
    while (true) {
      signal?.throwIfAborted();
      const page = await this.#listTimeline({ itemId, limit: 100, order: "newest",
        ...(cursor === undefined ? {} : { cursor }) });
      signal?.throwIfAborted();
      if (!Array.isArray(page.items) || page.items.length > 100) throw stale();
      const retry = page.items.find((entry) => entry.itemId === itemId &&
        entry.type === "transitioned" && (entry.actorId === "owner:local" ||
          (entry.actorId === "automatic-own-pr-inspection-recovery" &&
            entry.details?.reason === "automatic_inspection_objects_ready" &&
            AUTOMATIC_INSPECTION_FAILURES.includes(entry.details.context?.code)) ||
          (entry.actorId === VERIFICATION_RECOVERY_ACTOR && entry.details?.reason === VERIFICATION_RECOVERY_REASON &&
            entry.details.context?.code === AUTOMATIC_VERIFICATION_FAILURE)) &&
        entry.details?.toStatus === "queued" &&
        entry.details.context?.downstreamRef === jobId &&
        Date.parse(entry.at) > Date.parse(observedAfter));
      if (retry) return retry;
      if (page.nextCursor == null || page.items.length === 0 ||
          Date.parse(page.items.at(-1).at) <= Date.parse(observedAfter)) return null;
      if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) throw stale();
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async read({ itemId, inputBinding, decisionContext, signal }) {
    if (decisionContext?.source !== "proposal" || decisionContext.outcome !== "failed" ||
        decisionContext.value?.kind !== "code_action_proposal") return null;
    const expectedBinding = normalizePullRequestExecutionBinding(inputBinding);
    const evidence = decisionContext.value.evidence;
    if (!Array.isArray(evidence) || evidence.some((entry) => typeof entry !== "string")) throw stale();
    const jobs = evidence.filter((entry) => entry.startsWith("code-job:"));
    if (jobs.length === 0) return null; // A confirmation can fail before a job exists.
    if (jobs.length !== 1 || !JOB_ID.test(jobs[0].slice(9))) throw stale();
    const jobId = jobs[0].slice(9);
    signal?.throwIfAborted();
    let detail;
    let retry;
    try {
      [detail, retry] = await Promise.all([
        this.#getDetail({ jobId, limit: 20 }),
        this.#readRetry(itemId, jobId, decisionContext.observedAt, signal),
      ]);
    } catch (cause) {
      signal?.throwIfAborted();
      throw roleContextError("ROLE_CONTEXT_CODE_JOB_UNAVAILABLE", "Unable to read the failed code job", 503, { cause });
    }
    signal?.throwIfAborted();
    if (detail === null) throw stale();
    const job = normalizeCodeJobBrowserProjection(detail.job);
    const memory = evidence.filter((entry) => entry.startsWith("memory:"));
    if (job.jobId !== jobId || job.status !== "failed" || job.requestedBy.workItemId !== itemId ||
        job.inputBinding == null || !samePullRequestExecutionBinding(job.inputBinding, expectedBinding) ||
        memory.length !== 1 || memory[0] !== `memory:${job.memoryProjection?.recordId}`) throw stale();
    if (!Array.isArray(detail.observations) || detail.observations.length > 20) throw stale();
    const observedActions = detail.observations.map(({ actionType, status }) => {
      if (!ACTION_TYPES.has(actionType) || !["succeeded", "failed", "interrupted"].includes(status)) throw stale();
      return { actionType, status };
    });
    const failureCode = detail.terminalDetail?.code;
    const historyComplete = detail.historyAvailable === true && detail.nextCursor === null &&
      observedActions.length === job.observationCount;
    const recoveryEvidence = decodeVerificationRecoveryEvidence(retry?.details.context?.evidenceRefs);
    const recovery = retry?.actorId === VERIFICATION_RECOVERY_ACTOR && retry.details.reason === VERIFICATION_RECOVERY_REASON &&
      job.operation === 'verify' && job.writablePaths.length === 0 && failureCode === AUTOMATIC_VERIFICATION_FAILURE &&
      historyComplete && observedActions.every(action => READONLY_ACTIONS.has(action.actionType)) &&
      recoveryEvidence?.headRefOid === expectedBinding.headRefOid && job.requiredProfiles.includes(recoveryEvidence.profileId) ? {
        at: retry.at, reason: VERIFICATION_RECOVERY_REASON, failureCode, jobId,
        actionId: recoveryEvidence.actionId, executionId: recoveryEvidence.executionId,
        profileId: recoveryEvidence.profileId, profileConfigDigest: recoveryEvidence.profileConfigDigest,
        workspaceRevision: recoveryEvidence.workspaceRevision,
      } : null;
    return {
      jobId, status: job.status, operation: job.operation,
      failureCode: typeof failureCode === "string" && FAILURE_CODE.test(failureCode) ? failureCode : null,
      observedAt: job.terminalResult.recordedAt,
      observationCount: job.observationCount,
      observedActions,
      historyComplete,
      ownerRetry: retry?.actorId === "owner:local" ? {
        at: retry.at,
        reason: retryNote(retry.details.reason),
        note: retryNote(retry.details.context.note),
      } : null,
      automaticRecovery: retry?.actorId === "automatic-own-pr-inspection-recovery" &&
        job.operation === "inspect" && AUTOMATIC_INSPECTION_FAILURES.includes(failureCode) &&
        retry.details.context.code === failureCode &&
        historyComplete && job.observationCount === 0 ? {
          at: retry.at, reason: "automatic_inspection_objects_ready", failureCode, jobId,
        } : recovery,
    };
  }
}
