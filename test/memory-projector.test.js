import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import {
  createWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";
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

const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");

function graphProjectionSource(events = []) {
  let cursor = 0;
  return {
    acknowledgements: [],
    async readBatch({ limit }) {
      return structuredClone({
        cursor,
        highWatermark: events.length,
        checkpointDigest: events[cursor - 1]?.eventDigest ?? null,
        highWatermarkDigest: events.at(-1)?.eventDigest ?? null,
        authorityStateDigest:
          events.at(-1)?.authorityStateDigest ?? EMPTY_AUTHORITY_STATE_DIGEST,
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

function memoryAuthoritySource(items, timeline, graphSource, revision = null) {
  return {
    async readSnapshot({ limit }) {
      return structuredClone({
        ledgerRevision: revision ?? Math.max(
          1,
          ...items.map((item) => item.revision),
        ),
        items,
        timeline,
        graph: await graphSource.readBatch({ limit }),
      });
    },
  };
}

function memoryLifecycleProducer(memoryProducer) {
  return {
    appendProjectionRecords({ records }) {
      return typeof memoryProducer.appendProjectionRecords === "function"
        ? memoryProducer.appendProjectionRecords({ records })
        : memoryProducer.appendBatch({ records });
    },
    appendWorkItems({ records }) {
      return records.length === 0
        ? Promise.resolve({ added: 0, items: [] })
        : memoryProducer.appendBatch({ records });
    },
    appendGraphEvents({ events }) {
      return memoryProducer.appendBatch({
        records: events.map(({ memoryRecord }) => memoryRecord),
      });
    },
    async adoptGraphCheckpoint() {
      return {};
    },
  };
}

function emptyMemoryAuthorityReader() {
  return {
    async getAuthorityState() {
      return {
        cursor: 0,
        checkpointDigest: null,
        authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        workLedgerRevision: 0,
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

function localMemoryJournal() {
  const values = new Map();
  const journal = new LocalMemoryJournal({
    store: {
      async read(key, fallback = null) {
        return structuredClone(values.has(key) ? values.get(key) : fallback);
      },
      async write(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  return journal.recover().then(() => journal);
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
  const graphSource = graphProjectionSource();
  const trustedSink = {
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
  };
  const memoryProducer = {
    async appendBatch() {
      throw new Error("projector must not use the ordinary memory producer");
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(trustedSink),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource(items, timeline, graphSource),
    graphProjectionSource: graphSource,
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
  assert.equal(records.get("work-item:work-1:revision:1").eventType, "work.waiting_user");
  assert.equal(records.get("work-timeline:work-timeline-1").eventType, "timeline.assignment_intaken");
  assert.equal(records.get("legacy-pr-memory:pr-work-1:analysis_ready").eventType, "analysis_ready");
  assert.equal(records.get("legacy-pr-memory:pr-work-1:analysis_ready").roleId, "pr-reviewer");
  assert.deepEqual(records.get("legacy-pr-memory:pr-work-1:analysis_ready").tags, [
    "legacy",
    "pr-reviewer",
    "derived",
    "obsolete",
  ]);
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
  const events = graphEventsForItem(item);
  const graphSource = graphProjectionSource(events);
  const journal = await localMemoryJournal();
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
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
  const [oldContractId, contractId, submittedId, acceptedId] = events.map(
    (event) => workGraphMemoryRecordReceipt(event).memoryRecordId,
  );
  const graphRecords = journal.readRecords({
    recordIds: [oldContractId, contractId, submittedId, acceptedId],
  }).items;
  const [oldContractEntry, contractEntry, submittedEntry, acceptedEntry] =
    graphRecords;
  const contract = contractEntry.record;
  const submitted = submittedEntry.record;
  const accepted = acceptedEntry.record;
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
  assert.deepEqual(
    graphRecords.map(({ labels }) => labels.lifecycle),
    ["obsolete", "current", "current", "current"],
  );
  assert.equal(oldContractEntry.record.source.kind, "work-contract");
  assert.equal(
    journal.search({ eventType: "work.graph_record_obsoleted" }).items.length,
    0,
  );
});

test("schema 1 memory adopts a non-zero graph checkpoint before pending events", async () => {
  const values = new Map([
    ["unified-memory-records", {
      schemaVersion: 1,
      revision: 1,
      records: [],
    }],
  ]);
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();

  const item = workItem(11, "completed", 4);
  item.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-04T02:00:00.000Z",
    }],
    deliveries: [],
  };
  const checkpointDigest = "a".repeat(64);
  const event = createWorkGraphMemoryEvent({
    sequence: 8,
    previousDigest: checkpointDigest,
    ledgerRevision: 8,
    taskRevision: item.revision,
    item,
    kind: "acceptance_contract",
    record: item.graph.acceptanceContracts[0],
  });
  const authorityStateDigest = event.authorityStateDigest ?? EMPTY_AUTHORITY_STATE_DIGEST;
  let cursor = 7;
  const acknowledgements = [];
  const graphSource = {
    async readBatch({ limit }) {
      return structuredClone({
        cursor,
        highWatermark: event.sequence,
        checkpointDigest: cursor === 7 ? checkpointDigest : event.eventDigest,
        highWatermarkDigest: event.eventDigest,
        authorityStateDigest,
        items: cursor === 7 ? [event].slice(0, limit) : [],
      });
    },
    async ackBatch({ receipts }) {
      assert.deepEqual(receipts, [workGraphMemoryRecordReceipt(event)]);
      acknowledgements.push(structuredClone(receipts));
      cursor = event.sequence;
      return {
        status: "applied",
        cursor,
        highWatermark: event.sequence,
      };
    },
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource, 8),
    graphProjectionSource: graphSource,
    store,
  });

  const result = await projector.runCycle();

  assert.equal(result.graph.added, 1);
  assert.equal(result.graph.cursor, 8);
  assert.equal(acknowledgements.length, 1);
  const persisted = values.get("unified-memory-records");
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.lifecycleAuthority.baseCursor, 7);
  assert.equal(persisted.lifecycleAuthority.graphCursor, 8);
  const recovered = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await recovered.recover();
  assert.equal(recovered.getAuthorityState().cursor, 8);
  assert.equal(recovered.getAuthorityState().checkpointDigest, event.eventDigest);
});

test("schema 1 recovery preserves legacy pull request timelines as historical", async () => {
  const values = new Map([
    ["unified-memory-records", {
      schemaVersion: 1,
      revision: 1,
      records: [],
    }],
  ]);
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();

  const item = workItem(12, "cancelled", 2);
  item.kind = "assignment";
  item.source = null;
  item.event.eventType = "pull_request.observed";
  item.event.subject.id = "github:pr:acme/repo#12";
  const timeline = [{
    timelineId: "legacy-pr-timeline-12",
    sequence: 1,
    itemId: item.itemId,
    type: "assignment_intaken",
    at: "2026-08-02T01:00:01.000Z",
    actorId: "work-ledger-system",
    details: { sourceSequence: 12 },
  }];
  const checkpointDigest = "b".repeat(64);
  const graphSource = {
    async readBatch() {
      return {
        cursor: 7,
        highWatermark: 7,
        checkpointDigest,
        highWatermarkDigest: checkpointDigest,
        authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        items: [],
      };
    },
    async ackBatch() {
      throw new Error("checkpoint-only recovery must not acknowledge events");
    },
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource(
      [item],
      timeline,
      graphSource,
      8,
    ),
    graphProjectionSource: graphSource,
    store,
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();

  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
  assert.equal(journal.getAuthorityState().cursor, 7);
  assert.equal(journal.getAuthorityState().workLedgerRevision, 8);
  const timelineMatch = journal.search({
    eventType: "timeline.assignment_intaken",
  }).items[0];
  const timelineRecord = journal.readRecords({
    recordIds: [timelineMatch.id],
  }).items[0].record;
  assert.deepEqual(timelineRecord.tags, [
    "timeline",
    "assignment_intaken",
    "derived",
    "obsolete",
  ]);
  assert.deepEqual(JSON.parse(timelineRecord.content), {
    details: { sourceSequence: 12 },
    historicalOnly: true,
    citableConclusion: false,
  });
});

test("superseded work invalidates prior work revisions and every graph delivery without deleting history", async () => {
  const item = workItem(9, "completed", 3);
  item.updatedAt = "2026-08-05T05:00:00.000Z";
  item.graph = {
    parentItemId: "work-1",
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: "2026-08-05T03:00:00.000Z",
      },
    ],
    deliveries: [
      {
        deliverableId: "conflict-fix",
        revision: 1,
        contractRevision: 1,
        status: "submitted",
        summary: "Old provenance conflict fix",
        evidence: [
          {
            kind: "test-report",
            referenceId: "old-conflict-test",
            contentDigest: "b".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:00:00.000Z",
      },
      {
        deliverableId: "conflict-fix",
        revision: 2,
        contractRevision: 1,
        status: "accepted",
        summary: "Old provenance evidence accepted",
        evidence: [
          {
            kind: "test-report",
            referenceId: "old-conflict-test",
            contentDigest: "b".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:30:00.000Z",
      },
    ],
  };
  const events = graphEventsForItem(item);
  const contractId = workGraphMemoryRecordReceipt(events[0]).memoryRecordId;
  const submittedId = workGraphMemoryRecordReceipt(events[1]).memoryRecordId;
  const acceptedId = workGraphMemoryRecordReceipt(events[2]).memoryRecordId;
  const journal = await localMemoryJournal();
  const graphSource = graphProjectionSource(events);
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  await projector.runCycle();
  const completedWorkId = journal.search({
    eventType: "work.completed",
  }).items[0].id;
  assert.deepEqual(
    journal.readRecords({ recordIds: [submittedId, acceptedId] })
      .items.map(({ labels }) => labels.lifecycle),
    ["current", "current"],
  );

  item.status = "superseded";
  item.statusReason = "pr_head_superseded";
  item.revision = 4;
  item.updatedAt = "2026-08-05T06:00:00.000Z";
  item.event.payload.title = "Renamed after a new PR Head";
  item.decisionContext = { conclusion: "stale old-Head conclusion" };
  const result = await projector.runCycle();

  assert.equal(result.graph.observed, 0);
  assert.equal(result.added, 1);
  assert.deepEqual(
    journal.readRecords({
      recordIds: [completedWorkId, contractId, submittedId, acceptedId],
    })
      .items.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete", "obsolete", "obsolete"],
  );
  assert.equal(
    journal.search({ eventType: "work.graph_record_obsoleted" }).items.length,
    0,
  );
  const supersededWork = journal.search({
    eventType: "work.superseded",
  }).items[0];
  assert.equal(
    JSON.parse(journal.readRecords({ recordIds: [supersededWork.id] })
      .items[0].record.content).decisionContext,
    null,
  );

  const packet = await new MemoryContextRetriever({
    memorySearch: { search: (value) => journal.search(value) },
    contextReader: {
      readRecords: (value) => journal.readRecords(value),
    },
  }).retrieve({
    question: "旧冲突修复现在是否仍有效？",
    retrieval: {
      kind: "query",
      filters: {
        query: "Old provenance conflict fix",
        repository: "acme/repo",
      },
    },
  });
  const deliveryRecords = packet.records.filter(({ recordId }) =>
    [submittedId, acceptedId].includes(recordId)
  );
  assert.deepEqual(
    new Set(deliveryRecords.map(({ recordId }) => recordId)),
    new Set([submittedId, acceptedId]),
  );
  assert.deepEqual(
    deliveryRecords.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete"],
  );
  assert.equal(packet.citableRecordIds.includes(submittedId), false);
  assert.equal(packet.citableRecordIds.includes(acceptedId), false);
});

test("memory projector coalesces concurrent runs", async () => {
  let release;
  let calls = 0;
  const items = [workItem(1, "queued")];
  const graphSource = graphProjectionSource();
  const memoryProducer = { async appendBatch() { return { added: 0 }; } };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: {
      ...memoryLifecycleProducer(memoryProducer),
      async appendWorkItems() {
        await new Promise((resolve) => { release = resolve; });
        return { added: 1 };
      },
    },
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: {
      async readSnapshot({ limit }) {
        calls += 1;
        return {
          ledgerRevision: 1,
          items,
          timeline: [],
          graph: await graphSource.readBatch({ limit }),
        };
      },
    },
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  const first = projector.runCycle();
  const second = projector.runCycle();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(calls, 2);
});

test("memory projector rejects malformed atomic authority snapshots before writes", async () => {
  const producer = { async appendBatch() { throw new Error("must not write"); } };
  const store = { async read() { return []; } };
  const graphSource = graphProjectionSource();
  const malformed = new MemoryProjector({
    memoryProducer: producer,
    memoryLifecycleProducer: memoryLifecycleProducer(producer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: {
      async readSnapshot() {
        return { ledgerRevision: 1, items: null, timeline: [], graph: null };
      },
    },
    graphProjectionSource: graphSource,
    store,
  });
  await assert.rejects(malformed.runCycle(), /authority snapshot is invalid/);
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
  const memoryProducer = {
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
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
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
  const memoryProducer = {
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
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
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
  const memoryProducer = {
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
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
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
