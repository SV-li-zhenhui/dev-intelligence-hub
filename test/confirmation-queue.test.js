import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  ConfirmationExecutionError,
  ConfirmationQueue,
} from "../src/services/confirmation-queue.js";

class MemoryStore {
  constructor(initial = null) {
    this.value = structuredClone(initial);
    this.readCount = 0;
    this.writeCount = 0;
    this.failReadAt = null;
    this.failWriteAt = null;
  }

  async read(name, fallback = null) {
    assert.equal(name, "confirmation-queue");
    this.readCount += 1;
    if (this.readCount === this.failReadAt) throw new Error("disk read unavailable");
    return this.value === null ? structuredClone(fallback) : structuredClone(this.value);
  }

  async write(name, value) {
    assert.equal(name, "confirmation-queue");
    this.writeCount += 1;
    if (this.writeCount === this.failWriteAt) throw new Error("disk unavailable");
    this.value = structuredClone(value);
  }
}

class ExclusiveLease {
  constructor() {
    this.queue = new OperationQueue();
  }

  run(operation) {
    return this.queue.enqueue(operation);
  }
}

function createClock(...timestamps) {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]);
}

function actionPlan(overrides = {}) {
  const actor = overrides.actor || {
    provider: "github",
    accountId: "SV-li-zhenhui",
  };
  const target = overrides.target || {
    provider: "github",
    resourceId: "SVisions/OCT-Software#42",
    version: "0123456789abcdef0123456789abcdef01234567",
  };
  const action = overrides.action || {
    type: "pull_request_review",
    reviewEvent: "APPROVE",
    body: "The reviewed paths are covered.",
  };
  const display = overrides.display || {
    title: "发布 PR Review",
    summary: "以当前 GitHub 身份批准这条 PR",
    actionLabel: "确认并发布到 GitHub",
    evidence: ["CI 已通过", "当前 Head 已复核"],
    payload: {
      actor,
      target,
      action,
      subject: {
        repository: "SVisions/OCT-Software",
        number: 42,
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  };
  return {
    id: "confirmation-review-42",
    kind: "github.pull-request-review",
    requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-42" },
    ...overrides,
    actor,
    target,
    action,
    display,
  };
}

function executor(overrides = {}) {
  return {
    executeCalls: [],
    reconcileCalls: [],
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return { status: "applied", receipt: { id: "review-42" } };
    },
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "absent" };
    },
    ...overrides,
  };
}

async function readyQueue({
  store = new MemoryStore(),
  actionExecutor = executor(),
  exclusiveLease = new ExclusiveLease(),
} = {}) {
  const queue = new ConfirmationQueue({
    store,
    executor: actionExecutor,
    operationQueue: new OperationQueue(),
    exclusiveLease,
    clock: createClock(
      "2026-08-02T01:00:00.000Z",
      "2026-08-02T01:00:01.000Z",
      "2026-08-02T01:00:02.000Z",
      "2026-08-02T01:00:03.000Z",
      "2026-08-02T01:00:04.000Z",
    ),
  });
  await queue.recover();
  return queue;
}

