import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createConfigurationRuntime } from "../src/configuration-runtime.js";
import { createSafeDisabledConfiguration } from "../src/lib/config.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.json"), "utf8"),
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
    "readActive",
    "readDraft",
    "readProjectionBatch",
    "readSnapshot",
    "readVersion",
  ]);
  assert.deepEqual(Object.keys(runtime.draftManager).sort(), [
    "createDraft",
    "reviseDraft",
  ]);
  assert.deepEqual(Object.keys(runtime.simulator).sort(), [
    "prepareDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(runtime.activationExecutor).sort(), [
    "activateDraft",
    "activateRollback",
  ]);
  assert.deepEqual(Object.keys(runtime.proposalPort).sort(), [
    "createDraft",
    "reviseDraft",
  ]);
  assert.equal("importBootstrap" in runtime, false);
  assert.equal("activateDraft" in runtime.proposalPort, false);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.reader), true);
  assert.equal(runtime.status.safeMode, false);
  assert.equal(runtime.status.activeVersion, 1);
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

test("activation runs through the supplied shared action-admission gate", async () => {
  const events = [];
  const runtime = await createConfigurationRuntime(configuration(), {
    store: memoryStore(),
    fallbackConfiguration: createSafeDisabledConfiguration(configuration()),
    actionAdmissionGate: {
      async run(operation) {
        events.push("gate-enter");
        const result = await operation();
        events.push("gate-exit");
        return result;
      },
    },
    createGuard: () => guard([]),
  });
  const snapshot = await runtime.reader.readSnapshot();
  const next = configuration();
  next.refreshMinutes += 1;
  const draft = await runtime.draftManager.createDraft({
    configuration: next,
    expectedStateRevision: snapshot.revision,
    proposedBy: "owner:local",
  });
  const prepared = await runtime.simulator.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: snapshot.revision + 1,
    expectedActiveVersion: snapshot.activeVersion,
  });

  const activated = await runtime.activationExecutor.activateDraft({
    draftId: prepared.draftId,
    draftRevision: prepared.draftRevision,
    expectedStateRevision: prepared.expectedStateRevision,
    expectedActiveVersion: prepared.expectedActiveVersion,
    draftRevisionId: prepared.draftRevisionId,
    documentDigest: prepared.documentDigest,
    validationDigest: prepared.validationDigest,
    impactDigest: prepared.impactDigest,
    activatedBy: "owner:local",
  });

  assert.equal(activated.active.version, 2);
  assert.deepEqual(events, ["gate-enter", "gate-exit"]);
  await runtime.close();
});

test("an invalid first import starts from a non-persisted safe fallback", async () => {
  const events = [];
  const store = memoryStore();
  const invalid = configuration();
  invalid.githubActions.token = "ghp_not-a-real-token";
  const fallback = createSafeDisabledConfiguration(configuration());
  const runtime = await createConfigurationRuntime(invalid, {
    store,
    fallbackConfiguration: fallback,
    createGuard: () => guard(events),
  });

  assert.equal(runtime.status.safeMode, true);
  assert.equal(runtime.status.activeVersion, null);
  assert.equal(runtime.status.migrationError.code, "INVALID_CONFIGURATION_DOCUMENT");
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
  await assert.rejects(
    runtime.proposalPort.createDraft({
      configuration: fallback,
      expectedStateRevision: 0,
      proposedBy: "employee:orchestrator",
    }),
    (error) => error.code === "CONFIGURATION_BOOTSTRAP_REQUIRED",
  );
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
