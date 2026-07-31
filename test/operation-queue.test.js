import assert from "node:assert/strict";
import test from "node:test";
import { OperationQueue } from "../src/lib/operation-queue.js";

test("a shared operation queue serializes mutations and continues after failure", async () => {
  const queue = new OperationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.enqueue(async () => {
    events.push("second");
    throw new Error("expected failure");
  });
  const third = queue.enqueue(async () => {
    events.push("third");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await first;
  await assert.rejects(second, /expected failure/);
  await third;
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});
