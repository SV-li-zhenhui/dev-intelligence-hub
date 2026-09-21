import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRouter } from "../src/domain/workflow-router.js";
import { WorkflowRoutingService } from "../src/services/workflow-routing-service.js";
import {
  normalizeLegacyWorkflowPersistedStateForMigration,
  normalizeWorkflowPersistedState,
} from "../src/services/workflow-routing-state.js";
import { prettySerializedWorkflowBytes } from "../src/services/workflow-routing-values.js";

const STATE_KEY = "workflow-routing-state";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([key, value]) => [key, clone(value)]),
    );
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? clone(this.values.get(name)) : clone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copied = clone(value);
    this.values.set(name, copied);
    this.writes.push({ name, value: copied });
  }

  failNextWrite(error = new Error("durable write unavailable")) {
    this.nextWriteError = error;
  }

  stored(name) {
    return clone(this.values.get(name));
  }

  replaceStored(name, value) {
    this.values.set(name, clone(value));
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

function workflowConfig() {
  return {
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [
      {
        id: "pr-review",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: {
          op: "globAny",
          path: "eventType",
          patterns: ["pull_request.*"],
        },
        targets: [{ type: "role", id: "pr-reviewer" }],
        onMatch: "stop",
      },
    ],
  };
}

function workflowEvent(number, overrides = {}) {
  return {
    schemaVersion: 1,
    eventType: "pull_request.created",
    occurredAt: new Date(
      Date.parse("2026-08-02T01:00:00.000Z") + number * 1_000,
    ).toISOString(),
    source: { provider: "github", scopeId: "acme/repo" },
    subject: {
      id: `github:pr:acme/repo#${number}`,
      repository: "acme/repo",
      number,
    },
    payload: { number, author: "octocat", labels: ["risk:high"] },
    ...overrides,
  };
}

function workflowSnapshot(count) {
  return {
    refreshedAt: "2026-08-02T03:00:00.000Z",
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: true, stale: false },
    },
    items: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return {
        id: `github:pr:acme/repo#${number}`,
        kind: "pull_request",
        repo: "acme/repo",
        number,
        title: `PR ${number}`,
        author: "octocat",
        state: "OPEN",
        labels: [],
      };
    }),
  };
}

function incrementingClock() {
  let tick = 0;
  const epoch = Date.parse("2026-08-02T02:00:00.000Z");
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}

async function createService({
  store = new MemoryStore(),
  exclusiveLease = new ExclusiveLease(),
  recordLimit,
  stateByteBudget,
} = {}) {
  const service = new WorkflowRoutingService({
    store,
    router: createWorkflowRouter(),
    clock: incrementingClock(),
    exclusiveLease,
    ...(recordLimit === undefined ? {} : { recordLimit }),
    ...(stateByteBudget === undefined ? {} : { stateByteBudget }),
  });
  await service.recover();
  return { service, store };
}

async function configure(service) {
  await service.replaceConfig({
    definition: workflowConfig(),
    expectedVersion: 0,
    changedBy: "owner",
  });
}

function asV1State(state) {
  const {
    assignmentFeed: _assignmentFeed,
    assignmentHighWatermark: _assignmentHighWatermark,
    assignmentOldestAvailableSequence: _assignmentOldestAvailableSequence,
    ...legacy
  } = state;
  return { ...legacy, schemaVersion: 1 };
}

test("assignment feed is empty before routing and uses the current cursor", async () => {
  const { service } = await createService();
  await configure(service);

  assert.deepEqual(await service.readAssignmentBatch({ afterSequence: 0 }), {
    items: [],
    nextSequence: 0,
    highWatermark: 0,
    oldestAvailableSequence: 1,
  });
});

test("assignment feed cursors reject accessors and future positions", async () => {
  const { service } = await createService();
  await configure(service);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "afterSequence", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });

  await assert.rejects(
    service.readAssignmentBatch(accessor),
    (error) => error.code === "WORKFLOW_ASSIGNMENT_CURSOR_INVALID",
  );
  await assert.rejects(
    service.readAssignmentBatch({ afterSequence: 1 }),
    (error) => error.code === "WORKFLOW_ASSIGNMENT_CURSOR_INVALID",
  );
  await assert.rejects(
    service.readAssignmentBatch({ afterSequence: 0, limit: 101 }),
    (error) => error.code === "WORKFLOW_ASSIGNMENT_QUERY_INVALID",
  );
  assert.equal(getterCalls, 0);
});

