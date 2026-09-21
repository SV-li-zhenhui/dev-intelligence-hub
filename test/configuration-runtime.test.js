import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createConfigurationRuntime } from "../src/configuration-runtime.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { createSafeDisabledConfiguration } from "../src/lib/config.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

function configuration() {
  return structuredClone(committedConfiguration);
}

function memoryStore(initial = null) {
  let value = initial === null ? null : structuredClone(initial);
  return {
    async read(_key, fallback = null) {
      return structuredClone(value ?? fallback);
    },
    async write(_key, next) {
      value = structuredClone(next);
    },
    snapshot() {
      return structuredClone(value);
    },
  };
}

function guard(events, { acquireError = null } = {}) {
  return {
    async acquire() {
      events.push("acquire");
      if (acquireError) throw acquireError;
    },
    run(operation) {
      events.push("run");
      return operation();
    },
    async close() {
      events.push("close");
    },
  };
}

test("runtime imports once and exposes frozen least-authority ports", async () => {
  const events = [];
  const store = memoryStore();
  const runtime = await createConfigurationRuntime(configuration(), {
    store,
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    createGuard: () => guard(events),
  });

  assert.deepEqual(runtime.startupConfiguration, committedConfiguration);
  assert.deepEqual(Object.keys(runtime.reader).sort(), [
    "readActivationReconciliationSnapshot",
    "readActive",
    "readAuthoritySnapshot",
    "readControlPlaneSnapshot",
    "readDraft",
    "readProjectionBatch",
    "readSnapshot",
    "readVersion",
  ]);
  assert.deepEqual(Object.keys(runtime.draftManager).sort(), [
    "createDraft",
    "createInitializationDraft",
    "reviseDraft",
  ]);
  assert.deepEqual(Object.keys(runtime.simulator).sort(), [
    "prepareDraftActivation",
    "prepareInitialization",
    "prepareProposalDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(runtime.activationExecutor).sort(), [
    "activateDraft",
    "activateInitialization",
    "activateRollback",
  ]);
  assert.deepEqual(Object.keys(runtime.proposalPort).sort(), [
    "createDraft",
    "createInitializationDraft",
    "createProposalDraft",
    "readProposalDraft",
    "reviseDraft",
  ]);
  assert.deepEqual(Object.keys(runtime.runtimeAdmission).sort(), [
    "readStatus",
    "run",
  ]);
  assert.deepEqual(Object.keys(runtime.cutoverFence).sort(), [
    "cutover",
    "readStatus",
    "reconcileCutover",
  ]);
  assert.equal("importBootstrap" in runtime, false);
  assert.equal("activateDraft" in runtime.proposalPort, false);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.reader), true);
  assert.equal(runtime.status.safeMode, false);
  assert.equal(runtime.status.activeVersion, 1);
  assert.deepEqual(runtime.runtimeAdmission.readStatus(), {
    mode: "ready",
    storedActive: {
      version: 1,
      configurationDigest: store.snapshot().versions[0].configurationDigest,
    },
    runtimeEffective: {
      version: 1,
      configurationDigest: store.snapshot().versions[0].configurationDigest,
    },
  });
  assert.equal(store.snapshot().migration.status, "imported");

  const firstClose = runtime.close();
  assert.strictEqual(runtime.close(), firstClose);
  await firstClose;
  assert.deepEqual(events.filter((event) => event === "close"), ["close"]);
});

test("an existing active version ignores later bootstrap content without reading it", async () => {
  const store = memoryStore();
  const first = await createConfigurationRuntime(configuration(), {
    store,
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    createGuard: () => guard([]),
  });
  await first.close();

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "credential", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });
  const restarted = await createConfigurationRuntime(hostile, {
    store,
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    createGuard: () => guard([]),
  });

  assert.equal(getterCalls, 0);
  assert.equal(restarted.status.safeMode, false);
  assert.deepEqual(restarted.startupConfiguration, committedConfiguration);
  assert.equal(store.snapshot().revision, 1);
  await restarted.close();
});

