import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationalQuiescenceGate,
} from "../src/services/operational-quiescence-gate.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("quiescence closes synchronously, drains admitted work, and reopens by token", async () => {
  const gate = new OperationalQuiescenceGate();
  const started = deferred();
  const release = deferred();
  const operation = gate.run(async () => {
    started.resolve();
    await release.promise;
    return "done";
  });
  await started.promise;

  let entered = false;
  const entering = gate.enter().then((token) => {
    entered = true;
    return token;
  });
  assert.deepEqual(gate.readStatus(), {
    mode: "closing",
    activeOperations: 1,
  });
  await assert.rejects(() => gate.run(async () => {}), {
    code: "SYSTEM_QUIESCING",
  });
  assert.equal(entered, false);

  release.resolve();
  assert.equal(await operation, "done");
  const token = await entering;
  assert.match(token, /^quiescence-[a-f0-9]{64}$/u);
  assert.deepEqual(gate.readStatus(), {
    mode: "closed",
    activeOperations: 0,
  });
  assert.equal(JSON.stringify(gate.readStatus()).includes(token), false);

  assert.deepEqual(gate.leave(token), {
    mode: "open",
    activeOperations: 0,
  });
  assert.equal(await gate.run(async () => 42), 42);
});

test("wrong tokens and overlapping maintenance never reopen the gate", async () => {
  const gate = new OperationalQuiescenceGate();
  const token = await gate.enter();
  await assert.rejects(() => gate.enter(), { code: "QUIESCENCE_ALREADY_ACTIVE" });
  assert.throws(() => gate.leave(`quiescence-${"0".repeat(64)}`), {
    code: "QUIESCENCE_TOKEN_INVALID",
  });
  assert.equal(gate.readStatus().mode, "closed");
  gate.leave(token);
});

test("failed operations still release the drain barrier", async () => {
  const gate = new OperationalQuiescenceGate();
  const started = deferred();
  const release = deferred();
  const operation = gate.run(async () => {
    started.resolve();
    await release.promise;
    throw new Error("operation failed");
  });
  await started.promise;
  const entering = gate.enter();
  release.resolve();
  await assert.rejects(operation, /operation failed/u);
  const token = await entering;
  gate.leave(token);
  assert.equal(gate.readStatus().mode, "open");
});

test("a drain deadline fails maintenance and atomically reopens admission", {
  timeout: 1_000,
}, async () => {
  const gate = new OperationalQuiescenceGate({ drainTimeoutMs: 20 });
  const started = deferred();
  const release = deferred();
  const operation = gate.run(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;

  await assert.rejects(gate.enter(), {
    code: "QUIESCENCE_DRAIN_TIMEOUT",
  });
  assert.deepEqual(gate.readStatus(), {
    mode: "open",
    activeOperations: 1,
  });
  assert.equal(await gate.run(async () => "accepted-after-timeout"),
    "accepted-after-timeout");

  release.resolve();
  await operation;
  assert.deepEqual(gate.readStatus(), {
    mode: "open",
    activeOperations: 0,
  });
});
