import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { createConfigurationRuntime } from "../src/configuration-runtime.js";
import {
  createConfigurationActivationConfirmationPlan,
} from "../src/domain/configuration-activation-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { createSafeDisabledConfiguration } from "../src/lib/config.js";
import {
  ConfigurationActivationExecutor,
} from "../src/services/configuration-activation-executor.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

function memoryStore({ failCompletedConfirmationOnce = false } = {}) {
  const values = new Map();
  let failCompleted = failCompletedConfirmationOnce;
  return {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, next) {
      if (
        failCompleted &&
        key === "confirmation-queue" &&
        next?.items?.some((item) => item.status === "completed")
      ) {
        failCompleted = false;
        throw new Error("confirmation finalize write failed");
      }
      values.set(key, structuredClone(next));
    },
  };
}

function guard() {
  return {
    async acquire() {},
    run(operation) {
      return operation();
    },
    async close() {},
  };
}

function privateEnvelope(prepared) {
  const plan = normalizeConfirmationPlan(
    createConfigurationActivationConfirmationPlan(prepared),
  );
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
      requestId: "configuration-cutover-integration",
      attempt: 1,
      startedAt: "2026-08-05T16:00:00.000Z",
    },
  };
}

function activationExecutor(runtime) {
  return new ConfigurationActivationExecutor({
    activationExecutor: runtime.activationExecutor,
    configurationReader: runtime.reader,
    actionAdmissionGate: runtime.cutoverFence,
    allowedActionTypes: ["initialize_from_draft"],
  });
}

function approval(item, requestId) {
  return {
    requestId,
    expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
  };
}

test("a confirmed initialization fences the old process and restart rebinds v1", async () => {
  const store = memoryStore();
  const oldGate = new ActionAdmissionGate();
  const invalidBootstrap = structuredClone(committedConfiguration);
  invalidBootstrap.githubActions.token = "credential-must-not-be-persisted";
  const oldRuntime = await createConfigurationRuntime(invalidBootstrap, {
    store,
    fallbackConfiguration: createSafeDisabledConfiguration(
      committedConfiguration,
    ),
    actionAdmissionGate: oldGate,
    createGuard: guard,
  });
  const draft = await oldRuntime.draftManager.createInitializationDraft({
    configuration: committedConfiguration,
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  const prepared = await oldRuntime.simulator.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 1,
  });
  const envelope = privateEnvelope(prepared);

  assert.equal(
    (await activationExecutor(oldRuntime).execute(envelope)).status,
    "applied",
  );
  assert.equal(oldGate.readStatus().mode, "restart_required");
  await assert.rejects(
    oldGate.run(() => "must-not-run"),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );
  await oldRuntime.close();

  const newGate = new ActionAdmissionGate();
  const restarted = await createConfigurationRuntime(null, {
    store,
    fallbackConfiguration: createSafeDisabledConfiguration(
      committedConfiguration,
    ),
    actionAdmissionGate: newGate,
    createGuard: guard,
  });
  assert.equal(restarted.status.activeVersion, 1);
  assert.equal(newGate.readStatus().mode, "ready");
  assert.equal(
    (await activationExecutor(restarted).reconcile(envelope)).status,
    "already",
  );
  assert.equal(newGate.readStatus().mode, "ready");
  assert.equal(await newGate.run(() => "admitted"), "admitted");

  await restarted.close();
});

