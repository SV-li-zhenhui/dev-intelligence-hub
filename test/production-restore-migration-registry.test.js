import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackupManifest } from "../src/domain/backup-manifest.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  defaultConfirmationState,
  normalizeConfirmationState,
} from "../src/domain/confirmation-contract.js";
import {
  emptyConfigurationState,
  migrateConfigurationState,
  normalizeConfigurationLimits,
} from "../src/services/configuration-state.js";
import { ConfigurationStore } from "../src/services/configuration-store.js";
import {
  CHANGE_PACKAGE_APPLICATION_STATE_KEY,
  normalizeChangePackageApplicationPersistedState,
} from "../src/services/change-package-application-service.js";
import {
  CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY,
  normalizeChangePackageApplicationProjectionPersistedState,
} from "../src/services/change-package-application-projection-store.js";
import {
  CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY,
  normalizeControlledCommitDeliveryPersistedState,
} from "../src/services/change-package-controlled-commit-service.js";
import { normalizeCodeJobStoreState } from "../src/services/code-job-store.js";
import {
  configuredRoleLifecycleStateKey,
  normalizeConfiguredRoleLifecyclePersistedState,
} from "../src/services/configured-role-employee.js";
import { CONFIRMATION_QUEUE_STATE_KEY } from "../src/services/confirmation-queue.js";
import {
  CONTROLLED_CODE_EXECUTOR_STATE_KEY,
  normalizeControlledCodeExecutorState,
} from "../src/services/controlled-code-executor.js";
import {
  AGENT_MEMORY_QUERY_STATE_KEY,
  normalizeAgentMemoryQueryPersistedState,
} from "../src/services/agent-memory-query-service.js";
import { ATTENTION_INBOX_STATE_KEY } from "../src/services/attention-inbox-state.js";
import {
  defaultAttentionState,
  normalizeAttentionState,
} from "../src/services/attention-inbox-state.js";
import {
  buildMemoryJournalIndexState,
  isMemoryJournalIndexStateCurrent,
  normalizeMemoryJournalState,
} from "../src/services/local-memory-journal.js";
import {
  PERSISTED_SCHEMA_OWNER_IDS,
  allPersistedSchemaOwners,
  assertCompletePersistedSchemaOwnerCatalog,
  definePersistedSchemaOwner,
} from "../src/services/persisted-schema-owner-catalog.js";
import {
  createProductionRestoreMigrationRegistry,
} from "../src/services/production-restore-migration-registry.js";
import {
  createCodeJobArchiveFixture,
} from "./support/code-job-archive-fixture.js";
import {
  normalizePrEngineerReadFactsPersistedState,
  PR_ENGINEER_READ_FACTS_STATE_KEY,
} from "../src/services/pr-engineer-service.js";
import {
  emptyOwnerWorkRequestState,
  normalizeOwnerWorkRequestState,
} from "../src/services/owner-work-request-state.js";
import {
  normalizeWorkProposalPersistedState,
  WORK_PROPOSAL_STATE_KEY,
} from "../src/services/work-proposal-store.js";
import {
  emptyWorkLedgerState,
  normalizeWorkLedgerPersistedState,
} from "../src/services/work-ledger-state.js";
import { migrateWorkflowPersistedState } from "../src/services/workflow-routing-state.js";

const EXPECTED_OWNER_IDS = Object.freeze([
  "configuration-state",
  "workflow-routing-state",
  "work-ledger-state",
  "code-job-state",
  "code-job-archive-record",
  "code-job-archive-index",
  "code-executor-state",
  "confirmation-queue",
  "work-proposal-state",
  "attention-inbox",
  "owner-work-requests",
  "unified-memory-journal",
  "unified-memory-index",
  "legacy-authority-projection",
  "agent-memory-queries",
  "pr-engineer-read-facts",
  "change-package-applications",
  "change-package-controlled-commits",
  "change-package-application-projections",
  "configured-role-lifecycle",
]);

