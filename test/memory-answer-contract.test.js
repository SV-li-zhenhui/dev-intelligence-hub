import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_ANSWER_JSON_SCHEMA,
  MemoryAnswerContractError,
  normalizeMemoryAnswerRequest,
  parseStructuredMemoryAnswer,
} from "../src/domain/memory-answer-contract.js";

const MEMORY_ID = `memory-${"a".repeat(64)}`;

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    question: "此前 PR 的测试为什么失败？",
    mode: "configured",
    retrieval: {
      kind: "query",
      filters: { query: "测试失败", repository: "acme/repo" },
    },
    ...overrides,
  };
}

test("memory answer requests normalize query and exact reproducible context modes", () => {
  const query = normalizeMemoryAnswerRequest(request());
  assert.deepEqual(query.retrieval.filters, {
    query: "测试失败",
    roleId: "",
    repository: "acme/repo",
    eventType: "",
    from: "",
    to: "",
  });
  const context = normalizeMemoryAnswerRequest(request({
    mode: "local",
    retrieval: {
      kind: "context",
      contextDigest: "b".repeat(64),
      recordIds: [MEMORY_ID],
    },
  }));
  assert.equal(context.mode, "local");
  assert.deepEqual(context.retrieval.recordIds, [MEMORY_ID]);
  assert.equal(Object.isFrozen(context), true);
});

test("memory answer requests reject widening, duplicate records, controls, and accessors", () => {
  assert.throws(
    () => normalizeMemoryAnswerRequest({ ...request(), provider: "remote" }),
    MemoryAnswerContractError,
  );
  assert.throws(
    () => normalizeMemoryAnswerRequest(request({ question: "bad\nquestion" })),
    /question/,
  );
  assert.throws(
    () => normalizeMemoryAnswerRequest(request({
      retrieval: {
        kind: "query",
        filters: {
          from: "2026-08-05T02:00:00.000Z",
          to: "2026-08-05T01:00:00.000Z",
        },
      },
    })),
    /时间范围/,
  );
  assert.throws(
    () => normalizeMemoryAnswerRequest(request({
      retrieval: {
        kind: "context",
        contextDigest: "b".repeat(64),
        recordIds: [MEMORY_ID, MEMORY_ID],
      },
    })),
    /recordIds/,
  );
  let getterCalls = 0;
  const hostile = request();
  Object.defineProperty(hostile, "provider", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "remote";
    },
  });
  assert.throws(() => normalizeMemoryAnswerRequest(hostile));
  assert.equal(getterCalls, 0);
});

test("structured answers contain only bounded cited claims or explicit insufficiency", () => {
  const answered = parseStructuredMemoryAnswer(JSON.stringify({
    schemaVersion: 1,
    status: "answered",
    claims: [{ statement: "测试在应用变更前失败。", citationIds: [MEMORY_ID] }],
  }));
  assert.deepEqual(answered, {
    schemaVersion: 1,
    status: "answered",
    claims: [{ statement: "测试在应用变更前失败。", citationIds: [MEMORY_ID] }],
  });
  assert.deepEqual(
    parseStructuredMemoryAnswer(JSON.stringify({
      schemaVersion: 1,
      status: "insufficient_evidence",
      claims: [],
    })),
    { schemaVersion: 1, status: "insufficient_evidence", claims: [] },
  );
  for (const invalid of [
    { schemaVersion: 1, status: "answered", claims: [] },
    {
      schemaVersion: 1,
      status: "insufficient_evidence",
      claims: [{ statement: "unsupported", citationIds: [MEMORY_ID] }],
    },
    {
      schemaVersion: 1,
      status: "answered",
      claims: [{ statement: "uncited", citationIds: [] }],
    },
    {
      schemaVersion: 1,
      status: "answered",
      claims: [{ statement: "duplicate", citationIds: [MEMORY_ID, MEMORY_ID] }],
    },
  ]) {
    assert.throws(() => parseStructuredMemoryAnswer(JSON.stringify(invalid)));
  }
  assert.throws(
    () => parseStructuredMemoryAnswer(" ".repeat(64 * 1024 + 1)),
    /response/,
  );
});

test("the provider schema is closed and mirrors the local claim limits", () => {
  assert.equal(MEMORY_ANSWER_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(MEMORY_ANSWER_JSON_SCHEMA.required, [
    "schemaVersion",
    "status",
    "claims",
  ]);
  assert.equal(MEMORY_ANSWER_JSON_SCHEMA.properties.claims.maxItems, 12);
  assert.equal(
    MEMORY_ANSWER_JSON_SCHEMA.properties.claims.items.properties.citationIds.maxItems,
    8,
  );
});
