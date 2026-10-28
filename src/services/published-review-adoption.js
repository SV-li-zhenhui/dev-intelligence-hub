import { normalizeConfirmationState } from "../domain/confirmation-contract.js";
import { historicalGitHubReviewConfirmationPlans } from "../domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal, normalizeWorkProposalResult } from "../domain/work-proposal-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext } from "../domain/pull-request-read-facts.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";

const same = (left, right) => canonicalJsonDigest(left) === canonicalJsonDigest(right);

// Historical publication proof, not authority to act on a current PR or a new
// task. Consumers must separately bind and verify current coverage and target.
export function verifyReviewPublicationSource({ proposal: stored, result: storedResult, confirmationSnapshot } = {}) {
  try {
    const { contentDigest, ...content } = stored;
    const proposal = normalizeBoundWorkProposal(content);
    if (proposal.contentDigest !== contentDigest || proposal.kind !== "github_review_proposal") return null;
    const result = normalizeWorkProposalResult(storedResult);
    if (result.kind !== proposal.kind || result.outcome !== "succeeded" ||
        result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
        !same(result.requestedBy, proposal.requestedBy)) return null;
    const inputBinding = normalizePullRequestExecutionBinding(proposal.binding.inputBinding);
    if (inputBinding.schemaVersion !== 2) return null;
    const item = normalizeConfirmationState({ schemaVersion: 1, revision: confirmationSnapshot.queueRevision,
      items: [confirmationSnapshot.item] }).items[0];
    if (item.status !== "completed" || item.receipt === null || !/^[1-9][0-9]*$/.test(item.receipt.id) ||
        item.actor.accountId.toLowerCase() !== inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
        result.evidence.filter(value => value.startsWith("confirmation:")).length !== 1 ||
        !result.evidence.includes(`confirmation:${item.id}`) ||
        Date.parse(result.at) < Date.parse(item.receipt.createdAt)) return null;
    const matches = historicalGitHubReviewConfirmationPlans(proposal, item.actor.accountId).some(plan =>
      Object.keys(plan).every(key => Object.hasOwn(item, key) && same(item[key], plan[key])));
    if (!matches) return null;
    return Object.freeze({ producerTaskId: proposal.requestedBy.workItemId, producerRoleId: proposal.requestedBy.roleId,
      proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest,
      resultId: result.resultId, resultDigest: result.contentDigest,
      confirmationId: item.id, approvalBindingDigest: item.approvalBindingDigest,
      inputBinding: structuredClone(inputBinding), actorAccountId: item.actor.accountId,
      receipt: structuredClone(item.receipt), publishedVerdict: ({ APPROVE: "approve", REQUEST_CHANGES: "request_changes", COMMENT: "comment" })[item.action.reviewEvent],
      publishedBodyDigest: canonicalJsonDigest(item.action.body), publishedBody: item.action.body });
  } catch {
    return null;
  }
}


const reviewStates = { approve: "APPROVED", request_changes: "CHANGES_REQUESTED", comment: "COMMENTED" };
const timestampAfter = (value, at) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > at;

// A candidate is not accepted evidence. A current reviewer must explicitly
// assess coverage and propose adoption before the host can issue a receipt.
export function createReviewPublicationCandidate({ source: sourceRecords, target, facts: readFacts } = {}) {
  try {
    const source = verifyReviewPublicationSource(sourceRecords);
    if (source === null) return null;
    const inputBinding = normalizePullRequestExecutionBinding(target.inputBinding);
    const evidenceTarget = normalizeDeliveryEvidenceTarget(target.evidenceTarget);
    if (inputBinding.schemaVersion !== 2 || evidenceTarget.deliverables.length !== 1 ||
        !["github-review", "review-report"].includes(evidenceTarget.deliverables[0].kind) ||
        evidenceTarget.roleId !== "pr-engineer" ||
        inputBinding.repository !== source.inputBinding.repository ||
        inputBinding.pullRequestNumber !== source.inputBinding.pullRequestNumber ||
        !samePullRequestGitTarget(inputBinding.gitTarget, source.inputBinding.gitTarget)) return null;
    const facts = normalizePullRequestReadFacts(readFacts);
    if (!samePullRequestExecutionBinding(facts.identity.executionBinding, inputBinding)) return null;
    const materialDigest = projectPullRequestReadFactsContext(facts).materialDigest;
    if (typeof materialDigest !== "string") return null;
    const publicationAt = Date.parse(source.receipt.createdAt);
    const requestedAt = Date.parse(target.requestedAt);
    if (!Number.isFinite(requestedAt) || publicationAt < requestedAt || Date.parse(facts.observedAt) < publicationAt) return null;
    const urlMatches = review => {
      const url = new URL(review.url);
      return url.protocol === "https:" && url.hostname === "github.com" && url.search === "" &&
        url.pathname.toLowerCase() === `/${inputBinding.repository}/pull/${inputBinding.pullRequestNumber}`.toLowerCase() &&
        url.hash === `#pullrequestreview-${source.receipt.id}`;
    };
    const reviews = facts.reviews.filter(review => review.author?.toLowerCase() === source.actorAccountId.toLowerCase());
    const matches = reviews.filter(urlMatches);
    if (matches.length !== 1) return null;
    const review = matches[0];
    if (review.commitOid !== inputBinding.headRefOid || review.state !== reviewStates[source.publishedVerdict] ||
        Date.parse(review.submittedAt) !== publicationAt || review.bodyTruncated ||
        review.body.replace(/\n\n<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u, "") !== source.publishedBody) return null;
    const comments = [...facts.comments, ...facts.reviewThreads.flatMap(thread => thread.comments)];
    if (comments.some(comment => timestampAfter(comment.createdAt, publicationAt) || timestampAfter(comment.updatedAt, publicationAt)) ||
        facts.reviews.some(other => other.id !== review.id && (timestampAfter(other.submittedAt, publicationAt) ||
          (other.author?.toLowerCase() === source.actorAccountId.toLowerCase() && Date.parse(other.submittedAt) === publicationAt)))) return null;
    const content = { schemaVersion: 1, policy: "current_review_adopts_verified_publication/v1", source,
      target: { inputBinding, evidenceTarget, requestedAt: target.requestedAt },
      coverage: { materialDigest, reviewNodeId: review.id, publishedReviewUrl: review.url,
        publishedBodyDigest: canonicalJsonDigest(review.body), requiresCurrentReview: true } };
    return { ...structuredClone(content), candidateId: `review-publication-candidate-${canonicalJsonDigest(content)}`,
      materialDigest, requiresCurrentReview: true, observedAt: facts.observedAt };
  } catch {
    return null;
  }
}