test("application restart reconciles a durable executing configuration confirmation", async () => {
  const store = memoryStore({ failCompletedConfirmationOnce: true });
  const fallback = createSafeDisabledConfiguration(committedConfiguration);
  const desired = structuredClone(fallback);
  desired.refreshMinutes += 1;
  const gates = [];
  const applicationOptions = {
    store,
    versionedConfiguration: true,
    configBootstrapLoader: async () => ({
      candidate: null,
      fallbackConfiguration: fallback,
      bootstrapError: {
        code: "CONFIGURATION_TEST_BOOTSTRAP_FAILURE",
        message: "force the safe initialization path",
      },
    }),
    actionAdmissionGateFactory() {
      const gate = new ActionAdmissionGate();
      gates.push(gate);
      return gate;
    },
    configurationRuntimeDependencies: { createGuard: guard },
    confirmationRuntimeDependencies: { createGuard: guard },
    workflowRoutingDependencies: { createGuard: guard },
    memoryRuntimeDependencies: { createGuard: guard },
  };

  const first = await createApplication(applicationOptions);
  assert.equal(first.configuration.status.safeMode, true);
  const draft = await first.configuration.proposalPort.createInitializationDraft({
    configuration: desired,
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  const queued = await first.configuration.confirmationRequester.requestInitialization({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 1,
  });
  await assert.rejects(
    first.confirmationQueue.approve(
      queued.id,
      approval(queued, "configuration-cutover-finalize-loss"),
    ),
    /confirmation finalize write failed/,
  );
  assert.equal(gates[0].readStatus().mode, "restart_required");
  assert.equal((await first.configuration.reader.readSnapshot()).versions.length, 1);
  await first.close();

  const restarted = await createApplication(applicationOptions);
  const recovered = await restarted.confirmationQueue.get(queued.id);
  assert.equal(recovered.status, "completed");
  assert.equal(gates[1].readStatus().mode, "ready");
  const configuration = await restarted.configuration.reader.readSnapshot();
  assert.equal(configuration.activeVersion, 1);
  assert.equal(configuration.versions.length, 1);
  assert.equal(restarted.config.refreshMinutes, desired.refreshMinutes);
  await restarted.close();
});

test("active application confirms v2 then restarts and confirms an append-only rollback v3", async () => {
  const store = memoryStore();
  const gates = [];
  const baseConfiguration = createSafeDisabledConfiguration(
    committedConfiguration,
  );
  const applicationOptions = {
    store,
    versionedConfiguration: true,
    configBootstrapLoader: async () => ({
      candidate: baseConfiguration,
      fallbackConfiguration: baseConfiguration,
      bootstrapError: null,
    }),
    actionAdmissionGateFactory() {
      const gate = new ActionAdmissionGate();
      gates.push(gate);
      return gate;
    },
    configurationRuntimeDependencies: { createGuard: guard },
    confirmationRuntimeDependencies: { createGuard: guard },
    workflowRoutingDependencies: { createGuard: guard },
    memoryRuntimeDependencies: { createGuard: guard },
  };

  const first = await createApplication(applicationOptions);
  assert.equal(first.configuration.status.safeMode, false);
  assert.equal(first.configuration.status.activeVersion, 1);
  assert.deepEqual(
    Object.keys(first.configuration.confirmationRequester),
    ["requestDraftActivation", "requestRollback"],
  );
  const desired = structuredClone(baseConfiguration);
  desired.refreshMinutes += 1;
  const draft = await first.configuration.draftManager.createDraft({
    configuration: desired,
    expectedStateRevision: 1,
    proposedBy: "owner:local",
  });
  const activation = await first.configuration.confirmationRequester
    .requestDraftActivation({
      draftId: draft.draftId,
      draftRevision: draft.revision,
      expectedStateRevision: 2,
      expectedActiveVersion: 1,
    });
  const activated = await first.confirmationQueue.approve(
    activation.id,
    approval(activation, "configuration-activate-v2"),
  );
  assert.equal(activated.status, "completed");
  assert.equal(gates[0].readStatus().mode, "restart_required");
  assert.equal(
    (await first.configuration.reader.readSnapshot()).activeVersion,
    2,
  );
  await first.close();

  const second = await createApplication(applicationOptions);
  assert.equal(second.configuration.status.activeVersion, 2);
  assert.equal(second.config.refreshMinutes, desired.refreshMinutes);
  assert.equal(gates[1].readStatus().mode, "ready");
  const rollback = await second.configuration.confirmationRequester
    .requestRollback({
      targetVersion: 1,
      expectedStateRevision: 3,
      expectedActiveVersion: 2,
    });
  const rolledBack = await second.confirmationQueue.approve(
    rollback.id,
    approval(rollback, "configuration-rollback-v3"),
  );
  assert.equal(rolledBack.status, "completed");
  const rolledBackState = await second.configuration.reader.readSnapshot();
  assert.equal(rolledBackState.activeVersion, 3);
  assert.equal(rolledBackState.versions.at(-1).source, "rollback");
  assert.equal(rolledBackState.versions.at(-1).rollbackOf, 1);
  assert.equal(gates[1].readStatus().mode, "restart_required");
  await second.close();

  const third = await createApplication(applicationOptions);
  assert.equal(third.configuration.status.activeVersion, 3);
  assert.equal(third.config.refreshMinutes, baseConfiguration.refreshMinutes);
  assert.equal(gates[2].readStatus().mode, "ready");
  await third.close();
});

test("a second configuration confirmation from the old runtime baseline becomes stale", async () => {
  const store = memoryStore();
  const gates = [];
  const baseConfiguration = createSafeDisabledConfiguration(
    committedConfiguration,
  );
  const applicationOptions = {
    store,
    versionedConfiguration: true,
    configBootstrapLoader: async () => ({
      candidate: baseConfiguration,
      fallbackConfiguration: baseConfiguration,
      bootstrapError: null,
    }),
    actionAdmissionGateFactory() {
      const gate = new ActionAdmissionGate();
      gates.push(gate);
      return gate;
    },
    configurationRuntimeDependencies: { createGuard: guard },
    confirmationRuntimeDependencies: { createGuard: guard },
    workflowRoutingDependencies: { createGuard: guard },
    memoryRuntimeDependencies: { createGuard: guard },
  };

  const first = await createApplication(applicationOptions);
  const configurationA = structuredClone(baseConfiguration);
  configurationA.refreshMinutes += 1;
  const configurationB = structuredClone(baseConfiguration);
  configurationB.browserPollSeconds += 1;
  const draftA = await first.configuration.draftManager.createDraft({
    configuration: configurationA,
    expectedStateRevision: 1,
    proposedBy: "owner:local",
  });
  const draftB = await first.configuration.draftManager.createDraft({
    configuration: configurationB,
    expectedStateRevision: 2,
    proposedBy: "owner:local",
  });
  const confirmationA = await first.configuration.confirmationRequester
    .requestDraftActivation({
      draftId: draftA.draftId,
      draftRevision: draftA.revision,
      expectedStateRevision: 3,
      expectedActiveVersion: 1,
    });
  const confirmationB = await first.configuration.confirmationRequester
    .requestDraftActivation({
      draftId: draftB.draftId,
      draftRevision: draftB.revision,
      expectedStateRevision: 3,
      expectedActiveVersion: 1,
    });

  const currentA = await first.confirmationQueue.get(confirmationA.id);
  const activated = await first.confirmationQueue.approve(
    currentA.id,
    approval(currentA, "configuration-first-old-baseline"),
  );
  assert.equal(activated.status, "completed");
  assert.equal(gates[0].readStatus().mode, "restart_required");

  const currentB = await first.confirmationQueue.get(confirmationB.id);
  const superseded = await first.confirmationQueue.approve(
    currentB.id,
    approval(currentB, "configuration-second-old-baseline"),
  );
  assert.equal(superseded.status, "stale");
  assert.equal(superseded.retryable, false);
  assert.equal(
    (await first.configuration.reader.readSnapshot()).activeVersion,
    2,
  );
  await first.close();

  const restarted = await createApplication(applicationOptions);
  assert.equal(
    (await restarted.confirmationQueue.get(confirmationB.id)).status,
    "stale",
  );
  assert.equal(restarted.configuration.status.activeVersion, 2);
  assert.equal(gates[1].readStatus().mode, "ready");
  await restarted.close();
});
