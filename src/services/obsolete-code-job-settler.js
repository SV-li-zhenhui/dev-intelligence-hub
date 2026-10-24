import { normalizeCodeJobGrant } from "../domain/code-job-contract.js";
import { normalizeCodeJobConfirmationResult } from "./code-job-confirmation-result.js";
import { isDeepStrictEqual } from "node:util";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "fenced"]);
const CANCELLATION_REASON = "PR source superseded";
const unstartedAuthorityFences = new WeakMap();
const stoppedAuthorityFences = new WeakMap();

export function hasUnstartedCodeJobAuthorityFence(job) {
  const proof = unstartedAuthorityFences.get(job);
  return proof !== undefined && isDeepStrictEqual(job, proof);
}

export function hasSettledCodeJobAuthorityFence(job) {
  const proof = stoppedAuthorityFences.get(job);
  return hasUnstartedCodeJobAuthorityFence(job) || (proof !== undefined && isDeepStrictEqual(job, proof));
}

function stoppedNativeRun(job, run) {
  const receipt = run?.receipt;
  const finishedAt = Date.parse(receipt?.finishedAt);
  return run?.active === false && run.mode === "active" && run.pendingCommand === null && run.stopUnconfirmed !== true &&
    run.kind === "code-job" && run.taskId === job.jobId && run.roleId === job.requestedBy.roleId &&
    receipt?.kind === "code-job" && receipt.taskId === job.jobId && receipt.roleId === run.roleId &&
    receipt.runId === run.runId && ["completed", "failed"].includes(receipt.phase) && receipt.stopConfirmed === true &&
    receipt.session?.transport === "app-server" && Number.isFinite(finishedAt);
}

function stoppedExecutor(job, session, observations) {
  const lastAction = Array.isArray(session?.actions) ? session.actions.at(-1) : null;
  if (!Array.isArray(session?.actions) || !Array.isArray(observations) || observations.length !== job.observationCount) return false;
  const observed = new Map(observations.map(entry => [entry.actionId, entry]));
  if (observed.size !== observations.length || new Set(session.actions.map(action => action.id)).size !== session.actions.length) return false;
  for (const action of session.actions) {
    const record = observed.get(action.id);
    if (!record || action.type !== record.actionType || action.status !== record.status ||
        action.workspaceRevisionAfter !== record.workspaceRevision) return false;
    observed.delete(action.id);
  }
  // The host can record a failed write that it rejected before executor
  // admission. That audited failure is not a missing or uncertain action.
  if ([...observed.values()].some(record => record.actionType !== "write_text" || record.status !== "failed" ||
      record.detail?.schemaVersion !== 1 || record.detail.origin !== "host_pre_execution_rejection" || record.detail.notExecuted !== true)) return false;
  return session?.id === job.jobId && session.workspaceId === job.workspaceId &&
    isDeepStrictEqual(session.requestedBy, job.requestedBy) && isDeepStrictEqual(session.inputBinding, job.inputBinding) &&
    isDeepStrictEqual(session.executionSource ?? null, job.executionSource ?? null) &&
    ["interrupted", "failed", "cancelled"].includes(session.status) &&
    ["interrupted", "failed", "cancelled"].includes(session.attempt?.status) && session.cleanupPending === false &&
    session.actions.length > 0 && job.turn === job.observationCount &&
    session.actions.every(action => ["succeeded", "failed"].includes(action.status)) &&
    /^[a-f0-9]{64}$/.test(session.workspaceRevision ?? "") && lastAction.workspaceRevisionAfter === session.workspaceRevision;
}

function admitImmediately(operation) {
  return { operation: operation() };
}

export class ObsoleteCodeJobSettler {
  #get;
  #cancel;
  #getDetail;
  #getRun;
  #viewSession;

  constructor({ codeJobReader, codeJobControl, taskRuns = null, codeExecutorReader = null } = {}) {
    if (typeof codeJobReader?.get !== "function" || typeof codeJobControl?.cancel !== "function") {
      throw new TypeError("Obsolete code job settlement requires reader and cancellation ports");
    }
    this.#get = codeJobReader.get.bind(codeJobReader);
    this.#cancel = codeJobControl.cancel.bind(codeJobControl);
    this.#getDetail = typeof codeJobReader.getDetail === "function"
      ? codeJobReader.getDetail.bind(codeJobReader) : null;
    if ((taskRuns !== null && typeof taskRuns?.get !== "function") ||
        (codeExecutorReader !== null && typeof codeExecutorReader?.view !== "function")) throw new TypeError("Invalid obsolete code job stop reader");
    this.#getRun = taskRuns?.get.bind(taskRuns) ?? null;
    this.#viewSession = codeExecutorReader?.view.bind(codeExecutorReader) ?? null;
  }

