import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import {
  createWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
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

function graphProjectionSource(events = []) {
  let cursor = 0;
  return {
    acknowledgements: [],
    async readBatch({ limit }) {
      return structuredClone({
        cursor,
        highWatermark: events.length,
        items: events.slice(cursor, cursor + limit),
      });
    },
    async ackBatch({ receipts }) {
      assert.ok(Array.isArray(receipts));
      assert.ok(receipts.length > 0);
      for (let index = 0; index < receipts.length; index += 1) {
        assert.deepEqual(
          receipts[index],
          workGraphMemoryRecordReceipt(events[cursor + index]),
        );
      }
      this.acknowledgements.push(structuredClone(receipts));
      cursor += receipts.length;
      return {
        status: "applied",
        cursor,
        highWatermark: events.length,
      };
    },
  };
}

function graphEventsForItem(item) {
  let previousDigest = null;
  return [
    ...item.graph.acceptanceContracts.map((record) => ({
      kind: "acceptance_contract",
      record,
    })),
    ...item.graph.deliveries.map((record) => ({
      kind: `delivery_${record.status}`,
      record,
    })),
  ].map(({ kind, record }, index) => {
    const event = createWorkGraphMemoryEvent({
      sequence: index + 1,
      previousDigest,
      ledgerRevision: item.revision,
      taskRevision: item.revision,
      item,
      kind,
      record,
    });
    previousDigest = event.eventDigest;
    return event;
  });
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
    graphProjectionSource: graphProjectionSource(),
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
    graph: {
      observed: 0,
      added: 0,
      acknowledged: 0,
      cursor: 0,
      highWatermark: 0,
      pending: 0,
    },
  });
  assert.equal(second.added, 0);
  assert.equal(records.size, 4);
  assert.equal(batches[0][0].eventType, "work.waiting_user");
  assert.equal(batches[0][2].eventType, "timeline.assignment_intaken");
  assert.equal(batches[0][3].eventType, "analysis_ready");
  assert.equal(batches[0][3].roleId, "pr-reviewer");
  assert.deepEqual(batches[0][3].tags, ["legacy", "pr-reviewer", "derived"]);
});

test("graph contracts and deliveries remain searchable without retained timeline events", async () => {
  const item = workItem(3, "completed", 4);
  item.graph = {
    parentItemId: "work-1",
    dependsOnItemIds: ["work-2"],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: "2026-08-02T01:00:00.000Z",
      },
      {
        revision: 2,
        acceptanceCriteria: [
          {
            criterionId: "tests-pass",
            description: "All regression tests pass",
          },
        ],
        expectedDeliverables: [
          {
            deliverableId: "test-report",
            kind: "test-report",
            description: "Regression test evidence",
            required: true,
          },
        ],
        recordedAt: "2026-08-04T02:00:00.000Z",
      },
    ],
    deliveries: [
      {
        deliverableId: "test-report",
        revision: 1,
        contractRevision: 2,
        status: "submitted",
        summary: "Submitted 1218 regression results",
        evidence: [
          {
            kind: "test-report",
            referenceId: "artifact-test-report",
            contentDigest: "a".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T03:00:00.000Z",
      },
      {
        deliverableId: "test-report",
        revision: 2,
        contractRevision: 2,
        status: "accepted",
        summary: "Regression evidence accepted",
        evidence: [
          {
            kind: "test-report",
            referenceId: "artifact-test-report",
            contentDigest: "a".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:00:00.000Z",
      },
    ],
  };
  const records = new Map();
  const recordsBySource = new Map();
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch({ records: supplied }) {
        let added = 0;
        for (const candidate of supplied) {
          const record = normalizeMemoryRecord(candidate);
          if (!records.has(record.recordId)) added += 1;
          records.set(record.recordId, record);
          recordsBySource.set(`${record.source.kind}:${record.source.id}`, record);
        }
        return {
          added,
          items: supplied.map((candidate) => ({
            recordId: normalizeMemoryRecord(candidate).recordId,
            created: true,
          })),
        };
      },
    },
    ledgerView: {
      listItems: paged([item]),
      listTimeline: paged([]),
    },
    graphProjectionSource: graphProjectionSource(graphEventsForItem(item)),
    store: { async read() { return []; } },
  });

  const first = await projector.runCycle();
  item.revision = 5;
  item.updatedAt = "2026-08-02T01:00:05.000Z";
  item.currentTarget = { type: "role", id: "tester" };
  item.graph.dependsOnItemIds = ["work-1"];
  const second = await projector.runCycle();
  const third = await projector.runCycle();

  assert.equal(first.observed, 5);
  assert.equal(first.added, 5);
  assert.equal(second.added, 1);
  assert.equal(third.added, 0);
  const contract = recordsBySource.get("work-contract:work-3:contract:2");
  const submitted = recordsBySource.get("work-delivery:work-3:delivery:1");
  const accepted = recordsBySource.get("work-delivery:work-3:delivery:2");
  assert.equal(contract.roleId, null);
  assert.equal(submitted.roleId, null);
  assert.match(contract.content, /All regression tests pass/);
  assert.match(contract.content, /Regression test evidence/);
  assert.doesNotMatch(contract.content, /dependsOnItemIds/);
  assert.equal(contract.occurredAt, "2026-08-04T02:00:00.000Z");
  assert.equal(submitted.eventType, "work.delivery_submitted");
  assert.equal(submitted.occurredAt, "2026-08-05T03:00:00.000Z");
  assert.match(submitted.summary, /1218 regression results/);
  assert.match(submitted.content, /artifact-test-report/);
  assert.match(submitted.content, new RegExp("a{64}"));
  assert.equal(accepted.eventType, "work.delivery_accepted");
  assert.equal(accepted.occurredAt, "2026-08-05T04:00:00.000Z");
  assert.deepEqual(accepted.evidence, [
    `test-report:artifact-test-report:${"a".repeat(64)}`,
  ]);
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
    graphProjectionSource: graphProjectionSource(),
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
    graphProjectionSource: graphProjectionSource(),
    store,
  });
  await assert.rejects(looping.runCycle(), /did not advance/);

  const malformed = new MemoryProjector({
    memoryProducer: producer,
    ledgerView: {
      async listItems() { return { items: null, nextCursor: null }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
    },
    graphProjectionSource: graphProjectionSource(),
    store,
  });
  await assert.rejects(malformed.runCycle(), /source page is invalid/);
});

