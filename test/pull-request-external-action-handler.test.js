import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import {
  PullRequestExternalActionProposalHandler,
  createPullRequestExternalActionProposalRunnerService,
} from "../src/services/pull-request-external-action-handler.js";
import {
  externalActionControlledCommit,
  pullRequestExternalActionBinding,
  pullRequestExternalActionPlan,
  pullRequestExternalActionProposal,
} from "./support/pull-request-external-action-fixture.js";

const CLOCK = () => new Date("2026-08-08T07:00:00.000Z");

function itemFor(plan, status = "pending", extra = {}) {
  const expected = Object.hasOwn(plan, "approvalBindingDigest")
    ? plan
    : normalizeConfirmationPlan(plan);
  return {
    id: expected.id,
    kind: expected.kind,
    status,
    queueRevision: 1,
    itemRevision: 1,
    requestedBy: expected.requestedBy,
    actor: expected.actor,
    target: expected.target,
    display: expected.display,
    displayedPayloadDigest: expected.displayedPayloadDigest,
    approvalBindingDigest: expected.approvalBindingDigest,
    retryable: false,
    ...extra,
  };
}

function producer() {
  const items = new Map();
  return {
    enqueueCalls: [],
    invalidateCalls: [],
    async enqueue(plan) {
      this.enqueueCalls.push(structuredClone(plan));
      const item = itemFor(plan);
      items.set(item.id, item);
      return structuredClone(item);
    },
    async get(id) {
      const item = items.get(id);
      if (!item) {
        const error = new Error("not found");
        error.code = "CONFIRMATION_NOT_FOUND";
        throw error;
      }
      return structuredClone(item);
    },
    async invalidate(id, request) {
      this.invalidateCalls.push({ id, request: structuredClone(request) });
      const item = items.get(id);
      const stale = {
        ...item,
        status: "stale",
        itemRevision: item.itemRevision + 1,
        invalidation: {
          ...request,
          at: "2026-08-08T07:00:00.000Z",
        },
      };
      items.set(id, stale);
      return structuredClone(stale);
    },
    put(item) {
      items.set(item.id, structuredClone(item));
    },
  };
}

function handlerFor(action, confirmationProducer, overrides = {}) {
  const binding = pullRequestExternalActionBinding();
  return new PullRequestExternalActionProposalHandler({
    enabledActions: [action.type],
    confirmationProducer,
    inputAuthorityVerifier: {
      async verify() { return structuredClone(binding); },
    },
    actorAccountId: "runtime-user",
    clock: CLOCK,
    pollIntervalMs: 15_000,
    ...overrides,
  });
}

function handlerInput(proposal, overrides = {}) {
  return {
    proposal,
    status: "pending_delivery",
    attempt: 1,
    downstreamRef: null,
    ...overrides,
  };
}

test("an enabled action becomes one exact confirmation and waits for the user", async () => {
  const action = { type: "comment", body: "Please add coverage." };
  const proposal = pullRequestExternalActionProposal(action);
  const confirmations = producer();
  const handler = handlerFor(action, confirmations);

  const transition = await handler.handle(handlerInput(proposal));
  const queued = confirmations.enqueueCalls[0];

  assert.equal(transition.status, "waiting_confirmation");
  assert.equal(transition.downstreamRef, queued.id);
  assert.equal(transition.nextAttemptAt, "2026-08-08T07:00:15.000Z");
  assert.equal(confirmations.enqueueCalls.length, 1);
  assert.equal(queued.action.type, "pull_request_comment");
  assert.equal(queued.action.inputBinding.schemaVersion, 2);

  const repeated = await handler.handle(handlerInput(proposal, {
    status: "waiting_confirmation",
    attempt: 2,
    downstreamRef: queued.id,
  }));
  assert.equal(repeated.status, "waiting_confirmation");
  assert.equal(confirmations.enqueueCalls.length, 1);
});

test("actions are disabled by default and never enter the confirmation queue", async () => {
  const action = { type: "merge", method: "squash" };
  const confirmations = producer();
  const handler = new PullRequestExternalActionProposalHandler({
    confirmationProducer: confirmations,
    inputAuthorityVerifier: {
      async verify() { throw new Error("must not verify"); },
    },
    actorAccountId: "runtime-user",
    clock: CLOCK,
  });

  const transition = await handler.handle(
    handlerInput(pullRequestExternalActionProposal(action)),
  );

  assert.equal(transition.status, "stale");
  assert.match(transition.summary, /未启用/);
  assert.equal(confirmations.enqueueCalls.length, 0);
});