async function candidateDirectory(t, files) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "mydashboard-restore-registry-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(
      path.join(directory, name),
      typeof content === "string"
        ? content
        : `${JSON.stringify(content, null, 2)}\n`,
      "utf8",
    );
  }
  const names = (await readdir(directory)).sort();
  const facts = [];
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    facts.push({
      path: name,
      kind: "mutable",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const manifest = createBackupManifest({
    createdAt: "2026-08-08T08:00:00.000Z",
    stores: [{ name: "fixture", revision: 0, digest: "0".repeat(64) }],
    files: facts,
  });
  return { directory, manifest };
}

async function readJson(directory, key) {
  return JSON.parse(
    await readFile(path.join(directory, `${key}.json`), "utf8"),
  );
}

async function activeConfigurationState() {
  let value = null;
  const store = {
    async read(_key, fallback = null) {
      return structuredClone(value ?? fallback);
    },
    async write(_key, next) {
      value = structuredClone(next);
    },
  };
  const configurations = new ConfigurationStore({
    store,
    operationQueue: new OperationQueue(),
    exclusiveLease: { async run(operation) { return operation(); } },
    clock: () => new Date("2026-08-08T08:00:00.000Z"),
    idFactory: () => "restore-registry-configuration",
  });
  await configurations.recover();
  const configuration = JSON.parse(
    await readFile(
      path.resolve(import.meta.dirname, "..", "config.example.json"),
      "utf8",
    ),
  );
  await configurations.importBootstrap({
    configuration,
    importedBy: "restore-registry-test",
  });
  return structuredClone(value);
}

const noopNormalize = (value) => structuredClone(value);
const noopMigrate = (value) => structuredClone(value);
const noopDerive = () => null;
const noopPlan = () => Object.freeze([]);
const noopVerifyImmutable = () => undefined;
const OWNERS_REQUIRING_SPECIAL_ADAPTERS = Object.freeze([
  "configuration-state",
  "workflow-routing-state",
  "work-ledger-state",
  "code-job-state",
  "code-job-archive-record",
  "code-job-archive-index",
  "code-executor-state",
  "unified-memory-journal",
  "unified-memory-index",
  "legacy-authority-projection",
  "configured-role-lifecycle",
]);

function ownerDescriptor(ownerId) {
  const functions = { normalize: noopNormalize };
  if (
    [
      "configuration-state",
      "workflow-routing-state",
      "work-ledger-state",
      "code-job-state",
      "code-executor-state",
      "unified-memory-journal",
    ].includes(ownerId)
  ) {
    functions.migrate = noopMigrate;
  }
  if (["unified-memory-index", "configured-role-lifecycle"].includes(ownerId)) {
    functions.derive = noopDerive;
  }
  if (ownerId === "legacy-authority-projection") {
    functions.plan = noopPlan;
  }
  if (["code-job-archive-record", "code-job-archive-index"].includes(ownerId)) {
    functions.verifyImmutable = noopVerifyImmutable;
  }
  return definePersistedSchemaOwner({ ownerId, ...functions });
}

function completeCatalog() {
  return PERSISTED_SCHEMA_OWNER_IDS.map(ownerDescriptor);
}

function expectCoverageFailure(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, "RESTORE_SCHEMA_OWNER_COVERAGE_INCOMPLETE");
    assert.doesNotMatch(error.message, /configuration-state\.json|D:\\|\//u);
    return true;
  });
}

test("the executable restore-owner baseline is exact and deeply frozen", () => {
  assert.deepEqual(PERSISTED_SCHEMA_OWNER_IDS, EXPECTED_OWNER_IDS);
  assert.equal(Object.isFrozen(PERSISTED_SCHEMA_OWNER_IDS), true);

  const catalog = completeCatalog();
  assert.doesNotThrow(() => assertCompletePersistedSchemaOwnerCatalog(catalog));
  for (const descriptor of catalog) {
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(Object.isFrozen(descriptor.supportedVersions), true);
    if (descriptor.keyFamily) {
      assert.equal(Object.isFrozen(descriptor.keyFamily), true);
    }
  }
});

test("the production catalog and migration port expose the exact audited boundary", () => {
  const catalog = allPersistedSchemaOwners();
  assert.equal(Object.isFrozen(catalog), true);
  assert.deepEqual(
    catalog.map(({ ownerId }) => ownerId),
    EXPECTED_OWNER_IDS,
  );
  assert.doesNotThrow(() => assertCompletePersistedSchemaOwnerCatalog(catalog));

  const registry = createProductionRestoreMigrationRegistry();
  assert.equal(Object.isFrozen(registry), true);
  assert.deepEqual(Object.keys(registry), ["migrate"]);
  assert.equal(typeof registry.migrate, "function");
});

