import assert from "node:assert/strict";
import test from "node:test";
import { WorkProposalResultReconciler } from "../src/services/work-proposal-result-reconciler.js";

const JOB_ID = `code-job-${"a".repeat(55)}`;
const OTHER_JOB_ID = `code-job-${"b".repeat(55)}`;
const MEMORY_ID = `memory-${"c".repeat(64)}`;
const OTHER_MEMORY_ID = `memory-${"d".repeat(64)}`;
const PROJECTED_AT = "2026-08-02T08:00:00.000Z";

function resultBatch(sequence = 1) {
  return {
    items: [{ sequence }],
    nextSequence: sequence,
    highWatermark: sequence,
    oldestAvailableSequence: 1,
  };
}

function codeResult({
  sequence = 1,
  outcome = "succeeded",
  evidence = [`code-job:${JOB_ID}`, `memory:${MEMORY_ID}`],
} = {}) {
  return {
    sequence,
    kind: "code_action_proposal",
    outcome,
    evidence,
  };
}

function gateBatch(items, {
  highWatermark = items.at(-1)?.sequence ?? 0,
  oldestAvailableSequence = items.length === 0 ? null : 1,
} = {}) {
  return {
    items,
    nextSequence: items.at(-1)?.sequence ?? 0,
    highWatermark,
    oldestAvailableSequence,
  };
}