test("runtime binds the supplied admission gate to the exact startup version", async () => {
  const admissionGate = new ActionAdmissionGate();
  const runtime = await createConfigurationRuntime(configuration(), {
    store: memoryStore(),
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    actionAdmissionGate: admissionGate,
    createGuard: () => guard([]),
  });
  const active = await runtime.reader.readActive();

  assert.deepEqual(admissionGate.readStatus(), {
    mode: "ready",
    storedActive: {
      version: active.version,
      configurationDigest: active.configurationDigest,
    },
    runtimeEffective: {
      version: active.version,
      configurationDigest: active.configurationDigest,
    },
  });
  assert.notStrictEqual(runtime.runtimeAdmission, runtime.cutoverFence);
  await runtime.close();
});

test("an invalid first import starts from a non-persisted safe fallback", async () => {
  const events = [];
  const admissionGate = new ActionAdmissionGate();
  const store = memoryStore();
  const invalid = configuration();
  invalid.githubActions.token = "ghp_not-a-real-token";
  const fallback = createSafeDisabledConfiguration(configuration());
  const runtime = await createConfigurationRuntime(invalid, {
    store,
    fallbackConfiguration: fallback,
    createGuard: () => guard(events),
    actionAdmissionGate: admissionGate,
  });

  assert.equal(runtime.status.safeMode, true);
  assert.equal(runtime.status.activeVersion, null);
  assert.equal(runtime.status.migrationError.code, "INVALID_CONFIGURATION_DOCUMENT");
  assert.deepEqual(admissionGate.readStatus(), {
    mode: "boot_safe",
    storedActive: null,
    runtimeEffective: null,
  });
  assert.deepEqual(runtime.startupConfiguration, fallback);
  assert.equal(runtime.startupConfiguration.trackedRepositories.length, 0);
  assert.equal(runtime.startupConfiguration.workCoordination.enabled, false);
  assert.equal(runtime.startupConfiguration.githubActions.enabled, false);
  assert.equal(
    Object.values(runtime.startupConfiguration.employees.roles).every(
      (role) => role.enabled === false && role.initialPaused === true,
    ),
    true,
  );
  assert.equal(store.snapshot(), null);
  assert.equal((await runtime.reader.readSnapshot()).migration.status, "pending");
  const draft = await runtime.proposalPort.createInitializationDraft({
    configuration: fallback,
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  const prepared = await runtime.simulator.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 1,
  });
  assert.equal(prepared.expectedActiveVersion, null);
  const initialized = await runtime.activationExecutor.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  assert.equal(initialized.active.source, "initialization");
  await runtime.close();
});

test("a pre-parsing bootstrap failure also stays safely disabled", async () => {
  const runtime = await createConfigurationRuntime(null, {
    store: memoryStore(),
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    bootstrapError: {
      code: "CONFIG_LOCAL_INVALID",
      message: "本地覆盖配置无法解析",
    },
    createGuard: () => guard([]),
  });

  assert.equal(runtime.status.safeMode, true);
  assert.equal(runtime.status.migrationError.code, "CONFIG_LOCAL_INVALID");
  assert.equal(runtime.startupConfiguration.githubActions.enabled, false);
  await runtime.close();
});

test("bootstrap failure metadata rejects accessors without invoking them", async () => {
  let getterCalls = 0;
  const bootstrapError = { message: "must not be read" };
  Object.defineProperty(bootstrapError, "code", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "CONFIG_LOCAL_INVALID";
    },
  });

  await assert.rejects(
    createConfigurationRuntime(null, {
      store: memoryStore(),
      fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
      bootstrapError,
      createGuard: () => guard([]),
    }),
    /bootstrapError is invalid/,
  );
  assert.equal(getterCalls, 0);
});

test("runtime closes its guard while preserving acquisition and recovery failures", async (t) => {
  await t.test("acquisition failure", async () => {
    const events = [];
    const failure = new Error("guard unavailable");
    await assert.rejects(
      createConfigurationRuntime(configuration(), {
        store: memoryStore(),
        fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
        createGuard: () => guard(events, { acquireError: failure }),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(events, ["acquire", "close"]);
  });

  await t.test("recovery failure", async () => {
    const events = [];
    await assert.rejects(
      createConfigurationRuntime(configuration(), {
        store: memoryStore({ schemaVersion: 999 }),
        fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
        createGuard: () => guard(events),
      }),
      (error) => error.code === "CONFIGURATION_STATE_CORRUPTED",
    );
    assert.deepEqual(events.at(-1), "close");
  });
});
