import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBoundWorkProposal, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { verifyReviewPublicationSource, createReviewPublicationCandidate } from "../src/services/published-review-adoption.js";

async function sourceFixture() {
  const at = "2026-10-26T08:47:13.000Z";
  const binding = { schemaVersion: 2, kind: "pull_request", repository: "acme/repo", pullRequestNumber: 42,
    rootItemId: "old-review-root", workKey: "old-review-request", inputRevision: 1, headRevision: 1,
    headRefOid: "b".repeat(40), eventId: "review-event", eventDigest: "c".repeat(64), inputDigest: "d".repeat(64),
    gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "review-account", baseRepository: "acme/repo",
      baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "contributor/repo", headRefName: "fix/42", headRefOid: "b".repeat(40) } };
  const proposal = normalizeBoundWorkProposal({ proposalId: "work-intent-" + "a".repeat(64), policyVersion: 1,
    kind: "github_review_proposal", requestedBy: { roleId: "pr-engineer", workItemId: binding.rootItemId },
    source: { assignmentId: "old-review-assignment", eventId: binding.eventId },
    binding: { eventId: binding.eventId, subject: { repository: "acme/repo", number: 42 }, repository: "acme/repo",
      pullRequestNumber: 42, headRefOid: binding.headRefOid, inputBinding: binding },
    payload: { verdict: "approve", body: "Original published review", evidence: ["head:" + binding.headRefOid],
      summary: "Review complete", reason: "Current diff reviewed" } });
  const store = { value: null, async read(_name, fallback) { return structuredClone(this.value ?? fallback); },
    async write(_name, value) { this.value = structuredClone(value); } };
  const queue = new ConfirmationQueue({ store, clock: () => new Date(at),
    exclusiveLease: { async acquire() {}, run: operation => operation(), async close() {} },
    executor: { async execute() { return { status: "applied", receipt: { id: "12345", url: "https://github.com/acme/repo/pull/42", createdAt: at } }; },
      async reconcile() { assert.fail("Publication source must not be replayed"); } } });
  await queue.recover();
  const item = await queue.enqueue(createGitHubReviewProposalConfirmationPlan(proposal, { actorAccountId: "review-account" }));
  await queue.approve(item.id, { requestId: "source-review-publication", expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision, displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest });
  const result = createWorkProposalResult({ proposal, sequence: 1, downstreamRef: null, at,
    transition: { status: "succeeded", summary: "Review published", evidence: ["confirmation:" + item.id] } });
  return { proposal, result, confirmationSnapshot: await queue.readSettlement({ confirmationId: item.id }) };
}

test("a completed publication retains original producer provenance without a new evidence target", async () => {
  const source = await sourceFixture();
  const before = structuredClone(source);
  const proof = verifyReviewPublicationSource(source);
  assert.ok(proof);
  assert.equal(proof.producerTaskId, "old-review-root");
  assert.equal(proof.proposalId, source.proposal.proposalId);
  assert.equal(proof.resultId, source.result.resultId);
  assert.equal(proof.confirmationId, source.confirmationSnapshot.item.id);
  assert.equal(proof.receipt.id, "12345");
  assert.equal(proof.inputBinding.gitTarget.baseRefOid, "a".repeat(40));
  assert.equal(Object.hasOwn(source.proposal.binding, "evidenceTarget"), false);
  assert.deepEqual(source, before);
});

test("source verification rejects changed publication records and unresolved outcomes", async (t) => {
  const source = await sourceFixture();
  for (const [name, alter] of [
    ["proposal body", x => { x.proposal.payload.body = "Changed"; }],
    ["result producer", x => { x.result.requestedBy.workItemId = "different-task"; }],
    ["result confirmation", x => { x.result.evidence = ["confirmation:other"]; }],
    ["confirmation actor", x => { x.confirmationSnapshot.item.actor.accountId = "different-account"; }],
    ["confirmation head", x => { x.confirmationSnapshot.item.target.version = "f".repeat(40); }],
    ["not completed", x => { x.confirmationSnapshot.item.status = "pending"; x.confirmationSnapshot.item.receipt = null; }],
    ["unknown receipt", x => { x.confirmationSnapshot.item.receipt = null; }],
    ["wrong external id", x => { x.confirmationSnapshot.item.receipt.id = "not-a-github-id"; }],
  ]) await t.test(name, () => { const changed = structuredClone(source); alter(changed); assert.equal(verifyReviewPublicationSource(changed), null); });
});


