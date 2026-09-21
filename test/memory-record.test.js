import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryRecordError,
  normalizeMemoryRecord,
} from "../src/domain/memory-record.js";

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    source: { kind: "work-ledger", id: "work-1:completed" },
    occurredAt: "2026-08-02T01:02:03.000Z",
    roleId: "developer",
    repository: "acme/repo",
    eventType: "work.completed",
    title: "完成失败路径修复",
    summary: "补充了结算失败路径测试",
    content: "测试和实现均在隔离工作区完成。",
    evidence: ["node tests passed"],
    tags: ["development", "testing"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
    ...overrides,
  };
}

test("memory records are content addressed and deterministic", () => {
  const first = normalizeMemoryRecord(record());
  const second = normalizeMemoryRecord(record());

  assert.match(first.recordId, /^memory-[a-f0-9]{64}$/);
  assert.equal(first.contentDigest, first.recordId.slice("memory-".length));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
});

test("memory records reject extra fields, accessors, unsafe URLs, and invalid tags", () => {
  assert.throws(
    () => normalizeMemoryRecord({ ...record(), secret: "no" }),
    MemoryRecordError,
  );
  const malicious = record();
  Object.defineProperty(malicious, "title", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  assert.throws(
    () => normalizeMemoryRecord(malicious),
    (error) => error instanceof MemoryRecordError && !/getter must not run/.test(error.message),
  );
  assert.throws(
    () => normalizeMemoryRecord(record({ sourceUrl: "file:///secret" })),
    /sourceUrl/,
  );
  assert.throws(
    () => normalizeMemoryRecord(record({ tags: ["not allowed"] })),
    /tags/,
  );
});

test("memory record identity changes when searchable content changes", () => {
  const first = normalizeMemoryRecord(record());
  const second = normalizeMemoryRecord(record({ summary: "另一项结论" }));
  assert.notEqual(first.recordId, second.recordId);
});
