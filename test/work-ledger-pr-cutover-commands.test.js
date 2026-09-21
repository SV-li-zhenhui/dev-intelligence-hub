import assert from "node:assert/strict";
import test from "node:test";
import {
  appendPullRequestCutoverTimelineEvent,
  createPullRequestCutoverTimelineIndex,
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
  const { timeline = [], ...inspectionOptions } = options;
  return inspectPullRequestSourceCutover(
    item,
    [item],
    new Map(outbox.map((entry) => [entry.intentId, entry])),
    {
      ...inspectionOptions,
      timelineIndex: createPullRequestCutoverTimelineIndex(timeline),
    },
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
  const proposalDecisionDigest = "c".repeat(64);
  const proposalRejected = root({
    revision: 1,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: proposalDecisionDigest,
    },
  });
  const proposalRejectedResult = {
    sequence: 1,
    itemId: proposalRejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: proposalDecisionDigest },
    },
  };
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
  assert.deepEqual(
    blockersFor(proposalRejected, [], {
      timeline: [proposalRejectedResult],
    }),
    [],
  );
  assert.deepEqual(
    blockersFor(proposalRejected).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(proposalRejected, [], {
      timeline: [
        proposalRejectedResult,
        {
          sequence: 2,
          itemId: proposalRejected.itemId,
          type: "transitioned",
          details: {},
        },
      ],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
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

test("cutover proof expires when unrelated same-batch events rotate it out", () => {
  const decisionDigest = "f".repeat(64);
  const rejected = root({
    revision: 1,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const timelineIndex = createPullRequestCutoverTimelineIndex([{
    sequence: 1,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: decisionDigest },
    },
  }], 2);
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 2,
    itemId: null,
    type: "intake_completed",
    details: {},
  });
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 3,
    itemId: "unrelated-item",
    type: "assignment_intaken",
    details: {},
  });

  const blockers = inspectPullRequestSourceCutover(
    rejected,
    [rejected],
    new Map(),
    { timelineIndex },
  ).blockers;

  assert.deepEqual(blockers.map(({ itemId }) => itemId), ["root-a"]);
});

test("cutover keeps a newer same-item proof when the older record expires after compaction", () => {
  const decisionDigest = "9".repeat(64);
  const rejected = root({
    revision: 2,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const timelineIndex = createPullRequestCutoverTimelineIndex([], 1024);
  for (let sequence = 1; sequence <= 1024; sequence += 1) {
    appendPullRequestCutoverTimelineEvent(timelineIndex, {
      sequence,
      itemId: `old-${sequence}`,
      type: "assignment_intaken",
      details: {},
    });
  }
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 1025,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: "8".repeat(64) },
    },
  });
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 1026,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 2,
      decision: { contentDigest: decisionDigest },
    },
  });
  for (let sequence = 1027; sequence <= 2049; sequence += 1) {
    appendPullRequestCutoverTimelineEvent(timelineIndex, {
      sequence,
      itemId: `new-${sequence}`,
      type: "assignment_intaken",
      details: {},
    });
  }

  const blockers = inspectPullRequestSourceCutover(
    rejected,
    [rejected],
    new Map(),
    { timelineIndex },
  ).blockers;

  assert.deepEqual(blockers, []);
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
