import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalMemoryJournal,
  MEMORY_INDEX_KEY,
  MEMORY_JOURNAL_KEY,
} from "../src/services/local-memory-journal.js";

function record(index, overrides = {}) {
  return {
    schemaVersion: 1,
    source: { kind: "work-ledger", id: `work-${index}:event` },
    occurredAt: `2026-08-02T01:02:${String(index).padStart(2, "0")}.000Z`,
    roleId: index % 2 ? "requirements-analyst" : "developer",
    repository: index === 3 ? "other/repo" : "acme/repo",
    eventType: index % 2 ? "requirements.clarified" : "work.completed",
    title: index === 1 ? "梳理结算失败路径" : `工作记录 ${index}`,
    summary: index === 2 ? "修复失败路径并完成验证" : "本地员工工作结论",
    content: "所有原始记录和索引均保存在本机。",
    evidence: [`evidence-${index}`],
    tags: [index % 2 ? "requirements" : "development"],
    sourceUrl: null,
    subjectNumber: null,
    ...overrides,
  };
}

function batchRecords(count) {
  return Array.from({ length: count }, (_, index) =>
    record(index + 1, {
      source: { kind: "local-session", id: `session:chunk:${index + 1}` },
      occurredAt: "2026-08-02T01:02:00.000Z",
      title: `会话分片 ${index + 1}`,
    })
  );
}

function memoryStore({ failIndexWrites = false } = {}) {
  const values = new Map();
  const reads = [];
  const writes = [];
  return {
    values,
    reads,
    writes,
    async read(key, fallback = null) {
      reads.push(key);
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      if (failIndexWrites && key === MEMORY_INDEX_KEY) {
        throw new Error("index disk unavailable");
      }
      writes.push(key);
      values.set(key, structuredClone(value));
    },
  };
}

const lease = { async run(operation) { return operation(); } };

async function fixture(options = {}) {
  const store = options.store || memoryStore();
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: lease,
    ...(options.maximumRecords ? { maximumRecords: options.maximumRecords } : {}),
  });
  await journal.recover();
  return { store, journal };
}

test("journal append is durable, content-idempotent, and persists a separate index", async () => {
  const { store, journal } = await fixture();
  const first = await journal.append(record(1));
  const duplicate = await journal.append(record(1));
  const batch = await journal.appendBatch({ records: [record(2), record(3)] });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(batch.added, 2);
  assert.equal(journal.getHealth().recordCount, 3);
  assert.equal(store.values.get(MEMORY_JOURNAL_KEY).records.length, 3);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).journalRevision, 2);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).complete, true);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).entries["失败"].length, 2);
});

