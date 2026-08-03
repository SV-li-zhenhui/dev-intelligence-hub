import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value === null ? null : structuredClone(value);
    this.writes = 0;
  }

  async read(_name, fallback = null) {
    return this.value === null ? structuredClone(fallback) : structuredClone(this.value);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
    this.writes += 1;
  }
}

class PausableMemoryStore extends MemoryStore {
  constructor() {
    super();
    this.nextWriteGate = null;
  }

  pauseNextWrite() {
    let release;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    this.nextWriteGate = { markStarted, released };
    return Object.freeze({ started, release });
  }

  async write(name, value) {
    const gate = this.nextWriteGate;
    if (gate) {
      this.nextWriteGate = null;
      gate.markStarted();
      await gate.released;
    }
    return super.write(name, value);
  }
}

class FakeGuard {
  constructor(events) {
    this.events = events;
    this.tail = Promise.resolve();
    this.closePromise = null;
  }

  async acquire() {
    this.events.push("acquire");
  }

  run(operation) {
    this.events.push("run");
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    this.closePromise ||= Promise.resolve().then(() => {
      this.events.push("close");
    });
    return this.closePromise;
  }
}

function guardFactory(events) {
  return (options) => {
    assert.deepEqual(options, { name: "mydashboard-work-ledger-v1" });
    return new FakeGuard(events);
  };
}

function emptySource(events = []) {
  return {
    async readAssignmentBatch(request) {
      events.push({ type: "source-read", request: structuredClone(request) });
      return {
        items: [],
        nextSequence: request.afterSequence,
        highWatermark: request.afterSequence,
        oldestAvailableSequence: 1,
      };
    },
  };
}

function oneAssignmentSource() {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-02T02:00:00.000Z",
    source: { provider: "github", scopeId: "test-dashboard" },
    subject: {
      id: "issue-runtime-1",
      repository: "acme/dashboard",
      number: 1,
    },
    payload: { number: 1, title: "Runtime graph integration" },
  });
  const record = {
    sequence: 1,
    assignment: {
      assignmentId: "assignment-runtime-1",
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "test",
    },
    event,
  };
  return {
    async readAssignmentBatch({ afterSequence }) {
      const items = afterSequence < 1 ? [record] : [];
      return structuredClone({
        items,
        nextSequence: items.length ? 1 : afterSequence,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
    },
  };
}

function graphChildCommand(parent, graphRevision) {
  return {
    parentTaskId: parent.itemId,
    childKey: "runtime-child",
    work: {
      title: "运行时子任务",
      description: "验证共享图端口和关闭排空语义。",
    },
    target: { type: "role", id: "developer" },
    dependsOnTaskIds: [],
    acceptanceContract: {
      revision: 1,
      acceptanceCriteria: [
        { criterionId: "verified", description: "运行时验证通过" },
      ],
      expectedDeliverables: [
        {
          deliverableId: "test-report",
          kind: "test-report",
          description: "测试结果",
          required: true,
        },
      ],
    },
    leaseId: null,
    expectedGraphRevision: graphRevision,
    expectedTaskRevisions: [
      { taskId: parent.itemId, revision: parent.revision },
    ],
  };
}

test("runtime owns one named process guard and exposes least-authority graph ports", async () => {
  const events = [];
  const runtime = await createWorkLedgerRuntime({
    store: new MemoryStore(),
    assignmentSource: emptySource(events),
    clock: () => "2026-08-02T02:00:00.000Z",
    idFactory: () => "lease-runtime-1",
    createGuard: guardFactory(events),
  });

  assert.equal(Object.isFrozen(runtime), true);
  for (const method of [
    "getSummary",
    "listItems",
    "listTimeline",
    "listOutbox",
    "intake",
    "claim",
    "transition",
    "scheduleRetry",
    "handoff",
    "complete",
    "cancelGraphTask",
    "stageIntent",
    "claimIntent",
    "ackIntent",
    "close",
  ]) {
    assert.equal(typeof runtime[method], "function", method);
  }
  assert.equal(Object.isFrozen(runtime.graphReader), true);
  assert.equal(Object.isFrozen(runtime.graphPlanner), true);
  assert.deepEqual(Object.keys(runtime.graphReader), ["getSnapshot"]);
  assert.deepEqual(Object.keys(runtime.graphPlanner), ["createChild"]);
  assert.equal(runtime.getGraphSnapshot, undefined);
  assert.equal(runtime.createGraphChild, undefined);
  assert.equal(runtime.graphStore, undefined);
  assert.deepEqual(events.slice(0, 2), ["acquire", "run"]);

  const graphSnapshot = await runtime.graphReader.getSnapshot();
  assert.equal(graphSnapshot.graph.revision, 0);

  const intake = await runtime.intake();
  assert.equal(intake.cursor, 0);
  assert.deepEqual(events.at(-1), {
    type: "source-read",
    request: { afterSequence: 0, limit: 100 },
  });

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(events.filter((event) => event === "close").length, 1);
  await assert.rejects(
    runtime.getSummary(),
    (error) =>
      error.code === "WORK_LEDGER_RUNTIME_CLOSED" && error.statusCode === 503,
  );
  await assert.rejects(
    runtime.graphReader.getSnapshot(),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.graphPlanner.createChild({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
});

test("runtime drains an accepted graph write before closing its sole guard", async () => {
  const events = [];
  const store = new PausableMemoryStore();
  const runtime = await createWorkLedgerRuntime({
    store,
    assignmentSource: oneAssignmentSource(),
    clock: () => "2026-08-02T02:00:00.000Z",
    idFactory: () => "lease-runtime-graph-1",
    createGuard: guardFactory(events),
  });
  await runtime.intake();
  const parent = (await runtime.listItems()).items[0];
  const graph = await runtime.graphReader.getSnapshot();
  const gate = store.pauseNextWrite();

  const creation = runtime.graphPlanner.createChild(
    graphChildCommand(parent, graph.graph.revision),
  );
  await gate.started;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(events.includes("close"), false);

  gate.release();
  const result = await creation;
  await closing;

  assert.equal(result.applied, true);
  assert.equal(events.at(-1), "close");
  assert.equal(events.filter((event) => event === "close").length, 1);
});

test("runtime never tries to acquire a lock exposed by the assignment source", async () => {
  const source = emptySource();
  source.acquire = () => {
    throw new Error("ledger must not acquire the workflow guard");
  };
  const runtime = await createWorkLedgerRuntime({
    store: new MemoryStore(),
    assignmentSource: source,
    createGuard: guardFactory([]),
  });

  await runtime.intake();
  await runtime.close();
});

test("runtime closes its guard when acquisition or recovery fails", async (t) => {
  await t.test("acquisition", async () => {
    let closes = 0;
    const acquisitionError = new Error("guard held");
    await assert.rejects(
      createWorkLedgerRuntime({
        store: new MemoryStore(),
        assignmentSource: emptySource(),
        createGuard: () => ({
          async acquire() {
            throw acquisitionError;
          },
          async run(operation) {
            return operation();
          },
          async close() {
            closes += 1;
          },
        }),
      }),
      (error) => error === acquisitionError,
    );
    assert.equal(closes, 1);
  });

  await t.test("recovery", async () => {
    let closes = 0;
    await assert.rejects(
      createWorkLedgerRuntime({
        store: new MemoryStore({ corrupt: true }),
        assignmentSource: emptySource(),
        createGuard: () => ({
          async acquire() {},
          async run(operation) {
            return operation();
          },
          async close() {
            closes += 1;
          },
        }),
      }),
      (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
    );
    assert.equal(closes, 1);
  });
});
