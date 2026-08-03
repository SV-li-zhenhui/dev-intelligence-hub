import assert from "node:assert/strict";
import test from "node:test";
import { WorkCoordinationService } from "../src/services/work-coordination-service.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    codeJobRunner: port("code_jobs", "runCycle"),
    codeJobChangePackageDispatcher: port(
      "code_job_change_packages",
      "runCycle",
    ),
    changePackageApplicationResultReconciler: port(
      "change_package_application_results",
      "runCycle",
    ),
    codeJobMemoryProjector: port("code_job_memory", "runCycle"),
    proposalRunner: port("proposal_execution", "runCycle"),
    proposalResultReconciler: port("proposals", "runCycle"),
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

test("agency executes proposals before reconciling their durable results", async () => {
  const { service, calls } = fixture({
    intakeLimit: 61,
    workLimit: 7,
    dispatchLimit: 8,
    attentionLimit: 9,
    proposalLimit: 11,
    conditionLimit: 10,
    codeJobLimit: 6,
    codeJobMemoryLimit: 13,
  });

  const result = await service.runCycle({ trigger: "refresh_completed" });

  assert.deepEqual(calls, [
    ["code_jobs", { limit: 6 }],
    ["code_job_change_packages", { limit: 6 }],
    ["change_package_application_results", undefined],
    ["code_job_memory", { limit: 13 }],
    ["proposal_execution", { limit: 11 }],
    ["proposals", { limit: 11 }],
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
  assert.equal(result.includeWork, true);
  assert.deepEqual(result.stages.code_job_change_packages, {
    ok: true,
    result: { name: "code_job_change_packages" },
  });
  assert.deepEqual(result.stages.change_package_application_results, {
    ok: true,
    result: { name: "change_package_application_results" },
  });
  assert.equal(result.stages.dispatch.ok, true);
});

test("proposal execution is a safe no-op when no runner is configured", async () => {
  const calls = [];
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    proposalResultReconciler: {
      async runCycle(options) {
        calls.push(["proposals", options]);
      },
    },
    attentionResultReconciler: { async runCycle() {} },
    conditionWaker: { async runCycle() {} },
    workLoop: { async runCycle() {} },
    dispatcher: { async dispatchPending() {} },
    proposalLimit: 17,
  });

  const result = await service.runCycle();

  assert.equal(result.stages.proposal_execution.ok, true);
  assert.deepEqual(result.stages.code_jobs.result, {
    skipped: "not_configured",
  });
  assert.deepEqual(result.stages.code_job_change_packages.result, {
    skipped: "not_configured",
  });
  assert.deepEqual(result.stages.change_package_application_results.result, {
    skipped: "not_configured",
  });
  assert.deepEqual(result.stages.code_job_memory.result, {
    skipped: "not_configured",
  });
  assert.deepEqual(calls, [["proposals", { limit: 17 }]]);
});

test("housekeeping cycles reconcile and dispatch without making role decisions", async () => {
  const { service, calls } = fixture({ proposalLimit: 12 });

  const result = await service.runCycle({
    trigger: "refresh_completed",
    includeWork: false,
  });

  assert.deepEqual(calls, [
    ["code_jobs", { limit: 10 }],
    ["code_job_change_packages", { limit: 10 }],
    ["change_package_application_results", undefined],
    ["code_job_memory", { limit: 50 }],
    ["proposal_execution", { limit: 12 }],
    ["proposals", { limit: 12 }],
    ["attention", { limit: 50 }],
    ["conditions", { limit: 50 }],
    ["dispatch", { limit: 50 }],
  ]);
  assert.equal(result.includeWork, false);
  assert.equal("work" in result.stages, false);
});

test("role cycles forward the role scope to the proactive work loop", async () => {
  const { service, calls } = fixture();

  const result = await service.runCycle({
    trigger: "employee:developer",
    roleId: "developer",
  });

  assert.deepEqual(calls, [
    ["work", {
      trigger: "employee:developer",
      intakeLimit: 100,
      workLimit: 20,
      roleId: "developer",
    }],
    ["dispatch", { limit: 50 }],
  ]);
  assert.equal(result.roleId, "developer");
});

test("a failed work stage cannot strand an already durable dispatch", async () => {
  const calls = [];
  const failure = new Error("brain unavailable");
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    proposalRunner: { async runCycle() { calls.push("proposal_execution"); } },
    proposalResultReconciler: { async runCycle() { calls.push("proposals"); } },
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
  assert.deepEqual(calls, [
    "proposal_execution",
    "proposals",
    "attention",
    "conditions",
    "work",
    "dispatch",
  ]);
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
    codeJobRunner: failing("code_jobs", "runCycle"),
    codeJobChangePackageDispatcher: failing(
      "code_job_change_packages",
      "runCycle",
    ),
    changePackageApplicationResultReconciler: failing(
      "change_package_application_results",
      "runCycle",
    ),
    codeJobMemoryProjector: failing("code_job_memory", "runCycle"),
    proposalRunner: failing("proposal_execution", "runCycle"),
    proposalResultReconciler: failing("proposals", "runCycle"),
    attentionResultReconciler: failing("attention", "runCycle"),
    conditionWaker: failing("conditions", "runCycle"),
    workLoop: failing("work", "runCycle"),
    dispatcher: failing("dispatch", "dispatchPending"),
  });

  await assert.rejects(service.runCycle(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ stage }) => stage), [
      "code_jobs",
      "code_job_change_packages",
      "change_package_application_results",
      "code_job_memory",
      "proposal_execution",
      "proposal_results",
      "attention_results",
      "conditions",
      "work",
      "dispatch",
    ]);
    return true;
  });
  assert.deepEqual(calls, [
    "code_jobs",
    "code_job_change_packages",
    "change_package_application_results",
    "code_job_memory",
    "proposal_execution",
    "proposals",
    "attention",
    "conditions",
    "work",
    "dispatch",
  ]);
});

test("same role signals merge while different role cycles stay distinct", async () => {
  const release = deferred();
  const developerStarted = deferred();
  const requirementsStarted = deferred();
  let attentionCalls = 0;
  const workScopes = [];
  const service = new WorkCoordinationService({
    ledger: { async intake() {} },
    proposalResultReconciler: { async runCycle() {} },
    attentionResultReconciler: {
      async runCycle() {
        attentionCalls += 1;
      },
    },
    conditionWaker: { async runCycle() {} },
    workLoop: {
      async runCycle(options) {
        workScopes.push(options.roleId);
        if (options.roleId === "developer") developerStarted.resolve();
        if (options.roleId === "requirements-analyst") {
          requirementsStarted.resolve();
        }
        await release.promise;
      },
    },
    dispatcher: { async dispatchPending() {} },
  });

  const first = service.runCycle({ trigger: "manual", roleId: "developer" });
  const second = service.runCycle({
    trigger: "ignored_while_running",
    roleId: "developer",
  });
  const third = service.runCycle({
    trigger: "employee:requirements-analyst",
    roleId: "requirements-analyst",
  });
  assert.strictEqual(first, second);
  assert.notStrictEqual(first, third);
  await Promise.all([developerStarted.promise, requirementsStarted.promise]);
  assert.equal(attentionCalls, 0);
  release.resolve();
  const [result, duplicateResult, thirdResult] = await Promise.all([
    first,
    second,
    third,
  ]);
  assert.equal(result.trigger, "manual");
  assert.deepEqual(duplicateResult, result);
  assert.equal(thirdResult.roleId, "requirements-analyst");
  assert.equal(attentionCalls, 0);
  assert.deepEqual(workScopes.sort(), ["developer", "requirements-analyst"]);
});