  async settle({ grant: value, receipt }, { admitCancellation = admitImmediately } = {}) {
    if (typeof admitCancellation !== "function") throw new TypeError("Cancellation admission is invalid");
    const grant = normalizeCodeJobGrant(value);
    const read = () => this.read({ grant, receipt });
    const job = await read();
    if (job === null || TERMINAL_STATUSES.has(job.status) || job.status === "cancelling") return job;
    // Cancellation uses the same stop/action reconciliation as owner controls.
    // A pending or unknown stop is never treated as a terminal settlement.
    const admitted = await admitCancellation(() => this.#cancel({
      jobId: job.jobId, expectedRevision: job.revision, reason: CANCELLATION_REASON,
    }));
    await admitted.operation;
    return read();
  }

  async #fencedHistory(job, grant, receipt) {
    const observations = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const detail = await this.#getDetail({ jobId: job.jobId, limit: 20, ...(cursor ? { cursor } : {}) });
      if (detail?.archived !== false || detail.historyAvailable !== true || detail.terminalDetail?.code !== "INVALID_CODE_JOB_AUTHORITY" ||
          !isDeepStrictEqual(job, normalizeCodeJobConfirmationResult(detail.job, grant, receipt)) ||
          !Array.isArray(detail.observations) || detail.observations.length > 20) return null;
      observations.push(...detail.observations);
      if (observations.length > job.observationCount) return null;
      if (detail.nextCursor === null) return observations.length === job.observationCount ? observations : null;
      if (typeof detail.nextCursor !== "string" || !detail.nextCursor || cursors.has(detail.nextCursor)) return null;
      cursors.add(detail.nextCursor); cursor = detail.nextCursor;
    }
    return null;
  }

  async #readRun(jobId) {
    try { return await this.#getRun("code-job", jobId); }
    catch (error) { if (error?.code === "TASK_RUN_NOT_FOUND") return null; throw error; }
  }

  async #readSession(jobId) {
    try { return await this.#viewSession({ sessionId: jobId }); }
    catch (error) { if (error?.code === "SESSION_NOT_FOUND") return null; throw error; }
  }

  async read({ grant: value, receipt }) {
    const grant = normalizeCodeJobGrant(value);
    const valueFromStore = await this.#get(receipt.id);
    if (valueFromStore === null) return null;
    const job = normalizeCodeJobConfirmationResult(valueFromStore, grant, receipt);
    if (this.#getDetail !== null && job.status === "fenced" && job.turn === 0 &&
        job.observationCount === 0 && job.latestObservation === null &&
        job.pendingActionType === null && job.uncertainty === null) {
      const detail = await this.#getDetail({ jobId: job.jobId, limit: 1 });
      if (detail?.archived === false && detail.historyAvailable === true &&
          detail.nextCursor === null && Array.isArray(detail.observations) && detail.observations.length === 0 &&
          detail.terminalDetail?.code === "INVALID_CODE_JOB_AUTHORITY" &&
          isDeepStrictEqual(job, normalizeCodeJobConfirmationResult(detail.job, grant, receipt))) {
        unstartedAuthorityFences.set(job, structuredClone(job));
      }
    }
    if (this.#getDetail !== null && this.#getRun !== null && this.#viewSession !== null && job.status === "fenced" &&
        job.turn > 0 && job.pendingActionType === null && job.uncertainty === null) {
      const run = await this.#readRun(job.jobId);
      if (!stoppedNativeRun(job, run)) return job;
      const observations = await this.#fencedHistory(job, grant, receipt);
      if (observations === null) return job;
      const session = await this.#readSession(job.jobId);
      if (!stoppedExecutor(job, session, observations)) return job;
      // A fenced job cannot admit another turn. Re-read the three current host
      // views so a control change or still-draining preparation cannot mint proof.
      const [latestJob, latestRun, latestSession] = await Promise.all([
        this.#get(job.jobId), this.#readRun(job.jobId), this.#readSession(job.jobId),
      ]);
      if (isDeepStrictEqual(job, normalizeCodeJobConfirmationResult(latestJob, grant, receipt)) &&
          isDeepStrictEqual(run, latestRun) && isDeepStrictEqual(session, latestSession)) {
        stoppedAuthorityFences.set(job, structuredClone(job));
      }
    }
    return job;
  }
}
