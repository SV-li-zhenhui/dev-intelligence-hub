import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { ProactivePrEmployeeService } from "../src/services/proactive-pr-employee.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const BINDING_DIGEST = "b".repeat(64);

function readyGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([name, value]) => [
        name,
        structuredClone(value),
      ]),
    );
  }

  async read(name, fallback = null) {
    return structuredClone(
      this.values.has(name) ? this.values.get(name) : fallback,
    );
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

class RecordingConfirmationQueue {
  constructor({ store = null, loseFirstAcknowledgement = false } = {}) {
    this.store = store;
    this.loseFirstAcknowledgement = loseFirstAcknowledgement;
    this.enqueueCalls = [];
    this.getCalls = [];
    this.invalidateCalls = [];
    this.enqueueError = null;
    this.invalidateError = null;
    this.persistedStatesAtEnqueue = [];
    this.persistedStatesAtInvalidate = [];
    this.items = new Map();
  }

  async enqueue(plan) {
    const recordedPlan = structuredClone(plan);
    this.enqueueCalls.push(recordedPlan);
    if (this.store) {
      this.persistedStatesAtEnqueue.push(
        await this.store.read("pr-employee-state"),
      );
    }

    const normalized = normalizeConfirmationPlan(recordedPlan);
    if (this.enqueueError) throw this.enqueueError;
    const existing = this.items.get(normalized.id);
    if (
      existing &&
      existing.approvalBindingDigest !== normalized.approvalBindingDigest
    ) {
      throw new Error("confirmation id was rebound to different content");
    }
    const item =
      existing ||
      publicQueueItem(normalized, {
        approvalBindingDigest: normalized.approvalBindingDigest,
      });
    this.items.set(item.id, structuredClone(item));

    if (this.loseFirstAcknowledgement && this.enqueueCalls.length === 1) {
      throw new Error("confirmation queue acknowledgement was lost");
    }
    return structuredClone(item);
  }

  async get(id) {
    this.getCalls.push(id);
    const item = this.items.get(id);
    if (!item) throw new Error(`confirmation ${id} was not found`);
    return structuredClone(item);
  }

  async invalidate(id, input) {
    const request = structuredClone(input);
    this.invalidateCalls.push({ id, input: request });
    if (this.store) {
      this.persistedStatesAtInvalidate.push(
        await this.store.read("pr-employee-state"),
      );
    }
    if (this.invalidateError) throw this.invalidateError;
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error("confirmation not found"), { statusCode: 404 });
    if (
      JSON.stringify(item.requestedBy) !== JSON.stringify(request.requestedBy) ||
      item.approvalBindingDigest !== request.approvalBindingDigest
    ) {
      throw Object.assign(new Error("producer binding mismatch"), { statusCode: 409 });
    }
    if (item.status === "stale") return structuredClone(item);
    if (
      item.status !== "pending" &&
      !(item.status === "failed" && item.retryable)
    ) {
      throw Object.assign(new Error("confirmation cannot be invalidated"), {
        statusCode: 409,
      });
    }
    const stale = {
      ...item,
      status: "stale",
      retryable: false,
      invalidation: {
        requestedBy: structuredClone(request.requestedBy),
        reason: request.reason,
        at: "2026-08-02T01:01:00.000Z",
      },
    };
    this.items.set(id, structuredClone(stale));
    return structuredClone(stale);
  }
}

function publicQueueItem(plan, overrides = {}) {
  return {
    id: plan.id,
    kind: plan.kind,
    status: "pending",
    requestedBy: structuredClone(plan.requestedBy),
    actor: structuredClone(plan.actor),
    target: structuredClone(plan.target),
    display: structuredClone(plan.display),
    displayedPayloadDigest: plan.displayedPayloadDigest || "a".repeat(64),
    approvalBindingDigest:
      plan.approvalBindingDigest || overrides.approvalBindingDigest || BINDING_DIGEST,
    retryable: false,
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  const headRefOid = overrides.headRefOid || HEAD;
  return {
    id: "github:pr:acme/repo#42",
    kind: "pull_request",
    relation: "review_requested",
    repo: "acme/repo",
    number: 42,
    title: "Protect the checkout flow",
    url: "https://github.com/acme/repo/pull/42",
    author: "someone-else",
    state: "open",
    updatedAt: "2026-08-02T01:00:00.000Z",
    reviewFactsAvailable: true,
    headRefOid,
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "local-owner",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/review",
      headRefOid,
    },
    actionState: "action_now",
    nextAction: "review",
    actionReasons: ["等待你首次审核"],
    ...overrides,
  };
}

