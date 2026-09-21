import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMemoryRecord, projectMemoryRecord } from "../src/domain/memory-record.js";
import {
  MemoryContextRetriever,
  MemoryContextRetrieverError,
} from "../src/services/memory-context-retriever.js";

function rawRecord(index, overrides = {}) {
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "code-job", id: `job-${index}` },
    occurredAt: `2026-08-03T01:02:${String(index).padStart(2, "0")}.000Z`,
    roleId: "developer",
    repository: "acme/repo",
    eventType: "code-job.completed",
    title: `代码任务 ${index}`,
    summary: "完成本地测试",
    content: "测试通过",
    evidence: ["test:passed"],
    tags: ["code-job"],
    sourceUrl: null,
    subjectNumber: null,
    ...overrides,
  });
}

function fixture(records, labelById = new Map()) {
  const calls = { search: [], readRecords: [] };
  return {
    calls,
    retriever: new MemoryContextRetriever({
      memorySearch: {
        async search(options) {
          calls.search.push(structuredClone(options));
          return {
            items: records.map(projectMemoryRecord),
            nextCursor: null,
            totalMatched: records.length,
            indexHealthy: true,
          };
        },
      },
      contextReader: {
        async readRecords({ recordIds }) {
          calls.readRecords.push([...recordIds]);
          return {
            journalRevision: 9,
            items: recordIds.map((recordId) => ({
              record: structuredClone(records.find((record) => record.recordId === recordId)),
              labels: structuredClone(
                labelById.get(recordId) || {
                  authority: "raw",
                  lifecycle: "current",
                },
              ),
            })),
          };
        },
      },
    }),
  };
}

function query(question = "测试为什么失败？") {
  return {
    question,
    retrieval: {
      kind: "query",
      filters: { query: "测试失败", repository: "acme/repo" },
    },
  };
}

test("retrieval hydrates exact local records into a digest-bound cited packet", async () => {
  const records = [rawRecord(2), rawRecord(1)];
  const { retriever, calls } = fixture(records);

  const packet = await retriever.retrieve(query());

  assert.deepEqual(calls.search, [{
    q: "测试失败",
    roleId: "",
    repository: "acme/repo",
    eventType: "",
    from: "",
    to: "",
    limit: 12,
  }]);
  assert.deepEqual(calls.readRecords, [records.map(({ recordId }) => recordId)]);
  assert.deepEqual(packet.recordIds, records.map(({ recordId }) => recordId));
  assert.deepEqual(packet.citableRecordIds, packet.recordIds);
  assert.deepEqual(packet.dataClasses, ["requirements", "code", "memory"]);
  assert.equal(packet.records[0].content, "测试通过");
  assert.equal(packet.records[0].contentDigest, records[0].contentDigest);
  assert.match(packet.contextDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(packet.records[0].labels), true);
});

test("an exact local rerun rehydrates bound IDs without repeating lexical search", async () => {
  const records = [rawRecord(1)];
  const setup = fixture(records);
  const first = await setup.retriever.retrieve(query());

  const replay = await setup.retriever.retrieve({
    question: first.question,
    retrieval: {
      kind: "context",
      contextDigest: first.contextDigest,
      recordIds: first.recordIds,
    },
  });

  assert.equal(setup.calls.search.length, 1);
  assert.equal(setup.calls.readRecords.length, 2);
  assert.equal(replay.contextDigest, first.contextDigest);
  assert.deepEqual(replay.records, first.records);
  assert.equal(replay.retrievalKind, "context");
});

test("changed trusted labels make a prior context binding stale", async () => {
  const records = [rawRecord(1)];
  const labels = new Map();
  const setup = fixture(records, labels);
  const first = await setup.retriever.retrieve(query());
  labels.set(records[0].recordId, { authority: "raw", lifecycle: "obsolete" });

  await assert.rejects(
    setup.retriever.retrieve({
      question: first.question,
      retrieval: {
        kind: "context",
        contextDigest: first.contextDigest,
        recordIds: first.recordIds,
      },
    }),
    (error) =>
      error instanceof MemoryContextRetrieverError &&
      error.code === "MEMORY_CONTEXT_BINDING_STALE" &&
      error.statusCode === 409,
  );
});

