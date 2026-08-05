import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { normalizeAttentionRequest } from "../src/domain/attention-contract.js";
import {
  createAttentionItem,
  resolveAttentionItem,
} from "../src/services/attention-inbox-state.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
  workProposalDigest,
} from "../src/domain/work-proposal-contract.js";
import {
  createDeliveryEvidenceTarget,
} from "../src/domain/delivery-evidence-contract.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import {
  normalizeWorkLedgerLimits,
  WORK_LEDGER_STATE_SCHEMA_VERSION,
} from "../src/services/work-ledger-state.js";
import {
  migrateWorkGraphMemoryProjection,
} from "../src/services/work-ledger-graph-memory.js";

const STATE_KEY = "work-ledger-state";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
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

  stored(name = STATE_KEY) {
    return clone(this.values.get(name));
  }

  replaceStored(value, name = STATE_KEY) {
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

class FakeAssignmentSource {
  constructor(records = []) {
    this.records = records.map(clone);
    this.calls = [];
    this.oldestAvailableSequence = records.length ? records[0].sequence : 1;
    this.highWatermark = records.length ? records.at(-1).sequence : 0;
    this.override = null;
  }

  async readAssignmentBatch(request) {
    this.calls.push(clone(request));
    if (this.override) return this.override(request);
    const items = this.records
      .filter(({ sequence }) => sequence > request.afterSequence)
      .slice(0, request.limit);
    return clone({
      items,
      nextSequence: items.at(-1)?.sequence ?? request.afterSequence,
      highWatermark: this.highWatermark,
      oldestAvailableSequence: this.oldestAvailableSequence,
    });
  }
}

function assignment(sequence, target = { type: "role", id: "pr-reviewer" }) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: `workflow-event-${sequence}`,
      target,
      reason: `route-${sequence}`,
      createdAt: "2026-08-02T01:00:00.000Z",
    },
    event: {
      schemaVersion: 1,
      eventId: `workflow-event-${sequence}`,
      eventType: sequence % 2 ? "pull_request.created" : "issue.created",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: { id: `subject-${sequence}` },
      payload: { number: sequence, title: `Work ${sequence}` },
    },
  };
}

function controlledClock(initial = "2026-08-02T02:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now).toISOString(),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function incrementingIds() {
  let next = 1;
  return () => `lease-${String(next++).padStart(4, "0")}`;
}

async function createFixture({
  records = [],
  source = new FakeAssignmentSource(records),
  store = new MemoryStore(),
  lease = new ExclusiveLease(),
  time = controlledClock(),
  limits,
  actionAdmissionGate,
} = {}) {
  const service = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: time.clock,
    idFactory: incrementingIds(),
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
    ...(limits ? { limits } : {}),
  });
  await service.recover();
  return { service, source, store, lease, time };
}

test("an explicit invalid ledger admission gate never degrades to direct mode", async () => {
  await assert.rejects(
    createFixture({ actionAdmissionGate: null }),
    /actionAdmissionGate must provide run\(operation\)/,
  );
});

test("intake atomically advances its cursor and preserves unresolved targets", async () => {
  const records = [
    assignment(1, { type: "role", id: "missing-role" }),
    assignment(2, { type: "person", id: "missing-person" }),
    assignment(3, { type: "node", id: "missing-node" }),
  ];
  const { service, source, store } = await createFixture({ records });

  const result = await service.intake({ limit: 10 });
  const page = await service.listItems({ limit: 10 });
  const timeline = await service.listTimeline({ limit: 20 });
  const summary = await service.getSummary();

  assert.deepEqual(source.calls, [{ afterSequence: 0, limit: 10 }]);
  assert.equal(result.received, 3);
  assert.equal(result.deduplicated, 0);
  assert.equal(result.cursor, 3);
  assert.equal(result.gap, null);
  assert.equal(summary.intakeCursor, 3);
  assert.equal(summary.itemCounts.queued, 3);
  assert.deepEqual(
    page.items.map(({ assignmentId, status, currentTarget }) => ({
      assignmentId,
      status,
      currentTarget,
    })),
    records.map(({ assignment }) => ({
      assignmentId: assignment.assignmentId,
      status: "queued",
      currentTarget: assignment.target,
    })),
  );
  assert.equal(page.items.every((item) => item.inputDigest.length === 64), true);
  assert.equal(
    timeline.items.filter(({ type }) => type === "assignment_intaken").length,
    3,
  );
  assert.equal(timeline.items.at(-1).type, "intake_completed");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].name, STATE_KEY);
  assert.equal(store.writes[0].value.intakeCursor, 3);
  assert.equal(store.writes[0].value.items.length, 3);
});

test("a failed intake write advances neither the durable cursor nor live items", async () => {
  const { service, source, store } = await createFixture({
    records: [assignment(1)],
  });
  store.failNextWrite();

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await service.getSummary()).intakeCursor, 0);
  assert.deepEqual((await service.listItems()).items, []);
  assert.equal(store.stored(), undefined);

  const retried = await service.intake();
  assert.equal(retried.cursor, 1);
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
  assert.equal(store.stored().items.length, 1);
});

test("a source retention gap creates a durable blocked system alert without skipping", async () => {
  const source = new FakeAssignmentSource([assignment(5), assignment(6)]);
  source.oldestAvailableSequence = 5;
  const { service } = await createFixture({ source });

  const first = await service.intake();
  const repeated = await service.intake();
  const items = (await service.listItems({ limit: 10 })).items;
  const timeline = (await service.listTimeline({ limit: 20 })).items;

  assert.deepEqual(first.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 6,
    reason: "source_retention",
  });
  assert.equal(first.cursor, 0);
  assert.equal(repeated.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
  assert.equal(items[0].currentTarget.type, "node");
  assert.equal(items[0].currentTarget.id, "work-ledger-system");
  assert.equal(
    timeline.filter(({ type }) => type === "intake_gap").length,
    2,
  );
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
});

test("an internal source sequence gap is blocked as a system alert before partial intake", async () => {
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [assignment(1), assignment(3)],
    nextSequence: 3,
    highWatermark: 3,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  const result = await service.intake();
  const items = (await service.listItems()).items;

  assert.deepEqual(result.gap, {
    expectedSequence: 2,
    actualSequence: 3,
    highWatermark: 3,
    reason: "source_sequence",
  });
  assert.equal(result.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
});

test("configuration-first admission neither intakes nor claims work", async (t) => {
  await t.test("intake", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.intake(),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fixture.source.calls.length, 0);
    assert.equal(fixture.store.writes.length, 0);
    assert.deepEqual((await fixture.service.listItems()).items, []);
  });

  await t.test("claim", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await fixture.service.intake();
    const queued = (await fixture.service.listItems()).items[0];
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.claim({
        itemId: queued.itemId,
        expectedRevision: queued.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    const unchanged = (await fixture.service.listItems()).items[0];
    assert.equal(unchanged.status, "queued");
    assert.equal(unchanged.revision, queued.revision);
    assert.equal(fixture.store.writes.length, 1);
  });
});

