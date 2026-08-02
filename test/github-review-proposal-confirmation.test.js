import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";

function proposal(overrides = {}) {
  const source = { assignmentId: "assignment-1", eventId: "event-1" };
  const binding = {
    eventId: "event-1",
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    repository: "acme/repo",
    pullRequestNumber: 42,
    headRefOid: "b".repeat(40),
  };
  const payload = {
    verdict: "request_changes",
    body: "请先补充失败分支测试。",
    evidence: ["缺少失败路径覆盖"],
    summary: "建议修改",
    reason: "风险尚未覆盖",
  };
  return normalizeBoundWorkProposal({
    proposalId: `work-intent-${"a".repeat(64)}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: "work-item-1",
    },
    source,
    binding,
    payload,
    ...overrides,
    source: { ...source, ...overrides.source },
    binding: {
      ...binding,
      ...overrides.binding,
      subject: { ...binding.subject, ...overrides.binding?.subject },
    },
    payload: { ...payload, ...overrides.payload },
  });
}

test("a trusted GitHub proposal becomes the exact user-visible action", () => {
  const value = proposal();
  const plan = createGitHubReviewProposalConfirmationPlan(value, {
    actorAccountId: "review-account",
  });

  assert.match(plan.id, /^confirmation-github-review-[a-f0-9]{64}$/);
  assert.deepEqual(plan.requestedBy, value.requestedBy);
  assert.deepEqual(plan.actor, {
    provider: "github",
    accountId: "review-account",
  });
  assert.deepEqual(plan.target, {
    provider: "github",
    resourceId: "acme/repo#42",
    version: "b".repeat(40),
  });
  assert.deepEqual(plan.action, {
    type: "pull_request_review",
    reviewEvent: "REQUEST_CHANGES",
    body: "请先补充失败分支测试。",
  });
  assert.deepEqual(plan.display.payload, {
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
  });
  assert.equal("displayedPayloadDigest" in plan, false);
  assert.equal("approvalBindingDigest" in plan, false);
});

test("confirmation IDs remain stable and bounded for maximum-length proposal IDs", () => {
  const value = proposal({ proposalId: `p${"a".repeat(190)}b` });
  const first = createGitHubReviewProposalConfirmationPlan(value, {
    actorAccountId: "review-account",
  });
  const second = createGitHubReviewProposalConfirmationPlan(value, {
    actorAccountId: "review-account",
  });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^confirmation-github-review-[a-f0-9]{64}$/);
  assert.equal(Buffer.byteLength(first.id, "utf8") <= 128, true);
});

test("oversized review bodies fail at the proposal conversion boundary", () => {
  const value = proposal({ payload: { body: "x".repeat(16 * 1_024 + 1) } });

  assert.throws(
    () =>
      createGitHubReviewProposalConfirmationPlan(value, {
        actorAccountId: "review-account",
      }),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
});

test("source event and PR subject bindings must agree", () => {
  const mismatchedEvent = proposal({ binding: { eventId: "event-2" } });
  const mismatchedSubject = proposal({
    binding: { subject: { repository: "other/repo" } },
  });

  for (const value of [mismatchedEvent, mismatchedSubject]) {
    assert.throws(
      () =>
        createGitHubReviewProposalConfirmationPlan(value, {
          actorAccountId: "review-account",
        }),
      (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
    );
  }
});

test("accepts the exact trusted subject emitted by the work intent policy", () => {
  const value = proposal();
  const plan = createGitHubReviewProposalConfirmationPlan(value, {
    actorAccountId: "review-account",
  });

  assert.equal(value.binding.subject.id, "github:pr:acme/repo#42");
  assert.equal(plan.target.resourceId, "acme/repo#42");
});

test("tampered digests and non-GitHub proposal shapes fail closed", () => {
  const value = proposal();
  assert.throws(
    () =>
      createGitHubReviewProposalConfirmationPlan(
        { ...value, contentDigest: "f".repeat(64) },
        { actorAccountId: "review-account" },
      ),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
  assert.throws(
    () =>
      createGitHubReviewProposalConfirmationPlan(
        { ...value, kind: "code_action_proposal" },
        { actorAccountId: "review-account" },
      ),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
});
