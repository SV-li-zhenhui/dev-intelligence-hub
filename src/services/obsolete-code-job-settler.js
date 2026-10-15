import { normalizeCodeJobGrant } from "../domain/code-job-contract.js";
import { normalizeCodeJobConfirmationResult } from "./code-job-confirmation-result.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "fenced"]);
const CANCELLATION_REASON = "PR source superseded";

function admitImmediately(operation) {
  return { operation: operation() };
}

export class ObsoleteCodeJobSettler {
  #get;
  #cancel;

  constructor({ codeJobReader, codeJobControl } = {}) {
    if (typeof codeJobReader?.get !== "function" || typeof codeJobControl?.cancel !== "function") {
      throw new TypeError("Obsolete code job settlement requires reader and cancellation ports");
    }
    this.#get = codeJobReader.get.bind(codeJobReader);
    this.#cancel = codeJobControl.cancel.bind(codeJobControl);
  }

  async settle({ grant: value, receipt }, { admitCancellation = admitImmediately } = {}) {
    if (typeof admitCancellation !== "function") throw new TypeError("Cancellation admission is invalid");
    const grant = normalizeCodeJobGrant(value);
    const read = async () => {
      const job = await this.#get(receipt.id);
      return job === null ? null : normalizeCodeJobConfirmationResult(job, grant, receipt);
    };
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
}