test("intake-first admission releases cutover before its source settles", async () => {
  const gate = readyActionAdmissionGate();
  const sourceEntered = deferred();
  const releaseSource = deferred();
  const source = new FakeAssignmentSource([assignment(1)]);
  source.override = async ({ afterSequence, limit }) => {
    sourceEntered.resolve();
    await releaseSource.promise;
    return {
      items: source.records
        .filter(({ sequence }) => sequence > afterSequence)
        .slice(0, limit),
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    };
  };
  const fixture = await createFixture({
    source,
    actionAdmissionGate: gate,
  });

  const intake = fixture.service.intake();
  await sourceEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseSource.resolve();
  assert.equal((await intake).received, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("claim-first admission releases cutover before its durable write settles", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const writeEntered = deferred();
  const releaseWrite = deferred();
  const write = fixture.store.write.bind(fixture.store);
  let deferNextWrite = true;
  fixture.store.write = async (...args) => {
    if (deferNextWrite) {
      deferNextWrite = false;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return write(...args);
  };

  const claim = fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await writeEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseWrite.resolve();
  const claimed = await claim;
  assert.equal(claimed.status, "working");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("trusted reconciliation rereads one durable item without new intake", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const concurrent = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await concurrent.recover();
  const claimed = await concurrent.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await activateNextConfiguration(gate);
  const sourceCalls = fixture.source.calls.length;

  const reconciled = await fixture.service.readItemForReconciliation({
    itemId: queued.itemId,
  });

  assert.equal(reconciled.status, "working");
  assert.equal(reconciled.revision, claimed.revision);
  assert.equal(reconciled.leaseId, claimed.leaseId);
  assert.equal(fixture.source.calls.length, sourceCalls);
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(
    fixture.service.readItemForReconciliation({ itemId: queued.itemId, extra: true }),
    (error) => error?.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("claim records a bounded lease, revision, and immutable input digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];

  const claimed = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "working");
  assert.equal(claimed.revision, queued.revision + 1);
  assert.equal(claimed.leaseId, "lease-0001");
  assert.equal(claimed.leaseUntil, "2026-08-02T02:00:30.000Z");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(claimed.inputDigest, queued.inputDigest);
  assert.equal(claimed.attempt, 1);

  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: queued.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: claimed.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_ACTIVE",
  );
});

test("graph dependencies and child ownership block work before a lease is issued", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [consumer, prerequisite] = durable.items;
  consumer.graph.dependsOnItemIds = [prerequisite.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.claim({
      itemId: consumer.itemId,
      expectedRevision: consumer.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let gate = await recovered.claim({
    itemId: prerequisite.itemId,
    expectedRevision: prerequisite.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  gate = await recovered.complete({
    itemId: gate.itemId,
    expectedRevision: gate.revision,
    leaseId: gate.leaseId,
    actorId: "employee-pr-reviewer",
    result: { outcome: "prerequisite-complete" },
  });
  assert.equal(gate.status, "completed");
  const readyConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const claimed = await recovered.claim({
    itemId: readyConsumer.itemId,
    expectedRevision: readyConsumer.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");

  const parentFixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await parentFixture.service.intake();
  const parentState = parentFixture.store.stored();
  const [parent, child] = parentState.items;
  child.graph.parentItemId = parent.itemId;
  parentFixture.store.replaceStored(parentState);
  const parentService = new WorkLedgerService({
    store: parentFixture.store,
    assignmentSource: parentFixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: parentFixture.time.clock,
    idFactory: incrementingIds(),
  });
  await parentService.recover();
  await assert.rejects(
    parentService.claim({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("completion reports an ordinary graph conflict before corrupt-state handling", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-orchestrator",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.complete({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      leaseId: parent.leaseId,
      actorId: "employee-orchestrator",
      result: { outcome: "premature" },
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation atomically closes a safe subtree and blocks its dependents", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child, dependent] = durable.items;
  child.graph.parentItemId = root.itemId;
  dependent.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "owner-cancelled-scope",
  };

  const result = await recovered.cancelGraphTask(request);

  assert.equal(result.root.status, "cancelled");
  assert.deepEqual(result.cancelledItemIds, [child.itemId, root.itemId].sort());
  const byId = new Map(
    (await recovered.listItems({ limit: 10 })).items.map((item) => [
      item.itemId,
      item,
    ]),
  );
  assert.equal(byId.get(root.itemId).status, "cancelled");
  assert.equal(byId.get(child.itemId).status, "cancelled");
  assert.equal(byId.get(dependent.itemId).status, "queued");
  const writesAfterCancellation = fixture.store.writes.length;
  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  const cancelledRoot = byId.get(root.itemId);
  const replay = await recovered.cancelGraphTask({
    ...request,
    expectedGraphRevision: fixture.store.stored().revision,
    expectedRevision: cancelledRoot.revision,
  });
  assert.equal(replay.root.status, "cancelled");
  assert.deepEqual(replay.cancelledItemIds, []);
  assert.equal(fixture.store.writes.length, writesAfterCancellation);
  await assert.rejects(
    recovered.claim({
      itemId: dependent.itemId,
      expectedRevision: dependent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
  const cancelledEvents = (await recovered.listTimeline({ limit: 20 })).items
    .filter(({ type }) => type === "cancelled");
  assert.equal(cancelledEvents.length, 2);

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
  assert.equal(
    (await restarted.listItems({ status: "cancelled" })).items.length,
    2,
  );
});

test("graph cancellation refuses an active descendant and invokes no DTO accessors", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child] = durable.items;
  child.graph.parentItemId = root.itemId;
  Object.assign(child, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "child-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "cancel-tree",
  };

  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) =>
      error.code === "WORK_LEDGER_CANCELLATION_UNSAFE" &&
      error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let invoked = false;
  const hostile = { ...request };
  Object.defineProperty(hostile, "reason", {
    enumerable: true,
    get() {
      invoked = true;
      return "hidden";
    },
  });
  await assert.rejects(
    recovered.cancelGraphTask(hostile),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_INVALID",
  );
  assert.equal(invoked, false);
});

test("graph cancellation refuses an already active reverse dependency consumer", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [dependency, consumer] = durable.items;
  consumer.graph.dependsOnItemIds = [dependency.itemId];
  Object.assign(consumer, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "consumer-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: dependency.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: dependency.revision,
      actorId: "employee-orchestrator",
      reason: "dependency-invalidated",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation refuses an active ancestor", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-planner",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: child.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: child.revision,
      actorId: "employee-orchestrator",
      reason: "child-no-longer-needed",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("completed descendants do not create false active-dependent cancellation conflicts", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  let durable = fixture.store.stored();
  const [root, child, consumer] = durable.items;
  child.graph.parentItemId = root.itemId;
  consumer.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  let completedChild = await recovered.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  completedChild = await recovered.complete({
    itemId: child.itemId,
    expectedRevision: completedChild.revision,
    leaseId: completedChild.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  const currentConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const workingConsumer = await recovered.claim({
    itemId: consumer.itemId,
    expectedRevision: currentConsumer.revision,
    workerId: "employee-consumer",
    leaseDurationMs: 30_000,
  });
  assert.equal(workingConsumer.status, "working");

  durable = fixture.store.stored();
  const currentRoot = durable.items.find(({ itemId }) => itemId === root.itemId);
  const result = await recovered.cancelGraphTask({
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: currentRoot.revision,
    actorId: "employee-orchestrator",
    reason: "remaining-root-work-cancelled",
  });

  assert.deepEqual(result.cancelledItemIds, [root.itemId]);
  assert.equal(result.root.status, "cancelled");
  assert.equal(
    (await recovered.listItems()).items.find(
      ({ itemId }) => itemId === child.itemId,
    ).status,
    "completed",
  );
});

test("an expired working lease is recoverable and every claim is auditable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const first = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-first",
    leaseDurationMs: 1_000,
  });
  fixture.time.advance(1_000);

  const recovered = await fixture.service.claim({
    itemId: first.itemId,
    expectedRevision: first.revision,
    workerId: "employee-recovery",
    leaseDurationMs: 2_000,
  });
  const types = (await fixture.service.listTimeline({ limit: 20 })).items.map(
    ({ type }) => type,
  );

  assert.equal(recovered.leaseId, "lease-0002");
  assert.equal(recovered.ownerId, "employee-recovery");
  assert.equal(recovered.attempt, 2);
  assert.deepEqual(
    types.filter((type) => ["lease_expired", "claimed"].includes(type)),
    ["claimed", "lease_expired", "claimed"],
  );
});

test("every working command rejects the old worker exactly at lease expiry without writing", async (t) => {
  const cases = [
    {
      name: "transition",
      invoke: (service, item) => service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-old",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
    },
    {
      name: "scheduleRetry",
      invoke: (service, item) => service.scheduleRetry({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        availableAt: "2026-08-02T02:02:00.000Z",
        reason: "temporary-failure",
      }),
    },
    {
      name: "handoff",
      invoke: (service, item) => service.handoff({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        target: { type: "role", id: "tester" },
        reason: "ready-for-testing",
      }),
    },
    {
      name: "complete",
      invoke: (service, item) => service.complete({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        result: { outcome: "done" },
      }),
    },
    {
      name: "stageIntent",
      invoke: (service, item) => service.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        roleId: "pr-reviewer",
        intent: reviewIntent(),
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      await fixture.service.intake();
      let item = (await fixture.service.listItems()).items[0];
      item = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-old",
        leaseDurationMs: 1_000,
      });
      fixture.time.advance(1_000);
      const writesBefore = fixture.store.writes.length;

      await assert.rejects(
        entry.invoke(fixture.service, item),
        (error) =>
          error.code === "WORK_LEDGER_LEASE_EXPIRED" &&
          error.statusCode === 409,
      );

      assert.equal(fixture.store.writes.length, writesBefore);
      assert.equal((await fixture.service.listItems()).items[0].status, "working");
      const recovered = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-recovery",
        leaseDurationMs: 1_000,
      });
      assert.equal(recovered.ownerId, "employee-recovery");
      assert.equal(recovered.attempt, 2);
    });
  }
});

test("assignment input rejects accessors without invoking them", async () => {
  let invoked = false;
  const unsafeAssignment = assignment(1);
  Object.defineProperty(unsafeAssignment.event.payload, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("must not run");
    },
  });
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [unsafeAssignment],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_SOURCE_INVALID",
  );
  assert.equal(invoked, false);
  assert.equal((await service.getSummary()).intakeCursor, 0);
});

test("transition requires the exact item revision and active work lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: "wrong-lease",
      toStatus: "waiting_user",
      actorId: "employee-pr-reviewer",
      reason: "need-product-choice",
      details: { questionRef: "question-1" },
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_CONFLICT",
  );

  const waiting = await fixture.service.transition({
    itemId: working.itemId,
    expectedRevision: working.revision,
    leaseId: working.leaseId,
    toStatus: "waiting_user",
    actorId: "employee-pr-reviewer",
    reason: "need-product-choice",
    details: { questionRef: "question-1" },
  });

  assert.equal(waiting.status, "waiting_user");
  assert.equal(waiting.ownerId, null);
  assert.equal(waiting.leaseId, null);
  assert.equal(waiting.leaseUntil, null);
  assert.equal(waiting.statusReason, "need-product-choice");
  assert.equal(waiting.revision, working.revision + 1);

  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: working.revision,
      toStatus: "queued",
      actorId: "owner",
      reason: "answered",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      toStatus: "dispatch_pending",
      actorId: "owner",
      reason: "bypass-outbox",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_TRANSITION_INVALID",
  );
});

test("retry, handoff, and completion are explicit durable timeline events", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.scheduleRetry({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    availableAt: "2026-08-02T02:01:00.000Z",
    reason: "ci-still-running",
  });

  assert.equal(item.status, "retry_wait");
  assert.equal(item.availableAt, "2026-08-02T02:01:00.000Z");
  await assert.rejects(
    fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_NOT_AVAILABLE",
  );

  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.handoff({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    target: { type: "role", id: "requirements-analyst" },
    reason: "requirement-unclear",
  });

  assert.equal(item.status, "queued");
  assert.deepEqual(item.currentTarget, {
    type: "role",
    id: "requirements-analyst",
  });
  assert.equal(item.assignment.target.id, "pr-reviewer");

  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-requirements",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.complete({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-requirements",
    result: { outcome: "clarified", evidenceRefs: ["note-1"] },
  });

  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(item.status, "completed");
  assert.equal(item.leaseId, null);
  assert.equal(types.includes("retry_scheduled"), true);
  assert.equal(types.includes("handed_off"), true);
  assert.equal(types.includes("completed"), true);
});

function reviewIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_github_review",
    summary: "建议批准 PR",
    reason: "检查通过",
    verdict: "approve",
    body: "本地审查未发现阻塞问题。",
    evidence: ["tests:passed"],
    ...overrides,
  };
}

function boundReviewIntent(item, overrides = {}) {
  const content = {
    policyVersion: 4,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    },
    binding: {
      repository: "acme/repo",
      pullRequestNumber: 41,
    },
    payload: {
      verdict: "approve",
      body: "本地审查未发现阻塞问题。",
      evidence: ["tests:passed"],
    },
    ...overrides,
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

async function prepareClaimedReviewIntent(fixture, leaseDurationMs = 30_000) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { item, staged, claimed };
}

function codeActionIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_code_action",
    summary: "修改受控代码",
    reason: "需要验证修复",
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["回归测试通过"],
    evidence: ["revision 未校验"],
    ...overrides,
  };
}

function handoffIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "handoff",
    summary: "需要测试岗位继续处理",
    reason: "开发检查已经完成",
    capability: "testing",
    brief: "执行跨平台回归",
    evidence: ["unit-tests:passed"],
    ...overrides,
  };
}

function askUserIntent() {
  return {
    schemaVersion: 1,
    type: "ask_user",
    summary: "需要用户确认验收口径",
    reason: "当前事实不足以替用户决定",
    question: "是否继续按当前验收口径推进？",
    choices: [
      { id: "yes", label: "继续", description: "保持当前口径" },
      { id: "no", label: "停止", description: "退回重新梳理" },
    ],
  };
}

