import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BrainRouter } from "../src/services/brain-router.js";
import { MemoryAnswerService } from "../src/services/memory-answer-service.js";
import {
  AgentMemoryQueryService,
  AgentMemoryQueryServiceError,
} from "../src/services/agent-memory-query-service.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";

const INPUT_DIGEST = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function clock() {
  let milliseconds = Date.parse("2026-08-08T01:00:00.000Z");
  return () => new Date(milliseconds++).toISOString();
}

function item(roleId = "developer", revision = 2, inputDigest = INPUT_DIGEST) {
  return {
    itemId: "work-item-memory-query",
    revision,
    inputDigest,
    currentTarget: { type: "role", id: roleId },
  };
}

function contextItem(
  roleId = "developer",
  revision = 2,
  inputDigest = INPUT_DIGEST,
) {
  return {
    itemId: "work-item-memory-query",
    itemRevision: revision,
    inputDigest,
    currentTarget: { type: "role", id: roleId },
  };
}

function intent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "query_memory",
    summary: "需要检索历史修复证据",
    reason: "当前任务需要引用可复现的旧结论",
    question: "上次同类回归是如何修复的？",
    searchQuery: "同类 回归 修复",
    mode: "local",
    ...overrides,
  };
}

function sourceRecord() {
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "test-result", id: "test-result-1" },
    occurredAt: "2026-08-07T08:00:00.000Z",
    roleId: "tester",
    repository: "acme/repo",
    eventType: "test.completed",
    title: "旧回归测试",
    summary: "旧回归通过了空值分支验证。",
    content: "null branch regression passed after the guard was restored",
    evidence: ["test:null-branch"],
    tags: ["test", "regression"],
    sourceUrl: null,
    subjectNumber: null,
  });
}

function rawRecord(record) {
  const { recordId: _recordId, contentDigest: _contentDigest, ...raw } = record;
  return clone(raw);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function contentDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function legacyQueryId(entry) {
  return `agent-memory-query-${contentDigest({
    domain: "mydashboard-agent-memory-query/v1",
    binding: entry.binding,
    request: entry.request,
  })}`;
}

function projectionRecordFor(entry) {
  const projectedAnswer = entry.result.status === "answered"
    ? entry.result.claims.map(({ statement }) => statement).join("\n")
    : "证据不足";
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "agent-memory-query", id: entry.queryId },
    occurredAt: entry.completedAt,
    roleId: entry.binding.roleId,
    repository: null,
    eventType: entry.result.status === "answered"
      ? "agent.memory_answered"
      : "agent.memory_insufficient",
    title: `岗位记忆查询：${entry.request.question}`,
    summary: projectedAnswer,
    content: JSON.stringify({
      schemaVersion: 1,
      queryId: entry.queryId,
      itemId: entry.binding.itemId,
      itemRevision: entry.binding.itemRevision,
      inputDigest: entry.binding.inputDigest,
      question: entry.request.question,
      searchQuery: entry.request.retrieval.filters.query,
      mode: entry.request.mode,
      status: entry.result.status,
      contextDigest: entry.result.contextDigest,
      claimCount: entry.result.claims.length,
      citationIds: entry.result.citations.map(({ recordId }) => recordId),
      truncated: entry.result.truncated,
    }),
    evidence: entry.result.citations.map(({ recordId }) => `cites:${recordId}`),
    tags: ["agent-memory-query", "derived"],
    sourceUrl: null,
    subjectNumber: null,
  });
}

function legacyEntry(template, {
  revision,
  request = template.request,
  status = template.status,
  errorCode = "AGENT_MEMORY_QUERY_FAILED",
} = {}) {
  const entry = clone(template);
  entry.binding.itemRevision = revision;
  entry.request = clone(request);
  entry.queryId = legacyQueryId(entry);
  if (status === "reserved") {
    return {
      ...entry,
      status,
      completedAt: null,
      errorCode: "",
      result: null,
      projectionRecordId: null,
      projected: false,
    };
  }
  if (status === "failed") {
    return {
      ...entry,
      status,
      errorCode,
      result: null,
      projectionRecordId: null,
      projected: false,
    };
  }
  entry.status = "completed";
  entry.errorCode = "";
  entry.projected = false;
  entry.projectionRecordId = projectionRecordFor(entry).recordId;
  return entry;
}