test("assignment feed pages oldest-first with complete normalized events", async () => {
  const { service } = await createService();
  await configure(service);
  const routed = [];
  for (let number = 1; number <= 3; number += 1) {
    routed.push(await service.ingest({ event: workflowEvent(number) }));
  }

  const first = await service.readAssignmentBatch({
    afterSequence: 0,
    limit: 2,
  });
  assert.equal(first.highWatermark, 3);
  assert.equal(first.oldestAvailableSequence, 1);
  assert.equal(first.nextSequence, 2);
  assert.deepEqual(
    first.items.map(({ sequence, assignment }) => [
      sequence,
      assignment.assignmentId,
    ]),
    [
      [1, routed[0].assignments[0].assignmentId],
      [2, routed[1].assignments[0].assignmentId],
    ],
  );
  assert.deepEqual(first.items[0].event, routed[0].event);
  assert.notStrictEqual(first.items[0].event, routed[0].event);

  const second = await service.readAssignmentBatch({
    afterSequence: first.nextSequence,
    limit: 2,
  });
  assert.deepEqual(second.items.map(({ sequence }) => sequence), [3]);
  assert.equal(second.nextSequence, 3);
  assert.deepEqual(await service.readAssignmentBatch({ afterSequence: 3 }), {
    items: [],
    nextSequence: 3,
    highWatermark: 3,
    oldestAvailableSequence: 1,
  });
});

test("content replay does not allocate a second assignment sequence", async () => {
  const { service } = await createService();
  await configure(service);
  const event = workflowEvent(42);

  const first = await service.ingest({ event });
  const replay = await service.ingest({ event });
  const feed = await service.readAssignmentBatch({ afterSequence: 0 });

  assert.equal(first.deduplicated, false);
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(feed.items.map(({ sequence }) => sequence), [1]);
  assert.equal(feed.highWatermark, 1);
});

test("retention reports a stable gap instead of silently skipping assignments", async () => {
  const { service } = await createService({ recordLimit: 2 });
  await configure(service);
  for (let number = 1; number <= 3; number += 1) {
    await service.ingest({ event: workflowEvent(number) });
  }

  await assert.rejects(
    service.readAssignmentBatch({ afterSequence: 0 }),
    (error) => {
      assert.equal(error.code, "WORKFLOW_ASSIGNMENT_GAP");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {
        afterSequence: 0,
        expectedSequence: 1,
        oldestAvailableSequence: 2,
        highWatermark: 3,
      });
      assert.equal(Object.isFrozen(error.details), true);
      return true;
    },
  );
  const retained = await service.readAssignmentBatch({ afterSequence: 1 });
  assert.deepEqual(retained.items.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(retained.oldestAvailableSequence, 2);
  assert.equal(retained.highWatermark, 3);
});