function waitIntent(condition) {
  return {
    schemaVersion: 1,
    type: "wait_condition",
    summary: "等待外部事实",
    reason: "事实满足后再重新判断",
    condition,
    checkAfterSeconds: 60,
  };
}

test("stageIntent persists a complete policy-safe intent before dispatch is claimable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBeforeStage = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        ...reviewIntent(),
        dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
      },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBeforeStage);

  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(fixture.store.writes.length, writesBeforeStage + 1);
  assert.equal(staged.item.status, "dispatch_pending");
  assert.equal(staged.item.leaseId, null);
  assert.equal(staged.outbox.status, "pending");
  assert.match(staged.outbox.intentId, /^work-intent-[a-f0-9]{64}$/);
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "pr-reviewer",
    workerId: "employee-pr-reviewer",
  });
  assert.deepEqual(staged.outbox.intent, {
    ...reviewIntent(),
    dispatchIntentId: staged.outbox.intent.dispatchIntentId,
  });
  assert.match(
    staged.outbox.intent.dispatchIntentId,
    /^work-dispatch-intent-[a-f0-9]{64}$/,
  );
  assert.equal(staged.deliverySemantics, "at-least-once-idempotent");
  assert.equal(fixture.store.stored().outbox.length, 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 20 })).items.at(-1).type,
    "intent_staged",
  );

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: staged.item.itemId,
      expectedRevision: staged.item.revision,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        schemaVersion: 1,
        type: "propose_code_action",
        summary: "unsafe",
        reason: "unsafe",
        operation: "modify",
        objective: "unsafe",
        acceptanceCriteria: ["unsafe"],
        evidence: [],
        command: "rm -rf /",
      },
    }),
    (error) => error.code === "WORK_INTENT_INVALID",
  );
});

test("stageIntent binds the active lease owner and target role with one orchestrator exception", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-impostor",
      roleId: "pr-reviewer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  assert.equal(fixture.store.writes.length, writesBefore);

  const takeoverFixture = await createFixture({
    records: [assignment(1, { type: "person", id: "missing-owner" })],
  });
  await takeoverFixture.service.intake();
  let takeover = (await takeoverFixture.service.listItems()).items[0];
  takeover = await takeoverFixture.service.claim({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const askUser = {
    schemaVersion: 1,
    type: "ask_user",
    summary: "目标岗位缺失",
    reason: "需要用户决定安全路由",
    question: "由哪个岗位接手？",
    choices: [],
  };
  await assert.rejects(
    takeoverFixture.service.stageIntent({
      itemId: takeover.itemId,
      expectedRevision: takeover.revision,
      leaseId: takeover.leaseId,
      actorId: "employee-orchestrator",
      roleId: "orchestrator",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  const staged = await takeoverFixture.service.stageIntent({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    leaseId: takeover.leaseId,
    actorId: "employee-orchestrator",
    roleId: "orchestrator",
    intent: askUser,
  });
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "orchestrator",
    workerId: "employee-orchestrator",
  });
});

test("newest ledger query order paginates inside the selected order", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();

  const first = await fixture.service.listItems({ order: "newest", limit: 2 });
  const second = await fixture.service.listItems({
    order: "newest",
    limit: 2,
    cursor: first.nextCursor,
  });
  const timeline = await fixture.service.listTimeline({
    order: "newest",
    limit: 2,
  });

  assert.deepEqual(first.items.map(({ sourceSequence }) => sourceSequence), [3, 2]);
  assert.deepEqual(second.items.map(({ sourceSequence }) => sourceSequence), [1]);
  assert.equal(timeline.items[0].type, "intake_completed");
  await assert.rejects(
    fixture.service.listItems({ order: "sideways" }),
    (error) => error.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("recovery rejects requestedBy tampering because identity is part of the intent digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].requestedBy.workerId = "employee-impostor";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("outbox dispatch uses expiring leases and acknowledgement fences stale workers", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  const first = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 1_000,
  });
  assert.equal(first.status, "dispatching");
  assert.equal(first.dispatchLeaseId, "lease-0002");
  assert.equal(first.attempt, 1);
  assert.equal(first.deliverySemantics, "at-least-once-idempotent");

  await assert.rejects(
    fixture.service.claimIntent({
      intentId: first.intentId,
      expectedRevision: first.revision,
      dispatcherId: "another-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_ACTIVE",
  );
  fixture.time.advance(1_000);
  const recovered = await fixture.service.claimIntent({
    intentId: first.intentId,
    expectedRevision: first.revision,
    dispatcherId: "recovery-dispatcher",
    leaseDurationMs: 2_000,
  });
  assert.equal(recovered.dispatchLeaseId, "lease-0003");
  assert.equal(recovered.attempt, 2);

  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: first.revision,
      dispatchLeaseId: recovered.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: recovered.revision,
      dispatchLeaseId: first.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_CONFLICT",
  );

  const acknowledged = await fixture.service.ackIntent({
    intentId: recovered.intentId,
    expectedRevision: recovered.revision,
    dispatchLeaseId: recovered.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "recovery-dispatcher",
    details: { downstreamRef: "confirmation-1" },
  });

  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.outbox.dispatchLeaseId, null);
  assert.equal(acknowledged.item.status, "waiting_external");
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_acknowledged",
  );
});