function approvalRequest(next, requestId = "request-approve-0001") {
  return {
    requestId,
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
}

function producerInvalidation(item, overrides = {}) {
  return {
    requestedBy: structuredClone(item.requestedBy),
    approvalBindingDigest: item.approvalBindingDigest,
    reason: "work_item_superseded",
    ...overrides,
  };
}

test("the queue stays closed until durable recovery succeeds", async () => {
  const queue = new ConfirmationQueue({
    store: new MemoryStore(),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });

  await assert.rejects(
    queue.enqueue(actionPlan()),
    (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY" && error.statusCode === 503,
  );
});

test("enqueue freezes an exact plan and is idempotent only for the same binding", async () => {
  const queue = await readyQueue();
  const first = await queue.enqueue(actionPlan());
  const duplicate = await queue.enqueue(actionPlan());

  assert.equal(first.status, "pending");
  assert.deepEqual(duplicate, first);
  assert.match(first.displayedPayloadDigest, /^[a-f0-9]{64}$/);
  assert.match(first.approvalBindingDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(
    queue.enqueue(actionPlan({ action: { type: "pull_request_review", reviewEvent: "COMMENT", body: "changed" } })),
    (error) => error.code === "CONFIRMATION_ID_CONFLICT" && error.statusCode === 409,
  );
});

test("next returns exactly the oldest actionable item without its private action", async () => {
  const queue = await readyQueue();
  await queue.enqueue(actionPlan());
  await queue.enqueue(actionPlan({ id: "confirmation-review-43" }));

  const next = await queue.next();

  assert.equal(next.pendingCount, 2);
  assert.equal(next.item.id, "confirmation-review-42");
  assert.equal("action" in next.item, false);
  assert.equal(
    next.item.display.payload.action.body,
    "The reviewed paths are covered.",
  );
});

test("approval persists executing before the external executor is called", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(queue.approve(next.item.id, approvalRequest(next)), /disk unavailable/);

  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("concurrent and repeated approvals perform one external write", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      await gate;
      return { status: "applied", receipt: { id: "review-42" } };
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const request = approvalRequest(next);

  const first = queue.approve(next.item.id, request);
  const duplicate = queue.approve(next.item.id, request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actionExecutor.executeCalls.length, 1);
  release();

  assert.deepEqual(await duplicate, await first);
  const repeated = await queue.approve(next.item.id, request);
  assert.equal(repeated.status, "completed");
  assert.equal(actionExecutor.executeCalls.length, 1);
  assert.equal(
    actionExecutor.executeCalls[0].idempotencyKey,
    `confirmation-${next.item.approvalBindingDigest}`,
  );
  assert.deepEqual(actionExecutor.executeCalls[0].execution, {
    requestId: request.requestId,
    attempt: 1,
    startedAt: "2026-08-02T01:00:01.000Z",
  });
});

test("a shared exclusive lease prevents two queue instances from writing twice", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = new MemoryStore();
  const exclusiveLease = new ExclusiveLease();
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      await gate;
      return { status: "applied", receipt: { id: "review-42" } };
    },
  });
  const first = await readyQueue({ store, actionExecutor, exclusiveLease });
  await first.enqueue(actionPlan());
  const second = await readyQueue({ store, actionExecutor, exclusiveLease });
  const next = await first.next();
  const request = approvalRequest(next);

  const firstApproval = first.approve(next.item.id, request);
  const secondApproval = second.approve(next.item.id, request);
  await new Promise((resolve) => setImmediate(resolve));
  const writesBeforeRelease = actionExecutor.executeCalls.length;
  release();

  assert.equal((await firstApproval).status, "completed");
  assert.equal((await secondApproval).status, "completed");
  assert.equal(writesBeforeRelease, 1);
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("stale bindings and stale targets never invoke a second external action", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return { status: "stale", actualVersion: "fedcba" };
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const tampered = { ...approvalRequest(next), displayedPayloadDigest: "0".repeat(64) };

  await assert.rejects(
    queue.approve(next.item.id, tampered),
    (error) => error.code === "CONFIRMATION_BINDING_MISMATCH" && error.statusCode === 409,
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
  const result = await queue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("a trusted producer durably invalidates a pending action before concurrent approval", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const invalidation = producerInvalidation(next.item);

  const stalePromise = queue.invalidate(next.item.id, invalidation);
  const approvalPromise = queue.approve(
    next.item.id,
    approvalRequest(next, "request-approve-after-invalidation"),
  );
  const [stale, approval] = await Promise.all([
    stalePromise,
    approvalPromise,
  ]);

  assert.equal(stale.status, "stale");
  assert.equal(approval.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(store.value.items[0].status, "stale");
  assert.equal(
    store.value.items[0].invalidation.reason,
    "work_item_superseded",
  );
  assert.deepEqual(
    store.value.items[0].invalidation.requestedBy,
    next.item.requestedBy,
  );

  const recovered = await readyQueue({ store, actionExecutor });
  const recoveredItem = await recovered.get(next.item.id);
  const repeated = await recovered.invalidate(
    next.item.id,
    producerInvalidation(recoveredItem),
  );
  const approvedAfterRecovery = await recovered.approve(
    next.item.id,
    approvalRequest(next, "request-approve-after-recovery"),
  );

  assert.equal(recoveredItem.status, "stale");
  assert.equal(repeated.status, "stale");
  assert.equal(approvedAfterRecovery.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("a failed stale write leaves an in-process veto over every user action", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(
    queue.invalidate(next.item.id, producerInvalidation(next.item)),
    /disk unavailable/,
  );

  assert.equal(store.value.items[0].status, "pending");
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-vetoed-item"),
    ),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  await assert.rejects(
    queue.retry(
      next.item.id,
      approvalRequest(next, "request-retry-vetoed-item"),
    ),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  await assert.rejects(
    queue.reject(next.item.id, {
      ...approvalRequest(next, "request-reject-vetoed-item"),
      reason: "旧作业已经失效",
    }),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);

  const stale = await queue.invalidate(
    next.item.id,
    producerInvalidation(next.item),
  );
  assert.equal(stale.status, "stale");
  assert.equal((await queue.next()).item, null);
});

test("a queued producer mismatch cannot erase an earlier in-process veto", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  const failedInvalidation = queue.invalidate(
    next.item.id,
    producerInvalidation(next.item),
  );
  const mismatchedInvalidation = queue.invalidate(
    next.item.id,
    producerInvalidation(next.item, {
      requestedBy: {
        ...next.item.requestedBy,
        workItemId: "pr-work-untrusted",
      },
    }),
  );

  await assert.rejects(failedInvalidation, /disk unavailable/);
  await assert.rejects(
    mismatchedInvalidation,
    (error) => error.code === "CONFIRMATION_PRODUCER_MISMATCH",
  );
  assert.deepEqual(
    queue.producerVetoes.get(next.item.id),
    producerInvalidation(next.item),
  );
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-after-mismatch"),
    ),
    (error) => error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("a later reload failure restores an earlier in-process veto", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(
    queue.invalidate(next.item.id, producerInvalidation(next.item)),
    /disk unavailable/,
  );
  store.failReadAt = store.readCount + 1;
  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        requestedBy: {
          ...next.item.requestedBy,
          workItemId: "pr-work-untrusted",
        },
      }),
    ),
    /disk read unavailable/,
  );

  assert.deepEqual(
    queue.producerVetoes.get(next.item.id),
    producerInvalidation(next.item),
  );
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-after-reload-failure"),
    ),
    (error) => error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("a veto created by invalidate-before-enqueue makes a late plan durably stale", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  const normalizedPlan = normalizeConfirmationPlan(actionPlan());
  const invalidation = producerInvalidation(normalizedPlan);

  await assert.rejects(
    queue.invalidate(normalizedPlan.id, invalidation),
    (error) => error.statusCode === 404,
  );
  const late = await queue.enqueue(actionPlan());

  assert.equal(late.status, "stale");
  assert.equal(late.invalidation.reason, "work_item_superseded");
  assert.equal((await queue.next()).item, null);
  const approved = await queue.approve(
    late.id,
    approvalRequest(
      { queueRevision: late.queueRevision, item: late },
      "request-approve-late-plan",
    ),
  );
  assert.equal(approved.status, "stale");

  const recovered = await readyQueue({ store, actionExecutor });
  assert.equal((await recovered.get(late.id)).status, "stale");
  assert.equal((await recovered.next()).item, null);
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("producer invalidation requires the exact original producer and binding", async () => {
  const actionExecutor = executor();
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        requestedBy: {
          ...next.item.requestedBy,
          workItemId: "pr-work-other",
        },
      }),
    ),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        approvalBindingDigest: "0".repeat(64),
      }),
    ),
    (error) => error.statusCode === 409,
  );

  assert.equal((await queue.get(next.item.id)).status, "pending");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("a proven-absent failed action can be invalidated without another Review", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError("GITHUB_REJECTED", "absent");
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const failed = await queue.approve(next.item.id, approvalRequest(next));

  const stale = await queue.invalidate(
    failed.id,
    producerInvalidation(failed),
  );
  const approvedAfterInvalidation = await queue.approve(
    failed.id,
    approvalRequest(next, "request-approve-after-absent"),
  );

  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(stale.status, "stale");
  assert.equal(approvedAfterInvalidation.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("executing, unknown, completed, and rejected actions cannot be invalidated", async (t) => {
  await t.test("approval wins the race exactly once", async () => {
    let releaseExecution;
    const executionGate = new Promise((resolve) => {
      releaseExecution = resolve;
    });
    const actionExecutor = executor({
      async execute(envelope) {
        this.executeCalls.push(structuredClone(envelope));
        await executionGate;
        return { status: "applied", receipt: { id: "review-42" } };
      },
    });
    const queue = await readyQueue({ actionExecutor });
    await queue.enqueue(actionPlan());
    const next = await queue.next();
    const approval = queue.approve(next.item.id, approvalRequest(next));
    const invalidation = assert.rejects(
      queue.invalidate(
        next.item.id,
        producerInvalidation(next.item),
      ),
      (error) => error.statusCode === 409,
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseExecution();

    assert.equal((await approval).status, "completed");
    await invalidation;
    assert.equal(actionExecutor.executeCalls.length, 1);
  });

  const terminalCases = [
    {
      name: "unknown",
      actionExecutor: executor({
        async execute(envelope) {
          this.executeCalls.push(structuredClone(envelope));
          throw new ConfirmationExecutionError("GITHUB_TIMEOUT", "unknown");
        },
      }),
      finish: async (queue, next) =>
        queue.approve(next.item.id, approvalRequest(next)),
    },
    {
      name: "completed",
      actionExecutor: executor(),
      finish: async (queue, next) =>
        queue.approve(next.item.id, approvalRequest(next)),
    },
    {
      name: "rejected",
      actionExecutor: executor(),
      finish: async (queue, next) =>
        queue.reject(next.item.id, {
          ...approvalRequest(next, "request-reject-before-invalidation"),
          reason: "不再发布",
        }),
    },
  ];

  for (const scenario of terminalCases) {
    await t.test(scenario.name, async () => {
      const queue = await readyQueue({
        actionExecutor: scenario.actionExecutor,
      });
      await queue.enqueue(actionPlan());
      const next = await queue.next();
      const terminal = await scenario.finish(queue, next);
      const callsBeforeInvalidation =
        scenario.actionExecutor.executeCalls.length;

      await assert.rejects(
        queue.invalidate(
          next.item.id,
          producerInvalidation(next.item),
        ),
        (error) => error.statusCode === 409,
      );

      assert.equal((await queue.get(next.item.id)).status, terminal.status);
      assert.equal(
        scenario.actionExecutor.executeCalls.length,
        callsBeforeInvalidation,
      );
    });
  }
});

test("rejection is durable and cannot execute", async () => {
  const actionExecutor = executor();
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  const result = await queue.reject(next.item.id, {
    ...approvalRequest(next, "request-reject-0001"),
    reason: "正文需要重新整理",
  });

  assert.equal(result.status, "rejected");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal((await queue.next()).item, null);
});

test("a proven absent failure is retryable but an unknown outcome is not", async () => {
  const absentExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (this.executeCalls.length === 1) {
        throw new ConfirmationExecutionError("GITHUB_REJECTED", "absent");
      }
      return { status: "applied", receipt: { id: "review-retried" } };
    },
  });
  const queue = await readyQueue({ actionExecutor: absentExecutor });
  await queue.enqueue(actionPlan());
  let next = await queue.next();
  let result = await queue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.status, "failed");
  assert.equal(result.failure.retryable, true);

  next = await queue.next();
  result = await queue.retry(next.item.id, approvalRequest(next, "request-retry-0001"));
  assert.equal(result.status, "completed");
  assert.equal(absentExecutor.reconcileCalls.length, 1);
  assert.equal(absentExecutor.executeCalls.length, 2);
  assert.equal(
    absentExecutor.executeCalls[0].idempotencyKey,
    absentExecutor.executeCalls[1].idempotencyKey,
  );
  assert.equal(absentExecutor.executeCalls[1].execution.attempt, 2);
  assert.equal(
    absentExecutor.executeCalls[1].execution.requestId,
    "request-retry-0001",
  );

  const unknownExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError("GITHUB_TIMEOUT", "unknown");
    },
  });
  const unknownQueue = await readyQueue({ actionExecutor: unknownExecutor });
  await unknownQueue.enqueue(actionPlan());
  next = await unknownQueue.next();
  result = await unknownQueue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.failure.retryable, false);
  assert.equal((await unknownQueue.next()).item, null);
  await assert.rejects(
    unknownQueue.retry(result.id, approvalRequest({ queueRevision: result.queueRevision, item: result }, "request-retry-0002")),
    (error) => error.code === "CONFIRMATION_NOT_RETRYABLE",
  );
});