function snapshot(items) {
  return {
    refreshedAt: "2026-08-02T01:00:00.000Z",
    sourceStatus: { githubPullRequests: { ok: true } },
    items,
  };
}

function reviewResult(overrides = {}) {
  return {
    summary: "支付失败路径缺少回归覆盖，建议先补测试。",
    confidence: 0.86,
    evidence: ["checkout.js 修改了错误分支"],
    steps: ["补充失败路径测试", "核对错误码映射"],
    questions: [],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    ...overrides,
  };
}

function createService({
  store,
  confirmationQueue = null,
  producerQueue = confirmationQueue,
  githubActions = {
    enabled: true,
    actorAccountId: "local-owner",
  },
  analyze = async () => reviewResult(),
  loadReviewContext = async (item) => ({
    ...item,
    patch: "diff --git a/checkout.js b/checkout.js",
    patchTruncated: false,
    files: [{ path: "checkout.js", additions: 8, deletions: 2 }],
  }),
  config = {},
  actionAdmissionGate,
} = {}) {
  return new ProactivePrEmployeeService({
    store,
    github: { loadReviewContext },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      analyze,
    },
    confirmationQueue,
    producerQueue,
    githubActions,
    clock: () => new Date("2026-08-02T01:01:00.000Z"),
    config: {
      enabled: true,
      policyVersion: 1,
      maxJobsPerTick: 2,
      maxAttempts: 3,
      retryMinutes: [1, 5, 30],
      memoryLimit: 100,
      ...config,
    },
    actionAdmissionGate,
  });
}

async function createLinkedJob({
  reviewVerdict = "request_changes",
  actionAdmissionGate,
} = {}) {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  const service = createService({
    store,
    confirmationQueue,
    analyze: async () => reviewResult({ reviewVerdict }),
    actionAdmissionGate,
  });
  const work = await service.tick({ trigger: "refresh_completed" });
  return {
    store,
    confirmationQueue,
    service,
    work,
    job: work.jobs[0],
  };
}

test("confirmation recovery remains available after configuration cutover", async () => {
  const gate = readyGate();
  const { confirmationQueue, service, job } = await createLinkedJob({
    actionAdmissionGate: gate,
  });
  const pending = confirmationQueue.items.get(job.confirmationId);
  confirmationQueue.items.set(job.confirmationId, {
    ...pending,
    status: "completed",
    receipt: { id: "review-after-cutover" },
  });
  await gate.cutover(({ commit }) => {
    commit({ version: 2, configurationDigest: "2".repeat(64) });
  });

  const recovered = await service.recoverConfirmations();

  assert.equal(recovered.jobs[0].status, "published");
  assert.equal(recovered.jobs[0].confirmationStatus, "completed");
});

test("each review verdict enqueues one exact head-bound confirmation plan", async (t) => {
  const cases = [
    ["approve", "APPROVE"],
    ["request_changes", "REQUEST_CHANGES"],
    ["comment", "COMMENT"],
  ];

  for (const [reviewVerdict, reviewEvent] of cases) {
    await t.test(reviewVerdict, async () => {
      const { confirmationQueue, job } = await createLinkedJob({
        reviewVerdict,
      });

      assert.equal(confirmationQueue.enqueueCalls.length, 1);
      const plan = confirmationQueue.enqueueCalls[0];
      assert.equal(job.status, "waiting_confirmation");
      assert.equal(job.confirmationId, plan.id);
      assert.deepEqual(plan.requestedBy, {
        roleId: "pr-reviewer",
        workItemId: job.id,
      });
      assert.deepEqual(plan.actor, {
        provider: "github",
        accountId: "local-owner",
      });
      assert.deepEqual(plan.target, {
        provider: "github",
        resourceId: "acme/repo#42",
        version: HEAD,
      });
      assert.deepEqual(plan.action, {
        type: "pull_request_review",
        reviewEvent,
        body: reviewResult().reviewBody,
      });
      assert.deepEqual(plan.display.payload, {
        actor: plan.actor,
        target: plan.target,
        action: plan.action,
      });
    });
  }
});