test("intent policy binding is durable, idempotent, and fenced by its live lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture, 1_000);
  const boundIntent = boundReviewIntent(staged.item);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent,
  };
  const writesBeforeBinding = fixture.store.writes.length;

  const sealed = await fixture.service.bindIntent(input);

  assert.equal(sealed.revision, claimed.revision + 1);
  assert.deepEqual(sealed.dispatchBinding.boundIntent, boundIntent);
  assert.match(sealed.dispatchBinding.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_bound",
  );

  const replay = await fixture.service.bindIntent(input);
  assert.deepEqual(replay.dispatchBinding, sealed.dispatchBinding);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);

  fixture.time.advance(1_000);
  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_EXPIRED",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    sealed.dispatchBinding,
  );
});

test("a failed binding write leaves the claimed intent exactly retryable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  };
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);

  const retried = await fixture.service.bindIntent(input);
  assert.deepEqual(retried.dispatchBinding.boundIntent, input.boundIntent);
});

test("intent binding rejects stale items and semantically changed plans without writing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const base = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
  };
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.bindIntent({
      ...base,
      itemExpectedRevision: staged.item.revision + 1,
      boundIntent: boundReviewIntent(staged.item),
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  const changedSource = boundReviewIntent(staged.item, {
    source: {
      assignmentId: "workflow-assignment-forged",
      eventId: staged.item.event.eventId,
    },
  });
  await assert.rejects(
    fixture.service.bindIntent({ ...base, boundIntent: changedSource }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
});

test("recovery rejects a tampered durable intent binding", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].dispatchBinding.boundIntent.payload.body = "篡改后的动作";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema v7 quarantines an in-flight intent whose old policy binding is unknowable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await prepareClaimedReviewIntent(fixture, 1_000);
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 7;
  for (const entry of legacy.outbox) delete entry.dispatchBinding;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    { status: "legacy_unknown" },
  );
  const quarantined = (await recovered.listOutbox()).items[0];
  const writesBeforeClaim = fixture.store.writes.length;
  await assert.rejects(
    recovered.claimIntent({
      intentId: quarantined.intentId,
      expectedRevision: quarantined.revision,
      dispatcherId: "recovery-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
  );
  assert.equal(fixture.store.writes.length, writesBeforeClaim);
  assert.equal(fixture.store.stored().schemaVersion, 7);
});

test("a delivered handoff atomically acknowledges the outbox and queues the trusted role", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const writesBeforeAck = fixture.store.writes.length;

  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    target: { type: "role", id: "tester" },
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  });

  assert.equal(fixture.store.writes.length, writesBeforeAck + 1);
  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.item.status, "queued");
  assert.deepEqual(acknowledged.item.currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal(acknowledged.item.assignment.target.id, "pr-reviewer");
  assert.deepEqual(
    (await fixture.service.listTimeline({ limit: 50 })).items
      .slice(-2)
      .map(({ type }) => type),
    ["intent_acknowledged", "handed_off"],
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listItems()).items[0].currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal((await recovered.listOutbox()).items[0].status, "delivered");
});

test("handoff acknowledgement is exact, role-only, and retryable after a failed atomic write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  };

  await assert.rejects(
    fixture.service.ackIntent(base),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "person", id: "someone" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  fixture.store.failNextWrite();
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].status, "dispatching");
  assert.equal((await fixture.service.listItems()).items[0].status, "dispatch_pending");

  const retried = await fixture.service.ackIntent({
    ...base,
    target: { type: "role", id: "tester" },
  });
  assert.equal(retried.outbox.status, "delivered");
  assert.equal(retried.item.status, "queued");
});

test("non-handoff intents cannot use queued acknowledgement or inject a target", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: "bound-review" },
  };

  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "queued",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "waiting_external",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
});

test("the real assignment-feed gap error becomes a blocked alert", async () => {
  const source = new FakeAssignmentSource();
  let oldestAvailableSequence = 5;
  let highWatermark = 8;
  source.override = ({ afterSequence }) => {
    throw Object.assign(new Error("retention gap"), {
      code: "WORKFLOW_ASSIGNMENT_GAP",
      statusCode: 409,
      details: Object.freeze({
        afterSequence,
        expectedSequence: afterSequence + 1,
        oldestAvailableSequence,
        highWatermark,
      }),
    });
  };
  const { service } = await createFixture({ source });

  const result = await service.intake();

  assert.deepEqual(result.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 8,
    reason: "source_retention",
  });
  assert.equal(result.cursor, 0);
  assert.equal((await service.getSummary()).sourceHighWatermark, 8);
  assert.equal((await service.listItems()).items[0].status, "blocked");

  oldestAvailableSequence = 6;
  highWatermark = 9;
  await service.intake();
  assert.equal((await service.listItems()).items.length, 1);
  assert.equal((await service.getSummary()).sourceHighWatermark, 9);
});

test("a reused assignmentId with different input blocks cursor advancement", async () => {
  const source = new FakeAssignmentSource([assignment(1)]);
  const { service } = await createFixture({ source });
  await service.intake({ limit: 1 });
  const conflicting = assignment(2);
  conflicting.assignment.assignmentId = "workflow-assignment-1";
  source.records.push(conflicting);
  source.highWatermark = 2;

  await assert.rejects(
    service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_ASSIGNMENT_CONFLICT",
  );

  assert.equal((await service.getSummary()).intakeCursor, 1);
  assert.equal((await service.listItems()).items.length, 1);
});

test("recovery restores work, timeline, and outbox and rejects input tampering", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const before = {
    summary: await fixture.service.getSummary(),
    items: await fixture.service.listItems(),
    timeline: await fixture.service.listTimeline(),
    outbox: await fixture.service.listOutbox(),
  };
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  assert.deepEqual(await recovered.getSummary(), before.summary);
  assert.deepEqual(await recovered.listItems(), before.items);
  assert.deepEqual(await recovered.listTimeline(), before.timeline);
  assert.deepEqual(await recovered.listOutbox(), before.outbox);

  const tampered = fixture.store.stored();
  tampered.items[0].event.payload.title = "tampered";
  fixture.store.replaceStored(tampered);
  const rejected = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await assert.rejects(
    rejected.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery revalidates the complete work-intent DTO", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].intent.command = "git push --force";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery rejects dispatch-pending work without exactly one active outbox", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox = [];
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a failed intent can be restaged with the same idempotency key", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  let staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatchIntentId = staged.outbox.intent.dispatchIntentId;
  let dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 30_000,
  });
  dispatch = await fixture.service.bindIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "confirmation-bridge",
    dispatchLeaseId: dispatch.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const failed = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "confirmation-bridge",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: failed.item.itemId,
    expectedRevision: failed.item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(staged.outbox.intentId, dispatch.intentId);
  assert.equal(staged.outbox.intent.dispatchIntentId, dispatchIntentId);
  assert.equal(staged.outbox.status, "pending");
  assert.equal(staged.outbox.dispatchBinding, null);
  assert.equal(staged.outbox.attempt, 1);
  assert.equal((await fixture.service.listOutbox()).items.length, 1);
  assert.equal(
    (await fixture.service.listOutbox({ status: "pending" })).items.length,
    1,
  );
  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(types.includes("retry_scheduled"), true);
});