test("startup recovery reconciles an applied action after the final local write failed", async () => {
  const store = new MemoryStore();
  const firstExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor: firstExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 2;

  await assert.rejects(queue.approve(next.item.id, approvalRequest(next)), /disk unavailable/);
  assert.equal(store.value.items[0].status, "executing");
  store.failWriteAt = null;

  const recoveryExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "already", receipt: { id: "review-42" } };
    },
  });
  const recovered = await readyQueue({ store, actionExecutor: recoveryExecutor });

  assert.equal((await recovered.get(next.item.id)).status, "completed");
  assert.equal(recoveryExecutor.reconcileCalls.length, 1);
  assert.equal(recoveryExecutor.executeCalls.length, 0);
});

test("corrupted durable state fails closed without making the queue ready", async () => {
  const store = new MemoryStore({ schemaVersion: 1, revision: 1, items: [{ id: "bad" }] });
  const queue = new ConfirmationQueue({
    store,
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });

  await assert.rejects(queue.recover(), (error) => error.code === "CONFIRMATION_STATE_CORRUPTED");
  await assert.rejects(queue.next(), (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY");
});

test("plan validation bounds aggregate JSON entries and rejects accessor arrays", async () => {
  const queue = await readyQueue();
  const oversizedPayload = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => [`field-${index}`, index]),
  );

  await assert.rejects(
    queue.enqueue(
      actionPlan({
        display: {
          ...actionPlan().display,
          payload: {
            ...actionPlan().display.payload,
            oversizedPayload,
          },
        },
      }),
    ),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );

  const evidence = [];
  Object.defineProperty(evidence, "0", {
    enumerable: true,
    get() {
      throw new Error("accessor must not run");
    },
  });
  evidence.length = 1;
  await assert.rejects(
    queue.enqueue(
      actionPlan({ display: { ...actionPlan().display, evidence } }),
    ),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );
});

