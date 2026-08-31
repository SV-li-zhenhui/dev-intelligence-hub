import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";

function memoryRecord() {
  return {
    schemaVersion: 1,
    source: { kind: "code-job", id: "code-job:job-1:source-digest" },
    occurredAt: "2026-08-02T01:02:03.000Z",
    roleId: "developer",
    repository: "acme/repo",
    eventType: "code-job.completed",
    title: "Code job completed",
    summary: "The code job completed safely.",
    content: "private runtime memory",
    evidence: ["test:passed"],
    tags: ["code-job"],
    sourceUrl: null,
    subjectNumber: null,
  };
}

function legacyPullRequestMemory() {
  return {
    ...memoryRecord(),
    source: { kind: "legacy-pr-memory", id: "pr-42:analysis-ready" },
    roleId: "pr-reviewer",
    eventType: "analysis_ready",
    title: "Legacy PR analysis",
    summary: "This old PR conclusion requires live ledger authority.",
    content: JSON.stringify({ headRefOid: "a".repeat(40) }),
    evidence: [],
    tags: ["legacy", "pr-reviewer", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  };
}

function store() {
  const values = new Map();
  return {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
}

function guard(events, { acquireError = null } = {}) {
  return {
    async acquire() {
      events.push("acquire");
      if (acquireError) throw acquireError;
    },
    async run(operation) {
      events.push("run");
      return operation();
    },
    async close() {
      events.push("close");
    },
  };
}

test("memory runtime exposes least-authority frozen ports and closes once", async () => {
  const events = [];
  const runtime = await createMemoryRuntime({
    store: store(),
    createGuard: () => guard(events),
  });

  assert.deepEqual(Object.keys(runtime.producer).sort(), ["append", "appendBatch"]);
  assert.deepEqual(Object.keys(runtime.lifecycleProducer).sort(), [
    "adoptGraphCheckpoint",
    "appendAuthorityProjection",
    "appendGraphEvents",
    "appendProjectionRecords",
    "appendWorkItems",
  ]);
  assert.deepEqual(Object.keys(runtime.authorityReader).sort(), [
    "getAuthorityProjectionState",
    "getAuthorityState",
    "requiresAuthorityProjectionCheckpoint",
  ]);
  assert.deepEqual(Object.keys(runtime.search).sort(), ["getHealth", "search"]);
  assert.deepEqual(Object.keys(runtime.contextReader), ["readRecords"]);
  assert.deepEqual(Object.keys(runtime.receiptVerifier), ["verify"]);
  assert.deepEqual(Object.keys(runtime.maintenance), ["rebuildIndex"]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.producer), true);
  assert.equal(Object.isFrozen(runtime.lifecycleProducer), true);
  assert.equal(Object.isFrozen(runtime.authorityReader), true);
  assert.equal(Object.isFrozen(runtime.contextReader), true);
  assert.equal(Object.isFrozen(runtime.receiptVerifier), true);
  assert.equal("journal" in runtime, false);

  const value = memoryRecord();
  const expected = normalizeMemoryRecord(value);
  await runtime.producer.append(value);
  assert.equal((await runtime.search.search({ q: "completed" })).items.length, 1);
  const context = await runtime.contextReader.readRecords({
    recordIds: [expected.recordId],
  });
  assert.equal(context.journalRevision, 1);
  assert.deepEqual(context.items, [
    {
      record: structuredClone(expected),
      labels: { authority: "raw", lifecycle: "current" },
    },
  ]);
  assert.deepEqual(
    await runtime.receiptVerifier.verify({
      recordId: expected.recordId,
      contentDigest: expected.contentDigest,
      source: expected.source,
    }),
    {
      recordId: expected.recordId,
      contentDigest: expected.contentDigest,
      source: expected.source,
      persisted: true,
    },
  );
  assert.equal("append" in runtime.receiptVerifier, false);
  assert.equal("search" in runtime.receiptVerifier, false);
  assert.equal("append" in runtime.contextReader, false);
  assert.equal("search" in runtime.contextReader, false);
  assert.equal("verify" in runtime.contextReader, false);
  assert.equal("rebuildIndex" in runtime.contextReader, false);
  const first = runtime.close();
  assert.strictEqual(runtime.close(), first);
  await first;
  assert.deepEqual(events.filter((event) => event === "close"), ["close"]);
});

test("standalone memory stays available after dropping non-citable legacy PR history", async () => {
  const events = [];
  const persistedStore = store();
  const writer = await createMemoryRuntime({
    store: persistedStore,
    createGuard: () => guard(events),
  });
  const legacy = normalizeMemoryRecord(legacyPullRequestMemory());
  await writer.lifecycleProducer.appendProjectionRecords({
    records: [legacyPullRequestMemory()],
  });
  await writer.close();

  const restarted = await createMemoryRuntime({
    store: persistedStore,
    createGuard: () => guard(events),
  });
  assert.deepEqual((await restarted.search.search({ q: "Legacy PR" })).items, []);
  assert.equal((await restarted.search.getHealth()).ready, true);
  await assert.rejects(
    restarted.contextReader.readRecords({ recordIds: [legacy.recordId] }),
    (error) =>
      error.code === "MEMORY_RECORD_NOT_FOUND" && error.statusCode === 404,
  );
  await restarted.close();
});

test("standalone memory keeps ordinary session and git records available after restart", async () => {
  const events = [];
  const persistedStore = store();
  const writer = await createMemoryRuntime({
    store: persistedStore,
    createGuard: () => guard(events),
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      writer.producer.append(legacyPullRequestMemory())
    ),
    (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
  );
  const safeRecords = [
    {
      ...memoryRecord(),
      source: { kind: "local-session", id: "session-1:chunk-1" },
      eventType: "session.observation",
      title: "Local session note",
      tags: ["session"],
    },
    {
      ...memoryRecord(),
      source: { kind: "git-commit", id: "acme/repo:commit:abc123" },
      occurredAt: "2026-08-02T01:03:03.000Z",
      eventType: "git.commit",
      title: "Local git note",
      tags: ["git"],
    },
  ];
  const prShapedRecords = [
    {
      ...memoryRecord(),
      source: { kind: "local-session", id: "session-pr-event:chunk-1" },
      occurredAt: "2026-08-02T01:04:03.000Z",
      eventType: "pull_request.updated",
      title: "PR shaped event metadata",
      tags: ["session"],
    },
    {
      ...memoryRecord(),
      source: { kind: "local-session", id: "session-pr-url:chunk-1" },
      occurredAt: "2026-08-02T01:05:03.000Z",
      eventType: "session.observation",
      title: "PR shaped URL metadata",
      tags: ["session"],
      sourceUrl: "https://github.com/acme/repo/pull/42",
      subjectNumber: 42,
    },
    {
      ...memoryRecord(),
      source: { kind: "git-commit", id: "acme/repo:commit:pr-content" },
      occurredAt: "2026-08-02T01:06:03.000Z",
      eventType: "git.commit",
      title: "PR shaped content metadata",
      content: JSON.stringify({ eventType: "pull_request.updated" }),
      tags: ["git"],
    },
  ];
  await writer.producer.appendBatch({
    records: [...safeRecords, ...prShapedRecords],
  });
  await writer.close();

  const restarted = await createMemoryRuntime({
    store: persistedStore,
    createGuard: () => guard(events),
  });
  const result = await restarted.search.search({ repository: "acme/repo" });
  assert.equal(result.items.length, 5);
  const context = await restarted.contextReader.readRecords({
    recordIds: [
      ...safeRecords,
      ...prShapedRecords,
    ].map((record) => normalizeMemoryRecord(record).recordId),
  });
  assert.deepEqual(
    context.items.map(({ labels }) => labels.lifecycle),
    ["current", "current", "obsolete", "obsolete", "obsolete"],
  );
  const packet = await new MemoryContextRetriever({
    memorySearch: { search: restarted.search.search },
    contextReader: restarted.contextReader,
  }).retrieve({
    question: "Can PR-shaped ordinary memory be cited?",
    retrieval: {
      kind: "query",
      filters: { query: "PR shaped", repository: "acme/repo" },
    },
  });
  assert.equal(packet.records.length, 3);
  assert.deepEqual(packet.citableRecordIds, []);
  assert.equal((await restarted.search.getHealth()).authorityCurrent, true);
  await restarted.close();
});

test("memory runtime checks the live ledger revision and graph HWM on every read", async () => {
  const events = [];
  let reads = 0;
  let status;
  const runtime = await createMemoryRuntime({
    store: store(),
    createGuard: () => guard(events),
    authoritySource: {
      async readStatus() {
        reads += 1;
        return structuredClone(status);
      },
    },
  });
  const local = runtime.authorityReader.getAuthorityState();
  status = {
    ledgerRevision: 0,
    graph: {
      cursor: 0,
      highWatermark: 0,
      checkpointDigest: null,
      highWatermarkDigest: null,
      authorityStateDigest: local.authorityStateDigest,
    },
  };
  const persisted = normalizeMemoryRecord(memoryRecord());
  await runtime.producer.append(memoryRecord());
  assert.equal((await runtime.search.search({ q: "completed" })).items.length, 1);
  assert.equal(
    (await runtime.contextReader.readRecords({
      recordIds: [persisted.recordId],
    })).items.length,
    1,
  );

  status.ledgerRevision = 1;
  for (const operation of [
    () => runtime.search.search({}),
    () => runtime.search.getHealth(),
    () => runtime.contextReader.readRecords({ recordIds: [persisted.recordId] }),
  ]) {
    await assert.rejects(
      operation,
      (error) =>
        error.code === "MEMORY_AUTHORITY_NOT_CURRENT" &&
        error.statusCode === 503,
    );
  }
  await runtime.lifecycleProducer.appendWorkItems({
    records: [],
    ledgerRevision: 1,
    authorityStateDigest: local.authorityStateDigest,
  });
  await assert.rejects(
    runtime.search.search({}),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  await runtime.lifecycleProducer.appendAuthorityProjection({
    records: [],
    projectionState: {
      schemaVersion: 4,
      revision: 1,
      workLedgerRevision: 1,
      authorityStateDigest: local.authorityStateDigest,
      confirmationHighWatermark: 0,
      entries: [],
    },
  });
  assert.equal((await runtime.search.search({})).items.length, 1);

  status.graph.highWatermark = 1;
  status.graph.highWatermarkDigest = "a".repeat(64);
  await assert.rejects(
    runtime.search.search({}),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  assert.equal(reads, 8);
  await runtime.close();
});

test("memory runtime fails closed until the confirmation projection reaches its live HWM", async () => {
  const events = [];
  let highWatermark = 0;
  const runtime = await createMemoryRuntime({
    store: store(),
    createGuard: () => guard(events),
    confirmationAuthoritySource: {
      async readStatus() {
        return { highWatermark };
      },
    },
  });

  assert.equal((await runtime.search.search({})).items.length, 0);
  highWatermark = 1;
  await assert.rejects(
    runtime.search.search({}),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  await runtime.lifecycleProducer.appendAuthorityProjection({
    records: [],
    projectionState: {
      schemaVersion: 4,
      revision: 1,
      workLedgerRevision: 0,
      authorityStateDigest:
        runtime.authorityReader.getAuthorityState().authorityStateDigest,
      confirmationHighWatermark: 1,
      entries: [],
    },
  });
  assert.equal((await runtime.search.search({})).items.length, 0);
  assert.equal(
    (await runtime.search.getHealth()).confirmationMemoryHighWatermark,
    1,
  );
  await runtime.close();
});

test("memory runtime closes its guard while preserving startup failure", async () => {
  const events = [];
  const failure = new Error("guard unavailable");
  await assert.rejects(
    createMemoryRuntime({
      store: store(),
      createGuard: () => guard(events, { acquireError: failure }),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["acquire", "close"]);
});
