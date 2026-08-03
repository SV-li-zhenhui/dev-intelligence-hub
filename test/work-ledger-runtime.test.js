import assert from "node:assert/strict";
import test from "node:test";
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

test("runtime owns one named process guard and exposes only ledger operations", async () => {
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
  assert.deepEqual(events.slice(0, 2), ["acquire", "run"]);

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
