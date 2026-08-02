import assert from "node:assert/strict";
import test from "node:test";
import { WorkProposalResultReconciler } from "../src/services/work-proposal-result-reconciler.js";

function resultBatch(sequence = 1) {
  return {
    items: [{ sequence }],
    nextSequence: sequence,
    highWatermark: sequence,
    oldestAvailableSequence: 1,
  };
}

function ports(overrides = {}) {
  return {
    proposalConsumer: {
      readResultBatch: async () => resultBatch(),
      ...overrides.proposalConsumer,
    },
    ledger: {
      getSummary: async () => ({ proposalCursor: 0 }),
      applyProposalBatch: async () => ({ applied: 1, cursor: 1 }),
      ...overrides.ledger,
    },
  };
}

test("reconciler releases the proposal read before mutating the ledger", async () => {
  const calls = [];
  let reading = false;
  const batch = resultBatch();
  const dependencies = ports({
    proposalConsumer: {
      async readResultBatch(options) {
        calls.push(["read", options]);
        reading = true;
        await Promise.resolve();
        reading = false;
        return batch;
      },
    },
    ledger: {
      async getSummary() {
        calls.push(["checkpoint"]);
        return { proposalCursor: 0 };
      },
      async applyProposalBatch(value) {
        assert.equal(reading, false);
        calls.push(["apply", value]);
        return { applied: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler(dependencies);

  const result = await reconciler.runCycle({ limit: 10 });

  assert.deepEqual(result, { applied: 1, cursor: 1 });
  assert.deepEqual(calls.map(([kind]) => kind), ["checkpoint", "read", "apply"]);
  assert.deepEqual(calls[1][1], { afterSequence: 0, limit: 10 });
  assert.strictEqual(calls[2][1], batch);
});

test("reconciler coalesces concurrent cycles", async () => {
  let releaseRead;
  const readBlocked = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let reads = 0;
  const dependencies = ports({
    proposalConsumer: {
      async readResultBatch() {
        reads += 1;
        await readBlocked;
        return resultBatch();
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler(dependencies);

  const first = reconciler.runCycle();
  const second = reconciler.runCycle({ limit: 1 });

  assert.strictEqual(second, first);
  releaseRead();
  await first;
  assert.equal(reads, 1);
});

test("reconciler clears the in-flight cycle after errors so the batch can replay", async () => {
  const failure = new Error("ledger write unavailable");
  let applications = 0;
  const dependencies = ports({
    ledger: {
      async applyProposalBatch() {
        applications += 1;
        if (applications === 1) throw failure;
        return { applied: 0, deduplicated: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler(dependencies);

  await assert.rejects(reconciler.runCycle(), (error) => error === failure);
  assert.deepEqual(await reconciler.runCycle(), {
    applied: 0,
    deduplicated: 1,
    cursor: 1,
  });
  assert.equal(applications, 2);
});

test("reconciler propagates checkpoint and proposal feed failures", async (t) => {
  const checkpointFailure = new Error("ledger unavailable");
  const feedFailure = new Error("proposal feed unavailable");

  await t.test("checkpoint failure", async () => {
    const reconciler = new WorkProposalResultReconciler(
      ports({
        ledger: {
          getSummary: async () => {
            throw checkpointFailure;
          },
        },
      }),
    );
    await assert.rejects(reconciler.runCycle(), (error) => error === checkpointFailure);
  });

  await t.test("feed failure", async () => {
    const reconciler = new WorkProposalResultReconciler(
      ports({
        proposalConsumer: {
          readResultBatch: async () => {
            throw feedFailure;
          },
        },
      }),
    );
    await assert.rejects(reconciler.runCycle(), (error) => error === feedFailure);
  });
});

test("reconciler validates its minimal ports and durable cursor", async () => {
  const valid = ports();
  assert.throws(
    () => new WorkProposalResultReconciler({ ...valid, proposalConsumer: {} }),
    /proposalConsumer/,
  );
  assert.throws(
    () => new WorkProposalResultReconciler({ ...valid, ledger: {} }),
    /ledger/,
  );

  for (const proposalCursor of [-1, 1.5, "0", null, undefined]) {
    const reconciler = new WorkProposalResultReconciler(
      ports({
        ledger: { getSummary: async () => ({ proposalCursor }) },
      }),
    );
    await assert.rejects(reconciler.runCycle(), /proposal checkpoint/);
  }
});

test("reconciler strictly validates cycle options", () => {
  const reconciler = new WorkProposalResultReconciler(ports());

  for (const options of [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { extra: true }]) {
    assert.throws(() => reconciler.runCycle(options), /runCycle options|limit/);
  }

  const accessor = {};
  Object.defineProperty(accessor, "limit", { enumerable: true, get: () => 1 });
  assert.throws(() => reconciler.runCycle(accessor), /runCycle options/);
});
