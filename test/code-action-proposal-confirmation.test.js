import assert from "node:assert/strict";
import test from "node:test";
import { createCodeActionProposalConfirmationPlan } from "../src/domain/code-action-proposal-confirmation.js";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";

const PROFILE_DIGEST = "a".repeat(64);
const BRAIN_DIGEST = "b".repeat(64);

function event(overrides = {}) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "Fix race",
      headRefOid: "abc123",
      state: "open",
      changedFields: ["headRefOid"],
    },
    ...overrides,
  });
}

function proposal(operation = "modify", { roleId = "developer" } = {}) {
  const trustedEvent = event();
  const bound = createWorkIntentPolicy({
    version: 7,
    codeActionRoles: ["developer", "tester"],
    workspaceByRepository: { "acme/repo": "acme-workspace" },
  }).bind({
    context: {
      assignmentId: `workflow-assignment-${"c".repeat(64)}`,
      workItemId: `work-item-${"d".repeat(64)}`,
      roleId,
      event: trustedEvent,
    },
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      operation,
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过", "源工作区保持不变"],
      evidence: ["revision 未校验"],
      summary: "创建受控代码任务",
      reason: "需要在隔离副本中验证修复",
    },
  });
  return normalizeBoundWorkProposal({
    proposalId: bound.intentId,
    policyVersion: bound.policyVersion,
    kind: bound.kind,
    requestedBy: bound.requestedBy,
    source: bound.source,
    binding: bound.binding,
    payload: bound.payload,
  });
}

function proposalWith(value, overrides = {}) {
  return normalizeBoundWorkProposal({
    proposalId: overrides.proposalId ?? value.proposalId,
    policyVersion: overrides.policyVersion ?? value.policyVersion,
    kind: overrides.kind ?? value.kind,
    requestedBy: {
      ...value.requestedBy,
      ...overrides.requestedBy,
    },
    source: { ...value.source, ...overrides.source },
    binding: {
      ...value.binding,
      ...overrides.binding,
      subject: {
        ...value.binding.subject,
        ...overrides.binding?.subject,
      },
    },
    payload: { ...value.payload, ...overrides.payload },
  });
}

function grantFor(value, overrides = {}) {
  const operation = overrides.operation ?? value.payload.operation;
  const repository = overrides.repository ?? value.binding.repository;
  const subject = {
    ...value.binding.subject,
    ...(overrides.subject ?? {}),
  };
  return createCodeJobGrant({
    proposalId: overrides.proposalId ?? value.proposalId,
    contentDigest: overrides.contentDigest ?? value.contentDigest,
    policyVersion: overrides.policyVersion ?? value.policyVersion,
    requestedBy: {
      ...value.requestedBy,
      ...(overrides.requestedBy ?? {}),
    },
    source: { ...value.source, ...(overrides.source ?? {}) },
    subject,
    repository,
    workspaceId: overrides.workspaceId ?? value.binding.workspaceId,
    workspaceAuthorityDigest:
      overrides.workspaceAuthorityDigest ?? "9".repeat(64),
    operation,
    objective: overrides.objective ?? value.payload.objective,
    acceptanceCriteria:
      overrides.acceptanceCriteria ?? value.payload.acceptanceCriteria,
    evidence: overrides.evidence ?? value.payload.evidence,
    summary: overrides.summary ?? value.payload.summary,
    reason: overrides.reason ?? value.payload.reason,
    allowedActions:
      overrides.allowedActions ?? [...CODE_JOB_ACTIONS_BY_OPERATION[operation]],
    writablePaths:
      overrides.writablePaths ?? (operation === "modify" ? ["src"] : []),
    requiredProfiles: overrides.requiredProfiles ?? [
      { id: "node-tests", configDigest: PROFILE_DIGEST },
    ],
    brainDigest: overrides.brainDigest ?? BRAIN_DIGEST,
  });
}

function options(grant, allowedOperationsByRole = {}) {
  return {
    grant,
    allowedOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
      ...allowedOperationsByRole,
    },
  };
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) => error?.code === "INVALID_CODE_ACTION_PROPOSAL",
  );
}

test("a policy-bound code proposal becomes one exact local job creation approval", () => {
  const value = proposal();
  const grant = grantFor(value);
  const plan = createCodeActionProposalConfirmationPlan(
    value,
    options(grant),
  );

  assert.match(plan.id, /^confirmation-code-job-[a-f0-9]{64}$/);
  assert.equal(Buffer.byteLength(plan.id, "utf8") <= 128, true);
  assert.equal(plan.kind, "local.code-job-create");
  assert.deepEqual(plan.requestedBy, value.requestedBy);
  assert.deepEqual(plan.actor, {
    provider: "local-code",
    accountId: "controlled-code-executor",
  });
  assert.deepEqual(plan.target, {
    provider: "local-code",
    resourceId: "acme-workspace",
    version: value.contentDigest,
  });
  assert.deepEqual(plan.action, { type: "create_code_job", grant });
  assert.deepEqual(plan.display.payload, {
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
  });
  assert.match(plan.display.actionLabel, /创建本地代码任务/);
  assert.match(plan.display.actionLabel, /不会立即执行/);
  assert.equal("displayedPayloadDigest" in plan, false);
  assert.equal("approvalBindingDigest" in plan, false);

  const queued = normalizeConfirmationPlan(plan);
  assert.match(queued.displayedPayloadDigest, /^[a-f0-9]{64}$/);
  assert.match(queued.approvalBindingDigest, /^[a-f0-9]{64}$/);
});

