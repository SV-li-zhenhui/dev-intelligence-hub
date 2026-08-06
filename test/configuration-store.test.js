import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { configurationDocumentDigest } from "../src/domain/configuration-contract.js";
import {
  CONFIGURATION_STATE_KEY,
  ConfigurationStore,
} from "../src/services/configuration-store.js";
import { configurationContentDigest } from "../src/services/configuration-state.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.json"), "utf8"),
);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function configuration() {
  return clone(committedConfiguration);
}

class MemoryStore {
  constructor(value = null) {
    this.value = clone(value);
    this.writes = [];
    this.failure = null;
  }

  async read(_name, fallback = null) {
    return clone(this.value ?? fallback);
  }

  async write(name, value) {
    const copied = clone(value);
    if (this.failure === "before") {
      this.failure = null;
      throw new Error("write unavailable");
    }
    if (this.failure === "missing") {
      this.failure = null;
      this.value = null;
      throw new Error("durable state disappeared");
    }
    this.value = copied;
    this.writes.push({ name, value: copied });
    if (this.failure === "after") {
      this.failure = null;
      throw new Error("write acknowledgement unavailable");
    }
  }

  failNextWrite(mode) {
    this.failure = mode;
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

function clock() {
  let offset = 0;
  const epoch = Date.parse("2026-08-05T01:00:00.000Z");
  return () => new Date(epoch + offset++ * 1_000);
}

function idFactory() {
  let id = 0;
  return () => `draft-${++id}`;
}

async function readyStore({ store = new MemoryStore(), limits } = {}) {
  const configurations = new ConfigurationStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
    clock: clock(),
    idFactory: idFactory(),
    ...(limits ? { limits } : {}),
  });
  await configurations.recover();
  return { configurations, store };
}

async function importedFixture(options = {}) {
  const fixture = await readyStore(options);
  await fixture.configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });
  return fixture;
}

function changedConfiguration() {
  const changed = configuration();
  changed.employees.roles.developer.mission =
    "实现已验收需求，验证证据，并主动报告风险。";
  return changed;
}

function assertCode(code, statusCode) {
  return (error) => error?.code === code && error?.statusCode === statusCode;
}

function readdress(record, idName, prefix) {
  const { [idName]: _id, contentDigest: _digest, ...content } = record;
  const contentDigest = configurationContentDigest(content);
  return { [idName]: `${prefix}-${contentDigest}`, contentDigest, ...content };
}

function replaceVersionConfiguration(state, versionNumber, replacement) {
  const configurationDigest = configurationDocumentDigest(replacement);
  const versionIndex = state.versions.findIndex(
    (entry) => entry.version === versionNumber,
  );
  state.versions[versionIndex] = readdress(
    {
      ...state.versions[versionIndex],
      configurationDigest,
      configuration: clone(replacement),
    },
    "versionId",
    "configuration-version",
  );
  const auditIndex = state.audit.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.audit[auditIndex] = readdress(
    { ...state.audit[auditIndex], configurationDigest },
    "auditId",
    "configuration-audit",
  );
  const outboxIndex = state.projectionOutbox.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.projectionOutbox[outboxIndex] = readdress(
    { ...state.projectionOutbox[outboxIndex], configurationDigest },
    "outboxId",
    "configuration-outbox",
  );
}

test("bootstrap imports once and later file changes cannot replace active authority", async () => {
  const { configurations, store } = await readyStore();
  const imported = await configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });

  assert.equal(imported.applied, true);
  assert.equal(imported.active.version, 1);
  assert.equal(store.writes.length, 1);

  let getterCalls = 0;
  const ignoredHostileFile = {};
  Object.defineProperty(ignoredHostileFile, "credential", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });
  const ignoredHostile = await configurations.importBootstrap({
    configuration: ignoredHostileFile,
    importedBy: "changed-bootstrap-file",
  });
  assert.equal(ignoredHostile.applied, false);
  assert.equal(getterCalls, 0);
  assert.equal(store.writes[0].name, CONFIGURATION_STATE_KEY);

  const ignored = await configurations.importBootstrap({
    configuration: changedConfiguration(),
    importedBy: "changed-bootstrap-file",
  });
  assert.equal(ignored.applied, false);
  assert.equal(ignored.active.version, 1);
  assert.equal(
    ignored.active.configuration.employees.roles.developer.mission,
    configuration().employees.roles.developer.mission,
  );
  assert.equal(store.writes.length, 1);

  const restarted = await readyStore({ store });
  const active = await restarted.configurations.readActive();
  assert.deepEqual(active, imported.active);
  assert.equal(Object.isFrozen(active), true);
});

