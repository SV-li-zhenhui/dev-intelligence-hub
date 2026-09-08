import assert from "node:assert/strict";
import test from "node:test";
import { ReviewHandoffReconciler } from "../src/services/review-handoff-reconciler.js";

const items = ["first", "second"].map((id) => ({ id, request: { requestId: id } }));
const delivered = { phase: "intaken", workItemId: "work-42", assignment: { target: { id: "tester" } } };
function fixture(submit, recordReviewHandoff = async () => {}) {
  return new ReviewHandoffReconciler({
    confirmations: { readReviewHandoffs: async () => items, recordReviewHandoff },
    ownerWorkRequests: { submit },
    timeoutMs: 15,
    cycleTimeoutMs: 100,
  });
}

test("a stalled dispatch is bounded, aborted and not duplicated while still settling", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let dispatchSignal;
  const reconciler = fixture((request, options) => {
    calls.push(request.requestId);
    if (request.requestId === "first") { dispatchSignal = options?.signal; return stalled; }
    return delivered;
  });
  try {
    const results = await Promise.race([
      reconciler.runCycle(),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 250)),
    ]);
    assert.notEqual(results, "stalled");
    assert.equal(dispatchSignal.aborted, true);
    assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_TIMEOUT");
    assert.equal(results[1].status, "completed");
    await reconciler.runCycle();
    assert.equal(calls.filter((id) => id === "first").length, 1);
  } finally { release(delivered); }
});

test("one acknowledgement failure does not prevent another handoff", async () => {
  const calls = [];
  const reconciler = fixture(async (request) => { calls.push(request.requestId); return delivered; },
    async (id) => { if (id === "first") throw new Error("disk failure"); });
  const results = await reconciler.runCycle();
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_ACK_FAILED");
  assert.equal(results[1].status, "completed");
});

test("shutdown aborts a handoff without waiting for an uncooperative dependency", async () => {
  const controller = new AbortController();
  let observedSignal;
  const reconciler = fixture((_request, options) => {
    observedSignal = options?.signal;
    controller.abort();
    return new Promise(() => {});
  });
  const results = await reconciler.runCycle({ signal: controller.signal });
  assert.equal(observedSignal.aborted, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_CANCELLED");
});

test("a cycle cancelled before admission does not read or dispatch", async () => {
  let reads = 0;
  const reconciler = fixture(() => { throw new Error("must not submit"); });
  reconciler.confirmations.readReviewHandoffs = async () => { reads++; return items; };
  assert.deepEqual(await reconciler.runCycle({ signal: AbortSignal.abort() }), []);
  assert.equal(reads, 0);
});

test("the actual acknowledgement remains tracked after the cycle deadline", async () => {
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  const reconciler = fixture(async () => delivered, async (id) => { if (id === "first") await acknowledgement; });
  let active = 0;
  const runOperation = async (operation) => {
    active++;
    try { return await operation(); } finally { active--; }
  };
  try {
    const results = await reconciler.runCycle({ runOperation });
    assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_TIMEOUT");
    assert.equal(active, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 0);
  } finally { release(); }
});