async function completedEntryFixture() {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const service = createService({
    store,
    ports,
    memoryAnswer: { async answer() { return answer(record); } },
  });
  await service.recover();
  await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  return { record, ports, entry: clone(store.value.entries[0]) };
}

function answer(record, mode = "local") {
  return {
    schemaVersion: 1,
    status: "answered",
    answer: "旧回归通过恢复空值分支保护修复。",
    derived: true,
    claims: [{
      statement: "旧回归通过恢复空值分支保护修复。",
      citationIds: [record.recordId],
      derived: true,
    }],
    citations: [{
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      title: record.title,
      occurredAt: record.occurredAt,
      eventType: record.eventType,
      roleId: record.roleId,
      repository: record.repository,
      source: clone(record.source),
      sourceUrl: null,
      labels: { authority: "raw", lifecycle: "current" },
    }],
    context: {
      contextDigest: CONTEXT_DIGEST,
    },
    brain: {
      mode,
      provider: mode === "local" ? "ollama" : "remote",
      model: mode === "local" ? "qwen-local" : "strong-remote",
      remote: mode === "configured",
    },
    localRerunAvailable: true,
  };
}

class MemoryStore {
  value = null;

  async read(_name, fallback = null) {
    return this.value === null ? clone(fallback) : clone(this.value);
  }

  async write(_name, value) {
    this.value = clone(value);
  }
}

function memoryPorts(record) {
  const records = new Map([[record.recordId, record]]);
  const labels = new Map([[
    record.recordId,
    { authority: "raw", lifecycle: "current" },
  ]]);
  const projected = new Map();
  return {
    records,
    labels,
    projected,
    memoryContextReader: {
      async readRecords({ recordIds }) {
        if (recordIds.some((recordId) => !records.has(recordId))) {
          throw Object.assign(new Error("record not found"), {
            code: "MEMORY_RECORD_NOT_FOUND",
          });
        }
        return {
          journalRevision: 3,
          items: recordIds.map((recordId) => ({
            record: clone(records.get(recordId)),
            labels: clone(labels.get(recordId)),
          })),
        };
      },
    },
    memoryProducer: {
      async append(value) {
        const normalized = normalizeMemoryRecord(value);
        const created = !projected.has(normalized.recordId);
        projected.set(normalized.recordId, normalized);
        return { recordId: normalized.recordId, created };
      },
    },
  };
}

function createService({
  store,
  ports,
  memoryAnswer,
  allowedRoleIds = ["developer"],
  serviceClock = clock(),
} = {}) {
  return new AgentMemoryQueryService({
    store,
    memoryAnswer,
    memoryContextReader: ports.memoryContextReader,
    memoryProducer: ports.memoryProducer,
    allowedRoleIds,
    clock: serviceClock,
  });
}

test("a role query persists a bounded cited result and resumes after restart without another model call", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let answerCalls = 0;
  const memoryAnswer = {
    async answer(request) {
      answerCalls += 1;
      assert.equal(request.mode, "local");
      assert.equal(request.retrieval.filters.query, "同类 回归 修复");
      return answer(record);
    },
  };
  const first = createService({ store, ports, memoryAnswer });
  await first.recover();

  const executed = await first.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });

  assert.equal(executed.recovered, false);
  assert.equal(executed.context.status, "answered");
  assert.deepEqual(executed.context.claims[0].citationIds, [record.recordId]);
  assert.equal(executed.context.citations[0].contentDigest, record.contentDigest);
  assert.equal(answerCalls, 1);
  assert.deepEqual(first.status(), {
    revision: 3,
    count: 1,
    reserved: 0,
    failed: 0,
    completed: 1,
    unprojected: 0,
  });
  assert.equal(ports.projected.size, 1);
  assert.deepEqual([...ports.projected.values()][0].tags, [
    "agent-memory-query",
    "derived",
  ]);

  const restarted = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        answerCalls += 1;
        throw new Error("must not call after restart");
      },
    },
  });
  await restarted.recover();
  const restoredContext = await restarted.readContext({
    roleId: "developer",
    item: contextItem("developer", 8),
  });
  const replay = await restarted.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item("developer", 8),
    intent: intent(),
  });

  assert.equal(restoredContext.queryId, executed.context.queryId);
  assert.equal(replay.recovered, true);
  assert.equal(replay.context.contextDigest, CONTEXT_DIGEST);
  assert.equal(answerCalls, 1);
});