test("every omitted restore owner fails construction before restore starts", () => {
  for (const ownerId of PERSISTED_SCHEMA_OWNER_IDS) {
    expectCoverageFailure(() =>
      assertCompletePersistedSchemaOwnerCatalog(
        completeCatalog().filter((descriptor) => descriptor.ownerId !== ownerId),
      ),
    );
  }
});

test("duplicate, mis-moded, mis-versioned, and overlapping owners fail coverage", () => {
  const mutations = [
    (catalog) => {
      catalog[1] = Object.freeze({
        ...catalog[1],
        ownerId: catalog[0].ownerId,
      });
    },
    (catalog) => {
      catalog[0] = Object.freeze({ ...catalog[0], mode: "validate" });
    },
    (catalog) => {
      catalog[0] = Object.freeze({ ...catalog[0], currentVersion: 99 });
    },
    (catalog) => {
      catalog[0] = Object.freeze({
        ...catalog[0],
        supportedVersions: Object.freeze([3]),
      });
    },
    (catalog) => {
      catalog[1] = Object.freeze({ ...catalog[1], key: catalog[0].key });
    },
    (catalog) => {
      const index = catalog.findIndex(
        ({ ownerId }) => ownerId === "configured-role-lifecycle",
      );
      catalog[index] = Object.freeze({
        ...catalog[index],
        keyFamily: Object.freeze({
          prefix: "../configured-role-",
          suffix: "-state",
          memberPattern: "[a-z0-9-]+",
          discovery: "candidate-configuration",
        }),
      });
    },
  ];

  for (const mutate of mutations) {
    const catalog = completeCatalog();
    mutate(catalog);
    expectCoverageFailure(() =>
      assertCompletePersistedSchemaOwnerCatalog(catalog),
    );
  }
});

test("descriptor construction requires the mode-appropriate pure adapter", () => {
  for (const ownerId of OWNERS_REQUIRING_SPECIAL_ADAPTERS) {
    expectCoverageFailure(() =>
      definePersistedSchemaOwner({ ownerId, normalize: noopNormalize }),
    );
  }
});

test("coverage validation rejects accessors and proxies without invoking them", () => {
  let getterCalls = 0;
  const accessorCatalog = completeCatalog();
  const accessor = {};
  Object.defineProperty(accessor, "ownerId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "configuration-state";
    },
  });
  Object.freeze(accessor);
  accessorCatalog[0] = accessor;
  expectCoverageFailure(() =>
    assertCompletePersistedSchemaOwnerCatalog(accessorCatalog),
  );
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const proxyCatalog = completeCatalog();
  proxyCatalog[0] = new Proxy(proxyCatalog[0], {
    isExtensible() {
      proxyTrapCalls += 1;
      throw new Error("proxy trap must not run");
    },
  });
  expectCoverageFailure(() =>
    assertCompletePersistedSchemaOwnerCatalog(proxyCatalog),
  );
  assert.equal(proxyTrapCalls, 0);
});

test("validation-only adapters clone v1 states and migrate role lifecycle state", () => {
  const prFactContent = { schemaVersion: 1, revision: 0, records: [] };
  const fixtures = [
    [
      normalizeWorkProposalPersistedState,
      {
        schemaVersion: 1,
        revision: 0,
        nextResultSequence: 1,
        proposals: [],
        results: [],
      },
    ],
    [
      normalizePrEngineerReadFactsPersistedState,
      {
        ...prFactContent,
        contentDigest: createHash("sha256")
          .update(JSON.stringify(prFactContent), "utf8")
          .digest("hex"),
      },
    ],
    [
      normalizeChangePackageApplicationPersistedState,
      { schemaVersion: 1, revision: 0, applications: [] },
    ],
    [
      normalizeControlledCommitDeliveryPersistedState,
      { schemaVersion: 1, revision: 0, deliveries: [] },
    ],
    [
      normalizeChangePackageApplicationProjectionPersistedState,
      {
        schemaVersion: 1,
        revision: 0,
        sourceRevision: 0,
        sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
        entries: [],
      },
    ],
    [
      normalizeConfiguredRoleLifecyclePersistedState,
      {
        schemaVersion: 1,
        revision: 0,
        paused: false,
        runCount: 0,
        lastRun: null,
        lastErrorCode: "",
      },
      {
        schemaVersion: 2,
        revision: 0,
        paused: false,
        runCount: 0,
        lastRun: null,
        lastErrorCode: "",
      },
      3,
    ],
  ];

  for (const [normalize, fixture, expected = fixture, invalidVersion = 2] of fixtures) {
    const result = normalize(fixture);
    assert.deepEqual(result, expected);
    assert.notEqual(result, fixture);
    assert.throws(() => normalize({ ...fixture, schemaVersion: invalidVersion }));
  }
});

