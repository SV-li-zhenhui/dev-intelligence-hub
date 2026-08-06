import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryEvidenceTarget } from "../src/domain/delivery-evidence-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import {
  WorkIntentPolicyError,
  createWorkIntentPolicy,
} from "../src/services/work-intent-policy.js";

function event(overrides = {}) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: {
      title: "Fix race",
      headRefOid: "abc123",
      state: "open",
      changedFields: ["headRefOid"],
    },
    ...overrides,
  });
}

function inputBinding(trustedEvent, rootItemId) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: trustedEvent.subject.repository,
    pullRequestNumber: trustedEvent.subject.number,
    rootItemId,
    workKey: "github:dashboard:acme-repo:42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: trustedEvent.payload.headRefOid,
    eventId: trustedEvent.eventId,
    eventDigest: trustedEvent.contentDigest,
    inputDigest: "d".repeat(64),
  };
}

function context(overrides = {}) {
  const trustedEvent = overrides.event ?? event();
  const result = {
    assignmentId: `workflow-assignment-${"a".repeat(64)}`,
    workItemId: `work-item-${"b".repeat(64)}`,
    roleId: "pr-reviewer",
    event: trustedEvent,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "inputBinding")) {
    result.inputBinding = inputBinding(trustedEvent, result.workItemId);
  }
  return result;
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成核对",
    reason: "需要推进下一步",
  };
}

function orchestrateIntent() {
  const reason = "等待当前依赖恢复";
  return {
    ...common("orchestrate"),
    reason,
    action: {
      schemaVersion: 1,
      type: "pause",
      sourceTaskId: context().workItemId,
      sourceTaskRevision: 4,
      expectedGraphRevision: 8,
      reason,
    },
  };
}

function submitDeliveryIntent() {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: context().workItemId,
    expectedTaskRevision: 6,
    expectedGraphRevision: 9,
    contractRevision: 1,
    deliverableId: "implementation",
    summary: "实现和聚焦测试已经完成",
    reason: "当前证据满足提交条件",
    evidence: [{
      kind: "change-package",
      referenceId: "change-package:development:1",
      contentDigest: "a".repeat(64),
    }],
    artifact: null,
  };
}

function policy(overrides = {}) {
  return createWorkIntentPolicy({
    version: 3,
    capabilityRoles: {
      coordination: "orchestrator",
      requirements: "requirements-analyst",
      "pr-review": "pr-reviewer",
      development: "developer",
      testing: "tester",
    },
    githubReviewRoles: ["pr-reviewer"],
    codeActionRoles: ["developer"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
    },
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    ...overrides,
  });
}

function acceptanceContract() {
  return {
    revision: 4,
    acceptanceCriteria: [
      { criterionId: "verified", description: "受控执行结果可复核" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "主实现变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "change-package",
        description: "验证变更包",
        required: true,
      },
    ],
  };
}

