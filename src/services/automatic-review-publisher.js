import { createHash } from "node:crypto";
import { automaticReviewEligibility, automaticTestingOwner } from "../domain/automatic-review-policy.js";

// Only the composition root receives this port. Model output cannot grant
// automatic publication, choose arbitrary assignees, or execute other actions.
export class AutomaticReviewPublisher {
  constructor({ enabled = false, assignAfterReview = true, queue, github, testingOwnersByProduct = {}, clock = () => new Date() }) {
    this.enabled = enabled === true;
    this.assignAfterReview = assignAfterReview !== false;
    this.queue = queue;
    this.github = github;
    this.testingOwners = structuredClone(testingOwnersByProduct);
    this.clock = clock;
  }

  async publish(item) {
    if (!this.enabled || item.kind !== "github.work-proposal-review" || item.status !== "pending") return item;
    const action = item.display?.payload?.action;
    if (action?.type !== "pull_request_review") return item;
    const match = /^([^#]+)#([1-9]\d*)$/.exec(item.target.resourceId);
    if (!match) return item;
    const facts = await this.github.readIncomingReviewRequest({ repository: match[1], number: Number(match[2]), account: item.actor.accountId });
    if (automaticReviewEligibility(facts, item.actor.accountId, this.clock()) !== null || facts.headRefOid !== item.target.version) return item;
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
    return facts.headRefOid === envelope.target.version && automaticReviewEligibility(facts, envelope.actor.accountId, this.clock()) === null;
  }
}
