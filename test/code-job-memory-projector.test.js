import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
  updateCodeJobLifecycle,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  createCodeJobMemoryEvent,
  memoryRecordForCodeJobEvent,
} from "../src/domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import {
  CodeJobMemoryProjector,
} from "../src/services/code-job-memory-projector.js";

function approvedJob(index) {
  const suffix = index.toString(16);
  const grant = createCodeJobGrant({
    proposalId: `work-intent-proposal-${index}`,
    contentDigest: `${"a".repeat(63)}${suffix}`,
    policyVersion: 7,
    requestedBy: {
      roleId: "developer",
      workItemId: `work-${index}`,
    },
    source: {
      assignmentId: `assignment-${index}`,
      eventId: `event-${index}`,
    },
    subject: {
      id: `github:acme/widgets:pull-request:${index}`,
      repository: "acme/widgets",
      number: index,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: `Inspect code job ${index}.`,
    acceptanceCriteria: ["Return bounded evidence."],
    evidence: ["The owner approved local inspection."],
    summary: `Inspect code job ${index}`,
    reason: "A trusted workflow requested inspection.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [{
      id: "node-tests",
      configDigest: "b".repeat(64),
    }],
    brainDigest: "c".repeat(64),
  });
  return createQueuedCodeJob(
    {
      confirmationId: `confirmation-code-job-${index}`,
      requestId: `approval-request-${index}`,
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant,
    },
    {
      sequence: index,
      revision: 1,
      createdAt: `2026-08-02T06:00:0${index}.000Z`,
    },
  );
}

function observedJob(index) {
  const queued = approvedJob(index);
  const workspaceRevision = "4".repeat(64);
  const action = {
    type: "complete",
    actionId: `complete-action-${index}`,
    expectedWorkspaceRevision: workspaceRevision,
  };
  const detail = {
    schemaVersion: 1,
    outcome: "inspected",
    files: [`src/example-${index}.js`],
  };
  const updatedAt = `2026-08-02T06:01:0${index}.000Z`;
  return updateCodeJobLifecycle(queued, {
    status: "active",
    revision: 2,
    updatedAt,
    execution: {
      sessionId: queued.jobId,
      workspaceRevision,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [{
        turn: 1,
        actionId: action.actionId,
        actionType: action.type,
        actionDigest: digestValue(action),
        action,
        status: "succeeded",
        workspaceRevision,
        detail,
        detailDigest: digestValue(detail),
        recordedAt: updatedAt,
      }],
      result: null,
      pause: null,
      uncertainty: null,
      memoryProjection: null,
    },
  });
}

function memoryEvents(count = 2) {
  const events = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    events.push(createCodeJobMemoryEvent({
      sequence,
      previousDigest: events.at(-1)?.eventDigest ?? null,
      job: observedJob(sequence),
      kind: "observation",
    }));
  }
  return events;
}

function sourceFor(events, { acknowledge } = {}) {
  const state = { cursor: 0, reads: [], acknowledgements: [] };
  const source = {
    async readBatch(options) {
      state.reads.push(structuredClone(options));
      return {
        cursor: state.cursor,
        highWatermark: events.length,
        items: events
          .filter(({ sequence }) => sequence > state.cursor)
          .slice(0, options.limit)
          .map((event) => structuredClone(event)),
      };
    },
    async ack(request) {
      state.acknowledgements.push(structuredClone(request));
      if (acknowledge) return acknowledge(request, state);
      assert.equal(request.sequence, state.cursor + 1);
      state.cursor = request.sequence;
      return {
        status: "applied",
        cursor: state.cursor,
        highWatermark: events.length,
      };
    },
  };
  return { source, state };
}