test("local search supports Chinese keywords, filters, newest order, and stable cursors", async () => {
  const { journal } = await fixture();
  await journal.appendBatch({ records: [record(1), record(2), record(3)] });

  const chinese = journal.search({ q: "失败路径", repository: "acme/repo" });
  assert.deepEqual(chinese.items.map(({ title }) => title), [
    "工作记录 2",
    "梳理结算失败路径",
  ]);
  const filtered = journal.search({
    roleId: "requirements-analyst",
    eventType: "requirements.clarified",
  });
  assert.deepEqual(filtered.items.map(({ title }) => title), [
    "工作记录 3",
    "梳理结算失败路径",
  ]);
  const firstPage = journal.search({ limit: 2 });
  const secondPage = journal.search({ limit: 2, cursor: firstPage.nextCursor });
  assert.deepEqual(firstPage.items.map(({ title }) => title), [
    "工作记录 3",
    "工作记录 2",
  ]);
  assert.deepEqual(secondPage.items.map(({ title }) => title), [
    "梳理结算失败路径",
  ]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(firstPage.totalMatched, 3);
  assert.equal(secondPage.totalMatched, 3);
});

test("authoritative context reads preserve order and derive trusted labels without writes", async () => {
  const { store, journal } = await fixture();
  const raw = await journal.append(record(1, {
    content: "raw record that merely mentions derived",
    evidence: ["derived"],
    tags: ["requirements"],
  }));
  const derived = await journal.append(record(2, {
    content: "derived conclusion",
    evidence: [`supersedes:${raw.recordId}`],
    tags: ["derived"],
  }));
  const explicitlyObsolete = await journal.append(record(3, {
    evidence: [`note:supersedes:${derived.recordId}`],
    tags: ["obsolete"],
  }));
  const readsBefore = store.reads.length;
  const writesBefore = store.writes.length;

  const result = journal.readRecords({
    recordIds: [derived.recordId, raw.recordId, explicitlyObsolete.recordId],
  });

  assert.equal(result.journalRevision, 3);
  assert.deepEqual(
    result.items.map(({ record: value }) => value.recordId),
    [derived.recordId, raw.recordId, explicitlyObsolete.recordId],
  );
  assert.deepEqual(result.items.map(({ labels }) => labels), [
    { authority: "derived", lifecycle: "current" },
    { authority: "raw", lifecycle: "obsolete" },
    { authority: "raw", lifecycle: "obsolete" },
  ]);
  assert.equal(result.items[0].record.content, "derived conclusion");
  assert.equal(
    result.items[0].record.contentDigest,
    derived.recordId.slice("memory-".length),
  );
  assert.equal(store.reads.length, readsBefore);
  assert.equal(store.writes.length, writesBefore);

  result.items[0].record.content = "changed by caller";
  result.items[0].record.source.id = "changed-source";
  result.items[0].labels.lifecycle = "obsolete";
  const repeated = journal.readRecords({ recordIds: [derived.recordId] });
  assert.equal(repeated.items[0].record.content, "derived conclusion");
  assert.equal(repeated.items[0].record.source.id, record(2).source.id);
  assert.deepEqual(repeated.items[0].labels, {
    authority: "derived",
    lifecycle: "current",
  });
});

test("a corrected raw fact supersedes a derived summary without deleting history", async () => {
  const { journal } = await fixture();
  const derived = await journal.append(record(1, {
    summary: "模型推断测试已经通过",
    tags: ["derived"],
  }));
  const correction = await journal.append(record(2, {
    summary: "原始测试记录显示失败",
    evidence: [`supersedes:${derived.recordId}`, "test:failed"],
    tags: ["testing"],
  }));

  const result = journal.readRecords({
    recordIds: [derived.recordId, correction.recordId],
  });

  assert.equal(journal.getHealth().recordCount, 2);
  assert.deepEqual(result.items.map(({ labels }) => labels), [
    { authority: "derived", lifecycle: "obsolete" },
    { authority: "raw", lifecycle: "current" },
  ]);
  assert.equal(result.items[0].record.summary, "模型推断测试已经通过");
  assert.equal(result.items[1].record.summary, "原始测试记录显示失败");
});

test("authoritative context reads reject malformed, missing, and accessor-backed ids", async () => {
  const { store, journal } = await fixture();
  const persisted = await journal.append(record(1, {
    content: "private authoritative memory",
  }));
  const writesBefore = store.writes.length;
  const missingId = `memory-${"0".repeat(64)}`;

  for (const input of [
    {},
    { recordIds: [] },
    { recordIds: [persisted.recordId, persisted.recordId] },
    { recordIds: ["memory-invalid"] },
    { recordIds: new Array(1) },
    { recordIds: Array.from({ length: 21 }, (_, index) =>
      `memory-${index.toString(16).padStart(64, "0")}`) },
    { recordIds: [persisted.recordId], debug: true },
  ]) {
    assert.throws(
      () => journal.readRecords(input),
      (error) =>
        error.code === "MEMORY_INPUT_INVALID" &&
        !error.message.includes("private authoritative memory"),
    );
  }

  let objectGetterCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "recordIds", {
    enumerable: true,
    get() {
      objectGetterCalls += 1;
      return [persisted.recordId];
    },
  });
  assert.throws(() => journal.readRecords(accessorInput), /memory record query/i);
  assert.equal(objectGetterCalls, 0);

  let arrayGetterCalls = 0;
  const accessorIds = [persisted.recordId];
  Object.defineProperty(accessorIds, "0", {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return persisted.recordId;
    },
  });
  assert.throws(
    () => journal.readRecords({ recordIds: accessorIds }),
    /recordIds/i,
  );
  assert.equal(arrayGetterCalls, 0);

  assert.throws(
    () => journal.readRecords({ recordIds: [missingId] }),
    (error) =>
      error.code === "MEMORY_RECORD_NOT_FOUND" &&
      error.statusCode === 404 &&
      !error.message.includes(missingId) &&
      !error.message.includes("private authoritative memory"),
  );
  assert.equal(store.writes.length, writesBefore);
});

