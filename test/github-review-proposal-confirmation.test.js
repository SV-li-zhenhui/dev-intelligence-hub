import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";

const HEAD_REF_OID = "b".repeat(40);

function inputBindingFor({
  eventId = "event-1",
  workItemId = "work-item-1",
  repository = "acme/repo",
  pullRequestNumber = 42,
  headRefOid = HEAD_REF_OID,
  sourceAccountId = "review-account",
} = {}) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository,
    pullRequestNumber,
    rootItemId: workItemId,
    workKey: "github:dashboard:acme-repo:42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid,
    eventId,
    eventDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId,
      baseRepository: repository,
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/review",
      headRefOid,
    },
  };
}

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
    headRefOid: HEAD_REF_OID,
    inputBinding: inputBindingFor(),
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
      inputBinding:
        overrides.binding?.inputBinding?.schemaVersion === 1
          ? overrides.binding.inputBinding
          : {
              ...binding.inputBinding,
              ...overrides.binding?.inputBinding,
            },
    },
    payload: { ...payload, ...overrides.payload },
  });
}

function evidenceTarget(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "work-item-1",
    roleId: "pr-reviewer",
    contractRevision: 2,
    contractDigest: "c".repeat(64),
    deliverables: [{ deliverableId: "review", kind: "review-report" }],
    ...overrides,
  };
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
    version: HEAD_REF_OID,
  });
  assert.deepEqual(plan.action, {
    type: "pull_request_review",
    reviewEvent: "REQUEST_CHANGES",
    body: "请先补充失败分支测试。",
    inputBinding: value.binding.inputBinding,
  });
  assert.deepEqual(plan.display.payload, {
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
  });
  assert.equal("displayedPayloadDigest" in plan, false);
  assert.equal("approvalBindingDigest" in plan, false);
});

test("self-authored blocking verdicts become explicit COMMENT reviews", () => {
  for (const verdict of ["approve", "request_changes"]) {
    const plan = createGitHubReviewProposalConfirmationPlan(
      proposal({ payload: { verdict } }),
      {
        actorAccountId: "review-account",
        selfAuthored: true,
      },
    );

    assert.equal(plan.action.reviewEvent, "COMMENT");
    assert.equal(
      plan.display.payload.reviewIntent,
      verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES",
    );
    assert.notEqual(
      plan.id,
      createGitHubReviewProposalConfirmationPlan(
        proposal({ payload: { verdict } }),
        { actorAccountId: "review-account" },
      ).id,
    );
    assert.equal(plan.display.payload.action.reviewEvent, "COMMENT");
    assert.equal(plan.display.actionLabel, "确认并以 COMMENT 发布到 GitHub");
    assert.match(plan.display.evidence.at(-1), /PR 作者.*COMMENT/u);
  }

  const alreadyComment = createGitHubReviewProposalConfirmationPlan(
    proposal({ payload: { verdict: "comment" } }),
    { actorAccountId: "review-account", selfAuthored: true },
  );
  assert.equal(alreadyComment.action.reviewEvent, "COMMENT");
  assert.equal(alreadyComment.display.actionLabel, "确认并发布到 GitHub");
  assert.equal(alreadyComment.display.evidence.length, 1);
});

test("review confirmation accepts exact proposal authority and rejects foreign targets", () => {
  const dispatchIntentId = `work-dispatch-intent-${"d".repeat(64)}`;
  const authorized = proposal({
    binding: { evidenceTarget: evidenceTarget(), dispatchIntentId },
  });
  assert.doesNotThrow(() =>
    createGitHubReviewProposalConfirmationPlan(authorized, {
      actorAccountId: "review-account",
    }),
  );

  const foreign = proposal({
    binding: {
      evidenceTarget: evidenceTarget({ taskId: "work-item-foreign" }),
    },
  });
  assert.throws(
    () =>
      createGitHubReviewProposalConfirmationPlan(foreign, {
        actorAccountId: "review-account",
      }),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
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

test("the canonical PR input binding must match the exact Review target", () => {
  const mismatchedBindings = [
    proposal({
      binding: { inputBinding: { repository: "other/repo" } },
    }),
    proposal({
      binding: { inputBinding: { pullRequestNumber: 43 } },
    }),
    proposal({
      binding: { inputBinding: { headRefOid: "e".repeat(40) } },
    }),
    proposal({
      binding: { inputBinding: { eventId: "event-foreign" } },
    }),
  ];

  for (const value of mismatchedBindings) {
    assert.throws(
      () =>
        createGitHubReviewProposalConfirmationPlan(value, {
          actorAccountId: "review-account",
        }),
      (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
    );
  }
});

test("legacy work-proposal reviews are recovery-only and only v2 binds the execution account", () => {
  const legacy = proposal({
    binding: {
      inputBinding: {
        schemaVersion: 1,
        kind: "pull_request",
        repository: "acme/repo",
        pullRequestNumber: 42,
        rootItemId: "work-item-1",
        workKey: "github:dashboard:acme-repo:42",
        inputRevision: 1,
        headRevision: 1,
        headRefOid: HEAD_REF_OID,
        eventId: "event-1",
        eventDigest: "c".repeat(64),
        inputDigest: "d".repeat(64),
      },
    },
  });
  const foreignAccount = proposal({
    binding: {
      inputBinding: inputBindingFor({ sourceAccountId: "other-account" }),
    },
  });

  assert.throws(
    () => createGitHubReviewProposalConfirmationPlan(legacy, {
      actorAccountId: "review-account",
    }),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
  const legacyPlan = createGitHubReviewProposalConfirmationPlan(legacy, {
    actorAccountId: "review-account",
    legacyRecovery: true,
  });
  assert.equal(Object.hasOwn(legacyPlan.action, "inputBinding"), false);
  assert.deepEqual(
    legacyPlan.display.payload.inputBinding,
    legacy.binding.inputBinding,
  );
  assert.throws(
    () =>
      createGitHubReviewProposalConfirmationPlan(foreignAccount, {
        actorAccountId: "review-account",
      }),
    (error) => error.code === "INVALID_GITHUB_REVIEW_PROPOSAL",
  );
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
