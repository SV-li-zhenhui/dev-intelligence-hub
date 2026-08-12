import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkProposalRunnerGroup,
  createWorkProposalRunnerGroup,
} from "../src/services/work-proposal-runner-group.js";

test("one configured runner is returned without an unnecessary wrapper", () => {
  const runner = { async runCycle() {} };
  assert.strictEqual(createWorkProposalRunnerGroup([null, runner]), runner);
  assert.equal(createWorkProposalRunnerGroup([null]), null);
});

test("the group runs every proposal scope with the same bounded cycle options", async () => {
  const calls = [];
  const group = new WorkProposalRunnerGroup({
    runners: ["github", "code"].map((name) => ({
      async runCycle(options) {
        calls.push([name, options]);
        return { name };
      },
    })),
  });

  assert.deepEqual(await group.runCycle({ limit: 7 }), {
    runners: [{ name: "github" }, { name: "code" }],
  });
  assert.deepEqual(calls, [
    ["github", { limit: 7 }],
    ["code", { limit: 7 }],
  ]);
});

test("the group forwards one shutdown signal to every proposal scope", async () => {
  const observedSignals = [];
  const controller = new AbortController();
  const group = new WorkProposalRunnerGroup({
    runners: ["github", "code"].map(() => ({
      async runCycle(options) {
        observedSignals.push(options.signal);
        return {};
      },
    })),
  });

  await group.runCycle({ limit: 7, signal: controller.signal });

  assert.equal(observedSignals.length, 2);
  assert.equal(
    observedSignals.every((signal) => signal === controller.signal),
    true,
  );
});

test("a failing runner never starves another proposal scope", async () => {
  const calls = [];
  const failure = new Error("github unavailable");
  const group = new WorkProposalRunnerGroup({
    runners: [
      {
        async runCycle() {
          calls.push("github");
          throw failure;
        },
      },
      {
        async runCycle() {
          calls.push("code");
          return { claimed: 1 };
        },
      },
    ],
  });

  await assert.rejects(
    group.runCycle({ limit: 3 }),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.deepEqual(calls.sort(), ["code", "github"]);
});

test("invalid groups and unbounded options fail before running", async () => {
  assert.throws(() => new WorkProposalRunnerGroup({ runners: [] }), /runners/);
  const group = new WorkProposalRunnerGroup({
    runners: [{ async runCycle() {} }],
  });
  await assert.rejects(group.runCycle({ limit: 0 }), /limit/);
  await assert.rejects(group.runCycle({ signal: {} }), /signal/);
  await assert.rejects(group.runCycle({ limit: 1, extra: true }), /options/);
});