test("an owner initialization draft creates one audited v1 after safe mode", async () => {
  const { configurations, store } = await readyStore();
  const draft = await configurations.createInitializationDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  assert.equal(draft.baseVersion, 0);
  assert.equal(draft.revision, 1);

  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.employees.roles.developer.brain.model = "qwen3.5:small";
  const revised = await configurations.reviseDraft({
    draftId: draft.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 1,
    configuration: revisedConfiguration,
    proposedBy: "owner:local",
  });
  assert.equal(revised.baseVersion, 0);
  const writeCount = store.writes.length;
  const prepared = await configurations.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 2,
  });
  assert.equal(prepared.kind, "configuration.initialize");
  assert.equal(prepared.expectedActiveVersion, null);
  assert.equal(prepared.activeDigest, null);
  assert.match(prepared.baselineDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.baselineDigest, prepared.impact.beforeDigest);
  assert.equal(prepared.documentDigest, revised.configurationDigest);
  assert.equal(prepared.impact.changed, true);
  assert.match(prepared.validationDigest, /^[a-f0-9]{64}$/);
  assert.match(prepared.impactDigest, /^[a-f0-9]{64}$/);
  assert.equal(store.writes.length, writeCount);

  const initialized = await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  assert.equal(initialized.applied, true);
  assert.equal(initialized.active.version, 1);
  assert.equal(initialized.active.previousVersion, null);
  assert.equal(initialized.active.source, "initialization");
  assert.equal(initialized.active.draftRevisionId, revised.draftRevisionId);

  const snapshot = await configurations.readSnapshot();
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.activeVersion, 1);
  assert.equal(snapshot.migration.status, "imported");
  assert.equal(snapshot.audit.at(-1).kind, "configuration_initialized");
  assert.equal(snapshot.projectionOutbox.length, 1);
  const repeated = await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, initialized.active);

  const restarted = await readyStore({ store });
  assert.deepEqual(await restarted.configurations.readActive(), initialized.active);
});

test("initialization remains explicit, latest-only, and cannot race bootstrap", async () => {
  const { configurations } = await readyStore();
  await assert.rejects(
    configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 0,
      proposedBy: "owner:local",
    }),
    assertCode("CONFIGURATION_BOOTSTRAP_REQUIRED", 409),
  );
  const draft = await configurations.createInitializationDraft({
    configuration: configuration(),
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  const revised = await configurations.reviseDraft({
    draftId: draft.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 1,
    configuration: changedConfiguration(),
    proposedBy: "owner:local",
  });
  await assert.rejects(
    configurations.prepareInitialization({
      draftId: draft.draftId,
      draftRevision: 1,
      expectedStateRevision: 2,
    }),
    assertCode("CONFIGURATION_DRAFT_REVISION_CONFLICT", 409),
  );
  const ignoredBootstrap = await configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });
  assert.deepEqual(ignoredBootstrap, { applied: false, active: null });
  const prepared = await configurations.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 2,
  });
  await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  await assert.rejects(
    configurations.reviseDraft({
      draftId: draft.draftId,
      expectedDraftRevision: 2,
      expectedStateRevision: 3,
      configuration: configuration(),
      proposedBy: "owner:local",
    }),
    assertCode("CONFIGURATION_INITIALIZATION_STALE", 409),
  );
});