test("workflow restore migration applies the established v1 revision bump", () => {
  const legacy = {
    schemaVersion: 1,
    revision: 0,
    currentConfig: null,
    configHistory: [],
    events: [],
    assignments: [],
    audit: [],
    checkpoint: null,
    lastSnapshot: null,
  };

  const migrated = migrateWorkflowPersistedState(legacy);

  assert.deepEqual(migrated, {
    schemaVersion: 2,
    revision: 1,
    currentConfig: null,
    configHistory: [],
    events: [],
    assignments: [],
    assignmentFeed: [],
    assignmentHighWatermark: 0,
    assignmentOldestAvailableSequence: 1,
    audit: [],
    checkpoint: null,
    lastSnapshot: null,
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy, "assignmentFeed"), false);
  assert.deepEqual(migrateWorkflowPersistedState(migrated), migrated);
});

test("Code Job and executor legacy adapters are detached and idempotent", () => {
  const legacyCodeJobs = Object.freeze({
    schemaVersion: 1,
    revision: 0,
    nextJobSequence: 1,
    jobs: Object.freeze([]),
  });
  const codeJobs = normalizeCodeJobStoreState(legacyCodeJobs);
  assert.equal(codeJobs.schemaVersion, 8);
  assert.equal(codeJobs.revision, 0);
  assert.equal(codeJobs.nextJobSequence, 1);
  assert.deepEqual(codeJobs.jobs, []);
  assert.deepEqual(normalizeCodeJobStoreState(codeJobs), codeJobs);
  assert.equal(legacyCodeJobs.schemaVersion, 1);

  const legacyExecutor = Object.freeze({
    schemaVersion: 1,
    revision: 0,
    sessions: Object.freeze({}),
  });
  const executor = normalizeControlledCodeExecutorState(legacyExecutor);
  assert.equal(CONTROLLED_CODE_EXECUTOR_STATE_KEY, "code-executor-state");
  assert.deepEqual(executor, {
    schemaVersion: 2,
    revision: 0,
    sessions: {},
  });
  assert.notEqual(executor, legacyExecutor);
  assert.deepEqual(normalizeControlledCodeExecutorState(executor), executor);
  assert.equal(legacyExecutor.schemaVersion, 1);
});

test("memory journal, derived index, and query adapters are deterministic", () => {
  const legacyJournal = Object.freeze({
    schemaVersion: 1,
    revision: 0,
    records: Object.freeze([]),
  });
  const journal = normalizeMemoryJournalState(legacyJournal);
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.revision, 0);
  assert.deepEqual(journal.records, []);
  assert.equal(legacyJournal.schemaVersion, 1);
  assert.deepEqual(normalizeMemoryJournalState(journal), journal);

  const firstIndex = buildMemoryJournalIndexState(journal);
  const secondIndex = buildMemoryJournalIndexState(journal);
  assert.deepEqual(firstIndex, secondIndex);
  assert.notEqual(firstIndex, secondIndex);
  assert.equal(isMemoryJournalIndexStateCurrent(firstIndex, journal), true);
  assert.equal(
    isMemoryJournalIndexStateCurrent(
      { ...firstIndex, entries: { forged: ["memory-" + "0".repeat(64)] } },
      journal,
    ),
    false,
  );

  const queryState = { schemaVersion: 1, revision: 0, entries: [] };
  const normalizedQueries = normalizeAgentMemoryQueryPersistedState(queryState);
  assert.equal(AGENT_MEMORY_QUERY_STATE_KEY, "agent-memory-queries");
  assert.deepEqual(normalizedQueries, queryState);
  assert.notEqual(normalizedQueries, queryState);
  assert.throws(() =>
    normalizeAgentMemoryQueryPersistedState({
      ...queryState,
      schemaVersion: 2,
    }),
  );
});

