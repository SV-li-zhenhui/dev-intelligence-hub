import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { automaticReviewEligibility, automaticReviewContinuationEligibility, automaticTestingOwner } from "../domain/automatic-review-policy.js";

// Only the composition root receives this port. Model output cannot grant
// automatic publication, choose arbitrary assignees, or execute other actions.
export class AutomaticReviewPublisher {
  constructor({ enabled = false, assignAfterReview = true, queue, github, reviewAdmissionReader = null, testingOwnersByProduct = {}, clock = () => new Date() }) {
    this.enabled = enabled === true;
    this.assignAfterReview = assignAfterReview !== false;
    this.queue = queue;
    this.github = github;
    this.testingOwners = structuredClone(testingOwnersByProduct);
    this.clock = clock;
    if (reviewAdmissionReader !== null && typeof reviewAdmissionReader?.read !== "function") throw new TypeError("reviewAdmissionReader is invalid");
    this.readAdmission = reviewAdmissionReader?.read.bind(reviewAdmissionReader) ?? null;
  }

  async eligible(facts, item) {
    if (facts.headRefOid !== item.target.version) return false;
    if (this.readAdmission === null) return automaticReviewEligibility(facts, item.actor.accountId, this.clock()) === null;
    const binding = (item.action ?? item.display?.payload?.action)?.inputBinding;
    const resourceId = `${binding?.repository}#${binding?.pullRequestNumber}`;
    if (binding?.schemaVersion !== 2 || resourceId !== item.target.resourceId || binding.headRefOid !== item.target.version ||
        binding.gitTarget?.sourceAccountId?.toLowerCase() !== item.actor.accountId.toLowerCase()) return false;
    let context;
    try { context = await this.readAdmission(binding); }
    catch { return false; }
    return isDeepStrictEqual(context?.inputBinding, binding) && context?.admission !== null &&
      automaticReviewContinuationEligibility(facts, item.actor.accountId, this.clock(), context?.admission) === null;
  }

  async publish(item) {
    if (!this.enabled || item.kind !== "github.work-proposal-review" || item.status !== "pending") return item;
    const action = item.display?.payload?.action;
    if (action?.type !== "pull_request_review") return item;
    const match = /^([^#]+)#([1-9]\d*)$/.exec(item.target.resourceId);
    if (!match) return item;
    const facts = await this.github.readIncomingReviewRequest({ repository: match[1], number: Number(match[2]), account: item.actor.accountId });
    if (!await this.eligible(facts, item)) return item;
    let reviewHandoff;
    if (this.assignAfterReview) {
      if (action.reviewEvent === "APPROVE") {
        const responsiblePerson = automaticTestingOwner(facts, this.testingOwners);
        if (!responsiblePerson) return item;
        reviewHandoff = { workType: "testing", responsiblePerson };
      } else {
        reviewHandoff = { workType: "assignment", responsiblePerson: null };
      }
    }
    const digest = createHash("sha256").update(item.id + ":" + item.approvalBindingDigest).digest("hex").slice(0, 48);
    return this.queue.approve(item.id, {
      requestId: `auto-review-v1-${digest}`,
      expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
      displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
      ...(reviewHandoff ? { reviewHandoff } : {}),
    });
  }

  async verify(envelope) {
    if (!this.enabled || envelope.kind !== "github.work-proposal-review") return false;
    const match = /^([^#]+)#([1-9]\d*)$/.exec(envelope.target.resourceId);
    if (!match) return false;
    const facts = await this.github.readIncomingReviewRequest({ repository: match[1], number: Number(match[2]), account: envelope.actor.accountId });
    return this.eligible(facts, envelope);
  }
}