test("a head change during analysis supersedes the job without enqueueing", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  const service = createService({
    store,
    confirmationQueue,
    analyze: async () => {
      await store.write(
        "snapshot",
        snapshot([pullRequest({ headRefOid: NEXT_HEAD })]),
      );
      return reviewResult({ reviewVerdict: "approve" });
    },
  });

  const work = await service.tick();

  assert.equal(work.jobs[0].status, "superseded");
  assert.equal(confirmationQueue.enqueueCalls.length, 0);
  assert.equal(confirmationQueue.items.size, 0);
});

test("the intent is durable before enqueue and a lost acknowledgement is idempotently backfilled next tick", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({
    store,
    loseFirstAcknowledgement: true,
  });
  const service = createService({ store, confirmationQueue });

  const first = await service.tick({ trigger: "refresh_completed" });
  const persistedBeforeFirstEnqueue =
    confirmationQueue.persistedStatesAtEnqueue[0].jobs[0];

  assert.equal(
    persistedBeforeFirstEnqueue.status,
    "confirmation_enqueue_pending",
  );
  assert.deepEqual(
    persistedBeforeFirstEnqueue.confirmationIntent,
    confirmationQueue.enqueueCalls[0],
  );
  assert.equal(first.jobs[0].status, "confirmation_enqueue_pending");
  assert.equal(first.jobs[0].confirmationId, confirmationQueue.enqueueCalls[0].id);
  assert.match(first.jobs[0].error, /下次巡查时重试/);
  assert.equal(confirmationQueue.items.size, 1);

  const second = await service.tick({ trigger: "scheduled" });

  assert.equal(confirmationQueue.enqueueCalls.length, 2);
  assert.deepEqual(
    confirmationQueue.enqueueCalls[1],
    confirmationQueue.enqueueCalls[0],
  );
  assert.equal(confirmationQueue.items.size, 1);
  assert.equal(second.jobs[0].status, "waiting_confirmation");
  assert.equal(second.jobs[0].confirmationIntent, null);
  assert.equal(second.jobs[0].error, "");
});

test("startup recovery invalidates a pending enqueue before exposing a changed Git target", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  confirmationQueue.enqueueError = statusError(503, "queue unavailable");
  const service = createService({ store, confirmationQueue });
  const first = await service.tick({ trigger: "refresh_completed" });
  const changed = pullRequest();
  changed.gitTarget.baseRefOid = "c".repeat(40);
  await store.write("snapshot", snapshot([changed]));
  confirmationQueue.enqueueError = null;

  const recovered = await service.recoverConfirmations();

  assert.equal(first.jobs[0].status, "confirmation_enqueue_pending");
  assert.equal(confirmationQueue.enqueueCalls.length, 1);
  assert.equal(confirmationQueue.invalidateCalls.length, 1);
  assert.equal(confirmationQueue.items.size, 0);
  assert.equal(recovered.jobs[0].status, "superseded");
});

test("startup recovery never exposes a pending enqueue from an unhealthy PR snapshot", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  confirmationQueue.enqueueError = statusError(503, "queue unavailable");
  const service = createService({ store, confirmationQueue });
  await service.tick({ trigger: "refresh_completed" });
  confirmationQueue.enqueueError = null;
  await store.write("snapshot", {
    ...snapshot([pullRequest()]),
    sourceStatus: { githubPullRequests: { ok: false } },
  });

  const fenced = await service.recoverConfirmations();

  assert.equal(confirmationQueue.enqueueCalls.length, 1);
  assert.equal(fenced.jobs[0].status, "confirmation_enqueue_pending");
  assert.match(fenced.jobs[0].error, /尚未健康刷新/);

  await store.write("snapshot", snapshot([pullRequest()]));
  const recovered = await service.recoverConfirmations();
  assert.equal(confirmationQueue.enqueueCalls.length, 2);
  assert.equal(recovered.jobs[0].status, "waiting_confirmation");
});

test("startup recovery links one confirmation to a legacy ready_for_human job", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const legacyService = createService({
    store,
    githubActions: { enabled: false },
  });
  const legacy = await legacyService.tick();
  assert.equal(legacy.jobs[0].status, "ready_for_human");

  const confirmationQueue = new RecordingConfirmationQueue({ store });
  const recoveredService = createService({ store, confirmationQueue });
  const firstRecovery = await recoveredService.recoverConfirmations();
  const secondRecovery = await recoveredService.recoverConfirmations();

  assert.equal(confirmationQueue.enqueueCalls.length, 1);
  assert.equal(confirmationQueue.getCalls.length, 1);
  assert.equal(firstRecovery.jobs[0].status, "waiting_confirmation");
  assert.equal(secondRecovery.jobs[0].status, "waiting_confirmation");
  assert.equal(
    secondRecovery.jobs[0].confirmationId,
    confirmationQueue.enqueueCalls[0].id,
  );
});

