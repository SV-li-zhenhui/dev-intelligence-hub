import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkGraphMemoryEvent,
  memoryRecordForWorkGraphMemoryEvent,
  normalizeWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
import { createAssignmentWorkItem } from "../src/services/work-ledger-records.js";

const NOW = "2026-08-03T01:00:00.000Z";

function item() {
  return createAssignmentWorkItem({
    sequence: 1,
    assignment: {
      assignmentId: "assignment-1",
      eventId: "workflow-event-1",
      target: { type: "role", id: "requirements-analyst" },
      reason: "test",
    },
    event: {
      schemaVersion: 1,
      eventId: "workflow-event-1",
      eventType: "issue.created",
      occurredAt: NOW,
      subject: {
        id: "github:issue:acme/dashboard#7",
        repository: "acme/dashboard",
        number: 7,
      },
      payload: { title: "Build command center" },
    },
  }, NOW);
}

test("task graph memory events bind immutable graph records to stable memory records", () => {
  const task = item();
  const event = createWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: 1,
    taskRevision: task.revision,
    item: task,
    kind: "acceptance_contract",
    record: task.graph.acceptanceContracts[0],
  });

  assert.deepEqual(normalizeWorkGraphMemoryEvent(event), event);
  const receipt = workGraphMemoryRecordReceipt(event);
  assert.deepEqual(receipt, {
    sequence: 1,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    taskId: task.itemId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: `memory-${receipt.memoryRecordDigest}`,
    memoryRecordDigest: receipt.memoryRecordDigest,
  });
  const record = memoryRecordForWorkGraphMemoryEvent(event);
  assert.deepEqual(record.source, {
    kind: "work-contract",
    id: `${task.itemId}:contract:1`,
  });
  assert.equal(record.occurredAt, NOW);
  assert.match(record.title, /Build command center/);
  assert.ok(JSON.parse(record.content).acceptanceContract);
});

test("maximum valid graph contracts project to bounded deterministic memory", () => {
  const task = item();
  task.event.payload.title = "T".repeat(1_024);
  const record = {
    revision: 1,
    acceptanceCriteria: Array.from({ length: 64 }, (_, index) => ({
      criterionId: `criterion-${index}`,
      description: "c".repeat(4_096),
    })),
    expectedDeliverables: Array.from({ length: 64 }, (_, index) => ({
      deliverableId: `deliverable-${index}`,
      kind: "change-package",
      description: "d".repeat(4_096),
      required: index % 2 === 0,
    })),
    recordedAt: NOW,
  };
  const input = {
    sequence: 1,
    previousDigest: null,
    ledgerRevision: 1,
    taskRevision: task.revision,
    item: task,
    kind: "acceptance_contract",
    record,
  };

  const event = createWorkGraphMemoryEvent(input);
  const repeated = createWorkGraphMemoryEvent(input);
  const memory = memoryRecordForWorkGraphMemoryEvent(event);
  const content = JSON.parse(memory.content);

  assert.deepEqual(normalizeWorkGraphMemoryEvent(event), event);
  assert.equal(repeated.eventDigest, event.eventDigest);
  assert.deepEqual(repeated.memoryRecord, event.memoryRecord);
  assert.ok(Buffer.byteLength(memory.title, "utf8") <= 1_024);
  assert.ok(Buffer.byteLength(memory.content, "utf8") <= 32 * 1_024);
  assert.ok(Buffer.byteLength(JSON.stringify(memory), "utf8") <= 64 * 1_024);
  assert.equal(content.truncated, true);
  assert.equal(content.sourceRecordDigest, event.sourceRecordDigest);
  assert.equal(content.acceptanceCriteriaCount, 64);
  assert.equal(content.expectedDeliverablesCount, 64);
});

test("task graph memory event normalization rejects forged payloads and chain links", () => {
  const task = item();
  const event = createWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: 1,
    taskRevision: task.revision,
    item: task,
    kind: "acceptance_contract",
    record: task.graph.acceptanceContracts[0],
  });
  const forged = structuredClone(event);
  forged.memoryRecord.title = "forged";
  assert.throws(
    () => normalizeWorkGraphMemoryEvent(forged),
    (error) => error.code === "WORK_GRAPH_MEMORY_EVENT_INVALID",
  );
  assert.throws(
    () => createWorkGraphMemoryEvent({
      sequence: 2,
      previousDigest: null,
      ledgerRevision: 2,
      taskRevision: 1,
      item: task,
      kind: "acceptance_contract",
      record: task.graph.acceptanceContracts[0],
    }),
    (error) => error.code === "WORK_GRAPH_MEMORY_EVENT_INVALID",
  );
});