test("validation owner keys are exported from their owning modules", () => {
  assert.deepEqual(
    [
      CONFIRMATION_QUEUE_STATE_KEY,
      WORK_PROPOSAL_STATE_KEY,
      ATTENTION_INBOX_STATE_KEY,
      PR_ENGINEER_READ_FACTS_STATE_KEY,
      CHANGE_PACKAGE_APPLICATION_STATE_KEY,
      CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY,
      CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY,
    ],
    [
      "confirmation-queue",
      "work-proposal-state",
      "attention-inbox",
      "pr-engineer-read-facts",
      "change-package-applications",
      "change-package-controlled-commits",
      "change-package-application-projections",
    ],
  );
  assert.equal(
    configuredRoleLifecycleStateKey("developer"),
    "configured-role-developer-state",
  );
  assert.throws(() => configuredRoleLifecycleStateKey("../developer"));
  assert.throws(() => configuredRoleLifecycleStateKey("a".repeat(128)));
});

test("existing owner adapters migrate oldest empty states without mutation", () => {
  const currentConfiguration = emptyConfigurationState();
  const {
    schemaMigrations: _schemaMigrations,
    impactPolicy: _impactPolicy,
    ...legacyConfigurationContent
  } = currentConfiguration;
  const legacyConfiguration = {
    ...legacyConfigurationContent,
    schemaVersion: 1,
  };
  const configurationBefore = structuredClone(legacyConfiguration);
  const configuration = migrateConfigurationState(
    legacyConfiguration,
    normalizeConfigurationLimits(),
  );
  assert.equal(configuration.migratedFrom, 1);
  assert.equal(configuration.state.schemaVersion, 3);
  assert.deepEqual(configuration.state.schemaMigrations, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
  assert.deepEqual(legacyConfiguration, configurationBefore);

  const currentLedger = emptyWorkLedgerState();
  const legacyLedger = structuredClone(currentLedger);
  legacyLedger.schemaVersion = 1;
  delete legacyLedger.graphMemoryProjection;
  delete legacyLedger.proposalCursor;
  delete legacyLedger.proposalHighWatermark;
  const ledgerBefore = structuredClone(legacyLedger);
  assert.deepEqual(
    normalizeWorkLedgerPersistedState(legacyLedger),
    currentLedger,
  );
  assert.deepEqual(legacyLedger, ledgerBefore);

  for (const [normalize, empty] of [
    [normalizeConfirmationState, defaultConfirmationState],
    [normalizeAttentionState, defaultAttentionState],
    [normalizeOwnerWorkRequestState, emptyOwnerWorkRequestState],
  ]) {
    const value = empty();
    const normalized = normalize(value);
    assert.deepEqual(normalized, value);
    assert.notEqual(normalized, value);
  }
});

test("the production registry plans every fixed owner before deterministic writes", async (t) => {
  const currentConfiguration = emptyConfigurationState();
  const {
    schemaMigrations: _schemaMigrations,
    impactPolicy: _impactPolicy,
    ...legacyConfigurationContent
  } = currentConfiguration;
  const currentLedger = emptyWorkLedgerState();
  const legacyLedger = structuredClone(currentLedger);
  legacyLedger.schemaVersion = 1;
  delete legacyLedger.graphMemoryProjection;
  delete legacyLedger.proposalCursor;
  delete legacyLedger.proposalHighWatermark;
  const prFactContent = { schemaVersion: 1, revision: 0, records: [] };
  const unknownBytes = "{\n  \"schemaLess\": true,\n  \"keep\": \"exact bytes\"\n}\n";
  const fixture = await candidateDirectory(t, {
    "configuration-state.json": {
      ...legacyConfigurationContent,
      schemaVersion: 1,
    },
    "workflow-routing-state.json": {
      schemaVersion: 1,
      revision: 0,
      currentConfig: null,
      configHistory: [],
      events: [],
      assignments: [],
      audit: [],
      checkpoint: null,
      lastSnapshot: null,
    },
    "work-ledger-state.json": legacyLedger,
    "code-job-state.json": {
      schemaVersion: 1,
      revision: 0,
      nextJobSequence: 1,
      jobs: [],
    },
    "code-executor-state.json": {
      schemaVersion: 1,
      revision: 0,
      sessions: {},
    },
    "confirmation-queue.json": defaultConfirmationState(),
    "work-proposal-state.json": {
      schemaVersion: 1,
      revision: 0,
      nextResultSequence: 1,
      proposals: [],
      results: [],
    },
    "attention-inbox.json": defaultAttentionState(),
    "owner-work-requests-v1.json": emptyOwnerWorkRequestState(),
    "unified-memory-records.json": {
      schemaVersion: 1,
      revision: 0,
      records: [],
    },
    "authority-bound-memory-projection.json": {
      schemaVersion: 4,
      revision: 1,
      workLedgerRevision: 0,
      authorityStateDigest: createHash("sha256")
        .update("[]", "utf8")
        .digest("hex"),
      confirmationHighWatermark: 0,
      entries: [],
    },
    "agent-memory-queries.json": {
      schemaVersion: 1,
      revision: 0,
      entries: [],
    },
    "pr-engineer-read-facts.json": {
      ...prFactContent,
      contentDigest: createHash("sha256")
        .update(JSON.stringify(prFactContent), "utf8")
        .digest("hex"),
    },
    "change-package-applications.json": {
      schemaVersion: 1,
      revision: 0,
      applications: [],
    },
    "change-package-controlled-commits.json": {
      schemaVersion: 1,
      revision: 0,
      deliveries: [],
    },
    "change-package-application-projections.json": {
      schemaVersion: 1,
      revision: 0,
      sourceRevision: 0,
      sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
      entries: [],
    },
    "schema-less-cache.json": unknownBytes,
  });
  const registry = createProductionRestoreMigrationRegistry();

  await registry.migrate(fixture);

  assert.equal(
    (await readJson(fixture.directory, "configuration-state")).schemaVersion,
    3,
  );
  assert.deepEqual(
    await readJson(fixture.directory, "workflow-routing-state"),
    migrateWorkflowPersistedState({
      schemaVersion: 1,
      revision: 0,
      currentConfig: null,
      configHistory: [],
      events: [],
      assignments: [],
      audit: [],
      checkpoint: null,
      lastSnapshot: null,
    }),
  );
  assert.equal(
    (await readJson(fixture.directory, "work-ledger-state")).schemaVersion,
    11,
  );
  assert.equal(
    (await readJson(fixture.directory, "code-job-state")).schemaVersion,
    8,
  );
  assert.equal(
    (await readJson(fixture.directory, "code-executor-state")).schemaVersion,
    2,
  );
  const journal = await readJson(fixture.directory, "unified-memory-records");
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.revision, 1);
  assert.equal(journal.lifecycleAuthority.authorityProjection.revision, 1);
  assert.equal(
    (await readJson(fixture.directory, "unified-memory-index"))
      .journalRevision,
    journal.revision,
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "authority-bound-memory-projection.json"),
      "utf8",
    ),
    `${JSON.stringify({
      schemaVersion: 4,
      revision: 1,
      workLedgerRevision: 0,
      authorityStateDigest: createHash("sha256")
        .update("[]", "utf8")
        .digest("hex"),
      confirmationHighWatermark: 0,
      entries: [],
    }, null, 2)}\n`,
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "schema-less-cache.json"),
      "utf8",
    ),
    unknownBytes,
  );

  const names = (await readdir(fixture.directory)).sort();
  const firstPassBytes = new Map(
    await Promise.all(names.map(async (name) => [
      name,
      await readFile(path.join(fixture.directory, name), "utf8"),
    ])),
  );
  await registry.migrate(fixture);
  for (const [name, bytes] of firstPassBytes) {
    assert.equal(
      await readFile(path.join(fixture.directory, name), "utf8"),
      bytes,
    );
  }
});