test("operational revisions reuse one logical query and only changed input can query again", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let calls = 0;
  const service = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        return answer(record);
      },
    },
  });
  await service.recover();
  await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });

  await assert.rejects(
    service.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item(),
      intent: intent({ searchQuery: "另一个查询" }),
    }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED",
  );
  const recovered = await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item("developer", 3),
    intent: intent(),
  });
  await assert.rejects(
    service.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item("developer", 4),
      intent: intent({ searchQuery: "同一输入不能换查询" }),
    }),
    (error) => error.code === "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED",
  );
  const nextInputDigest = "c".repeat(64);
  const changedInput = await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item("developer", 5, nextInputDigest),
    intent: intent({ searchQuery: "新任务输入" }),
  });

  assert.equal(recovered.recovered, true);
  assert.equal(changedInput.recovered, false);
  assert.equal(calls, 2);
  assert.equal(service.status().count, 2);
});

test("legacy recovery selects one completed result independent of entry order", async () => {
  const { ports, entry } = await completedEntryFixture();
  const failed = legacyEntry(entry, { revision: 2, status: "failed" });
  const completed = legacyEntry(entry, { revision: 3 });
  let answerCalls = 0;

  for (const entries of [[failed, completed], [completed, failed]]) {
    const store = new MemoryStore();
    store.value = { schemaVersion: 1, revision: 20, entries: clone(entries) };
    const service = createService({
      store,
      ports,
      memoryAnswer: {
        async answer() {
          answerCalls += 1;
          throw new Error("legacy recovery must not call the model");
        },
      },
    });
    await service.recover();

    const recovered = await service.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item("developer", 9),
      intent: intent(),
    });

    assert.equal(recovered.recovered, true);
    assert.equal(recovered.context.queryId, completed.queryId);
  }
  assert.equal(answerCalls, 0);
});

test("multiple legacy completed results for one request fail closed in every order", async () => {
  const { ports, entry } = await completedEntryFixture();
  const first = legacyEntry(entry, { revision: 2 });
  const second = legacyEntry(entry, { revision: 3 });
  let answerCalls = 0;

  for (const entries of [[first, second], [second, first]]) {
    const store = new MemoryStore();
    store.value = { schemaVersion: 1, revision: 21, entries: clone(entries) };
    const service = createService({
      store,
      ports,
      memoryAnswer: {
        async answer() {
          answerCalls += 1;
          return answer(sourceRecord());
        },
      },
    });
    await service.recover();

    await assert.rejects(
      service.execute({
        roleId: "developer",
        workerId: "employee-developer",
        item: item("developer", 9),
        intent: intent(),
      }),
      (error) => error.code === "AGENT_MEMORY_QUERY_STATE_CONFLICT",
    );
  }
  assert.equal(answerCalls, 0);
});

test("legacy requests that disagree on one logical input fail closed in every order", async () => {
  const { ports, entry } = await completedEntryFixture();
  const completed = legacyEntry(entry, { revision: 2 });
  const changedRequest = clone(entry.request);
  changedRequest.retrieval.filters.query = "另一个历史查询";
  const failed = legacyEntry(entry, {
    revision: 3,
    request: changedRequest,
    status: "failed",
  });
  let answerCalls = 0;

  for (const entries of [[completed, failed], [failed, completed]]) {
    const store = new MemoryStore();
    store.value = { schemaVersion: 1, revision: 22, entries: clone(entries) };
    const service = createService({
      store,
      ports,
      memoryAnswer: {
        async answer() {
          answerCalls += 1;
          return answer(sourceRecord());
        },
      },
    });
    await service.recover();

    await assert.rejects(
      service.execute({
        roleId: "developer",
        workerId: "employee-developer",
        item: item("developer", 9),
        intent: intent(),
      }),
      (error) => error.code === "AGENT_MEMORY_QUERY_STATE_CONFLICT",
    );
  }
  assert.equal(answerCalls, 0);
});

