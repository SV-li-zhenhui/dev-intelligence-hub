import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

class ScriptedCandidateWorker extends EventEmitter {
  constructor(respond) {
    super();
    this.respond = respond;
    this.messages = [];
    this.terminationCount = 0;
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => this.emit("message", this.respond(message)));
  }

  ref() {}

  unref() {}

  async terminate() {
    this.terminationCount += 1;
    return 1;
  }
}

function successfulCandidateWorkerResponse(message) {
  if (message.type === "prepare") {
    return {
      requestId: message.requestId,
      ok: true,
      normalized: structuredClone(message.candidate),
    };
  }
  return { requestId: message.requestId, ok: true };
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

for (const [caseName, createCandidate] of [
  ["non-enumerable fields", (previous) => {
    const candidate = nextEmptyRevision(previous);
    Object.defineProperty(candidate, "hiddenUnexpected", {
      value: "must not be sanitized",
      enumerable: false,
    });
    return candidate;
  }],
  ["symbol fields", (previous) => {
    const candidate = nextEmptyRevision(previous);
    candidate[Symbol("unexpected")] = "must not be sanitized";
    return candidate;
  }],
  ["custom prototypes", (previous) =>
    Object.assign(
      Object.create({ inheritedUnexpected: true }),
      nextEmptyRevision(previous),
    )],
]) {
  test(`candidate processors reject transport-unsafe ${caseName}`, async (t) => {
    const previousState = emptyWorkLedgerState();
    for (const [processorName, createProcessor] of [
      ["local", createLocalWorkLedgerCandidateProcessor],
      ["worker", createWorkerWorkLedgerCandidateProcessor],
    ]) {
      await t.test(processorName, async (t) => {
        const processor = createProcessor();
        t.after(() => processor.close());
        await assert.rejects(
          processor.prepare({
            previousState,
            candidate: createCandidate(previousState),
            limits: normalizeWorkLedgerLimits(),
            appendGraphMemory: false,
          }),
          (error) =>
            error.code === "WORK_LEDGER_STATE_CORRUPTED" &&
            error.statusCode === 503,
        );
      });
    }
  });
}

for (const operation of ["commit", "discard"]) {
  test(`malformed ${operation} response terminates and resynchronizes the worker`, async (t) => {
    const firstWorker = new ScriptedCandidateWorker((message) => {
      const response = successfulCandidateWorkerResponse(message);
      return message.type === operation
        ? { ...response, unexpected: true }
        : response;
    });
    const replacementWorker = new ScriptedCandidateWorker(
      successfulCandidateWorkerResponse,
    );
    const workers = [firstWorker, replacementWorker];
    const processor = createWorkerWorkLedgerCandidateProcessor({
      workerFactory: () => workers.shift(),
    });
    t.after(() => processor.close());
    const limits = normalizeWorkLedgerLimits();
    const initial = emptyWorkLedgerState();
    const first = await processor.prepare({
      previousState: initial,
      candidate: nextEmptyRevision(initial),
      limits,
      appendGraphMemory: false,
    });

    await assert.rejects(
      processor[operation](),
      (error) =>
        error.code === "WORK_LEDGER_STATE_CORRUPTED" &&
        error.statusCode === 503,
    );

    const durableState = operation === "commit" ? first : initial;
    const replacement = await processor.prepare({
      previousState: durableState,
      candidate: nextEmptyRevision(durableState),
      limits,
      appendGraphMemory: false,
    });
    await processor.commit();

    assert.equal(firstWorker.terminationCount, 1);
    assert.equal(
      Object.hasOwn(replacementWorker.messages[0], "previousState"),
      true,
    );
    assert.equal(replacement.revision, durableState.revision + 1);
  });
}
