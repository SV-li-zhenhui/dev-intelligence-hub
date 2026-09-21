import assert from "node:assert/strict";
import test from "node:test";

import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { ChangePackageApplicationProjectionStore } from "../src/services/change-package-application-projection-store.js";
import {
  ChangePackageApplicationResultReconciler,
  ChangePackageApplicationResultReconcilerError,
} from "../src/services/change-package-application-result-reconciler.js";

const JOB_ID = `code-job-${"a".repeat(55)}`;
const PACKAGE_DIGEST = "b".repeat(64);
const PACKAGE_ID = `change-package-${PACKAGE_DIGEST}`;
const WORKSPACE_ID = "dashboard";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function confirmationId(index) {
  return `confirmation-change-package-apply-${String(index).repeat(64)}`;
}

function approvalDigest(index) {
  return "abcdef0123456789"[index].repeat(64);
}

function receiptFor(item) {
  return {
    id: `change-package-application-${digestValue({
      confirmationId: item.confirmationId,
      approvalBindingDigest: item.approvalBindingDigest,
    })}`,
    createdAt: "2026-08-03T01:01:00.000Z",
  };
}

class NamedMemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function applicationPlan(workItemId = "work-application-1") {
  const requestedBy = { roleId: "developer", workItemId };
  const actor = {
    provider: "local-code",
    accountId: "change-package-application-service",
  };
  const target = {
    provider: "local-code",
    resourceId: WORKSPACE_ID,
    version: "0123456789abcdef0123456789abcdef01234567",
  };
  const action = {
    type: "apply_change_package",
    packageId: PACKAGE_ID,
    packageDigest: PACKAGE_DIGEST,
    job: { id: JOB_ID, revision: 8, recordDigest: "f".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "1".repeat(64) },
    grant: { digest: "2".repeat(64) },
    workspace: {
      id: WORKSPACE_ID,
      sourceRevision: "3".repeat(64),
      workspaceRevision: "4".repeat(64),
    },
    changeSetDigest: "5".repeat(64),
    testEvidenceDigest: "6".repeat(64),
    targetAuthorityDigest: "7".repeat(64),
    expectedHeadOid: target.version,
  };
  return {
    id: `confirmation-change-package-apply-${digestValue({
      requestedBy,
      action,
    })}`,
    kind: "local.change-package-apply",
    requestedBy,
    actor,
    target,
    action,
    display: {
      title: "应用已验证的本地变更包",
      summary: "将已验证变更应用到本地 checkout。",
      actionLabel: "确认并应用变更包",
      evidence: ["固定测试已通过"],
      payload: { actor, target, action },
    },
  };
}

function sequenceClock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

function sourceItem(index, overrides = {}) {
  const queueStatus = overrides.queueStatus ?? "pending";
  const executionOutcome = overrides.executionOutcome ?? ({
    pending: null,
    executing: "unknown",
    rejected: null,
    stale: "stale",
    failed: "absent",
    completed: "applied",
  }[queueStatus]);
  const item = {
    confirmationId: confirmationId(index),
    approvalBindingDigest: approvalDigest(index),
    requestedBy: { roleId: "developer", workItemId: `work-${index}` },
    job: { id: JOB_ID, revision: 8, recordDigest: "f".repeat(64) },
    packageId: PACKAGE_ID,
    packageDigest: PACKAGE_DIGEST,
    workspaceId: WORKSPACE_ID,
    itemRevision: index + 1,
    createdAt: `2026-08-03T01:0${index}:00.000Z`,
    updatedAt: `2026-08-03T01:1${index}:00.000Z`,
    queueStatus,
    executionOutcome,
    receipt: null,
    failure: null,
    rejectedAt: null,
    ...overrides,
  };
  if (queueStatus === "completed" && overrides.receipt === undefined) {
    item.receipt = receiptFor(item);
  }
  if (queueStatus === "failed" && overrides.failure === undefined) {
    item.failure = {
      code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
      outcome: executionOutcome,
      retryable: executionOutcome === "absent",
      at: item.updatedAt,
    };
  }
  if (queueStatus === "rejected" && overrides.rejectedAt === undefined) {
    item.rejectedAt = item.updatedAt;
  }
  return item;
}

function snapshot(sourceRevision, items) {
  return {
    sourceRevision,
    unchanged: false,
    snapshotDigest: digestValue({ sourceRevision, items }),
    items,
  };
}