test("confirmation IDs bind both proposal and grant while remaining stable and bounded", () => {
  const original = proposal();
  const value = proposalWith(original, {
    proposalId: `p${"a".repeat(190)}b`,
  });
  const grant = grantFor(value);
  const first = createCodeActionProposalConfirmationPlan(
    value,
    options(grant),
  );
  const repeated = createCodeActionProposalConfirmationPlan(
    value,
    options(grant),
  );
  const anotherBrain = grantFor(value, { brainDigest: "e".repeat(64) });
  const changed = createCodeActionProposalConfirmationPlan(
    value,
    options(anotherBrain),
  );

  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, changed.id);
  assert.match(first.id, /^confirmation-code-job-[a-f0-9]{64}$/);
  assert.equal(Buffer.byteLength(first.id, "utf8") <= 128, true);
});

test("operation capabilities come only from the trusted grant and never widen write access", () => {
  for (const operation of ["inspect", "modify", "verify"]) {
    const value = proposal(operation);
    const grant = grantFor(value);
    const plan = createCodeActionProposalConfirmationPlan(
      value,
      options(grant),
    );
    assert.deepEqual(
      plan.action.grant.allowedActions,
      CODE_JOB_ACTIONS_BY_OPERATION[operation],
    );
    assert.equal(
      plan.action.grant.allowedActions.includes("write_text"),
      operation === "modify",
    );
    assert.deepEqual(
      plan.action.grant.writablePaths,
      operation === "modify" ? ["src"] : [],
    );
    assert.deepEqual(plan.action.grant.requiredProfiles, [
      { id: "node-tests", configDigest: PROFILE_DIGEST },
    ]);
  }

  const value = proposal();
  const injected = proposalWith(value, {
    payload: { allowedActions: ["write_text"] },
  });
  assertInvalid(() =>
    createCodeActionProposalConfirmationPlan(
      injected,
      options(grantFor(value)),
    ),
  );
});

test("trusted role policy permits developer modify but denies tester modify", () => {
  const developer = proposal("modify", { roleId: "developer" });
  assert.doesNotThrow(() =>
    createCodeActionProposalConfirmationPlan(
      developer,
      options(grantFor(developer)),
    ),
  );

  const tester = proposal("modify", { roleId: "tester" });
  assertInvalid(() =>
    createCodeActionProposalConfirmationPlan(
      tester,
      options(grantFor(tester)),
    ),
  );
  assert.doesNotThrow(() =>
    createCodeActionProposalConfirmationPlan(
      tester,
      options(grantFor(tester), { tester: ["inspect", "modify", "verify"] }),
    ),
  );
});

test("configured role IDs remain compatible through the code authorization chain", () => {
  const roleId = "r".repeat(65);
  const value = proposalWith(proposal("inspect"), {
    requestedBy: { roleId },
  });
  const grant = grantFor(value);

  assert.doesNotThrow(() =>
    createCodeActionProposalConfirmationPlan(value, {
      grant,
      allowedOperationsByRole: { [roleId]: ["inspect"] },
    }),
  );
});

test("proposal content, event, subject, and workspace bindings fail closed", () => {
  const value = proposal();
  const grant = grantFor(value);
  const invalidProposals = [
    { ...value, contentDigest: "f".repeat(64) },
    proposalWith(value, { binding: { eventId: "another-event" } }),
    proposalWith(value, {
      binding: { subject: { repository: "other/repo" } },
    }),
    proposalWith(value, { kind: "github_review_proposal" }),
  ];

  for (const candidate of invalidProposals) {
    assertInvalid(() =>
      createCodeActionProposalConfirmationPlan(candidate, options(grant)),
    );
  }
});

test("proposal and grant must agree on every execution-relevant field", () => {
  const value = proposal();
  const mismatchedGrants = [
    grantFor(value, { proposalId: `work-intent-${"e".repeat(64)}` }),
    grantFor(value, { contentDigest: "e".repeat(64) }),
    grantFor(value, { policyVersion: value.policyVersion + 1 }),
    grantFor(value, { requestedBy: { roleId: "tester" } }),
    grantFor(value, { source: { eventId: "another-event" } }),
    grantFor(value, {
      repository: "other/repo",
      subject: { repository: "other/repo" },
    }),
    grantFor(value, { workspaceId: "other-workspace" }),
    grantFor(value, { operation: "inspect" }),
    grantFor(value, { objective: "另一个目标" }),
    grantFor(value, { acceptanceCriteria: ["另一个验收标准"] }),
  ];

  for (const grant of mismatchedGrants) {
    assertInvalid(() =>
      createCodeActionProposalConfirmationPlan(value, options(grant)),
    );
  }
});

test("brain, grant, options, and role-policy tampering all fail closed", () => {
  const value = proposal();
  const grant = grantFor(value);
  const tamperedGrants = [
    { ...grant, brainDigest: "e".repeat(64) },
    { ...grant, grantDigest: "e".repeat(64) },
    { ...grant, allowedActions: ["write_text"] },
    { ...grant, requiredProfiles: [] },
  ];
  for (const tampered of tamperedGrants) {
    assertInvalid(() =>
      createCodeActionProposalConfirmationPlan(value, options(tampered)),
    );
  }

  assertInvalid(() =>
    createCodeActionProposalConfirmationPlan(value, {
      ...options(grant),
      extra: true,
    }),
  );
  assertInvalid(() =>
    createCodeActionProposalConfirmationPlan(value, {
      grant,
      allowedOperationsByRole: Object.create({ developer: ["modify"] }),
    }),
  );
  assertInvalid(() =>
    createCodeActionProposalConfirmationPlan(value, {
      grant,
      allowedOperationsByRole: { developer: ["modify", "modify"] },
    }),
  );
});