test("capacity rejection leaves the next assignment and cursor retryable", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
    limits: { itemLimit: 1 },
  });
  await fixture.service.intake({ limit: 1 });

  await assert.rejects(
    fixture.service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_CAPACITY_EXCEEDED",
  );

  assert.equal((await fixture.service.getSummary()).intakeCursor, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(fixture.store.stored().intakeCursor, 1);
  assert.deepEqual(
    fixture.source.calls.map(({ afterSequence }) => afterSequence),
    [0, 1],
  );
});

test("timeline retention remains contiguous and recoverable", async () => {
  const fixture = await createFixture({
    records: [assignment(1)],
    limits: { timelineLimit: 3 },
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  const summary = await fixture.service.getSummary();
  const timeline = (await fixture.service.listTimeline()).items;
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.map(({ sequence }) => sequence), [2, 3, 4]);
  assert.equal(summary.timelineStartSequence, 2);
  assert.equal(summary.nextTimelineSequence, 5);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { timelineLimit: 3 },
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listTimeline()).items, timeline);
});

test("services sharing an exclusive lease re-read durable state before writes", async () => {
  const store = new MemoryStore();
  const source = new FakeAssignmentSource([assignment(1)]);
  const lease = new ExclusiveLease();
  const time = controlledClock();
  const first = await createFixture({ store, source, lease, time });
  const second = await createFixture({ store, source, lease, time });
  await first.service.intake();
  const queued = (await first.service.listItems()).items[0];

  const claimed = await second.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-second-process",
    leaseDurationMs: 30_000,
  });
  const waiting = await first.service.transition({
    itemId: claimed.itemId,
    expectedRevision: claimed.revision,
    leaseId: claimed.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-second-process",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  assert.equal(waiting.status, "waiting_condition");
  assert.equal(store.stored().items.length, 1);
  assert.equal(store.stored().items[0].revision, waiting.revision);
});

test("durable revision rollback and same-revision forks fail closed", async (t) => {
  await t.test("rollback", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const rolledBack = fixture.store.stored();
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    fixture.store.replaceStored(rolledBack);

    await assert.rejects(
      fixture.service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-pr-reviewer",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("fork", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const item = (await fixture.service.listItems()).items[0];
    const fork = fixture.store.stored();
    fork.items[0].statusReason = "valid-but-forked";
    fixture.store.replaceStored(fork);

    await assert.rejects(
      fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });
});

test("a failed transition write preserves the active lease for exact retry", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.transition({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "await-ci",
      details: { conditionRef: "ci:pr-1" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await fixture.service.listItems()).items[0].status, "working");
  const retried = await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });
  assert.equal(retried.status, "waiting_condition");
});

test("transition details reject untrusted command-like fields", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: working.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "unsafe",
      details: { command: "git push" },
    }),
    (error) => error.code === "WORK_LEDGER_DETAILS_INVALID",
  );
});

async function prepareAttentionResult(fixture, answer) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const intent = askUserIntent();
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent,
  });
  const request = normalizeAttentionRequest({
    requestKey: staged.outbox.intentId,
    type: "ask_user",
    producer: {
      roleId: "pr-reviewer",
      workItemId: item.itemId,
    },
    question: intent.question,
    context: [],
    choices: intent.choices,
  });
  const attentionItem = createAttentionItem(
    request,
    1,
    "2026-08-02T01:59:00.000Z",
  );
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_user",
    actorId: "work-intent-dispatcher",
    details: {
      questionRef: attentionItem.requestId,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  return resolveAttentionItem(
    attentionItem,
    answer,
    2,
    "2026-08-02T02:00:00.000Z",
    1,
  ).outbox;
}

test("an answered attention result atomically advances its cursor and requeues durable context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  const batch = {
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const waiting = (await fixture.service.listItems()).items[0];
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      actorId: "unbound-system",
      toStatus: "blocked",
      reason: "bypass",
    }),
    (error) => error.code === "WORK_LEDGER_ACTIVE_INTENT_CONFLICT",
  );

  const applied = await fixture.service.applyAttentionBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "queued");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.decisionContext.source, "attention");
  assert.equal(item.decisionContext.outcome, "answered");
  assert.deepEqual(item.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
  assert.equal(summary.attentionCursor, 1);
  assert.equal(summary.attentionHighWatermark, 1);

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyAttentionBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(await recovered.getSummary(), summary);
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    item.decisionContext,
  );
});

test("a rejected attention result blocks work while a gap advances nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "reject",
    reason: "需求需要重新梳理",
  });
  const writesBeforeGap = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.applyAttentionBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_ATTENTION_GAP",
  );
  assert.equal((await fixture.service.getSummary()).attentionCursor, 0);
  assert.equal(fixture.store.writes.length, writesBeforeGap);

  await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.decisionContext.outcome, "rejected");
});