test("authority changes invalidate a pending approval without executing it", async () => {
  const action = { type: "update_branch" };
  const proposal = pullRequestExternalActionProposal(action);
  const confirmations = producer();
  const handler = handlerFor(action, confirmations);
  const waiting = await handler.handle(handlerInput(proposal));
  const plan = pullRequestExternalActionPlan(action);
  confirmations.put(itemFor(plan));
  const revoked = handlerFor(action, confirmations, {
    inputAuthorityVerifier: {
      async verify() { throw new Error("revoked"); },
    },
  });

  const transition = await revoked.handle(handlerInput(proposal, {
    status: "waiting_confirmation",
    attempt: 2,
    downstreamRef: waiting.downstreamRef,
  }));

  assert.equal(transition.status, "stale");
  assert.equal(confirmations.invalidateCalls.length, 1);
  assert.equal(
    confirmations.invalidateCalls[0].request.reason,
    "authorization_changed",
  );
});

test("completed and unknown confirmations map to terminal proposal outcomes", async () => {
  const action = { type: "merge", method: "merge" };
  const proposal = pullRequestExternalActionProposal(action);
  const plan = pullRequestExternalActionPlan(action);
  const confirmations = producer();
  const completed = itemFor(plan, "completed", {
    receipt: { id: "merge-commit" },
  });
  confirmations.put(completed);
  const handler = handlerFor(action, confirmations);

  assert.deepEqual(
    await handler.handle(handlerInput(proposal, {
      status: "waiting_confirmation",
      attempt: 2,
      downstreamRef: plan.id,
    })),
    {
      status: "succeeded",
      summary: "GitHub PR merge 已完成",
      evidence: [`confirmation:${plan.id}`, "receipt:merge-commit"],
    },
  );

  confirmations.put(itemFor(plan, "failed", {
    failure: {
      code: "GITHUB_RESPONSE_LOST",
      outcome: "unknown",
      retryable: false,
      at: "2026-08-08T07:00:00.000Z",
    },
  }));
  assert.deepEqual(
    await handler.handle(handlerInput(proposal, {
      status: "waiting_confirmation",
      attempt: 3,
      downstreamRef: plan.id,
    })),
    {
      status: "unknown",
      summary: "GitHub PR merge 外部结果无法确认",
      evidence: [`confirmation:${plan.id}`, "GITHUB_RESPONSE_LOST"],
    },
  );
});

test("completed push carries the exact controlled commit and receipt into proposal evidence", async () => {
  const controlledCommitEvidence = externalActionControlledCommit();
  const action = { type: "push", controlledCommitEvidence };
  const proposal = pullRequestExternalActionProposal(action);
  const plan = pullRequestExternalActionPlan(action);
  const confirmations = producer();
  confirmations.put(itemFor(plan, "completed", {
    receipt: { id: controlledCommitEvidence.commit.oid },
  }));
  const handler = handlerFor(action, confirmations);

  assert.deepEqual(
    await handler.handle(handlerInput(proposal, {
      status: "waiting_confirmation",
      attempt: 2,
      downstreamRef: plan.id,
    })),
    {
      status: "succeeded",
      summary: "GitHub PR push 已完成",
      evidence: [
        `confirmation:${plan.id}`,
        `receipt:${controlledCommitEvidence.commit.oid}`,
        `controlled-commit:${controlledCommitEvidence.evidenceId}`,
        `commit:${controlledCommitEvidence.commit.oid}`,
      ],
    },
  );
});

test("runner factory is master-disabled and scopes only the generic proposal kind", () => {
  assert.equal(createPullRequestExternalActionProposalRunnerService(), null);
  assert.equal(
    createPullRequestExternalActionProposalRunnerService({ enabled: false }),
    null,
  );

  let handler;
  const runner = {};
  const result = createPullRequestExternalActionProposalRunnerService({
    enabled: true,
    enabledActions: [],
    runner,
    confirmationProducer: producer(),
    inputAuthorityVerifier: { async verify() {} },
    actorAccountId: "runtime-user",
    clock: CLOCK,
    runnerFactory(options) {
      handler = options.handler;
      assert.strictEqual(options.runner, runner);
      return { configured: true };
    },
  });

  assert.deepEqual(result, { configured: true });
  assert.ok(handler instanceof PullRequestExternalActionProposalHandler);
});