test("receipt verification is exact, read-only, and never exposes memory content", async () => {
  const { store, journal } = await fixture();
  await journal.append(record(1, { content: "private-memory-content" }));
  const stored = store.values.get(MEMORY_JOURNAL_KEY).records[0];
  const request = {
    recordId: stored.recordId,
    contentDigest: stored.contentDigest,
    source: structuredClone(stored.source),
  };
  const readsBefore = store.reads.length;
  const writesBefore = store.writes.length;

  const verified = journal.verifyReceipt(request);

  assert.deepEqual(verified, { ...request, persisted: true });
  assert.deepEqual(Object.keys(verified), [
    "recordId",
    "contentDigest",
    "source",
    "persisted",
  ]);
  assert.equal("content" in verified, false);
  assert.equal("title" in verified, false);
  assert.notStrictEqual(verified.source, stored.source);
  assert.equal(store.reads.length, readsBefore);
  assert.equal(store.writes.length, writesBefore);

  verified.source.id = "changed-by-caller";
  assert.deepEqual(journal.verifyReceipt(request), { ...request, persisted: true });
});

test("receipt verification fails uniformly for malformed, missing, or mismatched bindings", async () => {
  const { journal } = await fixture();
  await journal.append(record(1, { content: "private-memory-content" }));
  const [stored] = journal.search({}).items;
  const persisted = record(1).source;
  const valid = {
    recordId: stored.id,
    contentDigest: stored.id.slice("memory-".length),
    source: persisted,
  };
  const failures = [
    { ...valid, recordId: `memory-${"0".repeat(64)}`, contentDigest: "0".repeat(64) },
    { ...valid, contentDigest: "0".repeat(64) },
    { ...valid, source: { ...valid.source, id: "another-source" } },
    { ...valid, debug: true },
    { recordId: valid.recordId, contentDigest: valid.contentDigest },
    { ...valid, source: { ...valid.source, debug: true } },
  ];
  const fingerprints = failures.map((candidate) => {
    let error;
    try {
      journal.verifyReceipt(candidate);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes("private-memory-content"), false);
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };
  });

  assert.deepEqual(
    fingerprints,
    failures.map(() => ({
      code: "MEMORY_RECEIPT_UNVERIFIED",
      message: "无法验证持久记忆凭据",
      statusCode: 409,
    })),
  );
});

test("an index write outage never rolls back raw memory and search stays local", async () => {
  const store = memoryStore({ failIndexWrites: true });
  const { journal } = await fixture({ store });
  const receipt = await journal.append(record(1));

  assert.equal(receipt.created, true);
  assert.equal(journal.getHealth().indexHealthy, false);
  assert.equal(store.values.get(MEMORY_JOURNAL_KEY).records.length, 1);
  assert.equal(journal.search({ q: "失败路径" }).items.length, 1);

  const recoveredStore = memoryStore();
  recoveredStore.values.set(
    MEMORY_JOURNAL_KEY,
    structuredClone(store.values.get(MEMORY_JOURNAL_KEY)),
  );
  const recovered = new LocalMemoryJournal({
    store: recoveredStore,
    exclusiveLease: lease,
  });
  await recovered.recover();
  assert.equal(recovered.getHealth().indexHealthy, true);
  assert.equal(recovered.search({ q: "失败路径" }).items.length, 1);
  assert.ok(recoveredStore.values.has(MEMORY_INDEX_KEY));
});

