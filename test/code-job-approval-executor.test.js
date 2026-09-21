import assert from "node:assert/strict";
import test from "node:test";
import {
  codeJobIdForGrant,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { codeJobConfirmationIdForGrant } from "../src/domain/code-action-proposal-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { CodeJobApprovalExecutor } from "../src/services/code-job-approval-executor.js";

function grant() {
  return createCodeJobGrant({
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:pr:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["固定测试通过"],
    evidence: ["revision 未校验"],
    summary: "修复状态覆盖",
    reason: "存在数据丢失风险",
    allowedActions: [
      "list_files",
      "read_text",
      "search_text",
      "write_text",
      "run_profile",
      "complete",
    ],
    writablePaths: ["src"],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }],
    brainDigest: "c".repeat(64),
  });
}

function pullRequestGrant() {
  const { grantDigest: _grantDigest, ...legacyContent } = grant();
  return createCodeJobGrant({
    schemaVersion: 2,
    ...legacyContent,
    inputBinding: {
      schemaVersion: 1,
      kind: "pull_request",
      repository: "acme/widgets",
      pullRequestNumber: 17,
      rootItemId: "work-root-17",
      workKey: `pr-work-${"1".repeat(64)}`,
      inputRevision: 1,
      headRevision: 1,
      headRefOid: "a".repeat(40),
      eventId: "event-1",
      eventDigest: "2".repeat(64),
      inputDigest: "3".repeat(64),
    },
  });
}

function envelope(sealedGrant = grant()) {
  const actor = {
    provider: "local-code",
    accountId: "controlled-code-executor",
  };
  const target = {
    provider: "local-code",
    resourceId: sealedGrant.workspaceId,
    version: sealedGrant.contentDigest,
  };
  const action = { type: "create_code_job", grant: sealedGrant };
  const plan = normalizeConfirmationPlan({
    id: codeJobConfirmationIdForGrant(sealedGrant),
    kind: "local.code-job-create",
    requestedBy: sealedGrant.requestedBy,
    actor,
    target,
    action,
    display: {
      title: "本地代码任务",
      summary: sealedGrant.summary,
      actionLabel: "只创建本地任务",
      evidence: sealedGrant.evidence,
      payload: { actor, target, action },
    },
  });
  return {
    schemaVersion: 1,
    id: plan.id,
    idempotencyKey: `confirmation-${plan.approvalBindingDigest}`,
    kind: plan.kind,
    requestedBy: plan.requestedBy,
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
    displayedPayloadDigest: plan.displayedPayloadDigest,
    approvalBindingDigest: plan.approvalBindingDigest,
    execution: {
      requestId: "approval-request-0001",
      attempt: 1,
      startedAt: "2026-08-02T03:00:00.000Z",
    },
  };
}

function store(overrides = {}) {
  const calls = [];
  return {
    calls,
    port: {
      async createApprovedJob(value) {
        calls.push(["create", value]);
        return {
          status: "applied",
          receipt: {
            id: codeJobIdForGrant(value.grant),
            createdAt: "2026-08-02T03:00:01.000Z",
          },
        };
      },
      async reconcileApprovedJob(value) {
        calls.push(["reconcile", value]);
        return { status: "absent" };
      },
      ...overrides,
    },
  };
}

function grantVerifier(overrides = {}) {
  return {
    async verify(value) {
      return structuredClone(value);
    },
    ...overrides,
  };
}

test("approval creates only one durable local job and returns its receipt", async () => {
  const fake = store();
  const executor = new CodeJobApprovalExecutor({
    codeJobStore: fake.port,
    grantVerifier: grantVerifier(),
  });
  const input = envelope();

  assert.deepEqual(await executor.execute(input), {
    status: "applied",
    receipt: {
      id: codeJobIdForGrant(input.action.grant),
      createdAt: "2026-08-02T03:00:01.000Z",
    },
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0][0], "create");
  assert.deepEqual(Object.keys(fake.calls[0][1]), [
    "confirmationId",
    "requestId",
    "displayedPayloadDigest",
    "approvalBindingDigest",
    "grant",
  ]);
});