test("binds user questions and waits to the trusted work item and event", () => {
  const created = policy().bind({
    context: context(),
    intent: {
      ...common("ask_user"),
      question: "是否接受新的验收口径？",
      choices: [{ id: "accept", label: "接受", description: "继续推进" }],
    },
  });

  assert.equal(created.kind, "attention_request");
  assert.deepEqual(created.requestedBy, {
    roleId: "pr-reviewer",
    workItemId: context().workItemId,
  });
  assert.equal(created.source.assignmentId, context().assignmentId);
  assert.equal(created.source.eventId, context().event.eventId);
  assert.equal(created.binding.subject.repository, "acme/repo");
  assert.equal(created.payload.question, "是否接受新的验收口径？");
  assert.match(created.intentId, /^work-intent-[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(created));

  const waiting = policy().bind({
    context: context(),
    intent: {
      ...common("wait_condition"),
      condition: { kind: "workflow_fact", fact: "ci-status", oneOf: ["success"] },
      checkAfterSeconds: 300,
    },
  });
  assert.equal(waiting.kind, "wait_condition");
  assert.deepEqual(waiting.payload.condition, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  assert.equal(waiting.payload.checkAfterSeconds, 300);
});

test("derives a GitHub review target only from the trusted event", () => {
  const bound = policy().bind({
    context: context(),
    intent: {
      ...common("propose_github_review"),
      verdict: "comment",
      body: "建议补一条并发回归测试。",
      evidence: ["状态更新可能丢失"],
    },
  });

  assert.equal(bound.kind, "github_review_proposal");
  assert.deepEqual(bound.binding, {
    eventId: context().event.eventId,
    subject: context().event.subject,
    repository: "acme/repo",
    pullRequestNumber: 42,
    headRefOid: "abc123",
    inputBinding: context().inputBinding,
  });
  assert.equal(Object.hasOwn(bound.binding, "accountId"), false);
  assert.equal(Object.hasOwn(bound.payload, "command"), false);
  assert.equal(bound.payload.verdict, "comment");

  const repeated = policy().bind({
    context: context(),
    intent: {
      ...common("propose_github_review"),
      verdict: "comment",
      body: "建议补一条并发回归测试。",
      evidence: ["状态更新可能丢失"],
    },
  });
  assert.equal(repeated.intentId, bound.intentId);
});

test("maps code workspaces and handoff roles from policy rather than model output", () => {
  const code = policy().bind({
    context: context({ roleId: "developer" }),
    intent: {
      ...common("propose_code_action"),
      operation: "modify",
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过"],
      evidence: ["revision 未校验"],
    },
  });
  assert.equal(code.kind, "code_action_proposal");
  assert.equal(code.binding.workspaceId, "acme-workspace");
  assert.equal(code.binding.repository, "acme/repo");
  assert.deepEqual(code.binding.inputBinding, context().inputBinding);
  assert.deepEqual(Object.keys(code.payload), [
    "operation",
    "objective",
    "acceptanceCriteria",
    "evidence",
    "summary",
    "reason",
  ]);

  const handoff = policy().bind({
    context: context(),
    intent: {
      ...common("handoff"),
      capability: "testing",
      brief: "执行跨平台回归",
      evidence: [],
    },
  });
  assert.equal(handoff.kind, "handoff");
  assert.equal(handoff.binding.targetRoleId, "tester");
  assert.equal(handoff.payload.capability, "testing");
});

test("proposal authority binds one selected delivery and the durable dispatch identity", () => {
  const trustedContext = context({ roleId: "developer" });
  const evidenceTarget = createDeliveryEvidenceTarget({
    taskId: trustedContext.workItemId,
    roleId: trustedContext.roleId,
    acceptanceContract: acceptanceContract(),
    deliverableId: "verification",
  });
  const dispatchIntentId = `work-dispatch-intent-${"e".repeat(64)}`;
  const intent = {
    ...common("propose_code_action"),
    deliverableId: "verification",
    dispatchIntentId,
    operation: "verify",
    objective: "验证指定交付物",
    acceptanceCriteria: ["聚焦测试通过"],
    evidence: [],
  };

  const bound = policy().bind({
    context: { ...trustedContext, evidenceTarget },
    intent,
  });

  assert.deepEqual(bound.binding.evidenceTarget, evidenceTarget);
  assert.equal(bound.binding.evidenceTarget.deliverables.length, 1);
  assert.equal(
    bound.binding.evidenceTarget.deliverables[0].deliverableId,
    "verification",
  );
  assert.equal(bound.binding.dispatchIntentId, dispatchIntentId);

  const nonAuthoritative = policy().bind({
    context: trustedContext,
    intent,
  });
  assert.equal(
    Object.hasOwn(nonAuthoritative.binding, "evidenceTarget"),
    false,
  );
  assert.equal(nonAuthoritative.binding.dispatchIntentId, dispatchIntentId);

  const continued = policy().bind({
    context: { ...trustedContext, evidenceTarget },
    intent: {
      ...intent,
      dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
    },
  });
  assert.notEqual(continued.intentId, bound.intentId);
  assert.notEqual(continued.binding.dispatchIntentId, dispatchIntentId);
});

test("proposal policy rejects foreign or differently selected evidence authority", () => {
  const trustedContext = context({ roleId: "developer" });
  const target = createDeliveryEvidenceTarget({
    taskId: trustedContext.workItemId,
    roleId: trustedContext.roleId,
    acceptanceContract: acceptanceContract(),
    deliverableId: "verification",
  });
  const baseIntent = {
    ...common("propose_code_action"),
    operation: "modify",
    objective: "修改主实现",
    acceptanceCriteria: ["测试通过"],
    evidence: [],
  };
  const foreignTask = { ...target, taskId: `work-item-${"f".repeat(64)}` };

  for (const [evidenceTarget, deliverableId] of [
    [target, "implementation"],
    [foreignTask, "verification"],
  ]) {
    assert.throws(
      () => policy().bind({
        context: { ...trustedContext, evidenceTarget },
        intent: { ...baseIntent, deliverableId },
      }),
      (error) =>
        error instanceof WorkIntentPolicyError &&
        error.code === "WORK_INTENT_CONTEXT_INVALID",
    );
  }
});

test("code operations are configurable per trusted role", () => {
  const configured = policy({
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
  });

  assert.throws(
    () =>
      configured.bind({
        context: context({ roleId: "tester" }),
        intent: {
          ...common("propose_code_action"),
          operation: "modify",
          objective: "修改实现",
          acceptanceCriteria: ["测试通过"],
          evidence: [],
        },
      }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("completion remains internal and carries no execution capability", () => {
  const complete = policy().bind({
    context: context(),
    intent: {
      ...common("complete"),
      outcome: "no-action",
      evidence: ["事项已关闭"],
    },
  });
  assert.equal(complete.kind, "complete");
  assert.deepEqual(complete.binding, {
    eventId: context().event.eventId,
    subject: context().event.subject,
  });
  assert.equal(JSON.stringify(complete).includes("command"), false);
});

test("orchestration and delivery intents create zero generic policy bindings", () => {
  const bindings = [];
  for (const intent of [orchestrateIntent(), submitDeliveryIntent()]) {
    assert.throws(
      () => bindings.push(policy().bind({ context: context(), intent })),
      (error) =>
        error instanceof WorkIntentPolicyError &&
        error.code === "WORK_INTENT_POLICY_DENIED",
    );
  }
  assert.deepEqual(bindings, []);
});

test("denies role escalation, stale PR contexts, and absent trusted mappings", () => {
  const githubIntent = {
    ...common("propose_github_review"),
    verdict: "approve",
    body: "可以合入。",
    evidence: [],
  };
  const codeIntent = {
    ...common("propose_code_action"),
    operation: "inspect",
    objective: "检查代码",
    acceptanceCriteria: ["定位问题"],
    evidence: [],
  };
  const cases = [
    () => policy().bind({ context: context({ roleId: "developer" }), intent: githubIntent }),
    () => policy().bind({
      context: context({ event: event({ eventType: "issue.updated" }) }),
      intent: githubIntent,
    }),
    () => policy().bind({
      context: context({ event: event({ eventType: "pull_request.completed" }) }),
      intent: githubIntent,
    }),
    () => policy().bind({
      context: context({ event: event({ payload: { title: "Missing head", state: "open" } }) }),
      intent: githubIntent,
    }),
    () => policy({ workspaceByRepository: {} }).bind({
      context: context({ roleId: "developer" }),
      intent: codeIntent,
    }),
    () => policy({ capabilityRoles: {} }).bind({
      context: context(),
      intent: { ...common("handoff"), capability: "testing", brief: "test", evidence: [] },
    }),
  ];

  for (const operation of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof WorkIntentPolicyError &&
        ["WORK_INTENT_POLICY_DENIED", "WORK_INTENT_CONTEXT_INVALID"].includes(error.code),
    );
  }
});

test("rejects untrusted context fields, inherited data, and post-bind mutation", () => {
  const intent = {
    ...common("complete"),
    outcome: "done",
    evidence: [],
  };
  assert.throws(
    () => policy().bind({ context: { ...context(), accountId: "attacker" }, intent }),
    (error) => error instanceof WorkIntentPolicyError,
  );
  assert.throws(
    () => policy().bind({ context: Object.assign(Object.create({ roleId: "root" }), context()), intent }),
    (error) => error instanceof WorkIntentPolicyError,
  );

  const bound = policy().bind({ context: context(), intent });
  assert.throws(() => {
    bound.binding.subject.repository = "attacker/repo";
  }, TypeError);
  assert.equal(bound.binding.subject.repository, "acme/repo");
});
