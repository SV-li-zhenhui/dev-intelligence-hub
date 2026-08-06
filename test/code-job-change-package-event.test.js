import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
  updateCodeJobLifecycle,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  CodeJobChangePackageEventError,
  createCodeJobChangePackageEvent,
  normalizeCodeJobChangePackageEvent,
  reconstructCodeJobChangePackageEventForRecovery,
} from "../src/domain/code-job-change-package-event.js";

const WORKSPACE_REVISION = "4".repeat(64);

function pullRequestInputBinding(schemaVersion) {
  return {
    schemaVersion,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "work-1",
    workKey: "pull-request-acme-widgets-17",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "1".repeat(40),
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    ...(schemaVersion === 2
      ? {
          gitTarget: {
            schemaVersion: 1,
            provider: "github",
            sourceAccountId: "runtime-user",
            baseRepository: "acme/widgets",
            baseRefName: "main",
            baseRefOid: "5".repeat(40),
            headRepository: "contributor/widgets",
            headRefName: "fix/retry-race",
            headRefOid: "1".repeat(40),
          },
        }
      : {}),
  };
}

function completedJob({ inputBindingVersion = null, grantSchemaVersion = 2 } = {}) {
  const inputBinding = inputBindingVersion === null
    ? null
    : pullRequestInputBinding(inputBindingVersion);
  const grant = createCodeJobGrant({
    ...(grantSchemaVersion === 2
      ? { schemaVersion: 2, inputBinding }
      : {}),
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: inputBinding === null
        ? "github:issue:acme/widgets#17"
        : "github:pr:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Inspect the retry race",
    acceptanceCriteria: ["Report the root cause"],
    evidence: [],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  });
  const queued = createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant,
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
  const action = {
    type: "complete",
    actionId: "complete-action-1",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
  };
  const observationDetail = {
    schemaVersion: 1,
    executor: { actionStatus: "succeeded" },
    result: { created: [], modified: [], deleted: [] },
  };
  const active = updateCodeJobLifecycle(queued, {
    status: "active",
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      sessionId: queued.jobId,
      workspaceRevision: WORKSPACE_REVISION,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [{
        turn: 1,
        actionId: action.actionId,
        actionType: action.type,
        actionDigest: digestValue(action),
        action,
        status: "succeeded",
        workspaceRevision: WORKSPACE_REVISION,
        detail: observationDetail,
        detailDigest: digestValue(observationDetail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      }],
      result: null,
      pause: null,
      uncertainty: null,
      memoryProjection: null,
    },
  });
  const resultDetail = {
    schemaVersion: 1,
    outcome: "completed",
    completedActionId: action.actionId,
  };
  return updateCodeJobLifecycle(active, {
    status: "completed",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      result: {
        kind: "completed",
        detail: resultDetail,
        detailDigest: digestValue(resultDetail),
        recordedAt: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function eventContent(event) {
  const { eventId: _eventId, eventDigest: _eventDigest, ...content } = event;
  return content;
}

function persistedLegacyEvent(job) {
  const source = job.execution.memoryProjection ?? {
    sourceRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
  };
  const content = {
    schemaVersion: 1,
    sequence: 1,
    previousDigest: null,
    job: {
      id: job.jobId,
      revision: source.sourceRevision,
      recordDigest: source.sourceRecordDigest,
    },
    proposal: {
      id: job.proposal.proposalId,
      contentDigest: job.proposal.contentDigest,
    },
    grant: { digest: job.grant.grantDigest },
    exportRequest: {
      sessionId: job.execution.sessionId,
      completedActionId: "complete-action-1",
      expectedWorkspaceRevision: job.execution.workspaceRevision,
    },
  };
  const eventDigest = digestValue(content);
  return {
    ...content,
    eventId: `code-job-change-package-event-${eventDigest}`,
    eventDigest,
  };
}

test("completed jobs produce a compact, digest-bound change-package event", () => {
  const job = completedJob();
  const event = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job,
  });

  assert.deepEqual(eventContent(event), {
    schemaVersion: 1,
    sequence: 1,
    previousDigest: null,
    job: { id: job.jobId, revision: job.revision, recordDigest: job.recordDigest },
    proposal: {
      id: job.proposal.proposalId,
      contentDigest: job.proposal.contentDigest,
    },
    grant: { digest: job.grant.grantDigest },
    exportRequest: {
      sessionId: job.execution.sessionId,
      completedActionId: "complete-action-1",
      expectedWorkspaceRevision: WORKSPACE_REVISION,
    },
  });
  assert.equal(event.eventDigest, digestValue(eventContent(event)));
  assert.equal(event.eventId, `code-job-change-package-event-${event.eventDigest}`);
  assert.deepEqual(normalizeCodeJobChangePackageEvent(event), event);
});

test("only v2 PR and Issue jobs can create a new change-package event", () => {
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: 1,
      previousDigest: null,
      job: completedJob({ inputBindingVersion: 1 }),
    }),
    (error) =>
      error instanceof CodeJobChangePackageEventError &&
      error.message.includes("旧版"),
  );
  assert.doesNotThrow(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ inputBindingVersion: 2 }),
  }));
  assert.doesNotThrow(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
  }));
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: 1,
      previousDigest: null,
      job: completedJob({ grantSchemaVersion: 1 }),
    }),
    (error) =>
      error instanceof CodeJobChangePackageEventError &&
      error.message.includes("旧版"),
  );
});

