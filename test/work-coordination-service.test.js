import assert from "node:assert/strict";
import test from "node:test";
import { WorkCoordinationService } from "../src/services/work-coordination-service.js";

function fixture(overrides = {}) {
  const calls = [];
  const port = (name, method, result = { name }) => ({
    async [method](options) {
      calls.push([name, options]);
      return result;
    },
  });
  const service = new WorkCoordinationService({
    ledger: port("intake", "intake"),
    attentionResultReconciler: port("attention", "runCycle"),
    conditionWaker: port("conditions", "runCycle"),
    workLoop: port("work", "runCycle"),
    dispatcher: port("dispatch", "dispatchPending"),
    ...overrides,
  });
  return { service, calls };
}

test("fact intake stays a separate fast operation", async () => {
  const { service, calls } = fixture({ intakeLimit: 73 });

  assert.deepEqual(await service.intake(), { name: "intake" });
  assert.deepEqual(calls, [["intake", { limit: 73 }]]);
});

test("agency runs answer, condition, decision, and dispatch stages in order", async () => {
  const { service, calls } = fixture({
    intakeLimit: 61,
    workLimit: 7,
    dispatchLimit: 8,
    attentionLimit: 9,
    conditionLimit: 10,
  });

  const result = await service.runCycle({ trigger: "refresh_completed" });

  assert.deepEqual(calls, [
    ["attention", { limit: 9 }],
    ["conditions", { limit: 10 }],
    ["work", {
      trigger: "refresh_completed",
      intakeLimit: 61,
      workLimit: 7,
    }],
    ["dispatch", { limit: 8 }],
  ]);
  assert.equal(result.trigger, "refresh_completed");
  assert.equal(result.stages.dispatch.ok, true);
});

test("a failed work stage cannot strand an already durable dispatch", async () => {
  const calls = [];
  const failure = new Error("brain unavailable");
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    attentionResultReconciler: { async runCycle() { calls.push("attention"); } },
    conditionWaker: { async runCycle() { calls.push("conditions"); } },
    workLoop: { async runCycle() { calls.push("work"); throw failure; } },
    dispatcher: { async dispatchPending() { calls.push("dispatch"); return {}; } },
  });

  await assert.rejects(service.runCycle(), (error) => {
    assert.equal(error.code, "WORK_COORDINATION_STAGE_FAILED");
    assert.equal(error.stage, "work");
    assert.deepEqual(error.result.stages.dispatch, { ok: true, result: {} });
    return true;
  });
  assert.deepEqual(calls, ["attention", "conditions", "work", "dispatch"]);
});

test("all independent stage failures are reported after every stage is attempted", async () => {
  const calls = [];
  const failing = (name, method) => ({
    async [method]() {
      calls.push(name);
      throw new Error(name);
    },
  });
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    attentionResultReconciler: failing("attention", "runCycle"),
    conditionWaker: failing("conditions", "runCycle"),
    workLoop: failing("work", "runCycle"),
    dispatcher: failing("dispatch", "dispatchPending"),
  });

  await assert.rejects(service.runCycle(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ stage }) => stage), [
      "attention_results",
      "conditions",
      "work",
      "dispatch",
    ]);
    return true;
  });
  assert.deepEqual(calls, ["attention", "conditions", "work", "dispatch"]);
});

test("concurrent agency signals merge into one cycle", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attentionCalls = 0;
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    attentionResultReconciler: {
      async runCycle() {
        attentionCalls += 1;
        await gate;
      },
    },
    conditionWaker: { async runCycle() {} },
    workLoop: { async runCycle() {} },
    dispatcher: { async dispatchPending() {} },
  });

  const first = service.runCycle({ trigger: "manual" });
  const second = service.runCycle({ trigger: "ignored_while_running" });
  assert.strictEqual(first, second);
  release();
  const result = await first;
  assert.equal(result.trigger, "manual");
  assert.equal(attentionCalls, 1);
});
