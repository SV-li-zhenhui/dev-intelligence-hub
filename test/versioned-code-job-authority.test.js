import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  configurationDocumentDigest,
  normalizeConfigurationDocument,
} from "../src/domain/configuration-contract.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { canonicalJsonDigest } from "../src/lib/canonical-json-digest.js";
import { CodeJobGrantFactory } from "../src/services/code-job-grant-factory.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { VersionedCodeJobAuthority } from "../src/services/versioned-code-job-authority.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.json"), "utf8"),
);
const IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

function configuration() {
  const value = structuredClone(committedConfiguration);
  value.trackedRepositories = ["acme/repo"];
  value.codeExecutor = {
    enabled: true,
    docker: {
      executable: "docker",
      host: "npipe:////./pipe/docker_engine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: ".",
        writablePaths: ["src", "test"],
        excludePaths: [],
      },
      {
        id: "auxiliary",
        sourceRoot: "fixtures/auxiliary",
        writablePaths: ["src"],
        excludePaths: [],
      },
    ],
    profiles: {
      "node-tests": { kind: "node-test", image: IMAGE, timeoutMs: 30_000 },
      "auxiliary-tests": {
        kind: "node-test",
        image: IMAGE,
        timeoutMs: 30_000,
      },
    },
    requiredProfilesByWorkspace: {
      dashboard: ["node-tests"],
      auxiliary: ["auxiliary-tests"],
    },
    brokerLimits: { maxFiles: 1_000, maxWriteBytes: 1_000_000 },
    executorLimits: { maxSessions: 4, maxActionsPerSession: 100 },
    maxArtifactBytes: 16_777_216,
  };
  value.workCoordination.enabled = true;
  value.workCoordination.policy = {
    ...value.workCoordination.policy,
    version: 7,
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
    workspaceByRepository: { "acme/repo": "dashboard" },
  };
  value.memory.enabled = true;
  return normalizeConfigurationDocument(value);
}

function active(value, version = 1) {
  return {
    version,
    configurationDigest: configurationDocumentDigest(value),
    configuration: value,
  };
}

function executorAuthority() {
  return {
    workspaces: [
      {
        id: "dashboard",
        writablePaths: ["src", "test"],
        requiredProfiles: [
          { id: "node-tests", configDigest: "a".repeat(64) },
        ],
        authorityDigest: "d".repeat(64),
      },
      {
        id: "auxiliary",
        writablePaths: ["src"],
        requiredProfiles: [
          { id: "auxiliary-tests", configDigest: "b".repeat(64) },
        ],
        authorityDigest: "e".repeat(64),
      },
    ],
  };
}

function legacyConfigurationAuthority(configurationValue) {
  const roles = Object.fromEntries(
    Object.entries(configurationValue.employees.roles).map(([roleId, role]) => [
      roleId,
      {
        enabled: role.enabled,
        allowedIntents: role.permissions.allowedIntents,
        brain: {
          provider: role.brain.provider,
          remoteData: role.brain.remoteData,
        },
      },
    ]),
  );
  const providers = Object.fromEntries(
    Object.entries(configurationValue.brainProviders).map(
      ([providerId, provider]) => [
        providerId,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv ?? null,
          remote: provider.remote ?? null,
        },
      ],
    ),
  );
  return canonicalJsonDigest({
    trackedRepositories: configurationValue.trackedRepositories,
    codeExecutor: configurationValue.codeExecutor,
    workCoordination: {
      enabled: configurationValue.workCoordination.enabled,
      policy: configurationValue.workCoordination.policy,
    },
    memoryEnabled: configurationValue.memory.enabled,
    roles,
    brainProviders: providers,
  });
}

