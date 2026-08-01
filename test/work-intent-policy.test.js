import assert from "node:assert/strict";
import test from "node:test";
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

function context(overrides = {}) {
  return {
    assignmentId: `workflow-assignment-${"a".repeat(64)}`,
    workItemId: `work-item-${"b".repeat(64)}`,
    roleId: "pr-reviewer",
    event: event(),
    ...overrides,
  };
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成核对",
    reason: "需要推进下一步",
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
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    ...overrides,
  });
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
