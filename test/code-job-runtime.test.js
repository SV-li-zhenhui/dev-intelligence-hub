import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { codeJobConfirmationIdForGrant } from "../src/domain/code-action-proposal-confirmation.js";
import { memoryRecordForCodeJobEvent } from "../src/domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { createChangePackage } from "../src/domain/change-package-contract.js";
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

class KeyedMemoryStore {
  constructor() {
    this.values = new Map();
    this.blockArchiveRead = null;
    this.archiveReadEntered = null;
    this.receivedSignal = null;
  }

  get value() {
    return this.values.get("code-job-state") ?? null;
  }

  async read(name, fallback, options) {
    if (
      this.blockArchiveRead !== null &&
      name.includes("code-job-tombstone-index")
    ) {
      this.receivedSignal = options?.signal ?? null;
      this.archiveReadEntered?.resolve();
      return this.blockArchiveRead.promise;
    }
    return structuredClone(this.values.get(name) ?? fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
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
    schemaVersion: 2,
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 3,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:issue:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    inputBinding: null,
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
  memoryReceiptVerifier,
  completedChangeExporter,
  changePackageProducer,
  changePackageReader,
  controlledCommitDelivery,
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
    ...(memoryReceiptVerifier === undefined
      ? {}
      : { memoryReceiptVerifier }),
    ...(completedChangeExporter === undefined
      ? {}
      : { completedChangeExporter }),
    ...(changePackageProducer === undefined ? {} : { changePackageProducer }),
    ...(changePackageReader === undefined ? {} : { changePackageReader }),
    ...(controlledCommitDelivery === undefined
      ? {}
      : { controlledCommitDelivery }),
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
  assert.deepEqual(Object.keys(runtime.control).sort(), [
    "cancel",
    "pause",
    "resume",
  ]);
  assert.equal(Object.isFrozen(runtime.projectionSource), true);
  assert.equal(runtime.worker, null);
  assert.equal(runtime.changePackageDelivery, null);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "changePackageDelivery",
    "close",
    "confirmationExecutor",
    "control",
    "projectionSource",
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
  const detail = await runtime.reader.getDetail({ jobId: first.receipt.id });
  assert.equal(detail.job.jobId, first.receipt.id);
  assert.equal(detail.archived, false);
  assert.equal(detail.historyAvailable, true);

  await runtime.close();
});

async function enqueueCompletedChangePackageDelivery(runtime, jobs) {
  const creation = await runtime.confirmationExecutor.execute(envelope());
  const queued = await jobs.getForWorker(creation.receipt.id);
  const starting = await jobs.claimStarting({
    jobId: queued.jobId,
    expectedRevision: queued.revision,
  });
  const workspaceRevision = "4".repeat(64);
  const active = await jobs.activate({
    jobId: queued.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision,
  });
  const actionId = "complete-change-package";
  const prepared = await jobs.prepareAction({
    jobId: queued.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId,
      expectedWorkspaceRevision: workspaceRevision,
    },
  });
  const detail = { created: [], modified: [], deleted: [] };
  const observed = await jobs.recordObservation({
    jobId: queued.jobId,
    expectedRevision: prepared.job.revision,
    actionId,
    status: "succeeded",
    workspaceRevision,
    detail,
  });
  await jobs.complete({
    jobId: queued.jobId,
    expectedRevision: observed.job.revision,
    result: { summary: "Change package ready", manifest: detail },
    changePackageDelivery: true,
  });
  return { workspaceRevision, actionId };
}