async function candidateFixture() {
  const source = await sourceFixture();
  const inputBinding = { ...structuredClone(source.proposal.binding.inputBinding), rootItemId: "new-review-root",
    workKey: "new-review-request", eventId: "new-review-event", eventDigest: "e".repeat(64), inputDigest: "f".repeat(64) };
  const { createDeliveryEvidenceTarget } = await import("../src/domain/delivery-evidence-contract.js");
  const { createPullRequestReadFacts, createPullRequestReadIdentity } = await import("../src/domain/pull-request-read-facts.js");
  const { normalizeWorkflowEvent } = await import("../src/domain/workflow-events.js");
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed",
    occurredAt: "2026-10-26T08:22:22.000Z", source: { provider: "github", scopeId: "github-account:review-account" },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { headRefOid: inputBinding.headRefOid, gitTargetAvailable: true, gitTarget: inputBinding.gitTarget } });
  inputBinding.eventId = event.eventId;
  inputBinding.eventDigest = event.contentDigest;
  const evidenceTarget = createDeliveryEvidenceTarget({ taskId: "new-review-child", roleId: "pr-engineer",
    acceptanceContract: { revision: 1, acceptanceCriteria: [{ criterionId: "published", description: "A verified published result" }],
      expectedDeliverables: [{ deliverableId: "review-result", kind: "review-report", description: "Published Review", required: true }] } });
  const target = { inputBinding, evidenceTarget, requestedAt: "2026-10-26T08:22:22.000Z" };
  const factsInput = { identity: createPullRequestReadIdentity({ executionBinding: inputBinding, event }), observedAt: "2026-10-28T05:00:00.000Z",
    reviewDecision: "APPROVED", comments: [], reviewThreads: [], checks: [],
    reviews: [{ id: "PRR_original", author: "review-account", state: "APPROVED", submittedAt: "2026-10-26T08:47:13.000Z",
      commitOid: inputBinding.headRefOid, body: source.proposal.payload.body, bodyTruncated: false,
      url: "https://github.com/acme/repo/pull/42#pullrequestreview-12345" }],
    truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } };
  return { source, target, factsInput, facts: createPullRequestReadFacts(factsInput), createFacts: createPullRequestReadFacts };
}

test("publication candidates bind complete current material and the new contract without claiming delivery", async () => {
  const f = await candidateFixture();
  const first = createReviewPublicationCandidate(f);
  assert.ok(first);
  assert.equal(first.target.evidenceTarget.taskId, "new-review-child");
  assert.equal(first.source.producerTaskId, "old-review-root");
  assert.equal(first.requiresCurrentReview, true);
  assert.match(first.candidateId, /^review-publication-candidate-[a-f0-9]{64}$/);
  const later = createReviewPublicationCandidate({ ...f, facts: f.createFacts({ ...f.factsInput, observedAt: "2026-10-28T05:30:00.000Z" }) });
  assert.equal(later.candidateId, first.candidateId, "observation refresh is not a new recovery condition");
  const differentContract = createReviewPublicationCandidate({ ...f, target: { ...f.target,
    evidenceTarget: { ...f.target.evidenceTarget, contractDigest: "0".repeat(64) } } });
  assert.notEqual(differentContract.candidateId, first.candidateId);
});

