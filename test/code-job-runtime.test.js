import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { codeJobConfirmationIdForGrant } from "../src/domain/code-action-proposal-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { createCodeJobRuntime } from "../src/code-job-runtime.js";
import { OperationQueue } from "../src/lib/operation-queue.js";

class MemoryStore {
  constructor({ events = [], value = null } = {}) {
    this.events = events;
    this.value = value === null ? null : structuredClone(value);
    this.writeCount = 0;
  }

  async read(_name, fallback) {
    this.events.push("read");
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.events.push("write");
    this.writeCount += 1;
    this.value = structuredClone(value);
  }
}

class FakeGuard {
  constructor({ events = [], acquireError = null, closeError = null } = {}) {
    this.events = events;
    this.acquireError = acquireError;
    this.closeError = closeError;
    this.acquired = false;
    this.closeCount = 0;
    this.name = null;
  }

  async acquire() {
    this.events.push("acquire");
    if (this.acquireError) throw this.acquireError;
    this.acquired = true;
  }

  async run(operation) {
    this.events.push("lease");
    if (!this.acquired) throw new Error("guard is not acquired");
    return operation();
  }

  async close() {
    this.events.push("close");
    this.closeCount += 1;
    this.acquired = false;
    if (this.closeError) throw this.closeError;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function grant() {
  return createCodeJobGrant({
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 3,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Find the retry race without changing source files.",
    acceptanceCriteria: ["The race is identified with file evidence."],
    evidence: ["CI intermittently reports a stale revision."],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  });
}

function envelope({ requestId = "approval-request-0001" } = {}) {
  const sealedGrant = grant();
  const actor = {
    provider: "local-code",
    accountId: "controlled-code-executor",
  };
  const target = {
    provider: "local-code",
    resourceId: sealedGrant.workspaceId,
    version: sealedGrant.contentDigest,
  };
  const action = { type: "create_code_job", grant: sealedGrant };
  const plan = normalizeConfirmationPlan({
    id: codeJobConfirmationIdForGrant(sealedGrant),
    kind: "local.code-job-create",
    requestedBy: sealedGrant.requestedBy,
    actor,
    target,
    action,
    display: {
      title: "本地代码任务",
      summary: sealedGrant.summary,
      actionLabel: "只创建本地任务",
      evidence: sealedGrant.evidence,
      payload: { actor, target, action },
    },
  });
  return {
    schemaVersion: 1,
    id: plan.id,
    idempotencyKey: `confirmation-${plan.approvalBindingDigest}`,
    kind: plan.kind,
    requestedBy: plan.requestedBy,
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
    displayedPayloadDigest: plan.displayedPayloadDigest,
    approvalBindingDigest: plan.approvalBindingDigest,
    execution: {
      requestId,
      attempt: 1,
      startedAt: "2026-08-02T06:00:00.000Z",
    },
  };
}

async function runtimeFixture({
  store = new MemoryStore(),
  guard = new FakeGuard(),
  executor,
  brainDirectory,
  workerFactory,
} = {}) {
  const runtime = await createCodeJobRuntime({
    store,
    grantVerifier: { async verify(value) { return structuredClone(value); } },
    operationQueue: new OperationQueue(),
    clock: () => new Date("2026-08-02T06:00:01.000Z"),
    createGuard({ name }) {
      guard.name = name;
      return guard;
    },
    ...(executor === undefined ? {} : { executor }),
    ...(brainDirectory === undefined ? {} : { brainDirectory }),
    ...(workerFactory === undefined ? {} : { workerFactory }),
  });
  return { runtime, store, guard };
}

test("runtime acquires and recovers before exposing local approval and reader ports", async () => {
  const events = [];
  const store = new MemoryStore({ events });
  const guard = new FakeGuard({ events });
  const { runtime } = await runtimeFixture({ store, guard });

  assert.deepEqual(events.slice(0, 3), ["acquire", "lease", "read"]);
  assert.equal(guard.name, "mydashboard-code-job-v1");
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.confirmationExecutor), true);
  assert.equal(Object.isFrozen(runtime.reader), true);
  assert.equal(Object.isFrozen(runtime.control), true);
  assert.equal(runtime.worker, null);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "close",
    "confirmationExecutor",
    "control",
    "reader",
    "worker",
  ]);

  const first = await runtime.confirmationExecutor.execute(envelope());
  const repeated = await runtime.confirmationExecutor.execute(
    envelope({ requestId: "approval-request-0002" }),
  );
  assert.equal(first.status, "applied");
  assert.equal(first.receipt.id, codeJobIdForGrant(grant()));
  assert.equal(repeated.status, "already");
  assert.equal(store.writeCount, 1);

  const listed = await runtime.reader.listNewest();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].status, "queued");
  const found = await runtime.reader.get(first.receipt.id);
  assert.equal(found.jobId, first.receipt.id);
  assert.equal("approval" in found, false);
  assert.equal("requestId" in found, false);
  assert.equal(JSON.stringify(found).includes("configDigest"), false);

  await runtime.close();
});

test("close is idempotent and all ports fail closed afterwards", async () => {
  const { runtime, guard } = await runtimeFixture();
  const firstClose = runtime.close();
  const secondClose = runtime.close();

  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.equal(guard.closeCount, 1);
  await assert.rejects(
    runtime.reader.list(),
    (error) =>
      error.code === "CODE_JOB_RUNTIME_CLOSED" && error.statusCode === 503,
  );
  await assert.rejects(
    runtime.confirmationExecutor.reconcile(envelope()),
    (error) => error.code === "CODE_JOB_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.control.pause({
      jobId: codeJobIdForGrant(grant()),
      expectedRevision: 1,
      reason: "pause",
    }),
    (error) => error.code === "CODE_JOB_RUNTIME_CLOSED",
  );
});