async function prepareProposalResult(
  fixture,
  {
    outcome = "succeeded",
    sequence = 1,
    kind = "github_review_proposal",
    downstreamRef,
    proposalDigest,
    authoritativeEvidence = false,
    intentOverrides = {},
  } = {},
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  const codeProposal = kind === "code_action_proposal";
  const roleId = codeProposal ? "developer" : "pr-reviewer";
  const workerId = `employee-${roleId}`;
  let evidenceTarget;
  if (authoritativeEvidence) {
    const acceptanceContract = {
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [
        {
          deliverableId: codeProposal ? "change-package" : "review-report",
          kind: codeProposal ? "change-package" : "review-report",
          description: codeProposal
            ? "可追溯的代码变更包"
            : "可追溯的 PR 审查报告",
          required: true,
        },
      ],
    };
    const durable = fixture.store.stored();
    const durableItem = durable.items.find(
      ({ itemId }) => itemId === item.itemId,
    );
    durableItem.graph.acceptanceContracts = [
      {
        ...acceptanceContract,
        recordedAt: durableItem.graph.acceptanceContracts[0].recordedAt,
      },
    ];
    durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
      durable.items,
      durable.revision,
      normalizeWorkLedgerLimits(),
    );
    fixture.store.replaceStored(durable);
    fixture.service = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: fixture.lease,
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await fixture.service.recover();
    item = (await fixture.service.listItems()).items[0];
    evidenceTarget = createDeliveryEvidenceTarget({
      taskId: item.itemId,
      roleId,
      acceptanceContract,
    });
  }
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: workerId,
    roleId,
    intent: codeProposal
      ? codeActionIntent(intentOverrides)
      : reviewIntent(intentOverrides),
  });
  const proposalContent = {
    policyVersion: 1,
    kind,
    requestedBy: {
      roleId,
      workItemId: staged.item.itemId,
    },
    source: {
      assignmentId: staged.item.assignmentId,
      eventId: staged.item.event.eventId,
    },
    binding: codeProposal
      ? {
          repository: "acme/repo",
          workspaceId: "dashboard",
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        }
      : {
          repository: "acme/repo",
          pullRequestNumber: 1,
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        },
    payload: codeProposal
      ? {
          operation: "modify",
          objective: "修复并发覆盖",
          acceptanceCriteria: ["回归测试通过"],
        }
      : { verdict: "approve", body: "本地审查通过。" },
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId: authoritativeEvidence
      ? `work-intent-${workProposalDigest(proposalContent)}`
      : `work-intent-${codeProposal ? "c".repeat(64) : "b".repeat(64)}`,
    ...proposalContent,
  });
  let claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  if (evidenceTarget !== undefined) {
    claimed = await fixture.service.bindIntent({
      intentId: claimed.intentId,
      expectedRevision: claimed.revision,
      itemExpectedRevision: staged.item.revision,
      dispatcherId: "work-intent-dispatcher",
      dispatchLeaseId: claimed.dispatchLeaseId,
      boundIntent: {
        intentId: proposal.proposalId,
        ...proposalContent,
      },
    });
  }
  await fixture.service.ackIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    dispatchLeaseId: claimed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "work-intent-dispatcher",
    details: {
      downstreamRef: downstreamRef ?? proposal.proposalId,
      proposalDigest: proposalDigest ?? proposal.contentDigest,
    },
  });
  return createWorkProposalResult({
    proposal,
    sequence,
    transition: {
      status: outcome,
      summary: `提案结果：${outcome}`,
      evidence: ["proposal-audit-1"],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });
}

test("a bound GitHub proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);
  const batch = {
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const applied = await fixture.service.applyProposalBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, "proposal_succeeded");
  assert.equal(item.decisionContext.source, "proposal");
  assert.equal(item.decisionContext.outcome, "succeeded");
  assert.equal(item.decisionContext.value.resultId, result.resultId);
  assert.equal(summary.proposalCursor, 1);
  assert.equal(summary.proposalHighWatermark, 1);
  assert.equal(
    (await fixture.service.listTimeline({ order: "newest" })).items[0].type,
    "proposal_result_applied",
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyProposalBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);
});

test("authoritative proposal evidence requeues graph work with trusted result context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
  });
  const firstOutbox = fixture.store.stored().outbox[0];
  const waiting = (await fixture.service.listItems()).items[0];
  const boundTarget = fixture.store.stored().outbox[0].dispatchBinding
    .boundIntent.binding.evidenceTarget;
  assert.deepEqual(
    boundTarget,
    createDeliveryEvidenceTarget({
      taskId: waiting.itemId,
      roleId: "pr-reviewer",
      acceptanceContract: waiting.graph.acceptanceContracts.at(-1),
    }),
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const queued = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(queued.status, "queued");
  assert.equal(queued.statusReason, "proposal_evidence_ready");
  assert.equal(queued.activeIntentId, null);
  assert.deepEqual(
    {
      source: queued.decisionContext.source,
      referenceId: queued.decisionContext.referenceId,
      outcome: queued.decisionContext.outcome,
      value: queued.decisionContext.value,
      observedAt: queued.decisionContext.observedAt,
    },
    {
      source: "proposal",
      referenceId: result.proposalId,
      outcome: "succeeded",
      value: {
        kind: result.kind,
        resultId: result.resultId,
        resultDigest: result.contentDigest,
        summary: result.summary,
        downstreamRef: result.downstreamRef,
      },
      observedAt: result.at,
    },
  );
  assert.match(queued.decisionContext.contentDigest, /^[a-f0-9]{64}$/);

  const nextTurn = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(nextTurn.decisionContext, queued.decisionContext);
  const continued = await fixture.service.stageIntent({
    itemId: nextTurn.itemId,
    expectedRevision: nextTurn.revision,
    leaseId: nextTurn.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  assert.notEqual(continued.outbox.intentId, firstOutbox.intentId);
  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    firstOutbox.intent.dispatchIntentId,
  );
});

test("a successful intervening proposal starts a new retry identity", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const failedDispatchIntentId = staged.outbox.intent.dispatchIntentId;
  const bound = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  await fixture.service.ackIntent({
    intentId: bound.intentId,
    expectedRevision: bound.revision,
    dispatchLeaseId: bound.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "work-intent-dispatcher",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);

  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
    intentOverrides: {
      summary: "先提交另一份审查",
      body: "另一份独立审查。",
    },
  });
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const continued = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    failedDispatchIntentId,
  );
  const historicalFailure = (await fixture.service.listOutbox()).items.find(
    ({ intent }) => intent.dispatchIntentId === failedDispatchIntentId,
  );
  assert.equal(historicalFailure.status, "failed");
});

test("a bound code proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({
    records: [assignment(1, { type: "role", id: "developer" })],
  });
  const result = await prepareProposalResult(fixture, {
    kind: "code_action_proposal",
  });

  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.statusReason, "proposal_succeeded");
});

test("proposal results reject forged downstream and digest bindings", async (t) => {
  for (const field of ["downstreamRef", "proposalDigest"]) {
    await t.test(field, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      const result = await prepareProposalResult(fixture, {
        ...(field === "downstreamRef"
          ? { downstreamRef: `work-intent-${"d".repeat(64)}` }
          : { proposalDigest: "d".repeat(64) }),
      });

      await assert.rejects(
        fixture.service.applyProposalBatch({
          items: [result],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        }),
        (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
      );
      assert.equal((await fixture.service.listItems()).items[0].status, "waiting_external");
    });
  }
});