function legacyGrant(configurations) {
  const current = configurations.at(-1);
  let previousDigest = null;
  let authorityDigest = null;
  let authorityEpoch = 0;
  for (const configurationValue of configurations) {
    authorityDigest = legacyConfigurationAuthority(configurationValue);
    if (authorityDigest !== previousDigest) {
      authorityEpoch += 1;
      previousDigest = authorityDigest;
    }
  }
  const policy = current.workCoordination.policy;
  const roleIds = policy.codeActionRoles.filter((roleId) => {
    const role = current.employees.roles[roleId];
    return (
      role?.enabled === true &&
      role.permissions.allowedIntents.includes("propose_code_action")
    );
  });
  const factory = new CodeJobGrantFactory({
    executorAuthority: {
      workspaces: executorAuthority().workspaces.map((workspace) => ({
        ...workspace,
        authorityDigest: canonicalJsonDigest({
          executorAuthorityDigest: workspace.authorityDigest,
          configurationAuthorityDigest: authorityDigest,
          configurationAuthorityEpoch: authorityEpoch,
        }),
      })),
    },
    policyVersion: policy.version,
    workspaceByRepository: policy.workspaceByRepository,
    codeActionRoles: roleIds,
    codeOperationsByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        policy.codeOperationsByRole[roleId],
      ]),
    ),
    brainByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        current.employees.roles[roleId].brain,
      ]),
    ),
    brainProviders: current.brainProviders,
  });
  return factory.create(proposal(current)).grant;
}

function proposal(config) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-05T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { title: "Fix race", headRefOid: "abc123", state: "open" },
  });
  const policy = config.workCoordination.policy;
  const bound = createWorkIntentPolicy({
    version: policy.version,
    codeActionRoles: policy.codeActionRoles,
    workspaceByRepository: policy.workspaceByRepository,
    codeOperationsByRole: policy.codeOperationsByRole,
  }).bind({
    context: {
      assignmentId: `workflow-assignment-${"c".repeat(64)}`,
      workItemId: `work-item-${"d".repeat(64)}`,
      roleId: "developer",
      event,
    },
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      operation: "modify",
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

function fixture({
  brainDirectoryFactory,
  actionAdmissionGate,
  grantFactoryFactory,
} = {}) {
  const startup = configuration();
  let current = active(startup);
  const versions = [current];
  let snapshotReads = 0;
  const admissionGate = actionAdmissionGate || new ActionAdmissionGate();
  if (admissionGate.readStatus().mode === "unbound") {
    admissionGate.bindEffective({
      version: current.version,
      configurationDigest: current.configurationDigest,
    });
  }
  const authority = new VersionedCodeJobAuthority({
    configurationReader: {
      async readActive() {
        return structuredClone(current);
      },
      async readSnapshot() {
        snapshotReads += 1;
        return { versions: structuredClone(versions) };
      },
    },
    executorAuthority: executorAuthority(),
    startupConfiguration: startup,
    actionAdmissionGate: admissionGate,
    ...(brainDirectoryFactory ? { brainDirectoryFactory } : {}),
    ...(grantFactoryFactory ? { grantFactoryFactory } : {}),
  });
  return {
    authority,
    actionAdmissionGate: admissionGate,
    startup,
    get snapshotReads() {
      return snapshotReads;
    },
    activate(value, version = current.version + 1) {
      current = active(normalizeConfigurationDocument(value), version);
      versions.push(current);
    },
    restart() {
      const restartGate = new ActionAdmissionGate();
      restartGate.bindEffective({
        version: current.version,
        configurationDigest: current.configurationDigest,
      });
      return new VersionedCodeJobAuthority({
        configurationReader: {
          async readActive() {
            return structuredClone(current);
          },
          async readSnapshot() {
            return { versions: structuredClone(versions) };
          },
        },
        executorAuthority: executorAuthority(),
        startupConfiguration: current.configuration,
        actionAdmissionGate: restartGate,
        ...(brainDirectoryFactory ? { brainDirectoryFactory } : {}),
        ...(grantFactoryFactory ? { grantFactoryFactory } : {}),
      });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function activateHistory(context, targetVersion, change) {
  for (let version = 2; version <= targetVersion; version += 1) {
    const configurationValue = structuredClone(context.startup);
    configurationValue.browserPollSeconds = version;
    change(configurationValue, version);
    context.activate(configurationValue);
  }
}

test("malformed grants fail before reading or constructing authority history", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });

  await assert.rejects(
    context.authority.verify({}),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads, 0);
  assert.equal(factoryCreations, 0);
});

test("a legacy global-digest grant remains valid after a same-config upgrade", async () => {
  const beforeUpgrade = configuration();
  const sealed = legacyGrant([beforeUpgrade]);
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });

  assert.deepEqual(await context.authority.verify(sealed), sealed);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(sealed),
      brainDigest: sealed.brainDigest,
    },
  );
  assert.equal(providerCalls, 1);
});

