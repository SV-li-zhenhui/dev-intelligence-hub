import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticReviewPublisher } from "../src/services/automatic-review-publisher.js";
const now = "2026-10-09T10:00:00.000Z";
const head = "a".repeat(40);
function fixture({ enabled = true, event = "APPROVE", facts = {}, owners = { qt: ["tester"] }, admission = null } = {}) {
  const calls = [];
  const current = { kind: "pull_request", state: "open", author: "dev", currentUser: "me", headRefOid: head, isDraft: false,
    title: "Qt fix", incomingReviewFactsAvailable: true, reviewRecipient: "me", reviewReceivedFrom: "dev",
    reviewReceivedAt: "2026-10-09T09:00:00Z", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_1", ...facts };
  const queue = { approve: async (...args) => { calls.push(args); return { ...item, status: "completed" }; } };
  const item = { id: "confirmation-1", kind: "github.work-proposal-review", status: "pending", actor: { accountId: "me" },
    target: { resourceId: "acme/repo#1", version: head }, queueRevision: 1, itemRevision: 1,
    displayedPayloadDigest: "b".repeat(64), approvalBindingDigest: "c".repeat(64), display: { payload: { action: { type: "pull_request_review", reviewEvent: event } } } };
  const inputBinding = { schemaVersion: 2, repository: "acme/repo", pullRequestNumber: 1, headRefOid: head,
    gitTarget: { sourceAccountId: "me" } };
  if (admission) item.display.payload.action.inputBinding = inputBinding;
  const publisher = new AutomaticReviewPublisher({ enabled, assignAfterReview: true, queue,
    github: { readIncomingReviewRequest: async () => current }, testingOwnersByProduct: owners, clock: () => now,
    ...(admission ? { reviewAdmissionReader: { async read() { return { inputBinding, admission }; } } } : {}) });
  return { publisher, item, calls };
}
test("eligible proposals publish using durable approval and configured testing handoff", async () => {
  const { publisher, item, calls } = fixture();
  assert.equal((await publisher.publish(item)).status, "completed");
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].requestId, /^auto-review-v1-/);
  assert.deepEqual(calls[0][1].reviewHandoff, { workType: "testing", responsiblePerson: { login: "tester", product: "qt" } });
});

test("an admitted failed-CI review publishes and passes execution verification after its intake window expires", async () => {
  const receivedAt = "2026-10-08T09:00:00Z";
  const { publisher, item, calls } = fixture({ event: "COMMENT", facts: { ciStatus: "FAILURE", reviewReceivedAt: receivedAt },
    admission: { kind: "assigned", admittedAt: "2026-10-08T09:10:00Z", reviewReceivedAt: receivedAt, reviewRequestEventId: "AE_1" } });
  assert.equal(await publisher.verify({ ...item, action: item.display.payload.action }), true);
  assert.equal((await publisher.publish(item)).status, "completed");
  assert.match(calls[0][1].requestId, /^auto-review-v1-/);
  assert.deepEqual(calls[0][1].reviewHandoff, { workType: "assignment", responsiblePerson: null });
});

test("an explicit owner review request automatically publishes an older current assignment", async () => {
  const { publisher, item, calls } = fixture({ event: "REQUEST_CHANGES", facts: { ciStatus: "ERROR", reviewReceivedAt: "2026-10-01T09:00:00Z" },
    admission: { kind: "owner_requested", admittedAt: "2026-10-09T09:50:00Z" } });
  assert.equal(await publisher.verify({ ...item, action: item.display.payload.action }), true);
  assert.equal((await publisher.publish(item)).status, "completed");
  assert.equal(calls.length, 1);
});

test("admission never authorizes a late intake, another Assign, revoked ownership or a duplicate Review", async () => {
  const receivedAt = "2026-10-08T09:00:00Z";
  const admitted = { kind: "assigned", admittedAt: "2026-10-08T09:10:00Z", reviewReceivedAt: receivedAt, reviewRequestEventId: "AE_1" };
  for (const patch of [
    { admission: { ...admitted, admittedAt: "2026-10-09T09:00:01Z" } },
    { admission: { ...admitted, admittedAt: "2026-10-09T10:00:01Z" } },
    { facts: { reviewRequestEventId: "AE_2" } },
    { facts: { reviewReceivedAt: "2026-10-08T10:00:00Z" } },
    { facts: { reviewRecipient: "someone-else" } },
    { facts: { headRefOid: "f".repeat(40) } },
    { facts: { myLatestPublishedReviewAt: "2026-10-09T09:30:00Z" } },
  ]) {
    const { publisher, item, calls } = fixture({ event: "COMMENT", admission: admitted,
      ...patch, facts: { reviewReceivedAt: receivedAt, ...patch.facts } });
    assert.equal(await publisher.verify({ ...item, action: item.display.payload.action }), false);
    assert.equal(await publisher.publish(item), item);
    assert.equal(calls.length, 0);
  }
});
test("request_changes assigns the author without creating local follow-up work", async () => {
  const { publisher, item, calls } = fixture({ event: "REQUEST_CHANGES" });
  await publisher.publish(item);
  assert.deepEqual(calls[0][1].reviewHandoff, { workType: "assignment", responsiblePerson: null });
});

test("comment prepares the same durable author handoff as request_changes", async () => {
  const { publisher, item, calls } = fixture({ event: "COMMENT" });
  assert.equal((await publisher.publish(item)).status, "completed");
  assert.deepEqual(calls[0][1].reviewHandoff, { workType: "assignment", responsiblePerson: null });
});

test("failed checks publish every evidence-based verdict and retain its normal handoff", async () => {
  for (const ciStatus of ["FAILURE", "ERROR"]) {
    for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
      const { publisher, item, calls } = fixture({ event, facts: { ciStatus } });
      assert.equal(await publisher.verify({ ...item, action: item.display.payload.action }), true);
      assert.equal((await publisher.publish(item)).status, "completed");
      assert.deepEqual(calls[0][1].reviewHandoff, event === "APPROVE"
        ? { workType: "testing", responsiblePerson: { login: "tester", product: "qt" } }
        : { workType: "assignment", responsiblePerson: null });
    }
  }
});
test("disabled, old, changed, revoked, already published and unknown outcomes never auto approve", async () => {
  for (const options of [ { enabled: false }, { facts: { reviewReceivedAt: "2026-10-01T09:00:00Z" } },
    { facts: { headRefOid: "d".repeat(40) } }, { facts: { reviewRecipient: null } },
    { facts: { reviewReceivedVia: "reviewer" } },
    { facts: { myReviewState: "APPROVED", myReviewCommitOid: head } }, { owners: {} } ]) {
    const { publisher, item, calls } = fixture(options);
    assert.equal(await publisher.publish(item), item);
    assert.equal(calls.length, 0);
  }
  const { publisher, item, calls } = fixture();
  await publisher.publish({ ...item, status: "failed", retryable: false });
  await publisher.publish({ ...item, status: "completed" });
  assert.equal(calls.length, 0);
});
