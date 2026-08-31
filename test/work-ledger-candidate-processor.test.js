import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalWorkLedgerCandidateProcessor,
  createWorkerWorkLedgerCandidateProcessor,
} from "../src/services/work-ledger-candidate-processor.js";
import {
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
} from "../src/services/work-ledger-state.js";

function nextEmptyRevision(previous) {
  return {
    ...structuredClone(previous),
    revision: previous.revision + 1,
  };
}

for (const [name, createProcessor] of [
  ["local", createLocalWorkLedgerCandidateProcessor],
  ["worker", createWorkerWorkLedgerCandidateProcessor],
]) {
  test(`${name} candidate processor validates consecutive committed revisions`, async (t) => {
    const processor = createProcessor();
    t.after(() => processor.close());
    const limits = normalizeWorkLedgerLimits();
    const initial = emptyWorkLedgerState();

    const first = await processor.prepare({
      previousState: initial,
      candidate: nextEmptyRevision(initial),
      limits,
      appendGraphMemory: false,
    });
    assert.equal(first.revision, 1);
    await processor.commit();

    const second = await processor.prepare({
      previousState: first,
      candidate: nextEmptyRevision(first),
      limits,
      appendGraphMemory: false,
    });
    assert.equal(second.revision, 2);
    await processor.discard();

    const replacement = await processor.prepare({
      previousState: first,
      candidate: nextEmptyRevision(first),
      limits,
      appendGraphMemory: false,
    });
    assert.deepEqual(replacement, second);
    await processor.commit();
  });

  test(`${name} candidate processor preserves ledger validation errors`, async (t) => {
    const processor = createProcessor();
    t.after(() => processor.close());
    const previousState = emptyWorkLedgerState();

    await assert.rejects(
      processor.prepare({
        previousState,
        candidate: {
          ...nextEmptyRevision(previousState),
          schemaVersion: 999,
        },
        limits: normalizeWorkLedgerLimits(),
        appendGraphMemory: false,
      }),
      (error) =>
        error.code === "WORK_LEDGER_STATE_CORRUPTED" &&
        error.statusCode === 503 &&
        error.cause?.code === "WORK_LEDGER_STATE_CORRUPTED",
    );
  });
}

test("worker candidate processor resynchronizes after a different durable state object", async (t) => {
  const processor = createWorkerWorkLedgerCandidateProcessor();
  t.after(() => processor.close());
  const limits = normalizeWorkLedgerLimits();
  const initial = emptyWorkLedgerState();
  const first = await processor.prepare({
    previousState: initial,
    candidate: nextEmptyRevision(initial),
    limits,
    appendGraphMemory: false,
  });
  await processor.commit();

  const recovered = structuredClone(first);
  const second = await processor.prepare({
    previousState: recovered,
    candidate: nextEmptyRevision(recovered),
    limits,
    appendGraphMemory: false,
  });

  assert.equal(second.revision, 2);
  await processor.commit();
});