test("the displayed payload must contain the exact actor, target, and action", async () => {
  const queue = await readyQueue();
  const plan = actionPlan();

  await assert.rejects(
    queue.enqueue({
      ...plan,
      display: {
        ...plan.display,
        payload: {
          ...plan.display.payload,
          action: { ...plan.action, body: "A safer-looking body" },
        },
      },
    }),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );
});

test("persisted terminal outcomes and revisions must be internally coherent", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next));

  const wrongOutcome = structuredClone(store.value);
  wrongOutcome.items[0].execution.outcome = "unknown";
  const wrongOutcomeQueue = new ConfirmationQueue({
    store: new MemoryStore(wrongOutcome),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    wrongOutcomeQueue.recover(),
    (error) => error.code === "CONFIRMATION_STATE_CORRUPTED",
  );

  const impossibleRevision = structuredClone(store.value);
  impossibleRevision.items[0].itemRevision = impossibleRevision.revision + 1;
  const impossibleRevisionQueue = new ConfirmationQueue({
    store: new MemoryStore(impossibleRevision),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    impossibleRevisionQueue.recover(),
    (error) => error.code === "CONFIRMATION_STATE_CORRUPTED",
  );
});

test("executor receipts are whitelisted before they reach durable or public state", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return {
        status: "applied",
        receipt: { id: "review-42", stdout: "token=must-not-persist" },
      };
    },
  });
  const store = new MemoryStore();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  const result = await queue.approve(next.item.id, approvalRequest(next));

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "EXTERNAL_PROTOCOL_ERROR");
  assert.equal(JSON.stringify(store.value).includes("must-not-persist"), false);

  const urlExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return {
        status: "applied",
        receipt: {
          id: "review-43",
          url: "https://github.com/SVisions/OCT-Software/pull/42?token=must-not-persist",
        },
      };
    },
  });
  const urlStore = new MemoryStore();
  const urlQueue = await readyQueue({ store: urlStore, actionExecutor: urlExecutor });
  await urlQueue.enqueue(actionPlan());
  const urlNext = await urlQueue.next();
  const urlResult = await urlQueue.approve(
    urlNext.item.id,
    approvalRequest(urlNext, "request-approve-0002"),
  );
  assert.equal(urlResult.status, "failed");
  assert.equal(JSON.stringify(urlStore.value).includes("must-not-persist"), false);
});