test("task graph projection is bounded to 100 events per cycle", async () => {
  const task = workItem(9, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  let previousDigest = null;
  const events = Array.from({ length: 101 }, (_, index) => {
    const event = createWorkGraphMemoryEvent({
      sequence: index + 1,
      previousDigest,
      ledgerRevision: 1,
      taskRevision: 1,
      item: task,
      kind: "acceptance_contract",
      record: task.graph.acceptanceContracts[0],
    });
    previousDigest = event.eventDigest;
    return event;
  });
  const records = new Set();
  const source = graphProjectionSource(events);
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch({ records: supplied }) {
        const items = supplied.map((candidate) => {
          const record = normalizeMemoryRecord(candidate);
          const created = !records.has(record.recordId);
          records.add(record.recordId);
          return { recordId: record.recordId, created };
        });
        return {
          added: items.filter(({ created }) => created).length,
          items,
        };
      },
    },
    ledgerView: {
      listItems: paged([]),
      listTimeline: paged([]),
    },
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();
  assert.equal(first.graph.observed, 100);
  assert.equal(first.graph.acknowledged, 100);
  assert.equal(first.graph.pending, 1);
  assert.equal(second.graph.observed, 1);
  assert.equal(second.graph.pending, 0);
  assert.deepEqual(source.acknowledgements.map(({ length }) => length), [100, 1]);
});

test("a lost graph acknowledgement response resumes from the durable cursor", async () => {
  const task = workItem(8, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  const event = graphEventsForItem(task)[0];
  const source = graphProjectionSource([event]);
  const originalAckBatch = source.ackBatch;
  let failAck = true;
  source.ackBatch = async function (request) {
    const result = await originalAckBatch.call(this, request);
    if (failAck) {
      failAck = false;
      throw new Error("ack response lost");
    }
    return result;
  };
  const records = new Set();
  let appendCalls = 0;
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch({ records: supplied }) {
        appendCalls += 1;
        const items = supplied.map((candidate) => {
          const record = normalizeMemoryRecord(candidate);
          const created = !records.has(record.recordId);
          records.add(record.recordId);
          return { recordId: record.recordId, created };
        });
        return {
          added: items.filter(({ created }) => created).length,
          items,
        };
      },
    },
    ledgerView: {
      listItems: paged([]),
      listTimeline: paged([]),
    },
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  await assert.rejects(projector.runCycle(), /ack response lost/);
  const retried = await projector.runCycle();
  assert.equal(retried.graph.added, 0);
  assert.equal(retried.graph.cursor, 1);
  assert.equal(records.size, 1);
  assert.equal(appendCalls, 1);
});

test("a lost graph append response replays idempotently before batch acknowledgement", async () => {
  const task = workItem(10, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  const source = graphProjectionSource(graphEventsForItem(task));
  const records = new Set();
  let appendCalls = 0;
  let loseResponse = true;
  const projector = new MemoryProjector({
    memoryProducer: {
      async appendBatch({ records: supplied }) {
        appendCalls += 1;
        const items = supplied.map((candidate) => {
          const record = normalizeMemoryRecord(candidate);
          const created = !records.has(record.recordId);
          records.add(record.recordId);
          return { recordId: record.recordId, created };
        });
        if (loseResponse) {
          loseResponse = false;
          throw new Error("append response lost");
        }
        return {
          added: items.filter(({ created }) => created).length,
          items,
        };
      },
    },
    ledgerView: {
      listItems: paged([]),
      listTimeline: paged([]),
    },
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  await assert.rejects(projector.runCycle(), /append response lost/);
  assert.equal(source.acknowledgements.length, 0);
  const retried = await projector.runCycle();
  assert.equal(retried.graph.added, 0);
  assert.equal(retried.graph.cursor, 1);
  assert.equal(records.size, 1);
  assert.equal(appendCalls, 2);
  assert.deepEqual(source.acknowledgements.map(({ length }) => length), [1]);
});
