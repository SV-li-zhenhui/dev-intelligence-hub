import assert from "node:assert/strict";
import test from "node:test";

import {
  inferTestingProduct,
  prLifecycleStatus,
  prLifecycleStageLabel,
  prReviewLifecycleRoute,
  reviewerOwnerRouting,
  testingOwnerRouting,
} from "../public/review-handoff-routing.js";

test("configured test owners override the safe defaults", () => {
  const routing = testingOwnerRouting({
    workCoordination: {
      policy: {
        testingOwnersByProduct: {
          qt: ["qt-tester-primary", "qt-tester-secondary"],
          bs: ["bs-tester"],
        },
      },
    },
  });

  assert.deepEqual(routing.products, ["qt", "bs"]);
  assert.deepEqual(routing.ownersByProduct.bs, ["bs-tester"]);
  assert.equal(routing.ownerLabel("qt-tester-secondary"), "@qt-tester-secondary");
});

test("lifecycle stages use owner-readable Chinese labels", () => {
  assert.equal(prLifecycleStageLabel("self_fix"), "自己修复");
  assert.equal(prLifecycleStageLabel("external_review"), "交给其他 Reviewer");
  assert.equal(prLifecycleStageLabel("testing"), "交给测试");
});

test("PR lifecycle status names the current stage and next owner", () => {
  assert.deepEqual(
    prLifecycleStatus({
      relation: "authored",
      nextAction: "address_review",
      reviewDecision: "CHANGES_REQUESTED",
    }),
    {
      ownership: "self",
      stage: "self_fix",
      title: "自己的 PR · 修复闭环",
      nextOwner: "开发工程师（自己）",
      nextStep: "处理外部 Review 意见，测试并推送新 Head；随后重新进入 Review。",
    },
  );
  assert.equal(
    prLifecycleStatus({
      relation: "authored",
      nextAction: "wait_merge",
      reviewDecision: "APPROVED",
    }).stage,
    "testing",
  );
  assert.equal(
    prLifecycleStatus({
      relation: "review_requested",
      nextAction: "review",
    }).stage,
    "internal_review",
  );
});

test("configured external reviewers are routed separately from testers", () => {
  const routing = reviewerOwnerRouting({
    workCoordination: {
      policy: {
        reviewOwnersByProduct: {
          qt: ["qt-reviewer"],
          bs: ["bs-reviewer"],
        },
      },
    },
  });

  assert.deepEqual(routing.products, ["qt", "bs"]);
  assert.deepEqual(routing.ownersByProduct.qt, ["qt-reviewer"]);
  assert.equal(routing.ownerLabel("bs-reviewer"), "@bs-reviewer");
});

test("B/S wording selects the web bucket without confusing B-scan with B/S", () => {
  assert.equal(inferTestingProduct("B/S 前端版本验证"), "bs");
  assert.equal(inferTestingProduct("Web version smoke test"), "bs");
  assert.equal(inferTestingProduct("B-scan Qt widget"), "qt");
});

test("another author's approved PR proceeds to testing", () => {
  assert.deepEqual(
    prReviewLifecycleRoute({ relation: "review_requested" }, "APPROVE"),
    {
      ownership: "other",
      stage: "testing",
      workType: "testing",
      responsibleKind: "tester",
      summary: "Review 通过，交给测试负责人验证；测试结论再进入合并门禁。",
    },
  );
});

test("another author's rejected PR waits on its author instead of assigning our developer", () => {
  assert.deepEqual(
    prReviewLifecycleRoute(
      { relation: "review_requested" },
      "REQUEST_CHANGES",
    ),
    {
      ownership: "other",
      stage: "awaiting_author_fix",
      workType: "pull_request",
      responsibleKind: "pr_engineer",
      summary: "Review 未通过，等待 PR 作者修复；出现新 Head 后由 PR 工程师复审。",
    },
  );
});

test("my PR loops through self-fix until it is ready for an external reviewer", () => {
  assert.deepEqual(
    prReviewLifecycleRoute({ relation: "authored" }, "REQUEST_CHANGES"),
    {
      ownership: "self",
      stage: "self_fix",
      workType: "development",
      responsibleKind: "self",
      summary: "内部 Review 未通过，交回自己的开发任务；修复、测试并推送新 Head 后重新 Review。",
    },
  );
  assert.deepEqual(
    prReviewLifecycleRoute({ relation: "authored" }, "APPROVE"),
    {
      ownership: "self",
      stage: "external_review",
      workType: "pull_request",
      responsibleKind: "external_reviewer",
      summary: "内部 Review 通过，交给其他 Reviewer；对方提出问题时再回到自己的修复闭环。",
    },
  );
});

test("external feedback on my PR routes back to development even when GitHub uses COMMENT", () => {
  assert.equal(
    prReviewLifecycleRoute(
      { relation: "authored", nextAction: "address_review" },
      "COMMENT",
    ).stage,
    "self_fix",
  );
});