test("initialization write uncertainty is reconciled without creating a second v1", async (t) => {
  async function preparedFixture() {
    const fixture = await readyStore();
    const draft = await fixture.configurations.createInitializationDraft({
      configuration: changedConfiguration(),
      expectedStateRevision: 0,
      proposedBy: "owner:local",
    });
    const prepared = await fixture.configurations.prepareInitialization({
      draftId: draft.draftId,
      draftRevision: draft.revision,
      expectedStateRevision: 1,
    });
    return { ...fixture, prepared };
  }

  await t.test("write rejected before persistence", async () => {
    const { configurations, store, prepared } = await preparedFixture();
    store.failNextWrite("before");
    await assert.rejects(
      configurations.activateInitialization({
        ...prepared,
        activatedBy: "owner:local",
      }),
      assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
    );
    const snapshot = await configurations.readSnapshot();
    assert.equal(snapshot.activeVersion, null);
    assert.equal(snapshot.versions.length, 0);
    assert.equal(snapshot.projectionOutbox.length, 0);
  });

  await t.test("write committed before acknowledgement loss", async () => {
    const { configurations, store, prepared } = await preparedFixture();
    store.failNextWrite("after");
    const initialized = await configurations.activateInitialization({
      ...prepared,
      activatedBy: "owner:local",
    });
    assert.equal(initialized.active.version, 1);
    const repeated = await configurations.activateInitialization({
      ...prepared,
      activatedBy: "owner:local",
    });
    assert.equal(repeated.applied, false);
    assert.equal((await configurations.readSnapshot()).versions.length, 1);
  });
});

test("draft edits append immutable revisions and validation never writes", async () => {
  const { configurations, store } = await importedFixture();
  const created = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "employee:orchestrator",
  });

  assert.equal(created.draftId, "draft-1");
  assert.equal(created.revision, 1);
  assert.equal(created.baseVersion, 1);
  assert.match(created.draftRevisionId, /^configuration-draft-revision-[a-f0-9]{64}$/);
  assert.equal(store.writes.length, 2);

  await assert.rejects(
    configurations.reviseDraft({
      draftId: created.draftId,
      expectedDraftRevision: 1,
      expectedStateRevision: 1,
      configuration: configuration(),
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );

  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.employees.roles.developer.brain.model = "qwen3.5:small";
  const revised = await configurations.reviseDraft({
    draftId: created.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 2,
    configuration: revisedConfiguration,
    proposedBy: "owner",
  });
  assert.equal(revised.revision, 2);
  assert.equal(revised.supersedesRevisionId, created.draftRevisionId);
  assert.deepEqual(
    await configurations.readDraft({ draftId: created.draftId, revision: 1 }),
    created,
  );

  const writeCount = store.writes.length;
  const prepared = await configurations.prepareDraftActivation({
    draftId: revised.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 3,
    expectedActiveVersion: 1,
  });
  assert.equal(prepared.documentDigest, revised.configurationDigest);
  assert.match(prepared.validationDigest, /^[a-f0-9]{64}$/);
  assert.match(prepared.impactDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.impact.changed, true);
  assert.equal(store.writes.length, writeCount);
  assert.equal(Object.isFrozen(prepared), true);
});

test("control-plane and authority reads bound history before cloning", async () => {
  const { configurations } = await importedFixture();
  const first = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner:local",
  });
  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.refreshMinutes += 1;
  const revised = await configurations.reviseDraft({
    draftId: first.draftId,
    expectedDraftRevision: first.revision,
    expectedStateRevision: 2,
    configuration: revisedConfiguration,
    proposedBy: "owner:local",
  });

  const authority = await configurations.readAuthoritySnapshot();
  assert.equal(authority.revision, 3);
  assert.equal(authority.activeVersion, 1);
  assert.equal(authority.versions.length, 1);
  assert.equal("configuration" in authority.versions[0], false);
  assert.deepEqual(
    authority.draftRevisions.map((draft) => draft.draftRevisionId),
    [revised.draftRevisionId],
  );
  assert.equal("configuration" in authority.draftRevisions[0], false);
  assert.equal("audit" in authority, false);
  assert.equal("projectionOutbox" in authority, false);
  assert.equal(Object.isFrozen(authority), true);

  const controlPlane = await configurations.readControlPlaneSnapshot({
    versionLimit: 1,
    auditLimit: 2,
  });
  assert.equal(controlPlane.versions.length, 1);
  assert.equal("configuration" in controlPlane.versions[0], false);
  assert.equal(controlPlane.draftRevisions.length, 1);
  assert.equal("configuration" in controlPlane.draftRevisions[0], false);
  assert.deepEqual(controlPlane.editableConfiguration, revisedConfiguration);
  assert.deepEqual(controlPlane.audit.map((entry) => entry.sequence), [2, 3]);
  assert.deepEqual(controlPlane.history, {
    totalVersions: 1,
    totalAuditEntries: 3,
    versionsTruncated: false,
    auditTruncated: true,
  });
  assert.equal("projectionOutbox" in controlPlane, false);
  assert.equal(Object.isFrozen(controlPlane), true);

  await assert.rejects(
    configurations.readControlPlaneSnapshot({ versionLimit: 0 }),
    /versionLimit is invalid/,
  );
  await assert.rejects(
    configurations.readControlPlaneSnapshot({ auditLimit: 0 }),
    /auditLimit is invalid/,
  );
});