test("worker cycles stay private and close drains the complete admitted cycle", async () => {
  const entered = deferred();
  const release = deferred();
  let workerOptions;
  const { runtime, guard } = await runtimeFixture({
    executor: {},
    brainDirectory: {},
    workerFactory(options) {
      workerOptions = options;
      return {
        runCycle(value) {
          return options.operationQueue.enqueue(async () => {
            entered.resolve();
            await release.promise;
            return { selected: value.limit, outcomes: [] };
          });
        },
      };
    },
  });

  assert.equal(Object.isFrozen(runtime.worker), true);
  assert.equal(typeof workerOptions.jobStore.getForWorker, "function");
  assert.equal("jobStore" in runtime, false);
  const cycle = runtime.worker.runCycle({ limit: 1 });
  await entered.promise;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(guard.closeCount, 0);

  release.resolve();
  assert.deepEqual(await cycle, { selected: 1, outcomes: [] });
  await closing;
  assert.equal(guard.closeCount, 1);
  await assert.rejects(
    runtime.worker.runCycle({ limit: 1 }),
    (error) => error.code === "CODE_JOB_RUNTIME_CLOSED",
  );
});

test("pause control is admitted while a worker cycle is still running", async () => {
  const entered = deferred();
  const release = deferred();
  const { runtime } = await runtimeFixture({
    executor: {},
    brainDirectory: {},
    workerFactory(options) {
      return {
        runCycle() {
          return options.operationQueue.enqueue(async () => {
            entered.resolve();
            await release.promise;
            return { selected: 1, outcomes: [] };
          });
        },
      };
    },
  });
  const created = await runtime.confirmationExecutor.execute(envelope());
  const queued = await runtime.reader.get(created.receipt.id);
  const cycle = runtime.worker.runCycle({ limit: 1 });
  await entered.promise;

  const pause = runtime.control.pause({
    jobId: queued.jobId,
    expectedRevision: queued.revision,
    reason: "用户请求安全暂停",
  });
  const observed = await Promise.race([
    pause.then((value) => ({ kind: "pause", value })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
  ]);

  release.resolve();
  await cycle;
  const paused = await pause;
  await runtime.close();

  assert.equal(observed.kind, "pause");
  assert.equal(paused.job.status, "paused");
});

test("close drains an admitted approval before releasing the process guard", async () => {
  const enteredWrite = deferred();
  const releaseWrite = deferred();
  class BlockingStore extends MemoryStore {
    async write(name, value) {
      enteredWrite.resolve();
      await releaseWrite.promise;
      return super.write(name, value);
    }
  }
  const store = new BlockingStore();
  const guard = new FakeGuard();
  const { runtime } = await runtimeFixture({ store, guard });

  const creation = runtime.confirmationExecutor.execute(envelope());
  await enteredWrite.promise;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(guard.closeCount, 0);
  await assert.rejects(
    runtime.reader.list(),
    (error) => error.code === "CODE_JOB_RUNTIME_CLOSED",
  );

  releaseWrite.resolve();
  assert.equal((await creation).status, "applied");
  await closing;
  assert.equal(guard.closeCount, 1);

  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore(),
      executor: {},
      createGuard: () => new FakeGuard(),
    }),
    /executor and brainDirectory/,
  );
});

test("recovery failure releases the independent guard and preserves its cause", async () => {
  const recoveryFailure = new Error("durable state unavailable");
  const store = {
    async read() {
      throw recoveryFailure;
    },
    async write() {},
  };
  const guard = new FakeGuard({ closeError: new Error("close also failed") });

  await assert.rejects(
    createCodeJobRuntime({
      store,
      operationQueue: new OperationQueue(),
      createGuard: () => guard,
    }),
    (error) => error === recoveryFailure,
  );
  assert.equal(guard.closeCount, 1);
});

test("guard acquisition failure also closes once and never reads durable state", async () => {
  const acquisitionFailure = new Error("guard is held");
  const events = [];
  const store = new MemoryStore({ events });
  const guard = new FakeGuard({ events, acquireError: acquisitionFailure });

  await assert.rejects(
    createCodeJobRuntime({
      store,
      operationQueue: new OperationQueue(),
      createGuard: () => guard,
    }),
    (error) => error === acquisitionFailure,
  );
  assert.deepEqual(events, ["acquire", "close"]);
  assert.equal(guard.closeCount, 1);
});

test("invalid startup dependencies fail closed without exposing a partial runtime", async () => {
  await assert.rejects(
    createCodeJobRuntime({ createGuard: null }),
    /createGuard must be a function/,
  );
  await assert.rejects(
    createCodeJobRuntime({
      store: {},
      createGuard: () => new FakeGuard(),
    }),
    /code job durable store is invalid/,
  );
  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore(),
      createGuard: () => ({}),
    }),
    /code job guard is invalid/,
  );

  const guard = new FakeGuard();
  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore(),
      operationQueue: {},
      createGuard: () => guard,
    }),
    /operationQueue is invalid/,
  );
  assert.equal(guard.closeCount, 1);
});
