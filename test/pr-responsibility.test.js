import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_STATES,
  assessPullRequestResponsibility,
} from "../src/domain/pr-responsibility.js";

const now = "2026-07-31T09:00:00.000Z";
const currentUser = "local-owner";

function pullRequest(overrides = {}) {
  return {
    kind: "pull_request",
    relation: "authored",
    author: currentUser,
    currentUser,
    state: "open",
    updatedAt: "2026-07-30T09:00:00.000Z",
    reviewDecision: "",
    ciStatus: "NONE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    headRefOid: "head-2",
    myReviewState: "",
    myReviewCommitOid: "",
    latestOtherDecisionState: "",
    latestOtherDecisionCommitOid: "",
    latestChangeRequestCommitOid: "",
    outstandingChangeRequestCommitOids: [],
    reviewFactsAvailable: true,
    ...overrides,
  };
}

function assess(overrides) {
  return assessPullRequestResponsibility(pullRequest(overrides), {
    now,
    historicalAfterDays: 60,
  });
}

test("a recent assigned PR without my review needs my review now", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextActor, "me");
  assert.equal(result.nextAction, "review");
  assert.equal(result.requiresConfirmation, false);
});

test("a new head commit after my review needs my re-review", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    myReviewState: "APPROVED",
    myReviewCommitOid: "reviewed-head",
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextAction, "rereview");
});

test("changes I requested without a new commit are waiting on the author", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    myReviewState: "CHANGES_REQUESTED",
    myReviewCommitOid: "head-2",
  });

  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "author");
  assert.equal(result.nextAction, "wait_author_changes");
});

test("an assigned draft or broken head waits on the author before review", () => {
  const draft = assess({
    relation: "review_requested",
    author: "contributor",
    isDraft: true,
  });
  const conflict = assess({
    relation: "review_requested",
    author: "contributor",
    mergeStateStatus: "DIRTY",
  });
  const failed = assess({
    relation: "review_requested",
    author: "contributor",
    ciStatus: "FAILURE",
  });

  assert.equal(draft.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(conflict.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(failed.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(draft.nextActor, "author");
});

test("an authored PR with unresolved review feedback needs my action", () => {
  const result = assess({
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "head-2",
    latestChangeRequestCommitOid: "head-2",
    outstandingChangeRequestCommitOids: ["head-2"],
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextActor, "me");
  assert.equal(result.nextAction, "address_review");
});

test("an authored PR updated after requested changes waits for re-review", () => {
  const result = assess({
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "reviewed-head",
    latestChangeRequestCommitOid: "reviewed-head",
    outstandingChangeRequestCommitOids: ["reviewed-head"],
  });

  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "reviewer");
  assert.equal(result.nextAction, "wait_rereview");
});

test("current authored blockers override an old change request", () => {
  const oldChangeRequest = {
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "reviewed-head",
    latestChangeRequestCommitOid: "reviewed-head",
    outstandingChangeRequestCommitOids: ["reviewed-head"],
  };
  const conflict = assess({
    ...oldChangeRequest,
    mergeStateStatus: "DIRTY",
  });
  const failed = assess({
    ...oldChangeRequest,
    ciStatus: "FAILURE",
  });
  const draft = assess({
    ...oldChangeRequest,
    isDraft: true,
  });

  assert.equal(conflict.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(conflict.nextAction, "resolve_conflict");
  assert.equal(failed.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(failed.nextAction, "fix_ci");
  assert.equal(draft.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(draft.nextAction, "continue_draft");
});

test("merge conflicts and failing CI remain my authored actions", () => {
  const conflict = assess({ mergeStateStatus: "DIRTY" });
  const failed = assess({ ciStatus: "FAILURE" });

  assert.equal(conflict.nextAction, "resolve_conflict");
  assert.equal(failed.nextAction, "fix_ci");
  assert.equal(conflict.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(failed.actionState, ACTION_STATES.ACTION_NOW);
});

test("an approved authored PR waits for merge instead of claiming modification work", () => {
  const result = assess({
    reviewDecision: "APPROVED",
    latestOtherDecisionState: "APPROVED",
    latestOtherDecisionCommitOid: "head-2",
  });

  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "merge_owner");
  assert.equal(result.nextAction, "wait_merge");
});

test("long inactive PRs go to cleanup even when their old CI failed", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    updatedAt: "2026-05-31T08:59:59.000Z",
    ciStatus: "FAILURE",
  });

  assert.equal(result.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(result.nextAction, "cleanup");
});

test("missing review facts are surfaced for confirmation instead of guessed", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    reviewFactsAvailable: false,
  });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
  assert.equal(result.requiresConfirmation, true);
});

test("a successful detail response without a head commit is still uncertain", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    headRefOid: "",
  });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
});

test("closed and malformed PR records never enter the active queue", () => {
  const closed = assess({ state: "closed" });
  const malformed = assess({ updatedAt: "not-a-date" });

  assert.equal(closed.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(malformed.actionState, ACTION_STATES.UNCERTAIN);
});

test("the historical boundary starts at exactly sixty days", () => {
  const stillActive = assess({
    updatedAt: "2026-06-01T09:00:01.000Z",
  });
  const historical = assess({
    updatedAt: "2026-06-01T09:00:00.000Z",
  });

  assert.notEqual(stillActive.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(historical.actionState, ACTION_STATES.HISTORICAL);
});

test("unknown CI state requires confirmation", () => {
  const result = assess({ ciStatus: "UNKNOWN" });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
});