test("a legacy grant keeps conservative global invalidation semantics", async () => {
  const beforeUpgrade = configuration();
  const sealed = legacyGrant([beforeUpgrade]);
  const context = fixture();
  const changed = structuredClone(context.startup);
  changed.employees.roles.tester.permissions.allowedIntents.push(
    "propose_github_review",
  );
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("legacy verification scans a long benign history once", async () => {
  let factoryCreations = 0;
  let providerCalls = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  const sealed = legacyGrant([context.startup]);
  activateHistory(context, 256, (configurationValue) => {
    configurationValue.employees.roles.developer.brain.model =
      "replacement-local-model";
  });

  const readsBefore = context.snapshotReads;
  assert.deepEqual(await context.authority.verify(sealed), sealed);
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(factoryCreations <= 2, `created ${factoryCreations} grant factories`);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(sealed),
      brainDigest: sealed.brainDigest,
    },
  );
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(factoryCreations <= 4, `created ${factoryCreations} grant factories`);
  assert.equal(providerCalls, 1);
});

test("a global executor limit expansion invalidates a scoped grant after restart", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const expanded = structuredClone(context.startup);
  expanded.codeExecutor.brokerLimits.maxFiles = 2_000;
  context.activate(expanded);

  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("an unrelated executor workspace change preserves a scoped grant after restart", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.codeExecutor.workspaces.find(
    ({ id }) => id === "auxiliary",
  ).writablePaths = ["test"];
  changed.codeExecutor.profiles["auxiliary-tests"].timeoutMs = 45_000;
  context.activate(changed);

  assert.deepEqual(await context.restart().verify(sealed), sealed);
});

test("current Active creates grants and security expansion invalidates old grants", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  assert.deepEqual(await context.authority.verify(sealed), sealed);

  const expanded = structuredClone(context.startup);
  expanded.employees.roles.developer.permissions.allowedIntents.push(
    "propose_github_review",
  );
  context.activate(expanded);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("unrelated role, provider, and repository changes keep sealed work valid", async () => {
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.tester.permissions.allowedIntents.push(
    "propose_github_review",
  );
  changed.brainProviders["unused-remote"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.invalid/v1",
    apiKeyEnv: "UNUSED_MODEL_TOKEN",
    remote: true,
  };
  changed.trackedRepositories.push("acme/other");
  changed.workCoordination.policy.workspaceByRepository["acme/other"] =
    "dashboard";
  context.activate(changed);

  assert.deepEqual(await context.authority.verify(sealed), sealed);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(sealed),
      brainDigest: sealed.brainDigest,
    },
  );
  assert.equal(providerCalls, 1);
});