test("invalid or widened envelopes fail before the store is called", async () => {
  const fake = store();
  const executor = new CodeJobApprovalExecutor({
    codeJobStore: fake.port,
    grantVerifier: grantVerifier(),
  });
  const input = envelope();
  const forgedBindingDigest = "f".repeat(64);
  const invalid = [
    { ...input, extra: true },
    { ...input, kind: "github.pull-request-review" },
    { ...input, target: { ...input.target, resourceId: "other-workspace" } },
    { ...input, action: { ...input.action, command: "npm test" } },
    { ...input, requestedBy: { ...input.requestedBy, roleId: "tester" } },
    {
      ...input,
      approvalBindingDigest: forgedBindingDigest,
      idempotencyKey: `confirmation-${forgedBindingDigest}`,
    },
  ];

  for (const value of invalid) {
    assert.deepEqual(await executor.execute(value), {
      status: "error",
      error: { trust: "unknown", code: "INVALID_CODE_JOB_APPROVAL" },
    });
  }
  assert.equal(fake.calls.length, 0);
});

test("a lost create acknowledgement reconciles to the exact existing job", async () => {
  const input = envelope();
  const fake = store({
    async createApprovedJob(value) {
      fake.calls.push(["create", value]);
      throw Object.assign(new Error("ack lost"), { code: "STATE_WRITE_FAILED" });
    },
    async reconcileApprovedJob(value) {
      fake.calls.push(["reconcile", value]);
      return {
        status: "already",
        receipt: {
          id: codeJobIdForGrant(value.grant),
          createdAt: "2026-08-02T03:00:01.000Z",
        },
      };
    },
  });
  const executor = new CodeJobApprovalExecutor({
    codeJobStore: fake.port,
    grantVerifier: grantVerifier(),
  });

  assert.equal((await executor.execute(input)).status, "already");
  assert.deepEqual(fake.calls.map(([name]) => name), ["create", "reconcile"]);
});

test("confirmed absence is retryable while conflicts remain unknown", async () => {
  const absentStore = store({
    async createApprovedJob() {
      throw new Error("disk unavailable");
    },
  });
  const absent = new CodeJobApprovalExecutor({
    codeJobStore: absentStore.port,
    grantVerifier: grantVerifier(),
  });
  assert.deepEqual(await absent.execute(envelope()), {
    status: "absent",
    code: "CODE_JOB_NOT_CREATED",
  });

  const conflictStore = store({
    async reconcileApprovedJob() {
      throw Object.assign(new Error("binding conflict"), {
        code: "CODE_JOB_BINDING_CONFLICT",
      });
    },
  });
  const conflict = new CodeJobApprovalExecutor({
    codeJobStore: conflictStore.port,
    grantVerifier: grantVerifier(),
  });
  assert.deepEqual(await conflict.reconcile(envelope()), {
    status: "error",
    error: { trust: "unknown", code: "CODE_JOB_BINDING_CONFLICT" },
  });
});

test("a changed PR Head becomes stale before durable job creation", async () => {
  const sealedGrant = pullRequestGrant();
  let currentHead = sealedGrant.inputBinding.headRefOid;
  const input = envelope(sealedGrant);
  currentHead = "b".repeat(40);
  const fake = store();
  const executor = new CodeJobApprovalExecutor({
    codeJobStore: fake.port,
    grantVerifier: grantVerifier({
      async verify(value) {
        if (value.inputBinding.headRefOid !== currentHead) {
          const error = new Error("PR Head changed after confirmation");
          error.code = "INVALID_CODE_JOB_AUTHORITY";
          throw error;
        }
        return structuredClone(value);
      },
    }),
  });

  assert.deepEqual(await executor.execute(input), { status: "stale" });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await executor.reconcile(input), { status: "stale" });
  assert.deepEqual(fake.calls.map(([operation]) => operation), ["reconcile"]);
});

test("reconciliation acknowledges an existing job before applying revocation", async () => {
  const input = envelope();
  const fake = store({
    async reconcileApprovedJob(value) {
      fake.calls.push(["reconcile", value]);
      return {
        status: "already",
        receipt: {
          id: codeJobIdForGrant(value.grant),
          createdAt: "2026-08-02T03:00:01.000Z",
        },
      };
    },
  });
  let verifierCalls = 0;
  const executor = new CodeJobApprovalExecutor({
    codeJobStore: fake.port,
    grantVerifier: grantVerifier({
      async verify() {
        verifierCalls += 1;
        throw new Error("must not be consulted for an existing fact");
      },
    }),
  });

  assert.equal((await executor.reconcile(input)).status, "already");
  assert.equal(verifierCalls, 0);
});
