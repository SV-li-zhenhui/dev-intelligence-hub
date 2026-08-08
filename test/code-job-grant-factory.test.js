import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import {
  CodeJobGrantFactory,
  codeJobBrainDigest,
  legacyCodeJobBrainDigest,
} from "../src/services/code-job-grant-factory.js";
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
    payload: {
      title: "Fix race",
      headRefOid: "a".repeat(40),
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/race",
        headRefOid: "a".repeat(40),
      },
      gitTargetAvailable: true,
      state: "open",
    },
  });
  const workItemId = `work-item-${"d".repeat(64)}`;
  const inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: event.subject.repository,
    pullRequestNumber: event.subject.number,
    rootItemId: workItemId,
    workKey: `pr-work-${"b".repeat(64)}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: event.payload.headRefOid,
    eventId: event.eventId,
    eventDigest: event.contentDigest,
    inputDigest: "c".repeat(64),
    gitTarget: structuredClone(event.payload.gitTarget),
  };
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
      workItemId,
      roleId,
      event,
      inputBinding,
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

function legacyProposal() {
  const current = proposal();
  const { gitTarget: _gitTarget, ...legacyBinding } =
    current.binding.inputBinding;
  return normalizeBoundWorkProposal({
    proposalId: current.proposalId,
    policyVersion: current.policyVersion,
    kind: current.kind,
    requestedBy: current.requestedBy,
    source: current.source,
    binding: {
      ...current.binding,
      inputBinding: { ...legacyBinding, schemaVersion: 1 },
    },
    payload: current.payload,
  });
}

function conflictProposal({
  conflicts = [{ path: "src/value.js", mode: "100644" }],
  operation = "modify",
} = {}) {
  const current = proposal();
  const gitTarget = current.binding.inputBinding.gitTarget;
  const workspaceSource = createConflictPreparationBinding({
    preparation: {
      schemaVersion: 1,
      preparationId: "1".repeat(64),
      status: "conflicted",
      baseCommitOid: gitTarget.baseRefOid,
      headCommitOid: gitTarget.headRefOid,
      mergeBaseOid: "e".repeat(gitTarget.headRefOid.length),
      resultTreeOid: "f".repeat(gitTarget.headRefOid.length),
      conflicts,
      boundaryDigest: "2".repeat(64),
      evidenceDigest: "3".repeat(64),
      resultObjectDigest: "4".repeat(64),
      materialization: "full-tree",
    },
    gitTarget,
  });
  return normalizeBoundWorkProposal({
    proposalId: current.proposalId,
    policyVersion: current.policyVersion,
    kind: current.kind,
    requestedBy: current.requestedBy,
    source: current.source,
    binding: {
      ...current.binding,
      executionSource: createConflictCodeExecutionSource({
        inputBinding: current.binding.inputBinding,
        preparationBinding: workspaceSource,
      }),
    },
    payload: { ...current.payload, operation },
  });
}

function issueProposal(operation = "modify", roleId = "developer") {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-02T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:issue:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { number: 42, title: "Fix race" },
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
      inputBinding: null,
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
          capabilities: [
            "conflict_preparation_snapshot",
            "git_head_snapshot",
          ],
          writablePaths: ["src", "test"],
          excludePaths: [],
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
    taskBrainByRole: {
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
    inputAuthorityVerifier: {
      verify: (binding) => structuredClone(binding),
    },
    ...overrides,
  });
}

function localBrain({
  provider = "ollama",
  model = "qwen3.5:9b",
  remoteData = { requirements: false, code: false, memory: false },
} = {}) {
  return { provider, model, remoteData };
}

function brainsByRole(brain = localBrain()) {
  return { developer: brain, tester: brain };
}

function proposalWithAuthority(value, authority) {
  return normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: { ...value.binding, ...authority },
    payload: value.payload,
  });
}

function evidenceTargetFor(value, deliverables = [
  { deliverableId: "implementation", kind: "change-package" },
]) {
  return {
    schemaVersion: 1,
    taskId: value.requestedBy.workItemId,
    roleId: value.requestedBy.roleId,
    contractRevision: 3,
    contractDigest: "c".repeat(64),
    deliverables,
  };
}

test("trusted authority seals workspace, operation, profile, and brain bindings", () => {
  const options = factory().create(proposal());

  assert.equal(options.grant.schemaVersion, 2);
  assert.equal(options.grant.brainBindingSchema, 2);
  assert.equal(options.grant.inputBinding.headRefOid, "a".repeat(40));
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

test("task brain digests are domain-separated from historical routine brains", () => {
  const brain = localBrain();
  const brainProviders = {
    ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
  };

  assert.notEqual(
    codeJobBrainDigest({
      roleId: "developer",
      taskBrain: brain,
      brainProviders,
    }),
    legacyCodeJobBrainDigest({
      roleId: "developer",
      brain,
      brainProviders,
    }),
  );
});

test("historical brain bindings require an explicit verify-only factory", () => {
  const brain = localBrain();
  const brainProviders = {
    ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
  };
  const { grantDigest: _grantDigest, ...currentGrant } =
    factory().create(proposal()).grant;
  delete currentGrant.brainBindingSchema;
  const historicalGrant = createCodeJobGrant({
    ...currentGrant,
    brainDigest: legacyCodeJobBrainDigest({
      roleId: "developer",
      brain,
      brainProviders,
    }),
  });
  const recovery = factory({
    taskBrainByRole: undefined,
    legacyBrainByRole: brainsByRole(brain),
  });

  assert.deepEqual(recovery.verify(historicalGrant), historicalGrant);
  assert.throws(
    () => recovery.create(proposal()),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("不能创建"),
  );
  assert.throws(
    () => factory().verify(historicalGrant),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("conflict authority seals the full preparation and only its writable paths", () => {
  const verified = [];
  const grants = factory({
    conflictPreparationVerifier: {
      verify(binding) {
        verified.push(structuredClone(binding));
        return structuredClone(binding);
      },
    },
  });
  const options = grants.create(conflictProposal());

  assert.equal(options.grant.schemaVersion, 3);
  assert.equal(options.grant.brainBindingSchema, 2);
  assert.equal(options.grant.inputBinding.schemaVersion, 2);
  assert.deepEqual(options.grant.writablePaths, ["src/value.js"]);
  assert.deepEqual(
    options.grant.executionSource.preparationBinding,
    verified[0],
  );
  assert.deepEqual(grants.verify(options.grant), options.grant);
  assert.equal(verified.length, 2);

  assert.throws(
    () => factory().create(conflictProposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () =>
      factory({
        conflictPreparationVerifier: {
          verify: (binding) => structuredClone(binding),
        },
      }).create(conflictProposal({
        conflicts: [{ path: "docs/value.md", mode: "100644" }],
      })),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () =>
      factory({
        executorAuthority: {
          workspaces: [{
            id: "acme-workspace",
            capabilities: [
              "conflict_preparation_snapshot",
              "git_head_snapshot",
            ],
            writablePaths: ["src"],
            excludePaths: ["src/private"],
            requiredProfiles: [
              { id: "node-tests", configDigest: "a".repeat(64) },
            ],
            authorityDigest: "d".repeat(64),
          }],
        },
        conflictPreparationVerifier: {
          verify: (binding) => structuredClone(binding),
        },
      }).create(conflictProposal({
        conflicts: [{ path: "src/private/value.js", mode: "100644" }],
      })),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("conflict authority verifies the current PR before sealed preparation evidence", () => {
  let conflictVerifications = 0;
  const grants = factory({
    inputAuthorityVerifier: {
      verify() {
        throw new Error("stale PR");
      },
    },
    conflictPreparationVerifier: {
      verify(binding) {
        conflictVerifications += 1;
        return structuredClone(binding);
      },
    },
  });

  assert.throws(
    () => grants.create(conflictProposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(conflictVerifications, 0);

  assert.throws(
    () =>
      factory({
        conflictPreparationVerifier: {
          verify(binding) {
            return {
              ...structuredClone(binding),
              evidenceDigest: "f".repeat(64),
            };
          },
        },
      }).create(conflictProposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("invalid conflict operations fail before any authority verifier call", () => {
  let inputVerifications = 0;
  let preparationVerifications = 0;
  const grants = factory({
    inputAuthorityVerifier: {
      verify() {
        inputVerifications += 1;
        throw new Error("must not verify an invalid local proposal");
      },
    },
    conflictPreparationVerifier: {
      verify() {
        preparationVerifications += 1;
        throw new Error("must not verify an invalid local proposal");
      },
    },
  });

  assert.throws(
    () => grants.create(conflictProposal({ operation: "inspect" })),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(inputVerifications, 0);
  assert.equal(preparationVerifications, 0);
});

test("conflict scope, capability, and configuration fail before external verifiers", () => {
  const validVerifier = {
    verify: (binding) => structuredClone(binding),
  };
  for (const [name, createFactory, candidate] of [
    [
      "scope",
      (inputAuthorityVerifier, conflictPreparationVerifier) =>
        factory({ inputAuthorityVerifier, conflictPreparationVerifier }),
      conflictProposal({
        conflicts: [{ path: "docs/value.md", mode: "100644" }],
      }),
    ],
    [
      "capability",
      (inputAuthorityVerifier, conflictPreparationVerifier) => factory({
        inputAuthorityVerifier,
        conflictPreparationVerifier,
        executorAuthority: {
          workspaces: [{
            id: "acme-workspace",
            capabilities: ["git_head_snapshot"],
            writablePaths: ["src", "test"],
            excludePaths: [],
            requiredProfiles: [
              { id: "node-tests", configDigest: "a".repeat(64) },
            ],
            authorityDigest: "d".repeat(64),
          }],
        },
      }),
      conflictProposal(),
    ],
    [
      "missing verifier",
      (inputAuthorityVerifier) => factory({ inputAuthorityVerifier }),
      conflictProposal(),
    ],
  ]) {
    let inputCalls = 0;
    let preparationCalls = 0;
    const grants = createFactory(
      {
        verify(binding) {
          inputCalls += 1;
          return structuredClone(binding);
        },
      },
      {
        verify(binding) {
          preparationCalls += 1;
          return structuredClone(binding);
        },
      },
    );
    assert.throws(
      () => grants.create(candidate),
      (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
      name,
    );
    assert.equal(inputCalls, 0, name);
    assert.equal(preparationCalls, 0, name);
  }

  const original = factory({ conflictPreparationVerifier: validVerifier })
    .create(conflictProposal()).grant;
  let inputCalls = 0;
  let preparationCalls = 0;
  const changedBrain = factory({
    inputAuthorityVerifier: {
      verify(binding) {
        inputCalls += 1;
        return structuredClone(binding);
      },
    },
    conflictPreparationVerifier: {
      verify(binding) {
        preparationCalls += 1;
        return structuredClone(binding);
      },
    },
    taskBrainByRole: {
      developer: {
        provider: "ollama",
        model: "qwen3.5:changed",
        remoteData: { requirements: false, code: false, memory: false },
      },
      tester: {
        provider: "ollama",
        model: "qwen3.5:9b",
        remoteData: { requirements: false, code: false, memory: false },
      },
    },
  });
  assert.throws(
    () => changedBrain.verify(original),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(inputCalls, 0);
  assert.equal(preparationCalls, 0);
});

test("conflict materialization capability does not require a Git Head snapshot port", () => {
  const executorAuthority = {
    workspaces: [{
      id: "acme-workspace",
      capabilities: ["conflict_preparation_snapshot"],
      writablePaths: ["src", "test"],
      excludePaths: [],
      requiredProfiles: [
        { id: "node-tests", configDigest: "a".repeat(64) },
      ],
      authorityDigest: "d".repeat(64),
    }],
  };
  const grants = factory({
    executorAuthority,
    conflictPreparationVerifier: {
      verify: (binding) => structuredClone(binding),
    },
  });

  assert.equal(grants.create(conflictProposal()).grant.schemaVersion, 3);
  assert.throws(
    () => factory({ executorAuthority }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("legacy PR bindings cannot create or authorize new code jobs", () => {
  const legacy = legacyProposal();
  assert.throws(
    () => factory().create(legacy),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("旧版"),
  );
  const { grantDigest: _grantDigest, ...currentGrant } =
    factory().create(proposal()).grant;
  const legacyBoundGrant = createCodeJobGrant({
    ...currentGrant,
    inputBinding: legacy.binding.inputBinding,
  });
  assert.deepEqual(normalizeCodeJobGrant(legacyBoundGrant), legacyBoundGrant);
  assert.throws(
    () => factory().verify(legacyBoundGrant),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("旧版"),
  );
});

test("grant creation preserves exact proposal authority boundaries", () => {
  const base = proposal();
  const authorized = proposalWithAuthority(base, {
    evidenceTarget: evidenceTargetFor(base),
    dispatchIntentId: `work-dispatch-intent-${"e".repeat(64)}`,
  });

  assert.doesNotThrow(() => factory().create(authorized));

  const ambiguous = proposalWithAuthority(base, {
    evidenceTarget: evidenceTargetFor(base, [
      { deliverableId: "implementation", kind: "change-package" },
      { deliverableId: "verification", kind: "change-package" },
    ]),
  });
  assert.throws(
    () => factory().create(ambiguous),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
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

test("task brain and sandbox changes invalidate only their sealed bindings", () => {
  const value = proposal();
  const first = factory().create(value).grant;
  const changedProviderConfiguration = factory({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:22434" },
    },
  }).create(value).grant;
  const changedTaskBrain = factory({
    taskBrainByRole: brainsByRole(localBrain({ model: "code-model-v2" })),
  }).create(value).grant;
  const changedTaskProvider = factory({
    taskBrainByRole: brainsByRole(localBrain({ provider: "code-provider" })),
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
      "code-provider": {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  }).create(value).grant;
  const changedRemoteData = factory({
    taskBrainByRole: brainsByRole(localBrain({
      remoteData: { requirements: true, code: false, memory: false },
    })),
  }).create(value).grant;
  const changedProfile = factory({
    executorAuthority: {
      workspaces: [
        {
          id: "acme-workspace",
          capabilities: ["git_head_snapshot"],
          writablePaths: ["src", "test"],
          requiredProfiles: [
            { id: "node-tests", configDigest: "b".repeat(64) },
          ],
          authorityDigest: "e".repeat(64),
        },
      ],
    },
  }).create(value).grant;

  for (const changedBrain of [
    changedProviderConfiguration,
    changedTaskBrain,
    changedTaskProvider,
    changedRemoteData,
  ]) {
    assert.notEqual(first.brainDigest, changedBrain.brainDigest);
    assert.notEqual(first.grantDigest, changedBrain.grantDigest);
    assert.deepEqual(changedBrain.allowedActions, first.allowedActions);
    assert.deepEqual(changedBrain.writablePaths, first.writablePaths);
    assert.deepEqual(changedBrain.requiredProfiles, first.requiredProfiles);
    assert.equal(
      changedBrain.workspaceAuthorityDigest,
      first.workspaceAuthorityDigest,
    );
  }
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
      taskBrainByRole: brainsByRole(localBrain({ model: "code-model-v2" })),
    }),
    factory({
      taskBrainByRole: brainsByRole(localBrain({
        remoteData: { requirements: true, code: false, memory: false },
      })),
    }),
    factory({
      executorAuthority: {
        workspaces: [
          {
            id: "acme-workspace",
            capabilities: ["git_head_snapshot"],
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
  for (const grants of [
    factory({ taskBrainByRole: { developer: undefined, tester: localBrain() } }),
    factory({ taskBrainByRole: { developer: null, tester: localBrain() } }),
    factory({
      taskBrainByRole: undefined,
      brainByRole: brainsByRole(),
    }),
  ]) {
    assert.throws(
      () => grants.create(proposal()),
      (error) => error?.code === "CODE_TASK_BRAIN_NOT_CONFIGURED",
    );
  }
});

test("PR grants require an exact Git Head workspace and a live input verifier", () => {
  const withoutSnapshotCapability = {
    workspaces: [
      {
        id: "acme-workspace",
        capabilities: ["directory_snapshot"],
        writablePaths: ["src", "test"],
        requiredProfiles: [
          { id: "node-tests", configDigest: "a".repeat(64) },
        ],
        authorityDigest: "d".repeat(64),
      },
    ],
  };
  assert.throws(
    () => factory({ executorAuthority: withoutSnapshotCapability }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.throws(
    () => factory({ inputAuthorityVerifier: undefined }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );

  const trusted = proposal();
  const invalidHead = normalizeBoundWorkProposal({
    proposalId: trusted.proposalId,
    policyVersion: trusted.policyVersion,
    kind: trusted.kind,
    requestedBy: trusted.requestedBy,
    source: trusted.source,
    binding: {
      ...trusted.binding,
      inputBinding: {
        ...trusted.binding.inputBinding,
        headRefOid: "not-a-git-object-id",
      },
    },
    payload: trusted.payload,
  });
  assert.throws(
    () => factory().create(invalidHead),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );

  const pullRequest = proposal();
  const nullBoundPullRequest = normalizeBoundWorkProposal({
    proposalId: pullRequest.proposalId,
    policyVersion: pullRequest.policyVersion,
    kind: pullRequest.kind,
    requestedBy: pullRequest.requestedBy,
    source: pullRequest.source,
    binding: { ...pullRequest.binding, inputBinding: null },
    payload: pullRequest.payload,
  });
  assert.throws(
    () => factory({ executorAuthority: withoutSnapshotCapability }).create(nullBoundPullRequest),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  const { grantDigest: _grantDigest, ...pullRequestGrantContent } =
    factory().create(pullRequest).grant;
  const nullBoundPullRequestGrant = createCodeJobGrant({
    ...pullRequestGrantContent,
    inputBinding: null,
  });
  assert.throws(
    () => factory().verify(nullBoundPullRequestGrant),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );

  const issue = factory({
    executorAuthority: withoutSnapshotCapability,
    inputAuthorityVerifier: undefined,
  }).create(issueProposal());
  assert.equal(issue.grant.inputBinding, null);
  assert.equal(issue.grant.subject.id, "github:issue:acme/repo#42");
});

test("changed, rejected, or mismatched current Head authority fails closed", async () => {
  for (const verify of [
    () => {
      throw new Error("source Head changed");
    },
    (binding) => ({ ...binding, inputRevision: binding.inputRevision + 1 }),
  ]) {
    assert.throws(
      () => factory({ inputAuthorityVerifier: { verify } }).create(proposal()),
      (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
    );
  }

  await assert.rejects(
    factory({
      inputAuthorityVerifier: {
        verify: async () => {
          throw new Error("source Head changed");
        },
      },
    }).create(proposal()),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  const asynchronouslyAuthorized = await factory({
    inputAuthorityVerifier: {
      verify: async (binding) => structuredClone(binding),
    },
  }).create(proposal());
  assert.equal(asynchronouslyAuthorized.grant.inputBinding.headRefOid, "a".repeat(40));

  let current = true;
  const liveFactory = factory({
    inputAuthorityVerifier: {
      verify(binding) {
        if (!current) throw new Error("source Head changed");
        return structuredClone(binding);
      },
    },
  });
  const sealed = liveFactory.create(proposal()).grant;
  current = false;
  assert.throws(
    () => liveFactory.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("legacy grants remain readable but cannot authorize a new execution", () => {
  const current = factory().create(proposal()).grant;
  const {
    schemaVersion: _schemaVersion,
    brainBindingSchema: _brainBindingSchema,
    inputBinding: _inputBinding,
    grantDigest: _grantDigest,
    ...legacyContent
  } = current;
  const legacy = createCodeJobGrant(legacyContent);

  assert.deepEqual(normalizeCodeJobGrant(legacy), legacy);
  assert.throws(
    () => factory().verify(legacy),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("旧版"),
  );
});