test("proposal results fail closed when two outbox records claim one downstream", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const items = (await fixture.service.listItems()).items;
  const proposal = normalizeBoundWorkProposal({
    proposalId: `work-intent-${"e".repeat(64)}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: items[0].itemId,
    },
    source: {
      assignmentId: items[0].assignmentId,
      eventId: items[0].event.eventId,
    },
    binding: { repository: "acme/repo", pullRequestNumber: 1 },
    payload: { verdict: "approve", body: "本地审查通过。" },
  });

  for (const [index, item] of items.entries()) {
    const claimedItem = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    const staged = await fixture.service.stageIntent({
      itemId: claimedItem.itemId,
      expectedRevision: claimedItem.revision,
      leaseId: claimedItem.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: reviewIntent({ body: `本地审查通过 ${index + 1}。` }),
    });
    const claimedIntent = await fixture.service.claimIntent({
      intentId: staged.outbox.intentId,
      expectedRevision: staged.outbox.revision,
      dispatcherId: "work-intent-dispatcher",
      leaseDurationMs: 30_000,
    });
    await fixture.service.ackIntent({
      intentId: claimedIntent.intentId,
      expectedRevision: claimedIntent.revision,
      dispatchLeaseId: claimedIntent.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "work-intent-dispatcher",
      details: {
        downstreamRef: proposal.proposalId,
        proposalDigest: proposal.contentDigest,
      },
    });
  }
  const result = createWorkProposalResult({
    proposal,
    sequence: 1,
    transition: {
      status: "succeeded",
      summary: "提案已成功",
      evidence: [],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [result],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
  );
  assert.deepEqual(
    (await fixture.service.listItems()).items.map(({ status }) => status),
    ["waiting_external", "waiting_external"],
  );
});

test("a failed proposal blocks work while gaps and binding changes fail closed", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, { outcome: "unknown" });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_GAP",
  );
  assert.equal((await fixture.service.getSummary()).proposalCursor, 0);

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [{ ...result, proposalContentDigest: "0".repeat(64) }],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BATCH_INVALID",
  );

  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "proposal_unknown");
});

test("work ledger recovers schema v1 state with an empty proposal checkpoint", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 1;
  delete legacy.graphMemoryProjection;
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
  for (const item of legacy.items) delete item.graph;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  const summary = await recovered.recover();

  assert.equal(summary.proposalCursor, 0);
  assert.equal(summary.proposalHighWatermark, 0);
  assert.equal(summary.intakeCursor, 1);
});

test("schema v2 migration is lazy and preserves an active outbox through its next write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const entry of legacy.items) delete entry.graph;
  for (const entry of legacy.outbox) delete entry.dispatchBinding;
  fixture.store.replaceStored(legacy);
  const writesBeforeRecovery = fixture.store.writes.length;
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  assert.equal(fixture.store.writes.length, writesBeforeRecovery);
  assert.equal(fixture.store.stored().schemaVersion, 2);
  const recoveredItem = (await recovered.listItems()).items[0];
  const recoveredOutbox = (await recovered.listOutbox()).items[0];
  assert.equal(recoveredItem.itemId, staged.item.itemId);
  assert.equal(recoveredItem.revision, staged.item.revision);
  assert.equal(recoveredItem.activeIntentId, staged.outbox.intentId);
  assert.deepEqual(recoveredItem.graph, {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: recoveredItem.createdAt,
      },
    ],
    deliveries: [],
  });
  assert.equal(recoveredOutbox.intentId, staged.outbox.intentId);

  const claimed = await recovered.claimIntent({
    intentId: recoveredOutbox.intentId,
    expectedRevision: recoveredOutbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "dispatching");
  assert.equal(
    fixture.store.stored().schemaVersion,
    WORK_LEDGER_STATE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    fixture.store.stored().items[0].graph,
    recoveredItem.graph,
  );
});

test("schema v2 keeps its original byte budget while graph metadata stays separately bounded", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) delete item.graph;
  const legacyBytes = Buffer.byteLength(
    `${JSON.stringify(legacy, null, 2)}\n`,
    "utf8",
  );
  const exactStore = new MemoryStore({ [STATE_KEY]: legacy });
  const recovered = new WorkLedgerService({
    store: exactStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes },
  });

  await recovered.recover();
  assert.equal((await recovered.listItems()).items.length, 1);
  assert.equal(exactStore.stored().schemaVersion, 2);
  assert.equal(exactStore.writes.length, 0);

  const undersizedStore = new MemoryStore({ [STATE_KEY]: legacy });
  const undersized = new WorkLedgerService({
    store: undersizedStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes - 1 },
  });
  await assert.rejects(
    undersized.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersizedStore.stored(), legacy);
  assert.equal(undersizedStore.writes.length, 0);
});

test("schema v2 keeps the original per-item byte budget during migration", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) delete item.graph;
  const legacyItemBytes = Buffer.byteLength(
    `${JSON.stringify(legacy.items[0], null, 2)}\n`,
    "utf8",
  );
  const createRecovered = (itemByteBudget) => {
    const store = new MemoryStore({ [STATE_KEY]: legacy });
    const service = new WorkLedgerService({
      store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
      limits: { itemByteBudget },
    });
    return { service, store };
  };
  const exact = createRecovered(legacyItemBytes);

  await exact.service.recover();

  assert.equal((await exact.service.listItems()).items.length, 1);
  assert.equal(exact.store.writes.length, 0);

  const undersized = createRecovered(legacyItemBytes - 1);
  await assert.rejects(
    undersized.service.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersized.store.stored(), legacy);
  assert.equal(undersized.store.writes.length, 0);
});

async function prepareWaitingCondition(fixture, condition) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: waitIntent(condition),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_condition",
    actorId: "work-intent-dispatcher",
    details: {
      conditionRef: `bound-${dispatch.intentId}`,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  return { item: acknowledged.item, intentId: staged.outbox.intentId };
}

test("condition wake is atomically bound, durable, and idempotent", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const input = {
    itemId: waiting.item.itemId,
    expectedRevision: waiting.item.revision,
    intentId: waiting.intentId,
    actorId: "work-condition-waker",
    observation: {
      kind: "workflow_fact",
      fact: "ci-status",
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
  };

  const woken = await fixture.service.wakeCondition(input);
  assert.equal(woken.status, "queued");
  assert.equal(woken.activeIntentId, null);
  assert.equal(woken.decisionContext.source, "condition");
  assert.deepEqual(woken.decisionContext.value, {
    fact: "ci-status",
    kind: "workflow_fact",
    value: "success",
  });

  const writesBeforeReplay = fixture.store.writes.length;
  const replay = await fixture.service.wakeCondition(input);
  assert.equal(replay.itemId, woken.itemId);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    woken.decisionContext,
  );
});

test("graph recovery reads a condition wake that lost its durable acknowledgement", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const before = await fixture.service.getGraphSnapshot();
  const durableWrite = fixture.store.write.bind(fixture.store);
  let loseAcknowledgement = true;
  fixture.store.write = async (...args) => {
    await durableWrite(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("durable acknowledgement lost");
    }
  };

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "success",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  const recovered = await fixture.service.getGraphSnapshot();
  assert.equal(recovered.graph.revision, before.graph.revision + 1);
  assert.equal(recovered.graph.tasks[0].revision, waiting.item.revision + 1);
});

test("an unmatched condition observation writes nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "failure",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_CONDITION_OBSERVATION_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listItems()).items[0].status, "waiting_condition");
});
