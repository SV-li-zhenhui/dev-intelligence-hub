import { normalizeCodeJobGrant } from "../domain/code-job-contract.js";
import { normalizeCodeJobConfirmationResult } from "./code-job-confirmation-result.js";
import { isDeepStrictEqual } from "node:util";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "fenced"]);
const CANCELLATION_REASON = "PR source superseded";
const unstartedAuthorityFences = new WeakMap();

export function hasUnstartedCodeJobAuthorityFence(job) {
  const proof = unstartedAuthorityFences.get(job);
  return proof !== undefined && isDeepStrictEqual(job, proof);
}

function admitImmediately(operation) {
  return { operation: operation() };
}

export class ObsoleteCodeJobSettler {
  #get;
  #cancel;
  #getDetail;

  constructor({ codeJobReader, codeJobControl } = {}) {
    if (typeof codeJobReader?.get !== "function" || typeof codeJobControl?.cancel !== "function") {
      throw new TypeError("Obsolete code job settlement requires reader and cancellation ports");
    }
    this.#get = codeJobReader.get.bind(codeJobReader);
    this.#cancel = codeJobControl.cancel.bind(codeJobControl);
    this.#getDetail = typeof codeJobReader.getDetail === "function"
      ? codeJobReader.getDetail.bind(codeJobReader) : null;
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
    return job;
  }
}