test("activation is revision-bound, audited, projected, and idempotent", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "employee:orchestrator",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });

  await assert.rejects(
    configurations.activateDraft({
      ...plan,
      documentDigest: "0".repeat(64),
      activatedBy: "owner",
    }),
    assertCode("CONFIGURATION_ACTIVATION_STALE", 409),
  );

  const activated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(activated.applied, true);
  assert.equal(activated.active.version, 2);
  assert.equal(activated.active.source, "draft");
  assert.equal(activated.active.draftRevisionId, draft.draftRevisionId);

  const snapshot = await configurations.readSnapshot();
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.activeVersion, 2);
  assert.equal(snapshot.audit.at(-1).kind, "configuration_activated");
  assert.equal(snapshot.projectionOutbox.length, 2);
  assert.equal(snapshot.projectionOutbox.at(-1).configurationVersion, 2);
  assert.equal(
    snapshot.projectionOutbox.at(-1).configurationDigest,
    activated.active.configurationDigest,
  );

  const reconciliation =
    await configurations.readActivationReconciliationSnapshot({ version: 1 });
  assert.deepEqual(reconciliation.active, {
    version: 2,
    configurationDigest: activated.active.configurationDigest,
  });
  assert.equal(reconciliation.observedVersion.version, 1);
  assert.deepEqual(Object.keys(reconciliation.observedVersion), [
    "version",
    "configurationDigest",
    "source",
    "previousVersion",
    "draftRevisionId",
    "rollbackOf",
    "activatedBy",
    "activatedAt",
    "impactDigest",
  ]);
  assert.equal("configuration" in reconciliation.observedVersion, false);
  assert.equal("draftRevisions" in reconciliation, false);
  assert.equal("audit" in reconciliation, false);
  assert.equal("projectionOutbox" in reconciliation, false);
  assert.equal(Object.isFrozen(reconciliation), true);

  const repeated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, activated.active);
  assert.equal(store.writes.length, 3);
});

test("a draft from an older Active baseline cannot be disguised as a new activation", async () => {
  const { configurations } = await importedFixture();
  const staleDraft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const winningConfiguration = configuration();
  winningConfiguration.refreshMinutes += 1;
  const winningDraft = await configurations.createDraft({
    configuration: winningConfiguration,
    expectedStateRevision: 2,
    proposedBy: "owner",
  });
  const winningPlan = await configurations.prepareDraftActivation({
    draftId: winningDraft.draftId,
    draftRevision: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 1,
  });
  await configurations.activateDraft({ ...winningPlan, activatedBy: "owner" });

  await assert.rejects(
    configurations.prepareDraftActivation({
      draftId: staleDraft.draftId,
      draftRevision: 1,
      expectedStateRevision: 4,
      expectedActiveVersion: 2,
    }),
    assertCode("CONFIGURATION_ACTIVATION_STALE", 409),
  );
});

test("rollback appends a new active version instead of moving the version backward", async () => {
  const { configurations } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const activation = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  await configurations.activateDraft({ ...activation, activatedBy: "owner" });

  const rollback = await configurations.prepareRollback({
    targetVersion: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 2,
  });
  const rolledBack = await configurations.activateRollback({
    ...rollback,
    activatedBy: "owner",
  });

  assert.equal(rolledBack.applied, true);
  assert.equal(rolledBack.active.version, 3);
  assert.equal(rolledBack.active.source, "rollback");
  assert.equal(rolledBack.active.rollbackOf, 1);
  assert.deepEqual(
    rolledBack.active.configuration,
    (await configurations.readVersion({ version: 1 })).configuration,
  );
  assert.equal(
    (await configurations.readSnapshot()).audit.at(-1).kind,
    "configuration_rolled_back",
  );
});