test("confirmation outcomes project onto linked jobs and terminal outcomes enter memory", async (t) => {
  const cases = [
    {
      name: "completed",
      queueOutcome: {
        status: "completed",
        receipt: { id: "review-42" },
      },
      jobStatus: "published",
      memoryEvent: "review_published",
    },
    {
      name: "rejected",
      queueOutcome: {
        status: "rejected",
        rejection: { reason: "正文需要重新整理" },
      },
      jobStatus: "rejected",
      memoryEvent: "review_rejected",
    },
    {
      name: "stale",
      queueOutcome: { status: "stale" },
      jobStatus: "superseded",
      memoryEvent: "review_stale",
    },
    {
      name: "retryable failed",
      queueOutcome: {
        status: "failed",
        retryable: true,
        failure: {
          code: "GITHUB_REJECTED",
          outcome: "absent",
          retryable: true,
          at: "2026-08-02T01:02:00.000Z",
        },
      },
      jobStatus: "waiting_retry_confirmation",
      memoryEvent: null,
    },
    {
      name: "unknown failed",
      queueOutcome: {
        status: "failed",
        retryable: false,
        failure: {
          code: "GITHUB_TIMEOUT",
          outcome: "unknown",
          retryable: false,
          at: "2026-08-02T01:02:00.000Z",
        },
      },
      jobStatus: "blocked",
      memoryEvent: "review_outcome_unknown",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { store, confirmationQueue, service, job } =
        await createLinkedJob();
      const pending = confirmationQueue.items.get(job.confirmationId);
      const outcome = {
        ...pending,
        receipt: undefined,
        failure: undefined,
        rejection: undefined,
        ...scenario.queueOutcome,
      };

      const projected = await service.recordConfirmationOutcome(outcome);
      const memories = await store.read("pr-employee-memory", []);
      const outcomeMemories = memories.filter(
        (memory) => memory.id === `${job.id}:${scenario.memoryEvent}`,
      );

      assert.equal(projected.jobs[0].status, scenario.jobStatus);
      assert.equal(projected.jobs[0].confirmationStatus, outcome.status);
      assert.ok(
        memories.some(
          (memory) =>
            memory.id === `${job.id}:analysis_ready` &&
            memory.sourceId === job.subjectId,
        ),
      );
      if (scenario.memoryEvent) {
        assert.equal(outcomeMemories.length, 1);
      } else {
        assert.equal(
          memories.some((memory) =>
            [
              "review_published",
              "review_rejected",
              "review_stale",
              "review_outcome_unknown",
            ].includes(memory.event),
          ),
          false,
        );
      }
    });
  }
});

test("scheduled ticks repair a missed employee projection without rewriting unchanged pending state", async () => {
  const { store, confirmationQueue, service, work, job } =
    await createLinkedJob();

  const unchanged = await service.tick({ trigger: "scheduled" });
  assert.equal(unchanged.jobs[0].status, "waiting_confirmation");
  assert.equal(unchanged.role.revision, work.role.revision);

  confirmationQueue.items.set(job.confirmationId, {
    ...confirmationQueue.items.get(job.confirmationId),
    status: "completed",
    receipt: { id: "review-42" },
  });
  const repaired = await service.tick({ trigger: "scheduled" });
  const memories = await store.read("pr-employee-memory", []);

  assert.equal(repaired.jobs[0].status, "published");
  assert.ok(
    memories.some(
      (memory) =>
        memory.id === `${job.id}:review_published` &&
        memory.sourceId === job.subjectId,
    ),
  );
  assert.equal(confirmationQueue.enqueueCalls.length, 1);
});

test("startup recovery can upgrade an unknown blocked outcome after queue reconciliation", async () => {
  const { confirmationQueue, service, job } = await createLinkedJob();
  const pending = confirmationQueue.items.get(job.confirmationId);
  await service.recordConfirmationOutcome({
    ...pending,
    status: "failed",
    retryable: false,
    failure: {
      code: "GITHUB_TIMEOUT",
      outcome: "unknown",
      retryable: false,
      at: "2026-08-02T01:02:00.000Z",
    },
  });
  confirmationQueue.items.set(job.confirmationId, {
    ...pending,
    status: "completed",
    receipt: { id: "review-42" },
  });

  const recovered = await service.recoverConfirmations();

  assert.equal(recovered.jobs[0].status, "published");
  assert.equal(recovered.jobs[0].confirmationStatus, "completed");
});

