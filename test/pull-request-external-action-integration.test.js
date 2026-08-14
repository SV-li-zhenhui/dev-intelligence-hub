import assert from "node:assert/strict";
import test from "node:test";

import { OperationQueue } from "../src/lib/operation-queue.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import {
  createPullRequestExternalActionExecutor,
  PullRequestExternalActionTransportError,
} from "../src/services/pull-request-external-action-executor.js";
import {
  externalActionControlledCommit,
  externalActionOid,
  pullRequestExternalActionBinding,
  pullRequestExternalActionQueuePlan,
} from "./support/pull-request-external-action-fixture.js";

const ACTIONS = ["comment", "review", "update_branch", "push", "merge"];
const NOW = "2026-08-08T08:09:10.111Z";

class MemoryStore {
  constructor() {
    this.value = null;
  }

  async read(name, fallback = null) {
    assert.equal(name, "confirmation-queue");
    return structuredClone(this.value ?? fallback);
  }

  async write(name, value) {
    assert.equal(name, "confirmation-queue");
    this.value = structuredClone(value);
  }
}

class ExclusiveLease {
  #queue = new OperationQueue();

  run(operation) {
    return this.#queue.enqueue(operation);
  }
}

function proposalAction(type, binding, controlledCommitEvidence) {
  return {
    comment: { type, body: "Please add the missing regression test." },
    review: { type, verdict: "approve", body: "The change is ready." },
    update_branch: { type },
    push: { type, controlledCommitEvidence },
    merge: { type, method: "squash" },
  }[type];
}

function initialObservation(input) {
  const actionEvidence = {
    pull_request_comment: { kind: "marker_records", records: [] },
    pull_request_review: { kind: "marker_records", records: [] },
    pull_request_update_branch: { kind: "head_commit", commit: null },
    pull_request_push: { kind: "head_ref" },
    pull_request_merge: { kind: "merge_state", merge: null },
  }[input.action.type];
  return {
    schemaVersion: 1,
    actorAccountId: input.actorAccountId,
    gitTarget: structuredClone(input.action.inputBinding.gitTarget),
    state: "open",
    actionEvidence,
  };
}

function completedObservation(input) {
  const observation = initialObservation(input);
  const action = input.action;
  if (action.type === "pull_request_comment") {
    observation.actionEvidence.records = [{
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      body: action.body,
      reviewEvent: "COMMENT",
      headOid: action.inputBinding.gitTarget.headRefOid,
      receipt: { id: "comment-42" },
    }];
  } else if (action.type === "pull_request_review") {
    observation.actionEvidence.records = [{
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      body: action.body,
      reviewEvent: action.reviewEvent,
      headOid: action.inputBinding.gitTarget.headRefOid,
      receipt: { id: "review-42" },
    }];
  } else if (action.type === "pull_request_update_branch") {
    const oid = externalActionOid("7");
    observation.gitTarget.headRefOid = oid;
    observation.actionEvidence.commit = {
      oid,
      parents: [action.expectedHeadOid, action.expectedBaseOid],
      receipt: { id: oid },
    };
  } else if (action.type === "pull_request_push") {
    observation.gitTarget.headRefOid = action.controlledCommitEvidence.commit.oid;
  } else {
    observation.state = "merged";
    observation.actionEvidence.merge = {
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      expectedHeadOid: action.expectedHeadOid,
      method: action.method,
      receipt: { id: "merge-42" },
    };
  }
  return observation;
}

function fakeTransport({
  loseResponseFor = [],
  advanceHeadAfterMutationFor = [],
  afterMutation = () => {},
} = {}) {
  const observations = new Map();
  const lost = new Set();
  const calls = [];
  return {
    calls,
    async observe(input) {
      calls.push({ method: "observe", input: structuredClone(input) });
      return structuredClone(
        observations.get(input.marker) || initialObservation(input),
      );
    },
    async perform(input) {
      calls.push({ method: "perform", input: structuredClone(input) });
      const completed = completedObservation(input);
      if (advanceHeadAfterMutationFor.includes(input.actionType)) {
        completed.gitTarget.headRefOid = externalActionOid("9");
      }
      observations.set(input.marker, completed);
      afterMutation(structuredClone(input));
      if (loseResponseFor.includes(input.actionType) && !lost.has(input.marker)) {
        lost.add(input.marker);
        throw new PullRequestExternalActionTransportError(
          "GITHUB_RESPONSE_LOST",
          "unknown",
        );
      }
      return { accepted: true };
    },
  };
}

