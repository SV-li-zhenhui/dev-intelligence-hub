import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import {
  GitHubReviewProposalHandler,
  createGitHubReviewProposalRunnerService,
} from "../src/services/github-review-proposal-handler.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";

function proposal(number = 42) {
  return normalizeBoundWorkProposal({
    proposalId: `work-intent-${"a".repeat(63)}${number % 10}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: `work-${number}` },
    source: { assignmentId: `assignment-${number}`, eventId: `event-${number}` },
    binding: {
      eventId: `event-${number}`,
      subject: { repository: "acme/repo", number },
      repository: "acme/repo",
      pullRequestNumber: number,
      headRefOid: "b".repeat(40),
    },
    payload: {
      verdict: "request_changes",
      body: "请先补充失败分支测试。",
      evidence: ["缺少失败路径覆盖"],
      summary: "建议修改",
      reason: "风险尚未覆盖",
    },
  });
}

function handlerInput(overrides = {}) {
  return {
    proposal: proposal(),
    status: "pending_delivery",
    attempt: 1,
    downstreamRef: null,
    ...overrides,
  };
}

function confirmationItem(plan, status, overrides = {}) {
  const normalized = normalizeConfirmationPlan(plan);
  return {
    id: normalized.id,
    kind: normalized.kind,
    status,
    queueRevision: 1,
    itemRevision: 1,
    requestedBy: normalized.requestedBy,
    actor: normalized.actor,
    target: normalized.target,
    display: normalized.display,
    displayedPayloadDigest: normalized.displayedPayloadDigest,
    approvalBindingDigest: normalized.approvalBindingDigest,
    retryable: false,
    ...overrides,
  };
}

class FakeConfirmationProducer {
  constructor(status = "pending", overrides = {}) {
    this.status = status;
    this.overrides = overrides;
    this.plan = null;
    this.enqueueCalls = [];
    this.getCalls = [];
  }

  async enqueue(plan) {
    this.plan = structuredClone(plan);
    this.enqueueCalls.push(structuredClone(plan));
    return confirmationItem(plan, this.status, this.overrides);
  }

  async get(id) {
    this.getCalls.push(id);
    return confirmationItem(this.plan, this.status, this.overrides);
  }
}

function handler(producer, overrides = {}) {
  return new GitHubReviewProposalHandler({
    confirmationProducer: producer,
    actorAccountId: "review-account",
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
    ...overrides,
  });
}

test("a pending proposal is idempotently enqueued and waits on its exact confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const transition = await handler(producer).handle(handlerInput());

  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 0);
  assert.match(
    producer.enqueueCalls[0].id,
    /^confirmation-github-review-[a-f0-9]{64}$/,
  );
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: producer.enqueueCalls[0].id,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("a bound proposal polls get without enqueuing another action", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer).handle(handlerInput());
  producer.enqueueCalls.length = 0;
  const downstreamRef = producer.plan.id;

  const transition = await handler(producer).handle(
    handlerInput({ status: "waiting_confirmation", downstreamRef }),
  );

  assert.equal(producer.enqueueCalls.length, 0);
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(transition.downstreamRef, downstreamRef);
});

test("confirmation outcomes map to bounded proposal transitions", async (t) => {
  const cases = [
    ["pending", {}, "waiting_confirmation"],
    ["executing", {}, "waiting_confirmation"],
    ["completed", { receipt: { id: "review-42" } }, "succeeded"],
    [
      "rejected",
      { rejection: { requestId: "reject-1", reason: "不发布", at: "2026-08-02T03:00:00.000Z" } },
      "rejected",
    ],
    [
      "stale",
      {
        invalidation: {
          reason: "work_item_superseded",
          requestedBy: proposal().requestedBy,
          approvalBindingDigest: "c".repeat(64),
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "stale",
    ],
    [
      "failed",
      {
        failure: {
          code: "EXTERNAL_OUTCOME_UNKNOWN",
          outcome: "unknown",
          retryable: false,
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "unknown",
    ],
    [
      "failed",
      {
        retryable: true,
        failure: {
          code: "EXTERNAL_ACTION_ABSENT",
          outcome: "absent",
          retryable: true,
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "waiting_retry",
    ],
  ];

  for (const [status, itemOverrides, expected] of cases) {
    await t.test(status + (itemOverrides.retryable ? " retryable" : ""), async () => {
      const producer = new FakeConfirmationProducer(status, itemOverrides);
      const transition = await handler(producer).handle(handlerInput());
      assert.equal(transition.status, expected);
      if (["succeeded", "rejected", "stale", "unknown"].includes(expected)) {
        assert.equal(typeof transition.summary, "string");
        assert.equal(Array.isArray(transition.evidence), true);
      }
    });
  }
});

test("mismatched confirmation bindings fail closed", async () => {
  const producers = [
    new FakeConfirmationProducer("pending", {
      approvalBindingDigest: "f".repeat(64),
    }),
    new FakeConfirmationProducer("pending", {
      display: {
        title: "被篡改的动作",
        summary: "错误目标",
        actionLabel: "发布",
        evidence: [],
        payload: {},
      },
    }),
  ];

  for (const producer of producers) {
    await assert.rejects(
      handler(producer).handle(handlerInput()),
      (error) => error.code === "INVALID_GITHUB_REVIEW_CONFIRMATION",
    );
  }
});

test("disabled GitHub proposal execution constructs no service", () => {
  assert.equal(createGitHubReviewProposalRunnerService({ enabled: false }), null);
  assert.equal(createGitHubReviewProposalRunnerService({}), null);
});

class MemoryStore {
  constructor() {
    this.value = null;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

class Guard {
  async acquire() {}
  run(operation) {
    return operation();
  }
  async close() {}
}

test("the enabled service closes the real proposal loop through confirmation", async () => {
  const store = new MemoryStore();
  let now = Date.parse("2026-08-02T03:00:00.000Z");
  const runtime = await createWorkProposalRuntime({
    store,
    clock: () => new Date(now),
    idFactory: () => "github-lease",
    runnerScopes: [
      {
        runnerId: "github-runner",
        allowedKinds: ["github_review_proposal"],
        allowedRoleIds: ["pr-reviewer"],
      },
    ],
    createGuard: () => new Guard(),
  });
  const producer = new FakeConfirmationProducer();
  const service = createGitHubReviewProposalRunnerService({
    enabled: true,
    runner: runtime.runners["github-runner"],
    confirmationProducer: producer,
    actorAccountId: "review-account",
    clock: () => new Date(now),
    pollIntervalMs: 1_000,
    leaseDurationMs: 30_000,
  });
  const { contentDigest: _contentDigest, ...proposalInput } = proposal();
  await runtime.producer.create(proposalInput);

  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "waiting_confirmation");
  assert.equal(store.value.results.length, 0);

  producer.status = "completed";
  producer.overrides = { receipt: { id: "review-42" } };
  now += 1_000;
  await service.runCycle({ limit: 1 });

  const batch = await runtime.consumer.readResultBatch();
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].outcome, "succeeded");
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 1);
  await runtime.close();
});