test("startup recovery invalidates a persisted superseded job and cannot revive it", async () => {
  const { store, confirmationQueue, job } = await createLinkedJob();
  const persisted = await store.read("pr-employee-state");
  persisted.jobs[0] = {
    ...persisted.jobs[0],
    status: "superseded",
    updatedAt: "2026-08-02T01:02:00.000Z",
    completedAt: "2026-08-02T01:02:00.000Z",
  };
  await store.write("pr-employee-state", persisted);
  assert.equal(
    confirmationQueue.items.get(job.confirmationId).status,
    "pending",
  );

  const recoveredService = createService({ store, confirmationQueue });
  const recovered = await recoveredService.recoverConfirmations();
  const staleItem = confirmationQueue.items.get(job.confirmationId);

  assert.equal(recovered.jobs[0].status, "superseded");
  assert.equal(recovered.jobs[0].confirmationStatus, "stale");
  assert.equal(staleItem.status, "stale");
  assert.equal(staleItem.invalidation.reason, "work_item_superseded");
  await assert.rejects(
    recoveredService.recordConfirmationOutcome({
      ...staleItem,
      status: "completed",
      receipt: { id: "review-must-not-revive" },
      invalidation: undefined,
    }),
    (error) => error.statusCode === 409,
  );
  assert.equal((await recoveredService.view()).jobs[0].status, "superseded");
});

test("startup recovery stays closed until a persisted invalidation intent succeeds", async () => {
  const { store, confirmationQueue, job } = await createLinkedJob();
  const pendingItem = confirmationQueue.items.get(job.confirmationId);
  const invalidationIntent = {
    requestedBy: pendingItem.requestedBy,
    approvalBindingDigest: pendingItem.approvalBindingDigest,
    reason: "work_item_superseded",
  };
  const persisted = await store.read("pr-employee-state");
  persisted.jobs[0] = {
    ...persisted.jobs[0],
    status: "confirmation_invalidation_pending",
    confirmationInvalidationIntent: invalidationIntent,
  };
  await store.write("pr-employee-state", persisted);

  let releaseInvalidation;
  const invalidationGate = new Promise((resolve) => {
    releaseInvalidation = resolve;
  });
  let invalidationStarted = false;
  const invalidate = confirmationQueue.invalidate.bind(confirmationQueue);
  confirmationQueue.invalidate = async (...args) => {
    invalidationStarted = true;
    await invalidationGate;
    return invalidate(...args);
  };
  const recoveredService = createService({ store, confirmationQueue });
  let recoveryCompleted = false;
  const recovery = recoveredService.recoverConfirmations().then((result) => {
    recoveryCompleted = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidationStarted, true);
  assert.equal(recoveryCompleted, false);
  releaseInvalidation();
  const recovered = await recovery;

  assert.equal(recovered.jobs[0].status, "superseded");
  assert.equal(recovered.jobs[0].confirmationStatus, "stale");
  assert.equal(
    confirmationQueue.items.get(job.confirmationId).status,
    "stale",
  );
});

test("a bound confirmation 404 stays fenced and preserves its invalidation error", async () => {
  const { store, confirmationQueue, service, job } =
    await createLinkedJob();
  confirmationQueue.invalidateError = statusError(
    404,
    "bound confirmation temporarily missing",
  );
  await store.write(
    "snapshot",
    snapshot([pullRequest({ nextAction: "rereview" })]),
  );

  const fenced = await service.tick({ trigger: "refresh_completed" });
  const oldJob = fenced.jobs.find((candidate) => candidate.id === job.id);

  assert.equal(oldJob.status, "confirmation_invalidation_pending");
  assert.match(fenced.role.lastError, /失效/);
  assert.equal(fenced.role.lastRun.newJobs, 0);
  assert.equal(fenced.jobs.length, 1);
  assert.equal(
    confirmationQueue.items.get(job.confirmationId).status,
    "pending",
  );
  assert.deepEqual(
    oldJob.confirmationInvalidationIntent,
    confirmationQueue.invalidateCalls[0].input,
  );
  await assert.rejects(
    service.recoverConfirmations(),
    (error) => error.statusCode === 503 && /拒绝启动服务/.test(error.message),
  );
  const persistedAfterRecovery = await store.read("pr-employee-state");
  assert.equal(
    persistedAfterRecovery.jobs[0].status,
    "confirmation_invalidation_pending",
  );
  assert.match(persistedAfterRecovery.jobs[0].error, /无法安全失效/);
});

test("only an unbound enqueue_pending confirmation treats invalidate 404 as safe", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  confirmationQueue.enqueueError = statusError(503, "queue unavailable");
  const service = createService({ store, confirmationQueue });
  const first = await service.tick({ trigger: "refresh_completed" });
  const oldJob = first.jobs[0];

  assert.equal(oldJob.status, "confirmation_enqueue_pending");
  assert.equal(oldJob.confirmationBindingDigest, undefined);
  assert.equal(confirmationQueue.items.size, 0);
  confirmationQueue.invalidateError = statusError(404, "never enqueued");
  await store.write(
    "snapshot",
    snapshot([pullRequest({ nextAction: "rereview" })]),
  );

  const updated = await service.tick({ trigger: "refresh_completed" });
  const superseded = updated.jobs.find(
    (candidate) => candidate.id === oldJob.id,
  );
  const persistedBeforeInvalidation =
    confirmationQueue.persistedStatesAtInvalidate[0].jobs.find(
      (candidate) => candidate.id === oldJob.id,
    );

  assert.equal(
    persistedBeforeInvalidation.status,
    "confirmation_invalidation_pending",
  );
  assert.deepEqual(
    persistedBeforeInvalidation.confirmationInvalidationIntent,
    confirmationQueue.invalidateCalls[0].input,
  );
  assert.equal(superseded.status, "superseded");
  assert.equal(confirmationQueue.items.size, 0);
  assert.ok(
    updated.jobs.some(
      (candidate) =>
        candidate.id !== oldJob.id &&
        candidate.nextAction === "rereview",
    ),
  );
});