test("a failed durable ingest does not advance the assignment sequence", async () => {
  const { service, store } = await createService();
  await configure(service);
  const durableBefore = store.stored(STATE_KEY);
  store.failNextWrite();

  await assert.rejects(
    service.ingest({ event: workflowEvent(1) }),
    (error) => error.code === "WORKFLOW_STATE_WRITE_FAILED",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
  assert.deepEqual(await service.readAssignmentBatch({ afterSequence: 0 }), {
    items: [],
    nextSequence: 0,
    highWatermark: 0,
    oldestAvailableSequence: 1,
  });

  await service.ingest({ event: workflowEvent(1) });
  await service.ingest({ event: workflowEvent(2) });
  const recovered = await service.readAssignmentBatch({ afterSequence: 0 });
  assert.deepEqual(recovered.items.map(({ sequence }) => sequence), [1, 2]);
});

test("shared single-writer lease allocates unique sequences across services", async () => {
  const store = new MemoryStore();
  const exclusiveLease = new ExclusiveLease();
  const first = await createService({ store, exclusiveLease });
  const second = await createService({ store, exclusiveLease });
  await configure(first.service);

  await Promise.all([
    first.service.ingest({ event: workflowEvent(1) }),
    second.service.ingest({ event: workflowEvent(2) }),
  ]);
  const batch = await first.service.readAssignmentBatch({ afterSequence: 0 });

  assert.deepEqual(batch.items.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(new Set(batch.items.map(({ assignment }) => assignment.assignmentId)).size, 2);
});

test("recovery atomically upgrades v1 assignments in durable order", async () => {
  const original = await createService();
  await configure(original.service);
  const routed = await original.service.ingestSnapshot({
    snapshot: workflowSnapshot(122),
  });
  const assignmentIds = routed.assignments.map(
    ({ assignmentId }) => assignmentId,
  );
  assert.equal(assignmentIds.length, 122);
  const v1 = asV1State(original.store.stored(STATE_KEY));
  const legacyRevision = v1.revision;
  const store = new MemoryStore({ [STATE_KEY]: v1 });

  const recovered = await createService({ store });
  const durable = store.stored(STATE_KEY);
  const batch = await recovered.service.readAssignmentBatch({
    afterSequence: 0,
    limit: 100,
  });
  const remainder = await recovered.service.readAssignmentBatch({
    afterSequence: batch.nextSequence,
    limit: 100,
  });

  assert.equal(durable.schemaVersion, 2);
  assert.equal(durable.revision, legacyRevision + 1);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(
    [...batch.items, ...remainder.items].map(({ sequence, assignment }) => [
      sequence,
      assignment.assignmentId,
    ]),
    assignmentIds.map((assignmentId, index) => [index + 1, assignmentId]),
  );
  assert.equal(durable.assignmentHighWatermark, 122);
  assert.equal(durable.assignmentOldestAvailableSequence, 1);
});

test("v1 migration retains whole bundles when only the temporary v2 exceeds the exact legacy byte budget", async () => {
  const original = await createService();
  await configure(original.service);
  const routed = [];
  for (let number = 1; number <= 3; number += 1) {
    routed.push(await original.service.ingest({ event: workflowEvent(number) }));
  }
  const v1 = asV1State(original.store.stored(STATE_KEY));
  const v1Bytes = prettySerializedWorkflowBytes(v1);
  const temporaryV2 = normalizeLegacyWorkflowPersistedStateForMigration(v1, {
    stateByteBudget: v1Bytes,
  });

  assert.equal(prettySerializedWorkflowBytes(v1), v1Bytes);
  assert.ok(prettySerializedWorkflowBytes(temporaryV2) > v1Bytes);
  assert.throws(
    () =>
      normalizeWorkflowPersistedState(temporaryV2, {
        stateByteBudget: v1Bytes,
      }),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );

  const store = new MemoryStore({ [STATE_KEY]: v1 });
  const recovered = await createService({ store, stateByteBudget: v1Bytes });
  const durable = store.stored(STATE_KEY);
  const retainedEventIds = durable.events.map(({ eventId }) => eventId);

  assert.equal(store.writes.length, 1);
  assert.equal(durable.schemaVersion, 2);
  assert.equal(durable.revision, v1.revision + 1);
  assert.ok(prettySerializedWorkflowBytes(durable) <= v1Bytes);
  assert.ok(durable.events.length > 0);
  assert.ok(durable.events.length < v1.events.length);
  assert.deepEqual(
    retainedEventIds,
    routed.slice(-durable.events.length).map(({ event }) => event.eventId),
  );
  assert.equal(durable.events.length, durable.assignments.length);
  assert.equal(durable.events.length, durable.assignmentFeed.length);
  assert.equal(durable.events.length, durable.audit.length);
  assert.equal(durable.assignmentHighWatermark, 3);
  assert.equal(
    durable.assignmentOldestAvailableSequence,
    4 - durable.assignmentFeed.length,
  );

  const batch = await recovered.service.readAssignmentBatch({
    afterSequence: durable.assignmentOldestAvailableSequence - 1,
  });
  assert.deepEqual(
    batch.items.map(({ sequence }) => sequence),
    durable.assignmentFeed.map(({ sequence }) => sequence),
  );
});

test("v1 migration rejects a legacy state one byte over budget without writing", async () => {
  const original = await createService();
  await configure(original.service);
  await original.service.ingest({ event: workflowEvent(1) });
  const v1 = asV1State(original.store.stored(STATE_KEY));
  const v1Bytes = prettySerializedWorkflowBytes(v1);
  const store = new MemoryStore({ [STATE_KEY]: v1 });

  await assert.rejects(
    createService({ store, stateByteBudget: v1Bytes - 1 }),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.stored(STATE_KEY), v1);
});

test("a failed v1 migration leaves legacy state intact for exact retry", async () => {
  const original = await createService();
  await configure(original.service);
  await original.service.ingest({ event: workflowEvent(1) });
  const v1 = asV1State(original.store.stored(STATE_KEY));
  const store = new MemoryStore({ [STATE_KEY]: v1 });
  store.failNextWrite();

  await assert.rejects(
    createService({ store }),
    (error) => error.code === "WORKFLOW_STATE_WRITE_FAILED",
  );
  assert.deepEqual(store.stored(STATE_KEY), v1);

  const retried = await createService({ store });
  const batch = await retried.service.readAssignmentBatch({ afterSequence: 0 });
  assert.deepEqual(batch.items.map(({ sequence }) => sequence), [1]);
});

test("recovery rejects assignment feed references and sequence gaps", async () => {
  const original = await createService();
  await configure(original.service);
  await original.service.ingest({ event: workflowEvent(1) });
  await original.service.ingest({ event: workflowEvent(2) });
  const corrupted = original.store.stored(STATE_KEY);
  corrupted.assignmentFeed[1].sequence = 3;
  const store = new MemoryStore({ [STATE_KEY]: corrupted });

  await assert.rejects(
    createService({ store }),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
});