test("change-package delivery is atomically configured, narrow, and drained on close", async () => {
  const entered = deferred();
  const release = deferred();
  let workerOptions;
  let manifest;
  const calls = [];
  const completedChangeExporter = {
    marker: "exporter",
    async export(request) {
      assert.equal(this.marker, "exporter");
      calls.push({ kind: "export", request });
      entered.resolve();
      await release.promise;
      return {
        workspace: {
          id: "widgets-local",
          sourceRevision: "3".repeat(64),
          workspaceRevision: request.expectedWorkspaceRevision,
        },
        passedProfiles: [{
          id: "node-tests",
          configDigest: "b".repeat(64),
          workspaceRevision: request.expectedWorkspaceRevision,
          actionId: "test-change-package",
          attemptNumber: 1,
          imageId: `sha256:${"4".repeat(64)}`,
          artifacts: {
            output: { path: "proof/output.json", sha256: "5".repeat(64), bytes: 1 },
            stdout: { path: "proof/stdout.json", sha256: "6".repeat(64), bytes: 1 },
            stderr: { path: "proof/stderr.json", sha256: "7".repeat(64), bytes: 1 },
          },
        }],
        created: [],
        modified: [],
        deleted: [],
      };
    },
  };
  const changePackageProducer = {
    marker: "producer",
    async create(draft) {
      assert.equal(this.marker, "producer");
      calls.push({ kind: "create", draft });
      manifest = createChangePackage(draft).manifest;
      return manifest;
    },
  };
  const changePackageReader = {
    marker: "reader",
    async get(packageId) {
      assert.equal(this.marker, "reader");
      calls.push({ kind: "get", packageId });
      return manifest;
    },
  };
  const { runtime, guard } = await runtimeFixture({
    executor: {},
    brainDirectory: {},
    completedChangeExporter,
    changePackageProducer,
    changePackageReader,
    workerFactory(options) {
      workerOptions = options;
      return {
        async runCycle() { return { selected: 0, outcomes: [] }; },
        requestCancellation() { return false; },
      };
    },
  });

  assert.equal(workerOptions.changePackageDeliveryEnabled, true);
  assert.deepEqual(Object.keys(runtime.changePackageDelivery), ["runCycle"]);
  assert.equal(Object.isFrozen(runtime.changePackageDelivery), true);
  const expected = await enqueueCompletedChangePackageDelivery(
    runtime,
    workerOptions.jobStore,
  );
  const cycle = runtime.changePackageDelivery.runCycle({ limit: 1 });
  await entered.promise;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(guard.closeCount, 0);

  release.resolve();
  assert.deepEqual(await cycle, {
    observed: 1,
    created: 1,
    acknowledged: 1,
    cursor: 1,
    highWatermark: 1,
    pending: 0,
  });
  assert.deepEqual(calls.map(({ kind }) => kind), ["export", "create", "get"]);
  assert.deepEqual(calls[0].request, {
    sessionId: codeJobIdForGrant(grant()),
    completedActionId: expected.actionId,
    expectedWorkspaceRevision: expected.workspaceRevision,
  });
  await closing;
  assert.equal(guard.closeCount, 1);
  await assert.rejects(
    runtime.changePackageDelivery.runCycle(),
    (error) => error.code === "CODE_JOB_RUNTIME_CLOSED",
  );
});

test("change-package delivery dependencies are all-or-none narrow ports", async () => {
  const exporter = { async export() {} };
  const producer = { async create() {} };
  const reader = { async get() {} };
  for (const dependencies of [
    { completedChangeExporter: exporter },
    { completedChangeExporter: exporter, changePackageProducer: producer },
    { changePackageProducer: producer, changePackageReader: reader },
    { controlledCommitDelivery: { async deliver() {} } },
  ]) {
    let guardCalls = 0;
    await assert.rejects(
      createCodeJobRuntime({
        store: new MemoryStore(),
        ...dependencies,
        createGuard() {
          guardCalls += 1;
          return new FakeGuard();
        },
      }),
      /configured together/,
    );
    assert.equal(guardCalls, 0);
  }

  for (const dependencies of [
    { completedChangeExporter: {}, changePackageProducer: producer, changePackageReader: reader },
    { completedChangeExporter: exporter, changePackageProducer: {}, changePackageReader: reader },
    { completedChangeExporter: exporter, changePackageProducer: producer, changePackageReader: {} },
    {
      completedChangeExporter: exporter,
      changePackageProducer: producer,
      changePackageReader: reader,
      controlledCommitDelivery: {},
    },
  ]) {
    await assert.rejects(
      createCodeJobRuntime({ store: new MemoryStore(), ...dependencies }),
      /change package/,
    );
  }

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "export", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => {};
    },
  });
  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore(),
      completedChangeExporter: accessor,
      changePackageProducer: producer,
      changePackageReader: reader,
    }),
    /change package/,
  );
  assert.equal(getterCalls, 0);
});