test("the grant repository binding invalidates without affecting history fallback", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  delete changed.workCoordination.policy.workspaceByRepository["acme/repo"];
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("the assigned provider authority invalidates its sealed grants", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.brainProviders.ollama.baseUrl = "http://127.0.0.1:11435";
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("an assigned provider protocol change invalidates its sealed grants", async () => {
  const context = fixture();
  const configured = structuredClone(context.startup);
  configured.brainProviders.codex = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "chat-completions",
    remote: true,
  };
  configured.employees.roles.developer.brain.provider = "codex";
  configured.employees.roles.developer.brain.remoteData.code = true;
  context.activate(configured);
  const sealed = (await context.authority.create(proposal(configured))).grant;
  const replaced = structuredClone(configured);
  replaced.brainProviders.codex.protocol = "responses";
  context.activate(replaced);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("a revoked authority cannot resurrect an old grant after exact restoration", async () => {
  const context = fixture();
  const oldGrant = (await context.authority.create(proposal(context.startup))).grant;
  assert.deepEqual(await context.authority.verify(oldGrant), oldGrant);

  const revoked = structuredClone(context.startup);
  revoked.workCoordination.policy.codeOperationsByRole.developer = [
    "inspect",
    "verify",
  ];
  context.activate(revoked);
  context.activate(structuredClone(context.startup));

  await assert.rejects(
    context.authority.verify(oldGrant),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  const newGrant = (
    await context.authority.create(proposal(context.startup))
  ).grant;
  assert.deepEqual(await context.authority.verify(newGrant), newGrant);
});

test("policy versions participate in the non-resurrecting scoped epoch", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const upgraded = structuredClone(context.startup);
  upgraded.workCoordination.policy.version += 1;
  context.activate(upgraded);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("a revoked scoped grant is rejected with bounded history replay", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  activateHistory(context, 256, (configurationValue, version) => {
    if (version === 2) {
      configurationValue.workCoordination.policy.codeOperationsByRole.developer = [
        "inspect",
        "verify",
      ];
    }
  });

  const factoriesBefore = factoryCreations;
  const readsBefore = context.snapshotReads;
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(
    factoryCreations - factoriesBefore <= 1,
    `created ${factoryCreations - factoriesBefore} grant factories`,
  );
});

test("a changed executor boundary blocks new authority until restart", async () => {
  const context = fixture();
  const changed = structuredClone(context.startup);
  changed.codeExecutor.docker.executable = "docker-updated";
  context.activate(changed);

  await assert.rejects(
    context.authority.create(proposal(context.startup)),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("重启"),
  );
});

test("a brain authorization change between selection and generation sends no context", async () => {
  let activate;
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        activate();
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  activate = () => {
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.brain.remoteData.code = true;
    context.activate(changed);
  };
  const sealed = (await context.authority.create(proposal(context.startup))).grant;

  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: async () => {},
        brainDigest: sealed.brainDigest,
      },
    ),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("activation admitted first prevents the stale brain request", async () => {
  const activationEntered = deferred();
  const releaseActivation = deferred();
  let providerCalls = 0;
  const gate = new ActionAdmissionGate();
  const context = fixture({
    actionAdmissionGate: gate,
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        const admitted = await authorization.admitGenerate(async () => {
          await authorization.beforeGenerate();
          providerCalls += 1;
          return { response: { action: { type: "complete" } } };
        });
        return admitted.response;
      },
    }),
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const activation = gate.run(async () => {
    activationEntered.resolve();
    await releaseActivation.promise;
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.brain.remoteData.code = true;
    context.activate(changed);
  });
  await activationEntered.promise;

  const decision = context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(grant),
      brainDigest: grant.brainDigest,
    },
  );
  releaseActivation.resolve();
  await activation;

  await assert.rejects(
    decision,
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("an admitted brain request releases activation before its response", async () => {
  const providerStarted = deferred();
  const providerResponse = deferred();
  let providerCalls = 0;
  const gate = new ActionAdmissionGate();
  const context = fixture({
    actionAdmissionGate: gate,
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        const admitted = await authorization.admitGenerate(async () => {
          await authorization.beforeGenerate();
          providerCalls += 1;
          providerStarted.resolve();
          return { response: providerResponse.promise };
        });
        return admitted.response;
      },
    }),
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const decision = context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(grant),
      brainDigest: grant.brainDigest,
    },
  );
  await providerStarted.promise;

  let activationFinished = false;
  await gate.run(() => {
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.brain.remoteData.code = true;
    context.activate(changed);
    activationFinished = true;
  });
  assert.equal(activationFinished, true);
  assert.equal(providerCalls, 1);

  providerResponse.resolve({ action: { type: "complete" } });
  assert.deepEqual(await decision, { action: { type: "complete" } });
});

test("a benign model change affects new claims while old work keeps its sealed brain", async () => {
  const selectedModels = [];
  const context = fixture({
    brainDirectoryFactory: (options) => ({
      async decide(_value, authorization) {
        selectedModels.push(options.roles.developer.brain.model);
        await authorization.beforeGenerate();
        return { action: { type: "complete" } };
      },
    }),
  });
  const oldGrant = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.developer.brain.model = "new-local-model";
  context.activate(changed);

  assert.deepEqual(await context.authority.verify(oldGrant), oldGrant);
  const newGrant = (await context.authority.create(proposal(changed))).grant;
  assert.notEqual(newGrant.brainDigest, oldGrant.brainDigest);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(oldGrant),
      brainDigest: oldGrant.brainDigest,
    },
  );

  assert.deepEqual(selectedModels, [
    context.startup.employees.roles.developer.brain.model,
  ]);
});