function journalProducer({ append } = {}) {
  const state = { records: new Map(), calls: [] };
  const producer = {
    async appendBatch(request) {
      state.calls.push(structuredClone(request));
      if (append) return append(request, state);
      let added = 0;
      const items = request.records.map((record) => {
        const normalized = normalizeMemoryRecord(record);
        const created = !state.records.has(normalized.recordId);
        if (created) {
          state.records.set(normalized.recordId, structuredClone(normalized));
          added += 1;
        }
        return { recordId: normalized.recordId, created };
      });
      return {
        added,
        items,
        health: { ready: true, recordCount: state.records.size },
      };
    },
  };
  return { producer, state };
}

function projectorFixture(events = memoryEvents(), options = {}) {
  const source = sourceFor(events, options.source);
  const journal = journalProducer(options.journal);
  return {
    events,
    source,
    journal,
    projector: new CodeJobMemoryProjector({
      projectionSource: source.source,
      memoryProducer: journal.producer,
    }),
  };
}

test("code job memory projector appends one ordered batch then acknowledges each event", async () => {
  const fixture = projectorFixture();

  const result = await fixture.projector.runCycle({ limit: 2 });

  assert.deepEqual(result, {
    observed: 2,
    appended: 2,
    acknowledged: 2,
    cursor: 2,
    highWatermark: 2,
    pending: 0,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(fixture.source.state.reads, [{ limit: 2 }]);
  assert.equal(fixture.journal.state.calls.length, 1);
  assert.equal(fixture.journal.state.calls[0].records.length, 2);
  assert.equal(
    fixture.journal.state.calls[0].records[0].source.kind,
    "code_job",
  );
  assert.equal(
    fixture.journal.state.calls[0].records[0].eventType,
    "code_job.observation",
  );
  for (let index = 0; index < fixture.events.length; index += 1) {
    const event = fixture.events[index];
    const record = normalizeMemoryRecord(
      fixture.journal.state.calls[0].records[index],
    );
    assert.deepEqual(fixture.source.state.acknowledgements[index], {
      sequence: event.sequence,
      eventId: event.eventId,
      eventDigest: event.eventDigest,
      jobId: event.jobId,
      sourceRecordDigest: event.sourceRecordDigest,
      memoryRecordId: record.recordId,
      memoryRecordDigest: record.contentDigest,
    });
  }

  assert.deepEqual(await fixture.projector.runCycle(), {
    observed: 0,
    appended: 0,
    acknowledged: 0,
    cursor: 2,
    highWatermark: 2,
    pending: 0,
  });
  assert.equal(fixture.journal.state.calls.length, 1);
});

test("projector safely replays when the memory append acknowledgement is lost", async () => {
  const events = memoryEvents();
  const source = sourceFor(events);
  let first = true;
  const stored = new Map();
  let calls = 0;
  const failure = new Error("memory append acknowledgement was lost");
  const memoryProducer = {
    async appendBatch({ records }) {
      calls += 1;
      let added = 0;
      const items = records.map((record) => {
        const normalized = normalizeMemoryRecord(record);
        const created = !stored.has(normalized.recordId);
        if (created) {
          stored.set(normalized.recordId, normalized);
          added += 1;
        }
        return { recordId: normalized.recordId, created };
      });
      if (first) {
        first = false;
        throw failure;
      }
      return { added, items };
    },
  };
  const projector = new CodeJobMemoryProjector({
    projectionSource: source.source,
    memoryProducer,
  });

  await assert.rejects(projector.runCycle(), (error) => error === failure);
  assert.equal(source.state.cursor, 0);
  assert.equal(source.state.acknowledgements.length, 0);
  assert.equal(stored.size, 2);

  assert.deepEqual(await projector.runCycle(), {
    observed: 2,
    appended: 0,
    acknowledged: 2,
    cursor: 2,
    highWatermark: 2,
    pending: 0,
  });
  assert.equal(calls, 2);
  assert.equal(stored.size, 2);
});

test("projector resumes after a partially acknowledged batch", async () => {
  const events = memoryEvents();
  const failure = new Error("projection acknowledgement unavailable");
  let failed = false;
  const source = sourceFor(events, {
    acknowledge(request, state) {
      assert.equal(request.sequence, state.cursor + 1);
      if (request.sequence === 2 && !failed) {
        failed = true;
        throw failure;
      }
      state.cursor = request.sequence;
      return {
        status: "applied",
        cursor: state.cursor,
        highWatermark: events.length,
      };
    },
  });
  const journal = journalProducer();
  const projector = new CodeJobMemoryProjector({
    projectionSource: source.source,
    memoryProducer: journal.producer,
  });

  await assert.rejects(projector.runCycle(), (error) => error === failure);
  assert.equal(source.state.cursor, 1);
  assert.equal(journal.state.records.size, 2);

  assert.deepEqual(await projector.runCycle(), {
    observed: 1,
    appended: 0,
    acknowledged: 1,
    cursor: 2,
    highWatermark: 2,
    pending: 0,
  });
  assert.equal(journal.state.calls.length, 2);
  assert.equal(journal.state.calls[1].records.length, 1);
});

test("projector converges when the source stores an ack before losing its response", async () => {
  const events = memoryEvents(1);
  const failure = new Error("store ack was lost");
  let loseResponse = true;
  const source = sourceFor(events, {
    acknowledge(request, state) {
      state.cursor = request.sequence;
      if (loseResponse) {
        loseResponse = false;
        throw failure;
      }
      return {
        status: "already",
        cursor: state.cursor,
        highWatermark: events.length,
      };
    },
  });
  const journal = journalProducer();
  const projector = new CodeJobMemoryProjector({
    projectionSource: source.source,
    memoryProducer: journal.producer,
  });

  await assert.rejects(projector.runCycle(), (error) => error === failure);
  assert.equal(source.state.cursor, 1);
  assert.equal(journal.state.records.size, 1);

  assert.deepEqual(await projector.runCycle(), {
    observed: 0,
    appended: 0,
    acknowledged: 0,
    cursor: 1,
    highWatermark: 1,
    pending: 0,
  });
  assert.equal(journal.state.calls.length, 1);
});

test("projector coalesces cycles and strictly validates ports and options", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const projectionSource = {
    async readBatch() {
      reads += 1;
      await waiting;
      return { cursor: 0, highWatermark: 0, items: [] };
    },
    async ack() {
      throw new Error("must not acknowledge");
    },
  };
  const memoryProducer = {
    async appendBatch() {
      throw new Error("must not append");
    },
  };
  const projector = new CodeJobMemoryProjector({
    projectionSource,
    memoryProducer,
  });

  const first = projector.runCycle({ limit: 10 });
  const second = projector.runCycle({ limit: 1 });
  assert.strictEqual(second, first);
  assert.throws(() => projector.runCycle({ limit: 0 }), /limit/);
  release();
  await first;
  assert.equal(reads, 1);

  assert.throws(
    () => new CodeJobMemoryProjector({ projectionSource: {}, memoryProducer }),
    /projection source/,
  );
  assert.throws(
    () => new CodeJobMemoryProjector({
      projectionSource,
      memoryProducer: {},
    }),
    /memory producer/,
  );
  for (const options of [
    null,
    [],
    { limit: 101 },
    { limit: 1.5 },
    { extra: true },
  ]) {
    assert.throws(() => projector.runCycle(options), /runCycle options|limit/);
  }
  const accessor = {};
  Object.defineProperty(accessor, "limit", {
    enumerable: true,
    get: () => 1,
  });
  assert.throws(() => projector.runCycle(accessor), /runCycle options/);
});

test("projector fails closed on malformed source, append, and ack protocols", async (t) => {
  await t.test("non-contiguous source batch", async () => {
    const events = memoryEvents();
    let appended = false;
    const projector = new CodeJobMemoryProjector({
      projectionSource: {
        async readBatch() {
          return { cursor: 0, highWatermark: 2, items: [events[1]] };
        },
        async ack() {
          throw new Error("must not acknowledge");
        },
      },
      memoryProducer: {
        async appendBatch() {
          appended = true;
          throw new Error("must not append");
        },
      },
    });
    await assert.rejects(
      projector.runCycle(),
      (error) =>
        error.code === "CODE_JOB_MEMORY_SOURCE_INVALID" &&
        error.statusCode === 502,
    );
    assert.equal(appended, false);
  });

  await t.test("tampered source event", async () => {
    const [event] = memoryEvents(1);
    const projector = new CodeJobMemoryProjector({
      projectionSource: {
        async readBatch() {
          return {
            cursor: 0,
            highWatermark: 1,
            items: [{ ...event, eventDigest: "0".repeat(64) }],
          };
        },
        async ack() {
          throw new Error("must not acknowledge");
        },
      },
      memoryProducer: {
        async appendBatch() {
          throw new Error("must not append");
        },
      },
    });

    await assert.rejects(
      projector.runCycle(),
      (error) =>
        error.code === "CODE_JOB_MEMORY_SOURCE_INVALID" &&
        error.statusCode === 502,
    );
  });

  for (const [name, response] of [
    ["wrong record", { added: 1, items: [{ recordId: "memory-wrong", created: true }] }],
    ["wrong added count", { added: 0, items: [{ recordId: null, created: true }] }],
    ["extra receipt field", { added: 1, items: [{ recordId: null, created: true, extra: true }] }],
  ]) {
    await t.test(name, async () => {
      const events = memoryEvents(1);
      const expected = normalizeMemoryRecord(
        memoryRecordForCodeJobEvent(events[0]),
      );
      const supplied = structuredClone(response);
      if (supplied.items[0].recordId === null) {
        supplied.items[0].recordId = expected.recordId;
      }
      let acknowledged = false;
      const source = sourceFor(events, {
        acknowledge() {
          acknowledged = true;
          throw new Error("must not acknowledge");
        },
      });
      const projector = new CodeJobMemoryProjector({
        projectionSource: source.source,
        memoryProducer: { async appendBatch() { return supplied; } },
      });
      await assert.rejects(
        projector.runCycle(),
        (error) =>
          error.code === "CODE_JOB_MEMORY_APPEND_RECEIPT_INVALID" &&
          error.statusCode === 502,
      );
      assert.equal(acknowledged, false);
    });
  }

  await t.test("malformed acknowledgement", async () => {
    const events = memoryEvents(1);
    const source = sourceFor(events, {
      acknowledge() {
        return { status: "applied", cursor: 0, highWatermark: 1 };
      },
    });
    const journal = journalProducer();
    const projector = new CodeJobMemoryProjector({
      projectionSource: source.source,
      memoryProducer: journal.producer,
    });
    await assert.rejects(
      projector.runCycle(),
      (error) =>
        error.code === "CODE_JOB_MEMORY_ACK_INVALID" &&
        error.statusCode === 502,
    );
    assert.equal(journal.state.records.size, 1);
  });
});

test("projector propagates downstream failures without replacing them", async (t) => {
  const events = memoryEvents(1);
  for (const boundary of ["read", "append", "ack"]) {
    await t.test(boundary, async () => {
      const failure = new Error(`${boundary} unavailable`);
      const source = sourceFor(events, {
        acknowledge(request, state) {
          if (boundary === "ack") throw failure;
          state.cursor = request.sequence;
          return {
            status: "applied",
            cursor: state.cursor,
            highWatermark: events.length,
          };
        },
      });
      if (boundary === "read") {
        source.source.readBatch = async () => { throw failure; };
      }
      const journal = journalProducer({
        append(request, state) {
          if (boundary === "append") throw failure;
          let added = 0;
          const items = request.records.map((record) => {
            const normalized = normalizeMemoryRecord(record);
            const created = !state.records.has(normalized.recordId);
            if (created) {
              state.records.set(normalized.recordId, normalized);
              added += 1;
            }
            return { recordId: normalized.recordId, created };
          });
          return { added, items };
        },
      });
      const projector = new CodeJobMemoryProjector({
        projectionSource: source.source,
        memoryProducer: journal.producer,
      });
      await assert.rejects(projector.runCycle(), (error) => error === failure);
    });
  }
});
