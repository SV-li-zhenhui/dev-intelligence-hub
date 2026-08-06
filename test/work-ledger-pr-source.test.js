import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import {
  activatePendingPullRequestWorkSource,
  appendPullRequestWorkSource,
  createPullRequestWorkSource,
  validatePullRequestSourceTransition,
} from "../src/services/work-ledger-pr-source.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

function pullRequestEnvelope(
  sequence,
  headRefOid,
  { previousHeadRefOid } = {},
) {
  const occurredAt = `2026-08-02T01:00:0${sequence}.000Z`;
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt,
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "PR 42",
      headRefOid,
      ciStatus: "PENDING",
      changedFields: previousHeadRefOid === undefined
        ? ["ciStatus"]
        : ["headRefOid"],
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
      createdAt: occurredAt,
    },
    event,
  };
}

function initialSource() {
  return createPullRequestWorkSource(
    pullRequestEnvelope(1, HEAD_A),
  ).source;
}

function sourceItem(source) {
  return { itemId: "work-item-pr-42", source };
}

test("deferred A to B keeps A active and records B as pending", () => {
  const sourceA = initialSource();

  const appended = appendPullRequestWorkSource(
    sourceA,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  );

  assert.equal(appended.changed, true);
  assert.equal(appended.headAdvanced, true);
  assert.equal(appended.activeAdvanced, false);
  assert.equal(appended.source.inputRevision, 2);
  assert.equal(appended.source.activeRevision, 1);
  assert.equal(appended.source.headRevision, 2);
  assert.equal(appended.source.pendingRevision, 2);
  assert.equal(appended.source.current.headRefOid, HEAD_A);
  assert.equal(appended.source.pending.headRefOid, HEAD_B);
});

test("activating a pending B atomically moves the active pointer to B", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;

  const activated = activatePendingPullRequestWorkSource(pendingB);

  assert.equal(activated.changed, true);
  assert.equal(activated.source.inputRevision, 2);
  assert.equal(activated.source.activeRevision, 2);
  assert.equal(activated.source.headRevision, 2);
  assert.equal(activated.source.pendingRevision, null);
  assert.equal(activated.source.pending, null);
  assert.equal(activated.source.current.headRefOid, HEAD_B);
  assert.equal(activated.source.current.eventId, pendingB.pending.eventId);
});

test("a pending B advances to a causally proven pending C", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;

  const pendingC = appendPullRequestWorkSource(
    pendingB,
    pullRequestEnvelope(3, HEAD_C, { previousHeadRefOid: HEAD_B }),
    { activate: false },
  ).source;

  assert.equal(pendingC.inputRevision, 3);
  assert.equal(pendingC.activeRevision, 1);
  assert.equal(pendingC.headRevision, 3);
  assert.equal(pendingC.pendingRevision, 3);
  assert.equal(pendingC.current.headRefOid, HEAD_A);
  assert.equal(pendingC.pending.headRefOid, HEAD_C);
  assert.deepEqual(
    pendingC.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("A to B to A creates monotonically increasing Head epochs", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;
  const activeB = activatePendingPullRequestWorkSource(pendingB).source;

  const pendingA = appendPullRequestWorkSource(
    activeB,
    pullRequestEnvelope(3, HEAD_A, { previousHeadRefOid: HEAD_B }),
    { activate: false },
  ).source;
  const activeA = activatePendingPullRequestWorkSource(pendingA).source;

  assert.equal(activeA.activeRevision, 3);
  assert.equal(activeA.headRevision, 3);
  assert.equal(activeA.current.headRefOid, HEAD_A);
  assert.deepEqual(
    activeA.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("source transitions accept pointer progress and reject history rewrites", () => {
  const sourceA = initialSource();
  const pendingB = appendPullRequestWorkSource(
    sourceA,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;
  const activeB = activatePendingPullRequestWorkSource(pendingB).source;
  const activeC = appendPullRequestWorkSource(
    activeB,
    pullRequestEnvelope(3, HEAD_C, { previousHeadRefOid: HEAD_B }),
  ).source;

  assert.doesNotThrow(() =>
    validatePullRequestSourceTransition(
      [sourceItem(sourceA)],
      [sourceItem(pendingB)],
    )
  );
  assert.doesNotThrow(() =>
    validatePullRequestSourceTransition(
      [sourceItem(pendingB)],
      [sourceItem(activeB)],
    )
  );

  const rewritten = structuredClone(activeC);
  rewritten.revisions[0].eventDigest = "f".repeat(64);

  assert.throws(
    () =>
      validatePullRequestSourceTransition(
        [sourceItem(activeB)],
        [sourceItem(rewritten)],
      ),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
  );
});
