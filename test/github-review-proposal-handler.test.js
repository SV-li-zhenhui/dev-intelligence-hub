import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import {
  GitHubReviewProposalHandler,
  createGitHubReviewProposalRunnerService,
} from "../src/services/github-review-proposal-handler.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";

const HEAD_REF_OID = "b".repeat(40);

function inputBindingFor(number, { schemaVersion = 2 } = {}) {
  const binding = {
    schemaVersion,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: number,
    rootItemId: `work-${number}`,
    workKey: `github:dashboard:acme-repo:${number}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: HEAD_REF_OID,
    eventId: `event-${number}`,
    eventDigest: `${"c".repeat(63)}${number % 10}`,
    inputDigest: `${"d".repeat(63)}${number % 10}`,
  };
  if (schemaVersion === 2) {
    binding.gitTarget = {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "review-account",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/review",
      headRefOid: HEAD_REF_OID,
    };
  }
  return binding;
}

function proposal(number = 42, { schemaVersion = 2 } = {}) {
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
      headRefOid: HEAD_REF_OID,
      inputBinding: inputBindingFor(number, { schemaVersion }),
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
    this.invalidateCalls = [];
  }

  async enqueue(plan) {
    if (
      this.plan !== null &&
      this.plan.id !== plan.id &&
      this.status === "stale"
    ) {
      this.status = "pending";
      this.overrides = {};
    }
    this.plan = structuredClone(plan);
    this.enqueueCalls.push(structuredClone(plan));
    return confirmationItem(plan, this.status, this.overrides);
  }

  async get(id) {
    this.getCalls.push(id);
    return confirmationItem(this.plan, this.status, this.overrides);
  }

  async invalidate(id, input) {
    this.invalidateCalls.push([id, structuredClone(input)]);
    this.status = "stale";
    this.overrides = {
      invalidation: {
        ...structuredClone(input),
        at: "2026-08-02T03:00:00.000Z",
      },
    };
    return confirmationItem(this.plan, this.status, this.overrides);
  }
}

function acceptingVerifier() {
  return {
    calls: [],
    async verify(value) {
      this.calls.push(structuredClone(value));
      return structuredClone(value);
    },
  };
}

function acceptingContextReader(author = "contributor") {
  return {
    calls: [],
    async readCurrent(value) {
      this.calls.push(structuredClone(value));
      return {
        inputBinding: structuredClone(value),
        author,
      };
    },
  };
}

function handler(producer, overrides = {}) {
  return new GitHubReviewProposalHandler({
    confirmationProducer: producer,
    inputAuthorityVerifier: acceptingVerifier(),
    pullRequestContextReader: acceptingContextReader(),
    actorAccountId: "review-account",
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
    ...overrides,
  });
}

test("a pending proposal is idempotently enqueued and waits on its exact confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const verifier = acceptingVerifier();
  const contextReader = acceptingContextReader();
  const transition = await handler(producer, {
    inputAuthorityVerifier: verifier,
    pullRequestContextReader: contextReader,
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 0);
  assert.equal(verifier.calls.length, 0);
  assert.deepEqual(contextReader.calls, [
    handlerInput().proposal.binding.inputBinding,
  ]);
  assert.match(
    producer.enqueueCalls[0].id,
    /^confirmation-github-review-[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    producer.enqueueCalls[0].action.inputBinding,
    handlerInput().proposal.binding.inputBinding,
  );
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: producer.enqueueCalls[0].id,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("a self-authored blocking proposal is queued as a COMMENT review", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer, {
    pullRequestContextReader: acceptingContextReader("REVIEW-ACCOUNT"),
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "COMMENT");
  assert.equal(
    producer.enqueueCalls[0].display.actionLabel,
    "确认并以 COMMENT 发布到 GitHub",
  );
});

test("missing author context preserves the proposed verdict", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer, {
    pullRequestContextReader: acceptingContextReader(null),
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "REQUEST_CHANGES");
  assert.equal(
    producer.enqueueCalls[0].display.actionLabel,
    "确认并发布到 GitHub",
  );
});

test("a pending legacy self-review is invalidated and replaced by COMMENT", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer).handle(handlerInput());
  const legacyId = producer.plan.id;
  producer.enqueueCalls.length = 0;

  const transition = await handler(producer, {
    pullRequestContextReader: acceptingContextReader("review-account"),
  }).handle(handlerInput({
    status: "waiting_confirmation",
    downstreamRef: legacyId,
  }));

  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.enqueueCalls.length, 1);
  assert.notEqual(producer.enqueueCalls[0].id, legacyId);
  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "COMMENT");
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: legacyId,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("a pending v1 self-comment is migrated to the lifecycle-bound confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const legacyPlan = createGitHubReviewProposalConfirmationPlan(
    handlerInput().proposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
      legacySelfAuthored: true,
    },
  );
  await producer.enqueue(legacyPlan);
  producer.enqueueCalls.length = 0;

  const transition = await handler(producer, {
    pullRequestContextReader: acceptingContextReader("review-account"),
  }).handle(handlerInput({
    status: "waiting_confirmation",
    downstreamRef: legacyPlan.id,
  }));

  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(
    producer.enqueueCalls[0].display.payload.reviewIntent,
    "REQUEST_CHANGES",
  );
  assert.equal(transition.downstreamRef, legacyPlan.id);
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

test("revoked target authority prevents enqueue and invalidates an existing confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const revoked = {
    async readCurrent() {
      throw Object.assign(new Error("stale"), {
        code: "WORK_LEDGER_PR_BINDING_STALE",
      });
    },
  };

  const beforeEnqueue = await handler(producer, {
    pullRequestContextReader: revoked,
  }).handle(handlerInput());
  assert.equal(beforeEnqueue.status, "stale");
  assert.equal(producer.enqueueCalls.length, 0);

  await handler(producer).handle(handlerInput());
  const downstreamRef = producer.plan.id;
  const afterEnqueue = await handler(producer, {
    pullRequestContextReader: revoked,
  }).handle(
    handlerInput({ status: "waiting_confirmation", downstreamRef }),
  );
  assert.equal(afterEnqueue.status, "stale");
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(
    producer.invalidateCalls[0][1].reason,
    "authorization_changed",
  );
});

test("the legacy verifier remains the authority fallback without a context reader", async () => {
  const producer = new FakeConfirmationProducer();
  const verifier = acceptingVerifier();

  await handler(producer, {
    inputAuthorityVerifier: verifier,
    pullRequestContextReader: undefined,
  }).handle(handlerInput());

  assert.deepEqual(verifier.calls, [
    handlerInput().proposal.binding.inputBinding,
  ]);
  assert.equal(producer.enqueueCalls.length, 1);
});

test("persisted v1 review proposals terminate stale instead of retrying forever", async () => {
  const producer = new FakeConfirmationProducer();
  const legacyInput = handlerInput({ proposal: proposal(42, { schemaVersion: 1 }) });

  const transition = await handler(producer).handle(legacyInput);

  assert.equal(transition.status, "stale");
  assert.equal(producer.enqueueCalls.length, 0);
});

test("persisted v1 review proposals recover stale when their confirmation is missing", async () => {
  const legacyProposal = proposal(42, { schemaVersion: 1 });
  const downstreamRef = createGitHubReviewProposalConfirmationPlan(
    legacyProposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
    },
  ).id;
  const producer = new FakeConfirmationProducer();
  producer.get = async function get(id) {
    this.getCalls.push(id);
    throw Object.assign(new Error("confirmation missing"), {
      code: "CONFIRMATION_NOT_FOUND",
    });
  };

  const transition = await handler(producer).handle(
    handlerInput({
      proposal: legacyProposal,
      status: "waiting_confirmation",
      downstreamRef,
    }),
  );

  assert.equal(transition.status, "stale");
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(producer.enqueueCalls.length, 0);
});

test("persisted v2 review proposals fail closed when their confirmation is missing", async () => {
  const currentProposal = proposal();
  const downstreamRef = createGitHubReviewProposalConfirmationPlan(
    currentProposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
    },
  ).id;
  const producer = new FakeConfirmationProducer();
  producer.get = async function get(id) {
    this.getCalls.push(id);
    throw Object.assign(new Error("confirmation missing"), {
      code: "CONFIRMATION_NOT_FOUND",
    });
  };

  await assert.rejects(
    handler(producer).handle(
      handlerInput({
        proposal: currentProposal,
        status: "waiting_confirmation",
        downstreamRef,
      }),
    ),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(producer.enqueueCalls.length, 0);
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
    inputAuthorityVerifier: acceptingVerifier(),
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