test("any legacy reserved result stays unknown regardless of request or order", async () => {
  const { ports, entry } = await completedEntryFixture();
  const completed = legacyEntry(entry, { revision: 2 });
  const changedRequest = clone(entry.request);
  changedRequest.retrieval.filters.query = "尚未落盘的历史查询";
  const reserved = legacyEntry(entry, {
    revision: 3,
    request: changedRequest,
    status: "reserved",
  });
  let answerCalls = 0;

  for (const entries of [[completed, reserved], [reserved, completed]]) {
    const store = new MemoryStore();
    store.value = { schemaVersion: 1, revision: 23, entries: clone(entries) };
    const service = createService({
      store,
      ports,
      memoryAnswer: {
        async answer() {
          answerCalls += 1;
          return answer(sourceRecord());
        },
      },
    });
    await service.recover();

    await assert.rejects(
      service.execute({
        roleId: "developer",
        workerId: "employee-developer",
        item: item("developer", 9),
        intent: intent(),
      }),
      (error) => error.code === "AGENT_MEMORY_QUERY_RESULT_UNKNOWN",
    );
  }
  assert.equal(answerCalls, 0);
});

test("bounded projection preserves a selected claim instead of cutting its meaning", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const statement = `${"前".repeat(1_000)}结束`;
  const result = answer(record);
  result.claims[0].statement = statement;
  const service = createService({
    store,
    ports,
    memoryAnswer: { async answer() { return result; } },
  });
  await service.recover();

  const executed = await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });

  assert.equal(executed.context.claims[0].statement, statement);
  assert.equal(executed.context.answer, statement);
  assert.equal(executed.context.truncated, false);
});

test("permission is explicit and denied roles cannot reach MemoryAnswerService", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let calls = 0;
  const service = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        return answer(record);
      },
    },
  });
  await service.recover();

  await assert.rejects(
    service.execute({
      roleId: "tester",
      workerId: "employee-tester",
      item: item("tester"),
      intent: intent(),
    }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_NOT_PERMITTED" &&
      error.statusCode === 403,
  );
  assert.equal(await service.readContext({
    roleId: "tester",
    item: contextItem("tester"),
  }), null);
  assert.equal(calls, 0);
  assert.equal(service.status().count, 0);
});

test("a persisted answer is rejected when any bound citation becomes obsolete", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let calls = 0;
  const service = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        return answer(record);
      },
    },
  });
  await service.recover();
  await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  ports.labels.set(record.recordId, {
    authority: "raw",
    lifecycle: "obsolete",
  });

  await assert.rejects(
    service.readContext({ roleId: "developer", item: contextItem() }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_CITATION_STALE",
  );
  const restarted = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        return answer(record);
      },
    },
  });
  await restarted.recover();
  await assert.rejects(
    restarted.readContext({ roleId: "developer", item: contextItem() }),
    (error) => error.code === "AGENT_MEMORY_QUERY_CITATION_STALE",
  );
  assert.equal(calls, 1);
});

test("a citation invalidated after context read is rejected at the decision boundary", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const service = createService({
    store,
    ports,
    memoryAnswer: { async answer() { return answer(record); } },
  });
  await service.recover();
  const executed = await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  ports.labels.set(record.recordId, {
    authority: "raw",
    lifecycle: "obsolete",
  });

  await assert.rejects(
    service.verifyContext({
      roleId: "developer",
      item: item("developer", 9),
      context: executed.context,
    }),
    (error) => error.code === "AGENT_MEMORY_QUERY_CITATION_STALE",
  );
});

test("a missing persisted citation is classified as stale after restart", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const service = createService({
    store,
    ports,
    memoryAnswer: { async answer() { return answer(record); } },
  });
  await service.recover();
  await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  ports.records.delete(record.recordId);

  const restarted = createService({
    store,
    ports,
    memoryAnswer: { async answer() { throw new Error("must not run"); } },
  });
  await restarted.recover();
  await assert.rejects(
    restarted.readContext({ roleId: "developer", item: contextItem() }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_CITATION_STALE" &&
      error.statusCode === 409,
  );
});

