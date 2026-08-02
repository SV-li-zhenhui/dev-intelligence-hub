import assert from "node:assert/strict";
import test from "node:test";
import { MemoryProjector } from "../src/services/memory-projector.js";

function workItem(id, status, revision = 1) {
  return {
    itemId: `work-${id}`,
    assignmentId: `assignment-${id}`,
    revision,
    status,
    statusReason: "",
    attempt: 0,
    currentTarget: { type: "role", id: "requirements-analyst" },
    event: {
      eventType: "issue.observed",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: { id: `github:issue:acme/repo#${id}`, repository: "acme/repo", number: id },
      payload: { title: `Issue ${id}` },
    },
    decisionContext: null,
    createdAt: "2026-08-02T01:00:00.000Z",
    updatedAt: `2026-08-02T01:00:0${id}.000Z`,
  };
}

function paged(values) {
  return async ({ cursor }) => {
    const start = cursor ? Number(cursor) : 0;
    const items = values.slice(start, start + 1);
    return {
      items,
      nextCursor: start + items.length < values.length ? String(start + 1) : null,
    };
  };
}

test("memory projector imports work items, timeline, and legacy PR memory idempotently", async () => {
  const items = [workItem(1, "waiting_user"), workItem(2, "queued")];
  const timeline = [{
    timelineId: "work-timeline-1",
    sequence: 1,
    itemId: "work-1",
    type: "assignment_intaken",
    at: "2026-08-02T01:00:01.000Z",
    actorId: "work-ledger-system",
    details: { sourceSequence: 1 },
  }];
  const legacy = [{
    id: "pr-work-1:analysis_ready",
    event: "analysis_ready",
    roleId: "pr-reviewer",
    sourceId: "github:pr:acme/repo#9",
    sourceUrl: "https://github.com/acme/repo/pull/9",
    repository: "acme/repo",
    number: 9,
    title: "Review checkout",
    summary: "需要补充失败路径",
    evidence: ["missing test"],
    steps: ["add test"],
    reviewBody: "Please add a test.",
    decision: "",
    brain: { provider: "ollama", model: "local" },
    createdAt: "2026-08-02T00:30:00.000Z",
  }];
  const records = new Map();
  const batches = [];
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch({ records: supplied }) {
        batches.push(structuredClone(supplied));
        let added = 0;
        for (const record of supplied) {
          const key = `${record.source.kind}:${record.source.id}`;
          if (!records.has(key)) added += 1;
          records.set(key, structuredClone(record));
        }
        return { added };
      },
    },
    ledgerView: {
      listItems: paged(items),
      listTimeline: paged(timeline),
    },
    store: {
      async read(name) {
        assert.equal(name, "pr-employee-memory");
        return structuredClone(legacy);
      },
    },
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();

  assert.deepEqual(first, {
    observed: 4,
    added: 4,
    workItems: 2,
    timeline: 1,
    legacy: 1,
  });
  assert.equal(second.added, 0);
  assert.equal(records.size, 4);
  assert.equal(batches[0][0].eventType, "work.waiting_user");
  assert.equal(batches[0][2].eventType, "timeline.assignment_intaken");
  assert.equal(batches[0][3].eventType, "analysis_ready");
  assert.equal(batches[0][3].roleId, "pr-reviewer");
});

test("memory projector coalesces concurrent runs", async () => {
  let release;
  let calls = 0;
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch() {
        await new Promise((resolve) => { release = resolve; });
        return { added: 1 };
      },
    },
    ledgerView: {
      async listItems() {
        calls += 1;
        return { items: [workItem(1, "queued")], nextCursor: null };
      },
      async listTimeline() {
        return { items: [], nextCursor: null };
      },
    },
    store: { async read() { return []; } },
  });

  const first = projector.runCycle();
  const second = projector.runCycle();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(calls, 1);
});

test("memory projector refuses looping and malformed source pagination", async () => {
  const producer = { async appendBatch() { throw new Error("must not write"); } };
  const store = { async read() { return []; } };
  const looping = new MemoryProjector({
    memoryProducer: producer,
    ledgerView: {
      async listItems() { return { items: [], nextCursor: "same" }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
    },
    store,
  });
  await assert.rejects(looping.runCycle(), /did not advance/);

  const malformed = new MemoryProjector({
    memoryProducer: producer,
    ledgerView: {
      async listItems() { return { items: null, nextCursor: null }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
    },
    store,
  });
  await assert.rejects(malformed.runCycle(), /source page is invalid/);
});