function codeJob({
  jobId = JOB_ID,
  status = "completed",
  memoryProjection = {
    recordId: MEMORY_ID,
    projectedAt: PROJECTED_AT,
  },
} = {}) {
  return { jobId, status, memoryProjection };
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

test("reconciler applies a completed code result only after its memory receipt is visible", async () => {
  const item = codeResult();
  const batch = gateBatch([item]);
  const calls = [];
  const reader = {
    marker: "bound-reader",
    async get(jobId) {
      assert.equal(this.marker, "bound-reader");
      calls.push(["get", jobId]);
      return codeJob();
    },
  };
  let applied;
  const dependencies = ports({
    proposalConsumer: { readResultBatch: async () => batch },
    ledger: {
      async applyProposalBatch(value) {
        applied = value;
        calls.push(["apply"]);
        return { applied: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: reader,
  });

  assert.deepEqual(await reconciler.runCycle(), { applied: 1, cursor: 1 });
  assert.deepEqual(calls, [["get", JOB_ID], ["apply"]]);
  assert.notStrictEqual(applied, batch);
  assert.strictEqual(applied.items[0], item);
  assert.deepEqual(applied, batch);
});

test("reconciler waits at active, unknown, cancelling, and unprojected terminal code jobs", async (t) => {
  for (const status of [
    "active",
    "unknown",
    "cancelling",
    "completed",
    "cancelled",
  ]) {
    await t.test(status, async () => {
      const batch = gateBatch([codeResult()], { highWatermark: 3 });
      let applied;
      const dependencies = ports({
        proposalConsumer: { readResultBatch: async () => batch },
        ledger: {
          async applyProposalBatch(value) {
            applied = value;
            return { applied: 0, cursor: 0 };
          },
        },
      });
      const reconciler = new WorkProposalResultReconciler({
        ...dependencies,
        codeJobReader: {
          get: async () => codeJob({ status, memoryProjection: null }),
        },
      });

      assert.deepEqual(await reconciler.runCycle(), { applied: 0, cursor: 0 });
      assert.deepEqual(applied, {
        items: [],
        nextSequence: 0,
        highWatermark: 3,
        oldestAvailableSequence: 1,
      });
    });
  }
});

test("reconciler applies only the longest ready prefix and never overtakes a blocked result", async () => {
  const first = { sequence: 1, kind: "github_review_proposal" };
  const blocked = codeResult({ sequence: 2 });
  const later = { sequence: 3, kind: "github_review_proposal" };
  const batch = gateBatch([first, blocked, later], { highWatermark: 5 });
  const reads = [];
  let applied;
  const dependencies = ports({
    proposalConsumer: { readResultBatch: async () => batch },
    ledger: {
      async applyProposalBatch(value) {
        applied = value;
        return { applied: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: {
      async get(jobId) {
        reads.push(jobId);
        return codeJob({ status: "active", memoryProjection: null });
      },
    },
  });

  await reconciler.runCycle();

  assert.deepEqual(reads, [JOB_ID]);
  assert.deepEqual(applied, {
    items: [first],
    nextSequence: 1,
    highWatermark: 5,
    oldestAvailableSequence: 1,
  });
  assert.equal(applied.items.includes(later), false);
});

test("reconciler rejects missing, ambiguous, and contradictory code-job evidence", async (t) => {
  const cases = [
    {
      name: "missing job",
      item: codeResult(),
      job: null,
      reads: 1,
    },
    {
      name: "ambiguous job references",
      item: codeResult({
        evidence: [`code-job:${JOB_ID}`, `code-job:${OTHER_JOB_ID}`],
      }),
      job: codeJob(),
      reads: 0,
    },
    {
      name: "succeeded without job reference",
      item: codeResult({ evidence: [] }),
      job: codeJob(),
      reads: 0,
    },
    {
      name: "memory receipt mismatch",
      item: codeResult({
        evidence: [`code-job:${JOB_ID}`, `memory:${OTHER_MEMORY_ID}`],
      }),
      job: codeJob(),
      reads: 1,
    },
    {
      name: "missing memory citation",
      item: codeResult({ evidence: [`code-job:${JOB_ID}`] }),
      job: codeJob(),
      reads: 1,
    },
    {
      name: "duplicate memory citations",
      item: codeResult({
        evidence: [
          `code-job:${JOB_ID}`,
          `memory:${MEMORY_ID}`,
          `memory:${MEMORY_ID}`,
        ],
      }),
      job: codeJob(),
      reads: 1,
    },
    {
      name: "succeeded result bound to failed job",
      item: codeResult(),
      job: codeJob({ status: "failed" }),
      reads: 1,
    },
    {
      name: "failed result bound to completed job",
      item: codeResult({ outcome: "failed" }),
      job: codeJob({ status: "completed" }),
      reads: 1,
    },
    {
      name: "rejected result bound to a non-cancelled job",
      item: codeResult({ outcome: "rejected" }),
      job: codeJob({ status: "failed" }),
      reads: 1,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let reads = 0;
      let applications = 0;
      const dependencies = ports({
        proposalConsumer: {
          readResultBatch: async () => gateBatch([fixture.item]),
        },
        ledger: {
          async applyProposalBatch() {
            applications += 1;
          },
        },
      });
      const reconciler = new WorkProposalResultReconciler({
        ...dependencies,
        codeJobReader: {
          async get() {
            reads += 1;
            return fixture.job;
          },
        },
      });

      await assert.rejects(
        reconciler.runCycle(),
        (error) =>
          error.code === "WORK_PROPOSAL_CODE_JOB_EVIDENCE_INVALID" &&
          error.statusCode === 502,
      );
      assert.equal(reads, fixture.reads);
      assert.equal(applications, 0);
    });
  }
});

test("reconciler permits non-code results and code failures without job evidence", async () => {
  let evidenceAccessorRead = false;
  const otherKind = { sequence: 1, kind: "github_review_proposal" };
  Object.defineProperty(otherKind, "evidence", {
    enumerable: true,
    get() {
      evidenceAccessorRead = true;
      throw new Error("must remain opaque");
    },
  });
  const rejectedBeforeExecution = codeResult({
    sequence: 2,
    outcome: "rejected",
    evidence: ["confirmation:declined"],
  });
  const batch = gateBatch([otherKind, rejectedBeforeExecution]);
  let reads = 0;
  let applied;
  const dependencies = ports({
    proposalConsumer: { readResultBatch: async () => batch },
    ledger: {
      async applyProposalBatch(value) {
        applied = value;
        return { applied: 2, cursor: 2 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: {
      async get() {
        reads += 1;
        return null;
      },
    },
  });

  await reconciler.runCycle();

  assert.equal(reads, 0);
  assert.equal(evidenceAccessorRead, false);
  assert.strictEqual(applied.items[0], otherKind);
  assert.strictEqual(applied.items[1], rejectedBeforeExecution);
});

test("reconciler accepts a projected terminal failure with matching evidence", async () => {
  const item = codeResult({ sequence: 1, outcome: "failed" });
  let applied;
  const dependencies = ports({
    proposalConsumer: {
      readResultBatch: async () => gateBatch([item]),
    },
    ledger: {
      async applyProposalBatch(value) {
        applied = value;
        return { applied: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: {
      get: async () => codeJob({ status: "failed" }),
    },
  });

  await reconciler.runCycle();

  assert.deepEqual(applied.items, [item]);
  assert.equal(applied.nextSequence, 1);
});

test("reconciler accepts a projected cancellation only as rejected", async () => {
  const item = codeResult({ sequence: 1, outcome: "rejected" });
  let applied;
  const dependencies = ports({
    proposalConsumer: {
      readResultBatch: async () => gateBatch([item]),
    },
    ledger: {
      async applyProposalBatch(value) {
        applied = value;
        return { applied: 1, cursor: 1 };
      },
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: {
      get: async () => codeJob({ status: "cancelled" }),
    },
  });

  assert.deepEqual(await reconciler.runCycle(), { applied: 1, cursor: 1 });
  assert.deepEqual(applied.items, [item]);
});

test("reconciler strictly validates and binds the optional code job reader", async () => {
  const valid = ports();
  assert.throws(
    () => new WorkProposalResultReconciler({ ...valid, codeJobReader: null }),
    /codeJobReader/,
  );
  assert.throws(
    () => new WorkProposalResultReconciler({ ...valid, codeJobReader: {} }),
    /codeJobReader/,
  );

  let getterRead = false;
  const accessorPort = {};
  Object.defineProperty(accessorPort, "get", {
    enumerable: true,
    get() {
      getterRead = true;
      return async () => null;
    },
  });
  assert.throws(
    () => new WorkProposalResultReconciler({
      ...valid,
      codeJobReader: accessorPort,
    }),
    /codeJobReader/,
  );
  assert.equal(getterRead, false);

  let statusRead = false;
  const accessorJob = { jobId: JOB_ID, memoryProjection: null };
  Object.defineProperty(accessorJob, "status", {
    enumerable: true,
    get() {
      statusRead = true;
      return "active";
    },
  });
  const dependencies = ports({
    proposalConsumer: {
      readResultBatch: async () => gateBatch([codeResult()]),
    },
  });
  const reconciler = new WorkProposalResultReconciler({
    ...dependencies,
    codeJobReader: { get: async () => accessorJob },
  });
  await assert.rejects(
    reconciler.runCycle(),
    (error) => error.code === "WORK_PROPOSAL_CODE_JOB_EVIDENCE_INVALID",
  );
  assert.equal(statusRead, false);
});