test("an unknown external outcome blocks every new fingerprint for the same subject", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const confirmationQueue = new RecordingConfirmationQueue({ store });
  let analysisCalls = 0;
  const service = createService({
    store,
    confirmationQueue,
    analyze: async () => {
      analysisCalls += 1;
      return reviewResult();
    },
  });
  const first = await service.tick({ trigger: "refresh_completed" });
  const job = first.jobs[0];
  const pending = confirmationQueue.items.get(job.confirmationId);
  await service.recordConfirmationOutcome({
    ...pending,
    status: "failed",
    retryable: false,
    failure: {
      code: "GITHUB_TIMEOUT",
      outcome: "unknown",
      retryable: false,
      at: "2026-08-02T01:02:00.000Z",
    },
  });
  await store.write(
    "snapshot",
    snapshot([
      pullRequest({
        headRefOid: NEXT_HEAD,
        nextAction: "rereview",
      }),
    ]),
  );
  const upgradedService = createService({
    store,
    confirmationQueue,
    analyze: async () => {
      analysisCalls += 1;
      return reviewResult();
    },
    config: { policyVersion: 2 },
  });

  const blocked = await upgradedService.tick({ trigger: "policy_changed" });

  assert.equal(blocked.jobs.length, 1);
  assert.equal(blocked.jobs[0].id, job.id);
  assert.equal(blocked.jobs[0].status, "blocked");
  assert.equal(blocked.jobs[0].confirmationFailure.outcome, "unknown");
  assert.equal(blocked.role.lastRun.newJobs, 0);
  assert.equal(confirmationQueue.enqueueCalls.length, 1);
  assert.equal(analysisCalls, 1);
});