test("configured-role validation follows only the candidate active configuration", async (t) => {
  const configurationState = await activeConfigurationState();
  const roleState = {
    schemaVersion: 1,
    revision: 0,
    paused: false,
    runCount: 0,
    lastRun: null,
    lastErrorCode: "",
  };
  const retiredBytes = "{ this retired role is intentionally unvalidated }\n";
  const fixture = await candidateDirectory(t, {
    "configuration-state.json": configurationState,
    "configured-role-developer-state.json": roleState,
    "configured-role-retired-state.json": retiredBytes,
  });

  await createProductionRestoreMigrationRegistry().migrate(fixture);

  assert.deepEqual(
    await readJson(fixture.directory, "configured-role-developer-state"),
    roleState,
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "configured-role-retired-state.json"),
      "utf8",
    ),
    retiredBytes,
  );
});

test("a future owner blocks every planned replacement before the first write", async (t) => {
  const currentConfiguration = emptyConfigurationState();
  const {
    schemaMigrations: _schemaMigrations,
    impactPolicy: _impactPolicy,
    ...legacyConfigurationContent
  } = currentConfiguration;
  const legacyConfiguration = {
    ...legacyConfigurationContent,
    schemaVersion: 1,
  };
  const fixture = await candidateDirectory(t, {
    "configuration-state.json": legacyConfiguration,
    "code-executor-state.json": {
      schemaVersion: 3,
      revision: 0,
      sessions: {},
    },
  });
  const configurationBytes = await readFile(
    path.join(fixture.directory, "configuration-state.json"),
    "utf8",
  );

  await assert.rejects(
    createProductionRestoreMigrationRegistry().migrate(fixture),
    (error) => error?.code === "RESTORE_SCHEMA_OWNER_FUTURE",
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "configuration-state.json"),
      "utf8",
    ),
    configurationBytes,
  );
});