test("uncertain coverage, changed publication and different versions cannot become reuse candidates", async (t) => {
  const f = await candidateFixture();
  const changes = [
    ["truncated facts", x => { x.truncation.comments = true; }],
    ["truncated review", x => { x.reviews[0].bodyTruncated = true; }],
    ["edited published body", x => { x.reviews[0].body = "New unverified review content"; }],
    ["different author", x => { x.reviews[0].author = "different-account"; }],
    ["different receipt identity", x => { x.reviews[0].url = "https://github.com/acme/repo/pull/42#pullrequestreview-99999"; }],
    ["changed verdict", x => { x.reviews[0].state = "COMMENTED"; }],
    ["ambiguous same-second actor review", x => { x.reviews.push({ ...x.reviews[0], id: "PRR_later",
      state: "CHANGES_REQUESTED", body: "A conflicting follow-up", url: "https://github.com/acme/repo/pull/42#pullrequestreview-12346" }); }],
    ["new feedback", x => { x.comments.push({ id: "IC_new", author: "developer", body: "A new request", bodyTruncated: false,
      createdAt: "2026-10-27T08:00:00.000Z", updatedAt: "2026-10-27T08:00:00.000Z", url: "https://github.com/acme/repo/pull/42#issuecomment-1" }); }],
  ];
  for (const [name, change] of changes) await t.test(name, () => {
    const input = structuredClone(f.factsInput); change(input);
    assert.equal(createReviewPublicationCandidate({ ...f, facts: f.createFacts(input) }), null);
  });
  assert.equal(createReviewPublicationCandidate({ ...f, target: { ...f.target, requestedAt: "2026-10-27T00:00:00.000Z" } }), null);
  assert.equal(createReviewPublicationCandidate({ ...f, target: { ...f.target,
    inputBinding: { ...f.target.inputBinding, gitTarget: { ...f.target.inputBinding.gitTarget, baseRefOid: "1".repeat(40) } } } }), null);
});


test("publication source discovery retains outstanding work and reports an incomplete bounded scan", async () => {
  const f = await candidateFixture();
  const { WorkProposalEvidenceReader } = await import("../src/services/work-proposal-evidence-reader.js");
  const pending = structuredClone(f.source.proposal);
  pending.proposalId = "work-intent-" + "b".repeat(64);
  const state = { proposals: [{ proposal: f.source.proposal, status: "succeeded", resultId: f.source.result.resultId, downstreamRef: null },
    { proposal: pending, status: "pending_delivery", resultId: null, downstreamRef: null }], results: [f.source.result] };
  const reader = new WorkProposalEvidenceReader({ readState: () => state });
  const page = reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 10 });
  assert.equal(page.complete, true);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].status, "pending_delivery", "unknown or pending source work must stay visible to the reuse gate");
  assert.equal(page.items[0].result, null);
  assert.equal(reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 1 }).complete, false);
  const otherBase = structuredClone(f.target.inputBinding);
  otherBase.gitTarget.baseRefOid = "0".repeat(40);
  assert.equal(reader.listReviewPublicationSources({ inputBinding: otherBase, limit: 10 }).items.length, 2,
    "old-Base outstanding work must remain visible; candidate eligibility checks the exact Base separately");
  const { contentDigest: _legacyDigest, ...legacyContent } = structuredClone(pending);
  legacyContent.proposalId = "work-intent-" + "c".repeat(64);
  const { gitTarget: _legacyGitTarget, ...legacyBinding } = legacyContent.binding.inputBinding;
  legacyContent.binding.inputBinding = { ...legacyBinding, schemaVersion: 1 };
  const legacy = normalizeBoundWorkProposal(legacyContent);
  state.proposals.push({ proposal: legacy, status: "waiting_retry", resultId: null, downstreamRef: "legacy-unknown" });
  const withLegacy = reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 10 });
  assert.equal(withLegacy.items.length, 3, "a legacy binding without an account is uncertain, not unrelated");
  assert.ok(withLegacy.items.some(item => item.proposal.proposalId === legacy.proposalId));
  const otherRequest = { ...f.target.inputBinding, pullRequestNumber: 43 };
  assert.equal(reader.listReviewPublicationSources({ inputBinding: otherRequest, limit: 10 }).items.length, 0);
});
