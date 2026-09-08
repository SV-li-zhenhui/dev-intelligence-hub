import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeAbortSignal, runStructuredProviderRequest } from "../lib/structured-provider-request.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function diagnostic(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : fallback;
}

function bounded(operation, timeoutMs, signal, controller = new AbortController()) {
  return runStructuredProviderRequest({
    controller, timeoutMs, signal, operation,
    cancellationError: () => failure("REVIEW_HANDOFF_CANCELLED"),
    timeoutError: () => failure("REVIEW_HANDOFF_TIMEOUT"),
  });
}

// The confirmation owns the durable intent; the owner-request service owns the
// idempotent local dispatch. A lost acknowledgement replays only local submit.
export class ReviewHandoffReconciler {
  constructor({ confirmations, ownerWorkRequests, timeoutMs = 10_000, cycleTimeoutMs = 15_000 }) {
    if (![timeoutMs, cycleTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError("handoff deadlines must be positive integers");
    }
    this.confirmations = confirmations;
    this.ownerWorkRequests = ownerWorkRequests;
    this.operations = new OperationQueue();
    this.timeoutMs = timeoutMs;
    this.cycleTimeoutMs = cycleTimeoutMs;
    this.inFlight = new Map();
    this.pendingRead = null;
    this.afterId = null;
  }

  runCycle({ signal = null, runOperation = (operation) => operation() } = {}) {
    normalizeAbortSignal(signal);
    if (typeof runOperation !== "function") throw new TypeError("runOperation must be a function");
    return this.operations.enqueue(async () => {
      if (signal?.aborted) return [];
      const deadline = performance.now() + this.cycleTimeoutMs;
      if (!this.pendingRead) {
        const read = Promise.resolve().then(() => runOperation(() => this.confirmations.readReviewHandoffs({ afterId: this.afterId })));
        this.pendingRead = read;
        read.then(() => { this.pendingRead = null; }, () => { this.pendingRead = null; });
      }
      const read = this.pendingRead;
      const pending = await bounded(() => read, this.cycleTimeoutMs, signal);
      const results = [];
      for (const item of pending) {
        if (signal?.aborted || performance.now() >= deadline) break;
        this.afterId = item.id;
        // A deadline does not release the submit service's durable lease. Never
        // start a second attempt while the original operation is still settling.
        if (this.inFlight.has(item.request.requestId)) continue;
        const controller = new AbortController();
        try {
          const outcome = await bounded(() => {
            const attempt = Promise.resolve().then(() => runOperation(() => this.#dispatch(item, controller.signal)));
            this.inFlight.set(item.request.requestId, attempt);
            attempt.then(() => this.inFlight.delete(item.request.requestId), () => this.inFlight.delete(item.request.requestId));
            return attempt;
          }, Math.max(1, Math.min(this.timeoutMs, deadline - performance.now())), signal, controller);
          results.push({ id: item.id, status: outcome.status });
        } catch (error) {
          results.push({ id: item.id, status: "retrying", diagnosticCode: diagnostic(error, "REVIEW_HANDOFF_SUBMIT_FAILED") });
        }
      }
      return results;
    });
  }

  async #dispatch(item, signal) {
    let outcome;
    try {
      const result = await this.ownerWorkRequests.submit(item.request, { signal });
      if (result?.phase !== "intaken" || !result.workItemId || !result.assignment?.target?.id) {
        throw failure("REVIEW_HANDOFF_NOT_INTAKEN");
      }
      outcome = { status: "completed", diagnosticCode: null, workItemId: result.workItemId, roleId: result.assignment.target.id };
    } catch (error) {
      if (signal.aborted) throw error;
      outcome = { status: "retrying", diagnosticCode: diagnostic(error, "REVIEW_HANDOFF_SUBMIT_FAILED"), workItemId: null, roleId: null };
    }
    // Keep the accepted request ID even if the acknowledgement cannot be saved.
    try {
      await this.confirmations.recordReviewHandoff(item.id, item.request.requestId, outcome);
    } catch (cause) {
      throw Object.assign(failure("REVIEW_HANDOFF_ACK_FAILED"), { cause });
    }
    return outcome;
  }
}