test("a future derived memory index blocks journal migration before writes", async (t) => {
  const journal = {
    schemaVersion: 1,
    revision: 0,
    records: [],
  };
  const fixture = await candidateDirectory(t, {
    "unified-memory-records.json": journal,
    "unified-memory-index.json": {
      schemaVersion: 2,
      journalRevision: 0,
      recordIdsDigest: "0".repeat(64),
      associations: {},
    },
  });
  const journalBytes = await readFile(
    path.join(fixture.directory, "unified-memory-records.json"),
    "utf8",
  );

  await assert.rejects(
    createProductionRestoreMigrationRegistry().migrate(fixture),
    (error) =>
      error?.code === "RESTORE_SCHEMA_OWNER_FUTURE" &&
      error.ownerId === "unified-memory-index",
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "unified-memory-records.json"),
      "utf8",
    ),
    journalBytes,
  );
});

test("malformed archive-family names fail before candidate writes", async (t) => {
  const fixture = await candidateDirectory(t, {
    "code-job-tombstone-record-not-a-content-id.json": {
      schemaVersion: 2,
    },
  });

  await assert.rejects(
    createProductionRestoreMigrationRegistry().migrate(fixture),
    (error) => error?.code === "RESTORE_SCHEMA_OWNER_UNSAFE_KEY",
  );
});

test("immutable Code Job archive families validate byte-for-byte against live state", async (t) => {
  const archive = await createCodeJobArchiveFixture();
  const files = Object.fromEntries(
    [...archive].map(([key, value]) => [`${key}.json`, value]),
  );
  const fixture = await candidateDirectory(t, files);
  const before = new Map(
    await Promise.all((await readdir(fixture.directory)).map(async (name) => [
      name,
      await readFile(path.join(fixture.directory, name), "utf8"),
    ])),
  );

  await createProductionRestoreMigrationRegistry().migrate(fixture);

  for (const [name, bytes] of before) {
    assert.equal(
      await readFile(path.join(fixture.directory, name), "utf8"),
      bytes,
    );
  }

  const corrupted = structuredClone(files);
  const indexName = Object.keys(corrupted).find((name) =>
    name.startsWith("code-job-tombstone-index-")
  );
  corrupted[indexName].tombstoneDigest = "0".repeat(64);
  const invalidFixture = await candidateDirectory(t, corrupted);
  const stateBytes = await readFile(
    path.join(invalidFixture.directory, "code-job-state.json"),
    "utf8",
  );
  await assert.rejects(
    createProductionRestoreMigrationRegistry().migrate(invalidFixture),
    (error) => error?.code === "RESTORE_SCHEMA_ARCHIVE_INVALID",
  );
  assert.equal(
    await readFile(
      path.join(invalidFixture.directory, "code-job-state.json"),
      "utf8",
    ),
    stateBytes,
  );
});