function executorFor(binding, evidence, transport, overrides = {}) {
  return createPullRequestExternalActionExecutor({
    enabledActions: ACTIONS,
    credentialSource: Object.freeze({
      async acquire() {
        return Object.freeze({
          async use(callback) {
            return callback("fake-runtime-secret");
          },
          async release() {},
        });
      },
    }),
    transport,
    inputAuthorityVerifier: {
      async verify() { return structuredClone(binding); },
    },
    controlledCommitVerifier: {
      async verify({ evidenceId }) {
        assert.equal(evidenceId, evidence.evidenceId);
        return structuredClone(evidence);
      },
    },
    ...overrides,
  });
}

async function readyQueue(store, executor) {
  const queue = new ConfirmationQueue({
    store,
    executor,
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
    clock: () => new Date(NOW),
  });
  await queue.recover();
  return queue;
}

function approval(next, index) {
  return {
    requestId: `request-pr-action-${String(index).padStart(4, "0")}`,
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
}

test("five PR actions are displayed and approved one at a time", async () => {
  const binding = pullRequestExternalActionBinding();
  const evidence = externalActionControlledCommit(binding);
  const transport = fakeTransport();
  const queue = await readyQueue(
    new MemoryStore(),
    executorFor(binding, evidence, transport),
  );
  const plans = ACTIONS.map((type) => pullRequestExternalActionQueuePlan(
    proposalAction(type, binding, evidence),
    { binding },
  ));
  for (const plan of plans) await queue.enqueue(plan);

  const seen = new Set();
  const seenActionTypes = new Set();
  const seenKinds = new Set();
  for (let index = 0; index < plans.length; index += 1) {
    const next = await queue.next();
    assert.ok(next.item);
    const displayedActionType = next.item.display.payload.action.type;
    seenActionTypes.add(displayedActionType);
    seenKinds.add(next.item.kind);
    if (displayedActionType === "pull_request_comment") {
      assert.equal(next.item.kind, "github.pull-request-comment");
    }
    if (displayedActionType === "pull_request_review") {
      assert.equal(next.item.kind, "github.work-proposal-review");
    }
    assert.equal(seen.has(next.item.id), false);
    assert.deepEqual(
      Object.keys(next.item.display.payload).sort(),
      ["action", "actor", "target"],
    );
    assert.deepEqual(next.item.display.payload.actor, next.item.actor);
    assert.deepEqual(next.item.display.payload.target, next.item.target);
    assert.equal(
      next.item.display.payload.action.inputBinding.schemaVersion,
      2,
    );
    const completed = await queue.approve(next.item.id, approval(next, index));
    assert.equal(completed.status, "completed");
    seen.add(next.item.id);
  }

  assert.equal((await queue.next()).item, null);
  assert.equal(seen.size, 5);
  assert.equal(seenActionTypes.has("pull_request_comment"), true);
  assert.equal(seenActionTypes.has("pull_request_review"), true);
  assert.equal(seenKinds.has("github.pull-request-comment"), true);
  assert.equal(
    transport.calls.filter(({ method }) => method === "perform").length,
    5,
  );
});

test("lost H1-bound comment response is recovered at H2 without replay", async () => {
  const binding = pullRequestExternalActionBinding();
  const evidence = externalActionControlledCommit(binding);
  let authorityCurrent = true;
  let authorityChecks = 0;
  const transport = fakeTransport({
    loseResponseFor: ["comment"],
    advanceHeadAfterMutationFor: ["comment"],
    afterMutation() {
      authorityCurrent = false;
    },
  });
  const executor = executorFor(binding, evidence, transport, {
    inputAuthorityVerifier: {
      async verify() {
        authorityChecks += 1;
        if (!authorityCurrent) throw new Error("H1 authority revoked at H2");
        return structuredClone(binding);
      },
    },
  });
  const store = new MemoryStore();
  const firstQueue = await readyQueue(store, executor);
  await firstQueue.enqueue(pullRequestExternalActionQueuePlan(
    proposalAction("comment", binding, evidence),
    { binding },
  ));
  const next = await firstQueue.next();
  const unknown = await firstQueue.approve(next.item.id, approval(next, 1));

  assert.equal(unknown.status, "failed");
  assert.equal(unknown.failure.outcome, "unknown");
  assert.equal(unknown.retryable, false);
  const resolution = await firstQueue.next();
  assert.equal(resolution.item.id, unknown.id);
  assert.equal(resolution.item.resolutionRequired, true);
  assert.equal(resolution.item.retryable, false);
  const checksBeforeRecovery = authorityChecks;

  const recoveredQueue = await readyQueue(store, executor);
  const recovered = await recoveredQueue.get(unknown.id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.receipt.id, "comment-42");
  assert.equal(authorityChecks, checksBeforeRecovery);
  assert.equal(
    transport.calls.filter(({ method }) => method === "perform").length,
    1,
  );
  const [mutation] = transport.calls.filter(({ method }) => method === "perform");
  assert.equal(
    mutation.input.action.inputBinding.gitTarget.headRefOid,
    binding.gitTarget.headRefOid,
  );
});
