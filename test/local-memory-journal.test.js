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

function memoryStore({ failIndexWrites = false } = {}) {
  const values = new Map();
  return {
    values,
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      if (failIndexWrites && key === MEMORY_INDEX_KEY) {
        throw new Error("index disk unavailable");
      }
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

test("query and batch boundaries reject unknown fields and sparse arrays", async () => {
  const { journal } = await fixture();
  assert.throws(() => journal.search({ debug: true }), /字段无效/);
  const records = new Array(1);
  assert.throws(() => journal.appendBatch({ records }), /records 无效/);
  assert.throws(() => journal.search({ cursor: "not-a-cursor" }), /cursor 无效/);
});