test("projection source is private, ordered, and bound to the memory verifier", async () => {
  const verificationRequests = [];
  const { runtime } = await runtimeFixture({
    memoryReceiptVerifier: {
      async verify(value) {
        verificationRequests.push(structuredClone(value));
        return { ...structuredClone(value), persisted: true };
      },
    },
  });
  const created = await runtime.confirmationExecutor.execute(envelope());
  const queued = await runtime.reader.get(created.receipt.id);
  await runtime.control.pause({
    jobId: queued.jobId,
    expectedRevision: queued.revision,
    reason: "等待本地记忆投影",
  });

  const batch = await runtime.projectionSource.readBatch({ limit: 1 });
  assert.equal(batch.cursor, 0);
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items[0].kind, "paused");
  const event = batch.items[0];
  const record = normalizeMemoryRecord(memoryRecordForCodeJobEvent(event));
  const request = {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    jobId: event.jobId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: record.recordId,
    memoryRecordDigest: record.contentDigest,
  };

  assert.deepEqual(await runtime.projectionSource.ack(request), {
    status: "applied",
    cursor: 1,
    highWatermark: 1,
  });
  assert.deepEqual(verificationRequests, [{
    recordId: record.recordId,
    contentDigest: record.contentDigest,
    source: record.source,
  }]);
  assert.deepEqual(await runtime.projectionSource.readBatch(), {
    cursor: 1,
    highWatermark: 1,
    items: [],
  });
  assert.equal("jobStore" in runtime, false);
  await runtime.close();
});

test("runtime supports projection-only recovery without execution authority", async () => {
  const store = new MemoryStore();
  const guard = new FakeGuard();
  const runtime = await createCodeJobRuntime({
    store,
    operationQueue: new OperationQueue(),
    memoryReceiptVerifier: {
      async verify(value) { return { ...value, persisted: true }; },
    },
    createGuard: () => guard,
  });

  assert.equal(runtime.confirmationExecutor, null);
  assert.equal(runtime.worker, null);
  assert.equal(Object.isFrozen(runtime.reader), true);
  assert.equal(Object.isFrozen(runtime.control), true);
  assert.equal(Object.isFrozen(runtime.projectionSource), true);
  assert.deepEqual(await runtime.projectionSource.readBatch(), {
    cursor: 0,
    highWatermark: 0,
    items: [],
  });
  await runtime.close();
});

