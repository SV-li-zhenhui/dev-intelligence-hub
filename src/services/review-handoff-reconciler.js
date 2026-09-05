import { OperationQueue } from "../lib/operation-queue.js";

// The confirmation owns the durable intent; the owner-request service owns the
// idempotent local dispatch. A lost acknowledgement replays only local submit.
export class ReviewHandoffReconciler {
  constructor({ confirmations, ownerWorkRequests }) {
    this.confirmations = confirmations;
    this.ownerWorkRequests = ownerWorkRequests;
    this.operations = new OperationQueue();
  }

  runCycle() {
    return this.operations.enqueue(async () => {
      const pending = await this.confirmations.readReviewHandoffs();
      const results = [];
      for (const item of pending) {
        let outcome;
        try {
          const result = await this.ownerWorkRequests.submit(item.request);
          if (result?.phase !== "intaken" || !result.workItemId || !result.assignment?.target?.id) {
            throw Object.assign(new Error("交接任务尚未进入工作台账"), { code: "REVIEW_HANDOFF_NOT_INTAKEN" });
          }
          outcome = { status: "completed", diagnosticCode: null, workItemId: result.workItemId, roleId: result.assignment.target.id };
        } catch (error) {
          outcome = { status: "retrying", diagnosticCode: typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : "REVIEW_HANDOFF_SUBMIT_FAILED", workItemId: null, roleId: null };
        }
        // Do not turn an acknowledgement-write failure into a new dispatch ID.
        await this.confirmations.recordReviewHandoff(item.id, item.request.requestId, outcome);
        results.push({ id: item.id, status: outcome.status });
      }
      return results;
    });
  }
}
