import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectPullRequestSourceCutover,
} from "../src/services/work-ledger-pr-cutover-commands.js";

function root(overrides = {}) {
  return {
    itemId: "root-a",
    status: "blocked",
    activeIntentId: null,
    inputDigest: "a".repeat(64),
    statusReason: "manual_block",
    decisionContext: null,
    source: { pendingRevision: null },
    ...overrides,
  };
}

function blockersFor(item, outbox = [], options = {}) {
  return inspectPullRequestSourceCutover(
    item,
    [item],
    new Map(outbox.map((entry) => [entry.intentId, entry])),
    options,
  ).blockers;
}

test("cutover releases only blocked outcomes with durable final evidence", () => {
  const rejected = root({
    statusReason: "attention_rejected",
    decisionContext: { source: "attention", outcome: "rejected" },
  });
  const proposalFailed = root({
    statusReason: "proposal_failed",
    decisionContext: { source: "proposal", outcome: "failed" },
  });
  const proposalRejected = root({
    statusReason: "proposal_rejected",
    decisionContext: { source: "proposal", outcome: "rejected" },
  });
  const intentFailed = root({ statusReason: "intent_failed" });
  const failedOutbox = {
    intentId: "intent-failed",
    itemId: intentFailed.itemId,
    inputDigest: intentFailed.inputDigest,
    status: "failed",
    outcome: { status: "failed", details: {} },
    updatedAt: "2026-08-02T02:00:00.000Z",
  };
  intentFailed.updatedAt = failedOutbox.updatedAt;

  assert.deepEqual(blockersFor(rejected), []);
  assert.deepEqual(blockersFor(proposalFailed), []);
  assert.deepEqual(blockersFor(proposalRejected), []);
  assert.deepEqual(blockersFor(intentFailed, [failedOutbox]), []);
  assert.deepEqual(
    blockersFor(root({
      statusReason: "attention_rejected",
      decisionContext: { source: "attention", outcome: "answered" },
    })).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(root({ statusReason: "intent_failed" }), [failedOutbox])
      .map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(root({ statusReason: "manual_block" }))
      .map(({ itemId }) => itemId),
    ["root-a"],
  );
});

test("cutover recovers a persisted blocker only from its latest durable rejected proposal", () => {
  const decisionDigest = "d".repeat(64);
  const persisted = root({
    revision: 7,
    statusReason: "pr_source_cross_root_cutover_blocker:root-b",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const rejected = {
    sequence: 10,
    itemId: persisted.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 6,
      decision: { contentDigest: decisionDigest },
    },
  };
  const sourceRevision = {
    sequence: 11,
    itemId: persisted.itemId,
    type: "pr_source_revised",
    details: {},
  };

  assert.deepEqual(
    blockersFor(persisted, [], { timeline: [rejected, sourceRevision] }),
    [],
  );
  assert.deepEqual(
    blockersFor(persisted, [], {
      timeline: [
        rejected,
        {
          sequence: 11,
          itemId: persisted.itemId,
          type: "transitioned",
          details: {},
        },
      ],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(persisted, [], {
      timeline: [{
        ...rejected,
        details: {
          ...rejected.details,
          decision: { contentDigest: "e".repeat(64) },
        },
      }],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
});

test("cutover treats side-effect-free decision exhaustion as settled", () => {
  assert.deepEqual(
    blockersFor(root({ statusReason: "decision_attempts_exhausted" })),
    [],
  );
});

test("cutover keeps unknown waiting states blocked and accepts retry settlement", () => {
  for (const status of [
    "waiting_user",
    "waiting_external",
    "waiting_condition",
    "dispatch_pending",
  ]) {
    const item = root({
      status,
      activeIntentId: status === "dispatch_pending" ? "sealed-intent" : null,
    });
    assert.deepEqual(
      blockersFor(item).map(({ itemId }) => itemId),
      ["root-a"],
      status,
    );
  }
  assert.deepEqual(
    blockersFor(root({
      status: "retry_wait",
      statusReason: "intent_failed",
    })),
    [],
  );
});
