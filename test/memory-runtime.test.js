import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryRuntime } from "../src/memory-runtime.js";

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
  assert.deepEqual(Object.keys(runtime.maintenance), ["rebuildIndex"]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.producer), true);
  assert.equal("journal" in runtime, false);
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