test("only current raw records are citable and ambiguous sessions require every data class", async () => {
  const raw = rawRecord(1, {
    source: { kind: "local-session", id: "codex:session-1:chunk:1" },
    eventType: "session.imported",
    tags: ["session", "untrusted"],
  });
  const derived = rawRecord(2, { tags: ["derived"] });
  const obsolete = rawRecord(3, { tags: ["obsolete"] });
  const setup = fixture([raw, derived, obsolete], new Map([
    [derived.recordId, { authority: "derived", lifecycle: "current" }],
    [obsolete.recordId, { authority: "raw", lifecycle: "obsolete" }],
  ]));

  const packet = await setup.retriever.retrieve(query());

  assert.deepEqual(packet.dataClasses, ["requirements", "code", "memory"]);
  assert.deepEqual(packet.citableRecordIds, [raw.recordId]);
});

test("free-form questions and records require every remote data class", async () => {
  const plainRequirement = rawRecord(1, {
    source: { kind: "issue", id: "issue-1" },
    eventType: "issue.specification",
    title: "结算需求说明",
    summary: "确认业务规则和验收条件",
    content: "用户确认后才能进入下一步。",
    evidence: ["requirement:approved"],
    tags: ["requirements"],
  });
  const codeRequirement = rawRecord(2, {
    source: { kind: "issue", id: "issue-2" },
    eventType: "issue.specification",
    title: "接口验收要求",
    summary: "验收规则包含实现示例",
    content: "```js\nexport function approve(item) { return item.ready; }\n```",
    evidence: ["acceptance:pending"],
    tags: ["requirements"],
  });

  const plainPacket = await fixture([plainRequirement]).retriever.retrieve(query());
  const mixedPacket = await fixture([codeRequirement]).retriever.retrieve(query());

  assert.deepEqual(plainPacket.dataClasses, ["requirements", "code", "memory"]);
  assert.deepEqual(mixedPacket.dataClasses, ["requirements", "code", "memory"]);
});

test("context packing keeps whole authoritative records and truncates only the ordered suffix", async () => {
  const records = [1, 2, 3, 4].map((index) =>
    rawRecord(index, { content: String(index).repeat(30 * 1024) }));
  const calls = { read: 0 };
  const retriever = new MemoryContextRetriever({
    maximumContextBytes: 96 * 1024,
    memorySearch: {
      async search() {
        return {
          items: records.map(projectMemoryRecord),
          nextCursor: "more",
          totalMatched: 5,
          indexHealthy: false,
        };
      },
    },
    contextReader: {
      async readRecords({ recordIds }) {
        calls.read += 1;
        return {
          journalRevision: 3,
          items: recordIds.map((recordId) => ({
            record: structuredClone(records.find((record) => record.recordId === recordId)),
            labels: { authority: "raw", lifecycle: "current" },
          })),
        };
      },
    },
  });

  const packet = await retriever.retrieve(query("解释这些测试记录"));

  assert.equal(calls.read, 1);
  assert.ok(packet.records.length >= 1 && packet.records.length < records.length);
  assert.equal(packet.records[0].content.length, 30 * 1024);
  assert.equal(packet.truncated, true);
  assert.equal(packet.indexHealthy, false);
});

test("hostile ports and malformed hydrated records fail without invoking accessors", async () => {
  let getterCalls = 0;
  const accessorPort = {};
  Object.defineProperty(accessorPort, "search", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => {};
    },
  });
  assert.throws(
    () => new MemoryContextRetriever({
      memorySearch: accessorPort,
      contextReader: { async readRecords() {} },
    }),
    /memorySearch/,
  );
  assert.equal(getterCalls, 0);

  const record = rawRecord(1);
  const retriever = new MemoryContextRetriever({
    memorySearch: {
      async search() {
        return {
          items: [projectMemoryRecord(record)],
          nextCursor: null,
          totalMatched: 1,
          indexHealthy: true,
        };
      },
    },
    contextReader: {
      async readRecords() {
        const hostileRecord = structuredClone(record);
        hostileRecord.contentDigest = "0".repeat(64);
        return {
          journalRevision: 1,
          items: [{
            record: hostileRecord,
            labels: { authority: "raw", lifecycle: "current" },
          }],
        };
      },
    },
  });
  await assert.rejects(
    retriever.retrieve(query()),
    (error) => error.code === "MEMORY_CONTEXT_READ_INVALID",
  );
});