test("a completed answer repairs an interrupted projection after restart without another model call", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const append = ports.memoryProducer.append;
  let answerCalls = 0;
  let appendCalls = 0;
  ports.memoryProducer.append = async (value) => {
    appendCalls += 1;
    if (appendCalls === 1) throw new Error("simulated projection interruption");
    return append(value);
  };
  const first = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        answerCalls += 1;
        return answer(record);
      },
    },
  });
  await first.recover();

  await assert.rejects(
    first.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item(),
      intent: intent(),
    }),
    /simulated projection interruption/,
  );
  assert.equal(first.status().unprojected, 1);

  const restarted = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        answerCalls += 1;
        throw new Error("restart must reuse the completed result");
      },
    },
  });
  await restarted.recover();
  const restored = await restarted.readContext({
    roleId: "developer",
    item: contextItem(),
  });

  assert.equal(restored.status, "answered");
  assert.equal(answerCalls, 1);
  assert.equal(appendCalls, 2);
  assert.equal(restarted.status().unprojected, 0);
  assert.equal(ports.projected.size, 1);
});

test("BrainRouter denies unauthorized remote memory before the provider and the failed query cannot loop", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let remoteProviderCalls = 0;
  const router = new BrainRouter({
    providers: [
      {
        id: "local",
        remote: false,
        async generate() {
          return JSON.stringify({ schemaVersion: 1, status: "insufficient_evidence", claims: [] });
        },
      },
      {
        id: "remote",
        remote: true,
        async generate() {
          remoteProviderCalls += 1;
          return JSON.stringify({ schemaVersion: 1, status: "insufficient_evidence", claims: [] });
        },
      },
    ],
  });
  const memoryAnswer = new MemoryAnswerService({
    contextRetriever: {
      async retrieve() {
        return {
          schemaVersion: 1,
          retrievalVersion: "lexical-v1",
          promptVersion: "cited-memory-v1",
          retrievalKind: "query",
          question: "上次如何修复？",
          contextDigest: CONTEXT_DIGEST,
          journalRevision: 3,
          recordIds: [record.recordId],
          records: [{
            ...clone(record),
            labels: { authority: "raw", lifecycle: "current" },
          }],
          dataClasses: ["requirements", "code", "memory"],
          citableRecordIds: [record.recordId],
          totalMatched: 1,
          truncated: false,
          indexHealthy: true,
        };
      },
    },
    brainRouter: router,
    configuredBrain: {
      provider: "remote",
      model: "strong-remote",
      remoteData: { requirements: true, code: true, memory: false },
    },
    localBrain: {
      provider: "local",
      model: "qwen-local",
      remoteData: { requirements: false, code: false, memory: false },
    },
  });
  const service = createService({ store, ports, memoryAnswer });
  await service.recover();
  const configuredIntent = intent({ mode: "configured" });

  await assert.rejects(
    service.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item(),
      intent: configuredIntent,
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  await assert.rejects(
    service.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item(),
      intent: configuredIntent,
    }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_ALREADY_ATTEMPTED",
  );

  assert.equal(remoteProviderCalls, 0);
  assert.equal(service.status().failed, 1);
});

test("a reserved query survives restart as unknown and is never duplicated", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const first = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        await pending;
        return answer(record);
      },
    },
  });
  await first.recover();
  const execution = first.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  while (store.value?.entries?.[0]?.status !== "reserved") {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const restarted = createService({
    store,
    ports,
    memoryAnswer: {
      async answer() {
        calls += 1;
        return answer(record);
      },
    },
  });
  await restarted.recover();
  await assert.rejects(
    restarted.execute({
      roleId: "developer",
      workerId: "employee-developer",
      item: item("developer", 7),
      intent: intent(),
    }),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_RESULT_UNKNOWN",
  );
  assert.equal(calls, 1);

  release();
  await execution;
});

test("restart rejects corrupted durable state with one stable local error", async () => {
  const record = sourceRecord();
  const store = new MemoryStore();
  const ports = memoryPorts(record);
  const service = createService({
    store,
    ports,
    memoryAnswer: { async answer() { return answer(record); } },
  });
  await service.recover();
  await service.execute({
    roleId: "developer",
    workerId: "employee-developer",
    item: item(),
    intent: intent(),
  });
  store.value.entries[0].requestedBy = "invalid\nrequester";

  const restarted = createService({
    store,
    ports,
    memoryAnswer: { async answer() { throw new Error("must not run"); } },
  });
  await assert.rejects(
    restarted.recover(),
    (error) =>
      error instanceof AgentMemoryQueryServiceError &&
      error.code === "AGENT_MEMORY_QUERY_STATE_CORRUPTED" &&
      error.statusCode === 503,
  );
});