test("a missing or stale index is rebuilt without changing raw records", async () => {
  const { store, journal } = await fixture();
  await journal.append(record(1));
  const rawBefore = structuredClone(store.values.get(MEMORY_JOURNAL_KEY));
  store.values.set(MEMORY_INDEX_KEY, {
    schemaVersion: 1,
    journalRevision: 0,
    journalDigest: "0".repeat(64),
    complete: true,
    entries: {},
  });
  const recovered = new LocalMemoryJournal({ store, exclusiveLease: lease });
  await recovered.recover();

  assert.deepEqual(store.values.get(MEMORY_JOURNAL_KEY), rawBefore);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).journalRevision, 1);
  assert.equal(recovered.search({ q: "结算" }).items.length, 1);
});

test("an intentionally bounded index falls back to a complete local scan", async () => {
  const { store, journal } = await fixture();
  const terms = Array.from({ length: 4_200 }, (_, index) => `t${index}`).join(" ");
  await journal.append(record(1, { content: terms }));

  assert.equal(store.values.get(MEMORY_INDEX_KEY).complete, false);
  assert.equal(journal.search({ q: "t4199" }).items.length, 1);
});

test("capacity is fail-closed and malformed journal state refuses recovery", async () => {
  const { journal } = await fixture({ maximumRecords: 1 });
  await journal.append(record(1));
  await assert.rejects(
    journal.append(record(2)),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED" && error.statusCode === 507,
  );

  const store = memoryStore();
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [{ ...record(1), recordId: "memory-wrong", contentDigest: "0".repeat(64) }],
  });
  const corrupted = new LocalMemoryJournal({ store, exclusiveLease: lease });
  await assert.rejects(corrupted.recover(), /摘要不一致/);
});

test("one atomic journal append accepts 160 records and rejects larger or over-capacity batches", async () => {
  const { store, journal } = await fixture({ maximumRecords: 200 });
  const writesBefore = store.writes.filter((key) => key === MEMORY_JOURNAL_KEY).length;

  const appended = await journal.appendBatch({ records: batchRecords(160) });

  assert.equal(appended.added, 160);
  assert.deepEqual(journal.getHealth(), {
    ready: true,
    revision: 1,
    recordCount: 160,
    indexHealthy: true,
    lastIndexError: "",
  });
  assert.equal(
    store.writes.filter((key) => key === MEMORY_JOURNAL_KEY).length,
    writesBefore + 1,
  );
  assert.throws(
    () => journal.appendBatch({ records: batchRecords(161) }),
    /records 无效/,
  );
  assert.equal(journal.getHealth().revision, 1);

  const constrained = await fixture({ maximumRecords: 159 });
  const constrainedRawBefore = structuredClone(
    constrained.store.values.get(MEMORY_JOURNAL_KEY) ?? null,
  );
  await assert.rejects(
    constrained.journal.appendBatch({ records: batchRecords(160) }),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED",
  );
  assert.equal(constrained.journal.getHealth().revision, 0);
  assert.equal(constrained.journal.getHealth().recordCount, 0);
  assert.deepEqual(
    constrained.store.values.get(MEMORY_JOURNAL_KEY) ?? null,
    constrainedRawBefore,
  );
});

test("query and batch boundaries reject unknown fields and sparse arrays", async () => {
  const { journal } = await fixture();
  assert.throws(() => journal.search({ debug: true }), /字段无效/);
  const records = new Array(1);
  assert.throws(() => journal.appendBatch({ records }), /records 无效/);
  assert.throws(() => journal.search({ cursor: "not-a-cursor" }), /cursor 无效/);
});
