import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import {
  PrReviewConfirmationError,
  createPrReviewConfirmationPlan,
} from "../src/domain/pr-review-confirmation.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function reviewJob(overrides = {}) {
  return {
    id: "pr-work-0123456789abcdef0123",
    workType: "review_draft",
    status: "ready_for_human",
    requiresApproval: true,
    repo: "acme/command-center",
    number: 42,
    headRefOid: HEAD,
    title: "Protect the checkout flow",
    summary: "失败路径缺少回归覆盖，建议补充测试后再合并。",
    evidence: ["checkout.js 修改了失败分支", "当前 head 已完成复核"],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    ...overrides,
  };
}

function options(actorAccountId = "local-owner") {
  return { githubActions: { actorAccountId } };
}

test("maps every employee verdict to a head-bound GitHub Review event", () => {
  const cases = [
    ["approve", "APPROVE"],
    ["request_changes", "REQUEST_CHANGES"],
    ["comment", "COMMENT"],
  ];

  for (const [reviewVerdict, reviewEvent] of cases) {
    const job = reviewJob({ reviewVerdict });
    const plan = createPrReviewConfirmationPlan(job, options());

    assert.deepEqual(plan, {
      id: `confirmation-${job.id}`,
      kind: "github.pull-request-review",
      requestedBy: {
        roleId: "pr-reviewer",
        workItemId: job.id,
      },
      actor: {
        provider: "github",
        accountId: "local-owner",
      },
      target: {
        provider: "github",
        resourceId: "acme/command-center#42",
        version: HEAD,
      },
      action: {
        type: "pull_request_review",
        reviewEvent,
        body: job.reviewBody,
      },
      display: {
        title: "acme/command-center #42 · Protect the checkout flow",
        summary: job.summary,
        actionLabel: "确认并发布到 GitHub",
        evidence: job.evidence,
        payload: {
          actor: {
            provider: "github",
            accountId: "local-owner",
          },
          target: {
            provider: "github",
            resourceId: "acme/command-center#42",
            version: HEAD,
          },
          action: {
            type: "pull_request_review",
            reviewEvent,
            body: job.reviewBody,
          },
        },
      },
    });

    const normalized = normalizeConfirmationPlan(plan);
    assert.match(normalized.displayedPayloadDigest, /^[a-f0-9]{64}$/);
    assert.match(normalized.approvalBindingDigest, /^[a-f0-9]{64}$/);
  }
});

test("requires an explicit configured GitHub actor without fallback", () => {
  for (const value of [
    undefined,
    {},
    { githubActions: {} },
    { githubActions: { actorAccountId: "" } },
    {
      githubActions: { actorAccountId: undefined },
      githubLogin: "implicit-user",
    },
  ]) {
    assert.throws(
      () => createPrReviewConfirmationPlan(reviewJob(), value),
      (error) =>
        error instanceof PrReviewConfirmationError &&
        error.code === "INVALID_PR_REVIEW_CONFIRMATION",
    );
  }

  let getterCalls = 0;
  const githubActions = {};
  Object.defineProperty(githubActions, "actorAccountId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "implicit-user";
    },
  });
  assert.throws(() =>
    createPrReviewConfirmationPlan(reviewJob(), { githubActions }),
  );
  assert.equal(getterCalls, 0);
});

test("fails closed for invalid verdict, body, head, or repository", () => {
  const cases = [
    { reviewVerdict: "none" },
    { reviewVerdict: "APPROVE" },
    { reviewBody: "" },
    { reviewBody: "  \n" },
    { reviewBody: "\u0000hidden" },
    { headRefOid: "head-42" },
    { headRefOid: "A".repeat(40) },
    { repo: "acme" },
    { repo: "../acme/command-center" },
    { repo: "acme/.hidden" },
  ];

  for (const overrides of cases) {
    assert.throws(
      () => createPrReviewConfirmationPlan(reviewJob(overrides), options()),
      PrReviewConfirmationError,
      JSON.stringify(overrides),
    );
  }
});

test("fails closed unless the job is an approval-ready PR review draft", () => {
  for (const overrides of [
    { status: "ready" },
    { requiresApproval: false },
    { workType: "owner_plan" },
    { number: 0 },
    { number: 1.5 },
    { summary: "" },
    { title: "" },
    { evidence: [] },
    { evidence: ["valid", 42] },
  ]) {
    assert.throws(
      () => createPrReviewConfirmationPlan(reviewJob(overrides), options()),
      PrReviewConfirmationError,
      JSON.stringify(overrides),
    );
  }
});

test("copies exact visible evidence and binds the complete action in display payload", () => {
  const job = reviewJob();
  const plan = createPrReviewConfirmationPlan(job, options());

  assert.notStrictEqual(plan.display.evidence, job.evidence);
  assert.deepEqual(plan.display.evidence, job.evidence);
  assert.deepEqual(plan.display.payload.actor, plan.actor);
  assert.deepEqual(plan.display.payload.target, plan.target);
  assert.deepEqual(plan.display.payload.action, plan.action);

  job.evidence[0] = "mutated after planning";
  job.reviewBody = "mutated after planning";
  assert.equal(plan.display.evidence[0], "checkout.js 修改了失败分支");
  assert.equal(plan.action.body, "建议补充失败路径测试后再合并。");
  assert.equal(plan.display.payload.action.body, plan.action.body);
});