function fixture({ source, results = new Map(), checkpoint } = {}) {
  const calls = { snapshots: [], results: [], applies: [] };
  const initialCheckpoint = checkpoint ?? {
    sourceRevision: 0,
    sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
  };
  const reconciler = new ChangePackageApplicationResultReconciler({
    applicationResultSource: {
      async readSnapshot(value) {
        calls.snapshots.push(value);
        return typeof source === "function" ? source(value) : source;
      },
    },
    applicationReader: {
      async getResult(value) {
        calls.results.push(value);
        const result = results.get(value);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    projectionStore: {
      async getCheckpoint() {
        return initialCheckpoint;
      },
      async applySnapshot(value) {
        calls.applies.push(value);
        return {
          revision: 1,
          sourceRevision: value.sourceRevision,
          sourceSnapshotDigest: value.sourceSnapshotDigest,
          entryCount: value.entries.length,
        };
      },
    },
  });
  return { reconciler, calls, checkpoint: initialCheckpoint };
}

function applicationResult(item, overrides = {}) {
  return {
    confirmationId: item.confirmationId,
    status: "applied",
    packageId: item.packageId,
    workspaceId: item.workspaceId,
    receipt: item.receipt,
    ...overrides,
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof ChangePackageApplicationResultReconcilerError &&
    error.code === code;
}

test("reconciler maps every queue state and verifies completed application receipts", async () => {
  const items = [
    sourceItem(1, { queueStatus: "pending" }),
    sourceItem(2, { queueStatus: "executing" }),
    sourceItem(3, { queueStatus: "rejected" }),
    sourceItem(4, { queueStatus: "stale" }),
    sourceItem(5, { queueStatus: "failed" }),
    sourceItem(6, {
      queueStatus: "completed",
      executionOutcome: "applied",
    }),
    sourceItem(7, {
      queueStatus: "completed",
      executionOutcome: "already",
    }),
  ].sort((left, right) => left.confirmationId.localeCompare(right.confirmationId));
  const results = new Map(
    items
      .filter(({ queueStatus }) => queueStatus === "completed")
      .map((item) => [item.confirmationId, applicationResult(item)]),
  );
  const setup = fixture({ source: snapshot(12, items), results });

  const cycle = await setup.reconciler.runCycle();

  assert.deepEqual(setup.calls.snapshots, [{ afterRevision: 0 }]);
  assert.deepEqual(
    setup.calls.results,
    items
      .filter(({ queueStatus }) => queueStatus === "completed")
      .map(({ confirmationId: id }) => id),
  );
  assert.equal(setup.calls.applies.length, 1);
  assert.deepEqual(
    setup.calls.applies[0].entries.map(({ status }) => status),
    ["pending", "applying", "rejected", "stale", "failed", "applied", "already"],
  );
  assert.equal(setup.calls.applies[0].sourceRevision, 12);
  assert.equal(
    setup.calls.applies[0].sourceSnapshotDigest,
    snapshot(12, items).snapshotDigest,
  );
  assert.deepEqual(cycle, {
    status: "applied",
    sourceRevision: 12,
    sourceSnapshotDigest: snapshot(12, items).snapshotDigest,
    entryCount: 7,
  });
});

test("real confirmation snapshots reconcile from pending to verified applied", async () => {
  const store = new NamedMemoryStore();
  const operationQueue = new OperationQueue();
  const exclusiveLease = { async run(operation) { return operation(); } };
  const applicationResults = new Map();
  const queue = new ConfirmationQueue({
    store,
    operationQueue,
    exclusiveLease,
    clock: sequenceClock(
      "2026-08-03T01:00:00.000Z",
      "2026-08-03T01:01:00.000Z",
      "2026-08-03T01:02:00.000Z",
    ),
    executor: {
      async execute(envelope) {
        const receipt = {
          id: `change-package-application-${digestValue({
            confirmationId: envelope.id,
            approvalBindingDigest: envelope.approvalBindingDigest,
          })}`,
          createdAt: envelope.execution.startedAt,
        };
        applicationResults.set(envelope.id, {
          confirmationId: envelope.id,
          status: "applied",
          packageId: envelope.action.packageId,
          workspaceId: envelope.action.workspace.id,
          receipt,
        });
        return { status: "applied", receipt };
      },
      async reconcile() {
        return { status: "absent" };
      },
    },
  });
  const projections = new ChangePackageApplicationProjectionStore({
    store,
    operationQueue,
    exclusiveLease,
  });
  await queue.recover();
  await projections.recover();
  const reconciler = new ChangePackageApplicationResultReconciler({
    applicationResultSource: queue,
    applicationReader: {
      async getResult(confirmationIdValue) {
        const result = applicationResults.get(confirmationIdValue);
        if (!result) throw new Error("application result unavailable");
        return structuredClone(result);
      },
    },
    projectionStore: projections,
  });

  const queued = await queue.enqueue(applicationPlan());
  const pendingSource = await queue.readSnapshot({ afterRevision: 0 });
  const pendingCycle = await reconciler.runCycle();
  assert.equal(pendingCycle.sourceSnapshotDigest, pendingSource.snapshotDigest);
  assert.equal((await projections.getForJob(JOB_ID)).status, "pending");

  await queue.approve(queued.id, {
    requestId: "application-request-0001",
    expectedQueueRevision: queued.queueRevision,
    expectedItemRevision: queued.itemRevision,
    displayedPayloadDigest: queued.displayedPayloadDigest,
    approvalBindingDigest: queued.approvalBindingDigest,
  });
  const completedSource = await queue.readSnapshot({
    afterRevision: pendingSource.sourceRevision,
  });
  const completedCycle = await reconciler.runCycle();
  const projected = await projections.getForJob(JOB_ID);

  assert.equal(completedCycle.sourceSnapshotDigest, completedSource.snapshotDigest);
  assert.equal(projected.status, "applied");
  assert.deepEqual(projected.receipt, completedSource.items[0].receipt);
  assert.equal(projected.confirmationId, queued.id);
});

test("runThrough waits for a trailing cycle that includes its queue revision", async () => {
  const store = new NamedMemoryStore();
  const operationQueue = new OperationQueue();
  const exclusiveLease = { async run(operation) { return operation(); } };
  const queue = new ConfirmationQueue({
    store,
    operationQueue,
    exclusiveLease,
    clock: sequenceClock(
      "2026-08-03T01:00:00.000Z",
      "2026-08-03T01:01:00.000Z",
    ),
    executor: {
      async execute() { throw new Error("pending items must not execute"); },
      async reconcile() { throw new Error("pending items must not reconcile"); },
    },
  });
  const projections = new ChangePackageApplicationProjectionStore({
    store,
    operationQueue,
    exclusiveLease,
  });
  await queue.recover();
  await projections.recover();
  const firstApplyStarted = deferred();
  const releaseFirstApply = deferred();
  let applyCalls = 0;
  const reconciler = new ChangePackageApplicationResultReconciler({
    applicationResultSource: queue,
    applicationReader: {
      async getResult() {
        throw new Error("pending items must not read application results");
      },
    },
    projectionStore: {
      getCheckpoint: projections.getCheckpoint.bind(projections),
      async applySnapshot(value) {
        applyCalls += 1;
        if (applyCalls === 1) {
          firstApplyStarted.resolve();
          await releaseFirstApply.promise;
        }
        return projections.applySnapshot(value);
      },
    },
  });

  await queue.enqueue(applicationPlan("work-first"));
  const oldCycle = reconciler.runCycle();
  await firstApplyStarted.promise;
  const queued = await queue.enqueue(applicationPlan("work-second"));
  let barrierSettled = false;
  const barrier = reconciler.runThrough(queued.queueRevision).then((result) => {
    barrierSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(barrierSettled, false);

  releaseFirstApply.resolve();
  await oldCycle;
  const result = await barrier;

  assert.equal(result.sourceRevision, queued.queueRevision);
  assert.equal(applyCalls, 2);
  assert.equal((await projections.getForJob(JOB_ID)).confirmationId, queued.id);
});

for (const [name, character] of [
  ["TAB", "\t"],
  ["LF", "\n"],
  ["CR", "\r"],
]) {
  test(`real confirmation snapshots preserve allowed ${name} characters`, async () => {
    const store = new NamedMemoryStore();
    const operationQueue = new OperationQueue();
    const exclusiveLease = { async run(operation) { return operation(); } };
    const queue = new ConfirmationQueue({
      store,
      operationQueue,
      exclusiveLease,
      executor: {
        async execute() {
          throw new Error("pending projection must not execute");
        },
        async reconcile() {
          throw new Error("pending projection must not reconcile execution");
        },
      },
    });
    const projections = new ChangePackageApplicationProjectionStore({
      store,
      operationQueue,
      exclusiveLease,
    });
    await queue.recover();
    await projections.recover();
    const reconciler = new ChangePackageApplicationResultReconciler({
      applicationResultSource: queue,
      applicationReader: {
        async getResult() {
          throw new Error("pending projection must not read application result");
        },
      },
      projectionStore: projections,
    });
    const workItemId = `work${character}item`;

    await queue.enqueue(applicationPlan(workItemId));
    await reconciler.runCycle();

    assert.equal((await projections.getForJob(JOB_ID)).requestedBy.workItemId, workItemId);
  });
}

test("stale projections accept pending and proven-absent invalidation paths", async () => {
  const items = [
    sourceItem(8, {
      queueStatus: "stale",
      executionOutcome: null,
    }),
    sourceItem(9, {
      queueStatus: "stale",
      executionOutcome: "absent",
    }),
  ];
  const setup = fixture({ source: snapshot(12, items) });

  await setup.reconciler.runCycle();

  assert.deepEqual(
    setup.calls.applies[0].entries.map(({ status }) => status),
    ["stale", "stale"],
  );
  assert.deepEqual(setup.calls.results, []);
});

test("unchanged snapshots reuse the exact durable checkpoint without writes", async () => {
  const checkpoint = {
    sourceRevision: 4,
    sourceSnapshotDigest: "4".repeat(64),
  };
  const setup = fixture({
    checkpoint,
    source: {
      sourceRevision: 4,
      unchanged: true,
      snapshotDigest: checkpoint.sourceSnapshotDigest,
      items: [],
    },
  });

  assert.deepEqual(await setup.reconciler.runCycle(), {
    status: "unchanged",
    sourceRevision: 4,
    sourceSnapshotDigest: checkpoint.sourceSnapshotDigest,
    entryCount: 0,
  });
  assert.deepEqual(setup.calls.snapshots, [{ afterRevision: 4 }]);
  assert.deepEqual(setup.calls.results, []);
  assert.deepEqual(setup.calls.applies, []);
});

test("reconciler rejects source digest, ordering, and unchanged contract violations", async () => {
  const first = sourceItem(1);
  const second = sourceItem(2);
  const invalidSources = [
    { ...snapshot(2, [first]), snapshotDigest: "0".repeat(64) },
    snapshot(2, [second, first]),
    {
      sourceRevision: 0,
      unchanged: false,
      snapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
      items: [],
    },
    {
      sourceRevision: 1,
      unchanged: true,
      snapshotDigest: "1".repeat(64),
      items: [],
    },
  ];

  for (const source of invalidSources) {
    const setup = fixture({ source });
    await assert.rejects(
      setup.reconciler.runCycle(),
      hasCode("CHANGE_PACKAGE_APPLICATION_RESULT_SOURCE_INVALID"),
    );
    assert.deepEqual(setup.calls.applies, []);
  }
});

test("completed projections fail closed on mismatched application results", async () => {
  const completed = sourceItem(1, { queueStatus: "completed" });
  const valid = applicationResult(completed);
  const invalidResults = [
    { ...valid, status: "intent", receipt: undefined },
    { ...valid, confirmationId: confirmationId(2) },
    { ...valid, packageId: `change-package-${"0".repeat(64)}` },
    { ...valid, workspaceId: "other-workspace" },
    { ...valid, receipt: { ...valid.receipt, id: `change-package-application-${"0".repeat(64)}` } },
    { ...valid, extra: true },
  ];

  for (const result of invalidResults) {
    const setup = fixture({
      source: snapshot(3, [completed]),
      results: new Map([[completed.confirmationId, result]]),
    });
    await assert.rejects(
      setup.reconciler.runCycle(),
      hasCode("CHANGE_PACKAGE_APPLICATION_RESULT_INVALID"),
    );
    assert.deepEqual(setup.calls.applies, []);
  }
});

test("application reader failures are bounded and never advance the projection", async () => {
  const completed = sourceItem(1, { queueStatus: "completed" });
  const privateFailure = Object.assign(
    new Error("failed at D:\\private\\application-state.json"),
    { code: "CHANGE_PACKAGE_APPLICATION_NOT_FOUND" },
  );
  const setup = fixture({
    source: snapshot(3, [completed]),
    results: new Map([[completed.confirmationId, privateFailure]]),
  });

  await assert.rejects(
    setup.reconciler.runCycle(),
    (error) =>
      hasCode("CHANGE_PACKAGE_APPLICATION_RESULT_UNAVAILABLE")(error) &&
      !error.message.includes("D:\\private"),
  );
  assert.deepEqual(setup.calls.applies, []);
});

test("concurrent cycles share one read and one atomic projection write", async () => {
  const release = deferred();
  const item = sourceItem(1);
  let reads = 0;
  const setup = fixture({
    source: async () => {
      reads += 1;
      await release.promise;
      return snapshot(2, [item]);
    },
  });

  const first = setup.reconciler.runCycle();
  const second = setup.reconciler.runCycle();
  assert.equal(first, second);
  await Promise.resolve();
  release.resolve();
  await first;

  assert.equal(reads, 1);
  assert.equal(setup.calls.applies.length, 1);
});

test("constructor binds only readSnapshot, getResult, and projection writer methods", () => {
  let forbiddenGetterCalls = 0;
  const source = { async readSnapshot() {} };
  const reader = { async getResult() {} };
  for (const [target, name] of [
    [source, "approve"],
    [source, "retry"],
    [reader, "execute"],
  ]) {
    Object.defineProperty(target, name, {
      get() {
        forbiddenGetterCalls += 1;
        return async () => {};
      },
    });
  }

  assert.doesNotThrow(
    () => new ChangePackageApplicationResultReconciler({
      applicationResultSource: source,
      applicationReader: reader,
      projectionStore: {
        async getCheckpoint() {},
        async applySnapshot() {},
      },
    }),
  );
  assert.equal(forbiddenGetterCalls, 0);
});