test("same-head work changes invalidate the durable confirmation before it can be used", async (t) => {
  const cases = [
    {
      name: "nextAction changed",
      replacement: pullRequest({ nextAction: "rereview" }),
      expectedJobs: 2,
    },
    {
      name: "candidate disappeared",
      replacement: pullRequest({
        actionState: "waiting",
        actionReasons: ["暂时无需审核"],
      }),
      expectedJobs: 1,
    },
    {
      name: "Git target changed under the same Head",
      replacement: pullRequest({
        gitTarget: {
          ...pullRequest().gitTarget,
          baseRefOid: "e".repeat(40),
        },
      }),
      expectedJobs: 2,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { store, confirmationQueue, service, job } =
        await createLinkedJob();
      const oldConfirmation = confirmationQueue.items.get(job.confirmationId);
      await store.write("snapshot", snapshot([scenario.replacement]));

      const updated = await service.tick({ trigger: "refresh_completed" });
      const superseded = updated.jobs.find(
        (candidate) => candidate.id === job.id,
      );
      const invalidation = confirmationQueue.invalidateCalls.find(
        (call) => call.id === job.confirmationId,
      );
      const persistedBeforeInvalidation =
        confirmationQueue.persistedStatesAtInvalidate[0].jobs.find(
          (candidate) => candidate.id === job.id,
        );

      assert.equal(superseded.status, "superseded");
      assert.equal(updated.jobs.length, scenario.expectedJobs);
      assert.deepEqual(invalidation, {
        id: job.confirmationId,
        input: {
          requestedBy: oldConfirmation.requestedBy,
          approvalBindingDigest: oldConfirmation.approvalBindingDigest,
          reason: "work_item_superseded",
        },
      });
      assert.equal(
        persistedBeforeInvalidation.status,
        "confirmation_invalidation_pending",
      );
      assert.deepEqual(
        persistedBeforeInvalidation.confirmationInvalidationIntent,
        invalidation.input,
      );
      assert.equal(
        confirmationQueue.items.get(job.confirmationId).status,
        "stale",
      );

      await service.tick({ trigger: "scheduled" });
      assert.equal(
        confirmationQueue.invalidateCalls.filter(
          (call) => call.id === job.confirmationId,
        ).length,
        1,
      );
    });
  }
});

test("a policy version change invalidates the old durable confirmation", async () => {
  const { store, confirmationQueue, job } = await createLinkedJob();
  const oldConfirmation = confirmationQueue.items.get(job.confirmationId);
  const upgradedService = createService({
    store,
    confirmationQueue,
    config: { policyVersion: 2 },
  });

  const upgraded = await upgradedService.tick({ trigger: "policy_changed" });
  const oldJob = upgraded.jobs.find((candidate) => candidate.id === job.id);

  assert.equal(oldJob.status, "superseded");
  assert.equal(confirmationQueue.items.get(job.confirmationId).status, "stale");
  assert.deepEqual(confirmationQueue.invalidateCalls[0], {
    id: job.confirmationId,
    input: {
      requestedBy: oldConfirmation.requestedBy,
      approvalBindingDigest: oldConfirmation.approvalBindingDigest,
      reason: "work_item_superseded",
    },
  });
  assert.ok(
    upgraded.jobs.some(
      (candidate) =>
        candidate.id !== job.id &&
        candidate.policyVersion === 2 &&
        candidate.status === "waiting_confirmation",
    ),
  );
});

test("external GitHub actions disabled preserves the legacy ready_for_human flow", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    githubActions: { enabled: false },
  });

  const work = await service.tick();

  assert.equal(work.jobs[0].status, "ready_for_human");
  assert.equal(work.jobs[0].confirmationId, undefined);
  assert.equal(work.jobs[0].confirmationIntent, undefined);
  assert.equal(work.confirmationQueue.length, 1);
});

test("enabled external GitHub actions require a complete producer queue", () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });

  assert.throws(
    () => createService({ store }),
    /Enabled GitHub actions require a confirmation queue/,
  );
  assert.throws(
    () =>
      createService({
        store,
        confirmationQueue: { async enqueue() {} },
      }),
    /Enabled GitHub actions require a confirmation queue/,
  );
  assert.throws(
    () =>
      createService({
        store,
        confirmationQueue: {
          async enqueue() {},
          async get() {},
        },
      }),
    /Enabled GitHub actions require a confirmation queue/,
  );
});

test("a confirmation-linked job cannot use the legacy local decide path", async () => {
  const { service, work, job, confirmationQueue } = await createLinkedJob();

  assert.equal(job.status, "waiting_confirmation");
  assert.equal(job.confirmationId, confirmationQueue.enqueueCalls[0].id);
  await assert.rejects(
    service.decide(job.id, "accept", {
      headRefOid: HEAD,
      expectedRevision: work.role.revision,
    }),
    (error) =>
      error.statusCode === 409 && /不在待确认状态/.test(error.message),
  );

  const unchanged = await service.view();
  assert.equal(unchanged.jobs[0].status, "waiting_confirmation");
  assert.equal(confirmationQueue.enqueueCalls.length, 1);
});
