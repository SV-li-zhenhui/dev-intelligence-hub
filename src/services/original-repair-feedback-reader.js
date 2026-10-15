import { isDeepStrictEqual } from "node:util";
import { normalizeAutomaticOwnPrRepairState, AUTOMATIC_OWN_PR_REPAIR_STATE_KEY } from "./automatic-own-pr-repair.js";
import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeInternalReviewMetadata } from "../domain/internal-repair-review.js";
import { originalRepairFeedbackBinding } from "../domain/original-repair-feedback.js";
import { readOriginalRepairFeedbackSnapshot } from "./original-repair-feedback-archive.js";

export class OriginalRepairFeedbackReader {
  constructor({ store, executionContextReader }) { this.store = store; this.executionContextReader = executionContextReader; }
  async #state() { return normalizeAutomaticOwnPrRepairState(await this.store.read(AUTOMATIC_OWN_PR_REPAIR_STATE_KEY, { schemaVersion: 1, repairs: [], published: [] })); }
  async readBinding({ inputBinding: value, internalReview }) {
    const inputBinding = normalizePullRequestExecutionBinding(value);
    const current = await this.executionContextReader.readPullRequestExecutionContext(inputBinding);
    if (!isDeepStrictEqual(current.inputBinding, inputBinding)) throw Object.assign(new Error("内部复审输入已变化"), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
    const state = await this.#state();
    const descriptor = originalRepairFeedbackBinding(state, inputBinding, normalizeInternalReviewMetadata(internalReview));
    await readOriginalRepairFeedbackSnapshot(this.store, state, { ...descriptor, repository: inputBinding.repository, number: inputBinding.pullRequestNumber });
    return descriptor;
  }
  async read(query) {
    return readOriginalRepairFeedbackSnapshot(this.store, await this.#state(), query);
  }
}