test("a failed write cannot expose a partial active pointer, audit, or outbox", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  const before = await configurations.readSnapshot();
  store.failNextWrite("before");

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
  );
  assert.deepEqual(await configurations.readSnapshot(), before);
  assert.equal(store.value.activeVersion, 1);
  assert.equal(store.value.audit.length, before.audit.length);
  assert.equal(store.value.projectionOutbox.length, before.projectionOutbox.length);
});

test("lost write acknowledgement is recovered as the same activation", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  store.failNextWrite("after");

  const recovered = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(recovered.applied, true);
  assert.equal(recovered.active.version, 2);
  assert.equal((await configurations.readActive()).version, 2);
  assert.equal((await configurations.readSnapshot()).revision, 3);

  const repeated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, recovered.active);
});

test("an unconfirmable write failure closes configuration reads fail-closed", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  store.failNextWrite("missing");

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
  );
  await assert.rejects(
    configurations.readActive(),
    assertCode("CONFIGURATION_NOT_READY", 503),
  );
});

test("recovery binds draft and rollback versions to their declared source content", async () => {
  const draftFixture = await importedFixture();
  const draft = await draftFixture.configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const activation = await draftFixture.configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  await draftFixture.configurations.activateDraft({
    ...activation,
    activatedBy: "owner",
  });

  const forgedDraftState = clone(draftFixture.store.value);
  replaceVersionConfiguration(
    forgedDraftState,
    2,
    forgedDraftState.versions[0].configuration,
  );
  await assert.rejects(
    readyStore({ store: new MemoryStore(forgedDraftState) }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const rollback = await draftFixture.configurations.prepareRollback({
    targetVersion: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 2,
  });
  await draftFixture.configurations.activateRollback({
    ...rollback,
    activatedBy: "owner",
  });
  const forgedRollbackState = clone(draftFixture.store.value);
  replaceVersionConfiguration(
    forgedRollbackState,
    3,
    forgedRollbackState.versions[1].configuration,
  );
  await assert.rejects(
    readyStore({ store: new MemoryStore(forgedRollbackState) }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );
});

test("capacity exhaustion returns 507 without deleting referenced history", async () => {
  const { configurations, store } = await importedFixture({
    limits: { maximumVersions: 1 },
  });
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  const before = clone(store.value);

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_CAPACITY_EXCEEDED", 507),
  );
  assert.deepEqual(store.value, before);
});

test("recovery rejects tampering, durable rollback, and same-revision forks", async () => {
  const primary = await importedFixture();
  const pristine = clone(primary.store.value);

  const tamperedStore = new MemoryStore(pristine);
  tamperedStore.value.versions[0].configuration.employees.roles.developer.mission =
    "tampered";
  await assert.rejects(
    readyStore({ store: tamperedStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const forgedAuditStore = new MemoryStore(pristine);
  forgedAuditStore.value.audit[0] = readdress(
    {
      ...forgedAuditStore.value.audit[0],
      kind: "configuration_activated",
    },
    "auditId",
    "configuration-audit",
  );
  await assert.rejects(
    readyStore({ store: forgedAuditStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const partialMigrationStore = new MemoryStore(pristine);
  partialMigrationStore.value.migration.importedBy = null;
  await assert.rejects(
    readyStore({ store: partialMigrationStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const forkAStore = new MemoryStore(pristine);
  const forkBStore = new MemoryStore(pristine);
  const forkA = await readyStore({ store: forkAStore });
  const forkB = await readyStore({ store: forkBStore });
  await forkA.configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner:a",
  });
  const alternate = configuration();
  alternate.employees.roles.tester.mission = "独立验证交付证据并报告风险。";
  await forkB.configurations.createDraft({
    configuration: alternate,
    expectedStateRevision: 1,
    proposedBy: "owner:b",
  });

  forkAStore.value = clone(pristine);
  await assert.rejects(
    forkA.configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 2,
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );

  forkAStore.value = clone(forkBStore.value);
  await assert.rejects(
    forkA.configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 2,
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );
});
