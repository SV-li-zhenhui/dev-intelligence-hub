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
    ],
    profiles: {
      "node-tests": { kind: "node-test", image: IMAGE, timeoutMs: 30_000 },
    },
    requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
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
    ],
  };
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

function fixture({ brainDirectoryFactory, actionAdmissionGate } = {}) {
  const startup = configuration();
  let current = active(startup);
  const versions = [current];
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
        return { versions: structuredClone(versions) };
      },
    },
    executorAuthority: executorAuthority(),
    startupConfiguration: startup,
    actionAdmissionGate: admissionGate,
    ...(brainDirectoryFactory ? { brainDirectoryFactory } : {}),
  });
  return {
    authority,
    actionAdmissionGate: admissionGate,
    startup,
    activate(value, version = current.version + 1) {
      current = active(normalizeConfigurationDocument(value), version);
      versions.push(current);
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
