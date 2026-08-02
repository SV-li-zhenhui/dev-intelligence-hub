import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";

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
  assert.deepEqual(Object.keys(runtime.search).sort(), ["getHealth", "search"]);
  assert.deepEqual(Object.keys(runtime.receiptVerifier), ["verify"]);
  assert.deepEqual(Object.keys(runtime.maintenance), ["rebuildIndex"]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.producer), true);
  assert.equal(Object.isFrozen(runtime.receiptVerifier), true);
  assert.equal("journal" in runtime, false);

  const value = memoryRecord();
  const expected = normalizeMemoryRecord(value);
  await runtime.producer.append(value);
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
  const first = runtime.close();
  assert.strictEqual(runtime.close(), first);
  await first;
  assert.deepEqual(events.filter((event) => event === "close"), ["close"]);
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
