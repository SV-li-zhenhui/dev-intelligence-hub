import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { CodeJobGrantFactory } from "../src/services/code-job-grant-factory.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";

function proposal(operation = "modify", roleId = "developer") {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { title: "Fix race", headRefOid: "abc123", state: "open" },
  });
  const bound = createWorkIntentPolicy({
    version: 7,
    codeActionRoles: ["developer", "tester"],
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
  }).bind({
    context: {
      assignmentId: `workflow-assignment-${"c".repeat(64)}`,
      workItemId: `work-item-${"d".repeat(64)}`,
      roleId,
      event,
    },
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      operation,
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过"],
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

function factory(overrides = {}) {
  return new CodeJobGrantFactory({
    executorAuthority: {
      workspaces: [
        {
          id: "acme-workspace",
          writablePaths: ["src", "test"],
          requiredProfiles: [
            { id: "node-tests", configDigest: "a".repeat(64) },
          ],
          authorityDigest: "d".repeat(64),
        },
      ],
    },
    policyVersion: 7,
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
    brainByRole: {
      developer: {
        provider: "ollama",
        model: "qwen3.5:9b",
        remoteData: { requirements: false, code: false, memory: false },
      },
      tester: {
        provider: "ollama",
        model: "qwen3.5:9b",
        remoteData: { requirements: false, code: false, memory: false },
      },
    },
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    ...overrides,
  });
}

test("trusted authority seals workspace, operation, profile, and brain bindings", () => {
  const options = factory().create(proposal());

  assert.equal(options.grant.operation, "modify");
  assert.deepEqual(options.grant.allowedActions, [
    "list_files",
    "read_text",
    "search_text",
    "write_text",
    "run_profile",
    "complete",
  ]);
  assert.deepEqual(options.grant.writablePaths, ["src", "test"]);
  assert.deepEqual(options.grant.requiredProfiles, [
    { id: "node-tests", configDigest: "a".repeat(64) },
  ]);
  assert.equal(options.grant.workspaceAuthorityDigest, "d".repeat(64));
  assert.match(options.grant.brainDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(options.allowedOperationsByRole.tester, ["inspect", "verify"]);
  assert.equal(Object.isFrozen(options.allowedOperationsByRole), true);
});

test("read-only operations never inherit workspace write paths", () => {
  for (const operation of ["inspect", "verify"]) {
    const { grant } = factory().create(proposal(operation, "tester"));
    assert.deepEqual(grant.writablePaths, []);
    assert.equal(grant.allowedActions.includes("write_text"), false);
  }
});

test("unknown workspaces and role operation widening fail closed", () => {
  const trusted = proposal();
  const otherWorkspace = normalizeBoundWorkProposal({
    proposalId: trusted.proposalId,
    policyVersion: trusted.policyVersion,
    kind: trusted.kind,
    requestedBy: trusted.requestedBy,
    source: trusted.source,
    binding: { ...trusted.binding, workspaceId: "other-workspace" },
    payload: trusted.payload,
  });
  assert.throws(
    () => factory().create(otherWorkspace),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory().create(proposal("modify", "tester")),
    (error) => error?.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("stale policy versions and revoked repository bindings fail closed", () => {
  assert.throws(
    () => factory({ policyVersion: 8 }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () =>
      factory({
        workspaceByRepository: { "acme/repo": "other-workspace" },
      }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ workspaceByRepository: {} }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ codeActionRoles: ["tester"] }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("brain and sandbox changes produce different sealed grants", () => {
  const value = proposal();
  const first = factory().create(value).grant;
  const changedBrain = factory({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:22434" },
    },
  }).create(value).grant;
  const changedProfile = factory({
    executorAuthority: {
      workspaces: [
        {
          id: "acme-workspace",
          writablePaths: ["src", "test"],
          requiredProfiles: [
            { id: "node-tests", configDigest: "b".repeat(64) },
          ],
          authorityDigest: "e".repeat(64),
        },
      ],
    },
  }).create(value).grant;

  assert.notEqual(first.brainDigest, changedBrain.brainDigest);
  assert.notEqual(first.grantDigest, changedBrain.grantDigest);
  assert.notEqual(first.grantDigest, changedProfile.grantDigest);
});

test("execution-time verification fences every changed authority surface", () => {
  const sealed = factory().create(proposal()).grant;
  assert.deepEqual(factory().verify(sealed), sealed);

  const changed = [
    factory({ policyVersion: 8 }),
    factory({ workspaceByRepository: {} }),
    factory({ codeActionRoles: ["tester"] }),
    factory({
      brainProviders: {
        ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:22434" },
      },
    }),
    factory({
      executorAuthority: {
        workspaces: [
          {
            id: "acme-workspace",
            writablePaths: ["src", "test"],
            requiredProfiles: [
              { id: "node-tests", configDigest: "b".repeat(64) },
            ],
            authorityDigest: "e".repeat(64),
          },
        ],
      },
    }),
  ];
  for (const verifier of changed) {
    assert.throws(
      () => verifier.verify(sealed),
      (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
    );
  }
});

test("authority, policy, and brain configuration must be complete", () => {
  assert.throws(
    () => factory({ executorAuthority: { workspaces: [] } }),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ codeOperationsByRole: {} }),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ policyVersion: 0 }),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ codeActionRoles: [] }),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ brainByRole: { developer: undefined } }),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});
