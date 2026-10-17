import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewEligibility, automaticTestingOwner } from "../src/domain/automatic-review-policy.js";

const now = "2026-10-09T10:00:00.000Z";
const item = {
  kind: "pull_request", state: "open", author: "developer", currentUser: "reviewer",
  headRefOid: "a".repeat(40), isDraft: false, ciStatus: "SUCCESS",
  incomingReviewFactsAvailable: true, reviewRecipient: "reviewer",
  reviewReceivedAt: "2026-10-09T09:00:00Z", reviewReceivedFrom: "developer",
  reviewReceivedVia: "assignee", reviewRequestEventId: "event-1",
};
test("automatic Review uses incoming request time rather than PR creation or activity", () => {
  assert.equal(automaticReviewEligibility({ ...item, createdAt: "2025-01-01T00:00:00Z" }, "reviewer", now), null);
  for (const reviewReceivedAt of ["2026-10-08T09:59:59Z", "2026-10-09T10:00:01Z", null]) {
    assert.ok(automaticReviewEligibility({ ...item, reviewReceivedAt, updatedAt: now }, "reviewer", now));
  }
});
test("missing, revoked, self-authored, draft and already reviewed heads do not auto publish", () => {
  for (const patch of [
    { incomingReviewFactsAvailable: false }, { reviewRecipient: "other" },
    { reviewReceivedVia: "reviewer" },
    { author: "REVIEWER" }, { reviewReceivedFrom: "reviewer" }, { state: "merged" },
    { isDraft: true }, { myReviewState: "APPROVED", myReviewCommitOid: item.headRefOid },
    { ciStatus: "PENDING" }, { ciStatus: "UNKNOWN" },
  ]) assert.ok(automaticReviewEligibility({ ...item, ...patch }, "reviewer", now));
  assert.equal(automaticReviewEligibility({ ...item, myReviewState: "CHANGES_REQUESTED", myReviewCommitOid: "b".repeat(40) }, "reviewer", now), null);
});

test("failed checks remain eligible for evidence-based automatic Review", () => {
  for (const ciStatus of ["FAILURE", "ERROR"]) {
    assert.equal(automaticReviewEligibility({ ...item, ciStatus }, "reviewer", now), null);
  }
});

test("a published Review consumes its assignment until a later Assign arrives", () => {
  assert.equal(automaticReviewEligibility({ ...item, myLatestPublishedReviewAt: "2026-10-09T09:30:00Z" }, "reviewer", now), "ASSIGNMENT_ALREADY_REVIEWED");
  assert.equal(automaticReviewEligibility({ ...item, myLatestPublishedReviewAt: "2026-10-09T09:30:00Z", reviewReceivedAt: "2026-10-09T09:45:00Z" }, "reviewer", now), null);
});
test("testing routing uses explicit product evidence and configured owners only", () => {
  const owners = { qt: ["qt-tester"], bs: ["bs-tester"] };
  assert.deepEqual(automaticTestingOwner({ title: "fix Qt renderer", labels: [] }, owners), { login: "qt-tester", product: "qt" });
  assert.deepEqual(automaticTestingOwner({ title: "B/S build", labels: [] }, owners), { login: "bs-tester", product: "bs" });
  assert.equal(automaticTestingOwner({ title: "ambiguous", labels: [] }, owners), null);
  assert.equal(automaticTestingOwner({ title: "Qt renderer" }, {}), null);
});