test("executor authority cannot bypass grant verification through a custom worker", async () => {
  const events = [];
  let workerFactoryCalled = false;

  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore({ events }),
      executor: {},
      brainDirectory: {},
      operationQueue: new OperationQueue(),
      createGuard: () => new FakeGuard({ events }),
      workerFactory() {
        workerFactoryCalled = true;
        return { async runCycle() {} };
      },
    }),
    (error) =>
      error instanceof TypeError &&
      error.message === "grantVerifier is required when executor is configured",
  );

  assert.equal(workerFactoryCalled, false);
  assert.deepEqual(events, []);
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
  await assert.rejects(
    runtime.projectionSource.readBatch({ limit: 1 }),
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
        requestCancellation() { return false; },
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

test("aborting an archived evidence read releases runtime close and a recovered runtime can retry", async () => {
  const store = new KeyedMemoryStore();
  let jobStore;
  const { runtime, guard } = await runtimeFixture({
    store,
    executor: {},
    brainDirectory: {},
    memoryReceiptVerifier: {
      async verify(value) {
        return { ...structuredClone(value), persisted: true };
      },
    },
    workerFactory(options) {
      jobStore = options.jobStore;
      return {
        async runCycle() { return { selected: 0, outcomes: [] }; },
        requestCancellation() { return false; },
      };
    },
  });
  const created = await runtime.confirmationExecutor.execute(envelope());
  const queued = await jobStore.getForWorker(created.receipt.id);
  const failed = await jobStore.fail({
    jobId: queued.jobId,
    expectedRevision: queued.revision,
    result: { code: "EVIDENCE_ARCHIVE_FIXTURE" },
  });
  const memoryDigest = "9".repeat(64);
  await jobStore.markMemoryProjected({
    jobId: failed.job.jobId,
    expectedRevision: failed.job.revision,
    sourceRecordDigest: failed.job.recordDigest,
    memoryRecordId: `memory-${memoryDigest}`,
    memoryRecordDigest: memoryDigest,
  });
  await jobStore.compactTerminalPrefix({
    compactionId: "runtime-evidence-archive",
    expectedRevision: store.value.revision,
    targetThroughSequence: failed.job.sequence,
    preArchiveDigest: store.value.archive.digest,
  });

  store.blockArchiveRead = deferred();
  store.archiveReadEntered = deferred();
  const controller = new AbortController();
  const evidenceRead = runtime.reader.readDeliveryEvidence({
    jobId: failed.job.jobId,
    signal: controller.signal,
  });
  await store.archiveReadEntered.promise;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(guard.closeCount, 0);

  controller.abort();
  await assert.rejects(evidenceRead, (error) => error?.name === "AbortError");
  assert.equal(store.receivedSignal, controller.signal);
  await closing;
  assert.equal(guard.closeCount, 1);

  store.blockArchiveRead = null;
  store.archiveReadEntered = null;
  const recovered = await runtimeFixture({ store });
  const retry = await recovered.runtime.reader.readDeliveryEvidence({
    jobId: failed.job.jobId,
  });
  assert.equal(retry.archived, true);
  assert.equal(retry.job.jobId, failed.job.jobId);
  assert.equal(retry.job.memoryProjection.recordId, `memory-${memoryDigest}`);
  await recovered.runtime.close();
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
        requestCancellation() { return false; },
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

test("control transitions share the worker session-transition lease", async () => {
  let workerOptions;
  const { runtime } = await runtimeFixture({
    executor: {},
    brainDirectory: {},
    workerFactory(options) {
      workerOptions = options;
      return {
        async runCycle() { return { selected: 0, outcomes: [] }; },
        requestCancellation() { return false; },
      };
    },
  });
  const created = await runtime.confirmationExecutor.execute(envelope());
  const whileLeaseIsHeld = async (operation) => {
    const entered = deferred();
    const release = deferred();
    const held = workerOptions.sessionTransitionLease.run(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const mutation = operation();
    const observed = await Promise.race([
      mutation.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]);
    assert.equal(observed, "waiting");
    release.resolve();
    await held;
    return mutation;
  };

  let current = await runtime.reader.get(created.receipt.id);
  const paused = await whileLeaseIsHeld(() => runtime.control.pause({
    jobId: current.jobId,
    expectedRevision: current.revision,
    reason: "用户请求安全暂停",
  }));
  assert.equal(paused.job.status, "paused");

  current = paused.job;
  const resumed = await whileLeaseIsHeld(() => runtime.control.resume({
    jobId: current.jobId,
    expectedRevision: current.revision,
  }));
  assert.equal(resumed.job.status, "queued");

  current = resumed.job;
  const cancelled = await whileLeaseIsHeld(() => runtime.control.cancel({
    jobId: current.jobId,
    expectedRevision: current.revision,
    reason: "用户取消任务",
  }));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(Object.isFrozen(workerOptions.sessionTransitionLease), true);
  assert.equal("sessionTransitionLease" in runtime, false);
  await runtime.close();
});

test("cancel persists before best-effort worker interruption and keeps it private", async () => {
  const events = [];
  const store = new MemoryStore({ events });
  let workerOptions;
  const { runtime } = await runtimeFixture({
    store,
    executor: {},
    brainDirectory: {},
    workerFactory(options) {
      workerOptions = options;
      return {
        async runCycle() {
          return options.operationQueue.enqueue(() => ({
            selected: 0,
            outcomes: [],
          }));
        },
        requestCancellation(jobId) {
          events.push(`request-cancellation:${jobId}`);
          throw new Error("best-effort interruption failed");
        },
      };
    },
  });
  const created = await runtime.confirmationExecutor.execute(envelope());
  const queued = await runtime.reader.get(created.receipt.id);
  const starting = await workerOptions.jobStore.claimStarting({
    jobId: queued.jobId,
    expectedRevision: queued.revision,
  });
  events.length = 0;

  const cancelled = await runtime.control.cancel({
    jobId: starting.job.jobId,
    expectedRevision: starting.job.revision,
    reason: "用户从本地指挥中枢取消代码任务",
  });

  const writeIndex = events.lastIndexOf("write");
  const signalIndex = events.indexOf(`request-cancellation:${queued.jobId}`);
  assert.equal(cancelled.status, "applied");
  assert.equal(cancelled.job.status, "cancelling");
  assert.equal(writeIndex >= 0, true);
  assert.equal(signalIndex > writeIndex, true);
  assert.deepEqual(Object.keys(runtime.worker), ["runCycle"]);
  await runtime.close();
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

  const invalidWorkerGuard = new FakeGuard();
  await assert.rejects(
    createCodeJobRuntime({
      store: new MemoryStore(),
      executor: {},
      brainDirectory: {},
      grantVerifier: { async verify(value) { return value; } },
      workerFactory: () => ({ async runCycle() {} }),
      createGuard: () => invalidWorkerGuard,
    }),
    /code job worker is invalid/,
  );
  assert.equal(invalidWorkerGuard.closeCount, 1);
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