test("legacy event identities remain verifiable only for durable recovery", () => {
  const job = completedJob({ inputBindingVersion: 1 });
  const event = persistedLegacyEvent(job);
  assert.deepEqual(
    reconstructCodeJobChangePackageEventForRecovery({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      job,
    }),
    event,
  );
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      job,
    }),
    CodeJobChangePackageEventError,
  );
});

test("creation and normalization return detached DTOs", () => {
  const job = completedJob();
  const event = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job });
  job.proposal.proposalId = "mutated-source";
  assert.equal(event.proposal.id, "work-intent-proposal-1");

  const normalized = normalizeCodeJobChangePackageEvent(event);
  event.job.id = "mutated-event";
  event.exportRequest.completedActionId = "mutated-action";
  assert.notEqual(normalized.job.id, event.job.id);
  assert.equal(normalized.exportRequest.completedActionId, "complete-action-1");
});

test("a memory-projected job reproduces its original completion event", () => {
  const completed = completedJob();
  const original = createCodeJobChangePackageEvent({
    sequence: 2,
    previousDigest: "f".repeat(64),
    job: completed,
  });
  const memoryRecordDigest = "8".repeat(64);
  const projectedAt = "2026-08-02T06:03:00.000Z";
  const projected = updateCodeJobLifecycle(completed, {
    status: "completed",
    revision: 4,
    updatedAt: projectedAt,
    execution: {
      ...completed.execution,
      memoryProjection: {
        jobId: completed.jobId,
        sourceRecordDigest: completed.recordDigest,
        sourceRevision: completed.revision,
        sourceUpdatedAt: completed.updatedAt,
        memoryRecordId: `memory-${memoryRecordDigest}`,
        memoryRecordDigest,
        projectedAt,
      },
    },
  });

  assert.deepEqual(
    createCodeJobChangePackageEvent({
      sequence: original.sequence,
      previousDigest: original.previousDigest,
      job: projected,
    }),
    original,
  );
});

test("only completed jobs and a canonical digest chain are accepted", () => {
  const completed = completedJob();
  const queued = createQueuedCodeJob(
    {
      confirmationId: completed.approval.confirmationId,
      requestId: completed.approval.requestId,
      displayedPayloadDigest: completed.approval.displayedPayloadDigest,
      approvalBindingDigest: completed.approval.approvalBindingDigest,
      grant: completed.grant,
    },
    { sequence: 1, revision: 1, createdAt: completed.createdAt },
  );
  for (const input of [
    { sequence: 1, previousDigest: null, job: queued },
    { sequence: 1, previousDigest: "f".repeat(64), job: completed },
    { sequence: 2, previousDigest: null, job: completed },
  ]) {
    assert.throws(
      () => createCodeJobChangePackageEvent(input),
      (error) => error instanceof CodeJobChangePackageEventError,
    );
  }
});

test("accessors, sparse data, cycles, extra keys, and oversized values fail closed", () => {
  const job = completedJob();
  let getterCalls = 0;
  const accessor = Object.defineProperty(
    { previousDigest: null, job },
    "sequence",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    },
  );
  assert.throws(() => createCodeJobChangePackageEvent(accessor));
  assert.equal(getterCalls, 0);

  const sparseJob = structuredClone(job);
  sparseJob.execution.observations = new Array(1);
  assert.throws(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: sparseJob,
  }));

  const cyclicJob = structuredClone(job);
  cyclicJob.proposal = cyclicJob;
  assert.throws(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: cyclicJob,
  }));

  const event = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job });
  assert.throws(() => normalizeCodeJobChangePackageEvent({ ...event, extra: true }));
  assert.throws(() => normalizeCodeJobChangePackageEvent({
    ...event,
    proposal: { ...event.proposal, id: "x".repeat(10_000) },
  }));
});
