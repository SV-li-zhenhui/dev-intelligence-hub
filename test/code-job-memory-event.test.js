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
  classifyCodeJobMemoryEvent,
  codeJobMemorySourceId,
  createCodeJobMemoryEvent,
  memoryRecordForCodeJobEvent,
  normalizeCodeJobMemoryEvent,
} from "../src/domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";

const WORKSPACE_REVISION = "4".repeat(64);
const FILE_BEFORE = "5".repeat(64);
const FILE_AFTER = "6".repeat(64);
const HEAD_REF_OID = "1".repeat(40);

function inputBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "github:acme/widgets:pull-request:17",
    workKey: "github:acme/widgets:pull-request:17",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: HEAD_REF_OID,
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
  };
}

function grant(binding) {
  const content = {
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Never project this prompt or C:\\private\\source.js",
    acceptanceCriteria: ["Never project raw file content"],
    evidence: ["token=super-secret"],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  };
  return createCodeJobGrant(
    binding === undefined
      ? content
      : { schemaVersion: 2, ...content, inputBinding: binding },
  );
}

function queuedJob(binding) {
  return createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant: grant(binding),
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
}

function observedJob(binding) {
  const queued = queuedJob(binding);
  const action = {
    type: "complete",
    actionId: "complete-action-1",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
  };
  const detail = {
    schemaVersion: 1,
    executor: { actionStatus: "succeeded" },
    result: {
      created: [],
      modified: [{
        path: "src/app.js",
        beforeSha256: FILE_BEFORE,
        afterSha256: FILE_AFTER,
      }],
      deleted: [],
      content: "raw file content must not escape",
      stdout: "token=from-stdout",
      stderr: "C:\\private\\stderr.log",
    },
  };
  return updateCodeJobLifecycle(queued, {
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
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      }],
      result: null,
      pause: null,
      uncertainty: null,
      memoryProjection: null,
    },
  });
}

function completedJob(binding) {
  const active = observedJob(binding);
  const detail = {
    schemaVersion: 1,
    outcome: "fixed",
    evidence: ["token=terminal-secret", "C:\\private\\proof.txt"],
    checks: ["node-tests"],
    workspaceRevision: WORKSPACE_REVISION,
    manifest: {
      created: [],
      modified: [{
        path: "src/app.js",
        beforeSha256: FILE_BEFORE,
        afterSha256: FILE_AFTER,
      }],
      deleted: [],
    },
    completedActionId: "complete-action-1",
    content: "raw read content",
    stdout: "raw stdout",
    stderr: "raw stderr",
  };
  return updateCodeJobLifecycle(active, {
    status: "completed",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      result: {
        kind: "completed",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function pausedJob() {
  const queued = queuedJob();
  return updateCodeJobLifecycle(queued, {
    status: "paused",
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      ...queued.execution,
      pause: {
        from: "queued",
        reason: "Waiting for owner guidance at C:\\private\\notes.txt",
        at: "2026-08-02T06:01:00.000Z",
      },
    },
  });
}

function resumedJob() {
  const paused = pausedJob();
  return updateCodeJobLifecycle(paused, {
    status: "queued",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: { ...paused.execution, pause: null },
  });
}

function unknownJob() {
  const active = observedJob();
  const action = {
    type: "list_files",
    actionId: "list-action-2",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
    path: ".",
  };
  return updateCodeJobLifecycle(active, {
    status: "unknown",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      pendingAction: {
        turn: 2,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-02T06:02:00.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest: digestValue(action),
        epoch: 3,
        admittedAt: "2026-08-02T06:02:00.000Z",
      },
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "Executor result at C:\\private\\workspace is unknown",
        at: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function reconciledJob() {
  const unknown = unknownJob();
  const pending = unknown.execution.pendingAction;
  const detail = {
    schemaVersion: 1,
    executor: { actionStatus: "interrupted" },
    result: { files: [], stdout: "raw recovery output" },
  };
  return updateCodeJobLifecycle(unknown, {
    status: "active",
    revision: 4,
    updatedAt: "2026-08-02T06:03:00.000Z",
    execution: {
      ...unknown.execution,
      turn: 2,
      pendingAction: null,
      actionAdmission: null,
      uncertainty: null,
      observations: [
        ...unknown.execution.observations,
        {
          turn: 2,
          actionId: pending.actionId,
          actionType: pending.action.type,
          actionDigest: pending.actionDigest,
          action: pending.action,
          status: "interrupted",
          workspaceRevision: WORKSPACE_REVISION,
          detail,
          detailDigest: digestValue(detail),
          recordedAt: "2026-08-02T06:03:00.000Z",
        },
      ],
    },
  });
}

function terminalJob(kind) {
  const queued = queuedJob();
  const detail = {
    schemaVersion: 1,
    code: kind === "failed" ? "CODE_JOB_FAILED" : "CODE_JOB_FENCED",
    message: `Do not expose token=${kind}`,
  };
  return updateCodeJobLifecycle(queued, {
    status: kind,
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      ...queued.execution,
      result: {
        kind,
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      },
    },
  });
}

function cancellingJob() {
  const unknown = unknownJob();
  const detail = {
    schemaVersion: 1,
    outcome: "cancelled",
    code: "CODE_JOB_CANCELLED",
    message: "代码任务已按用户请求取消",
    reason: "用户不再需要这项任务",
    requestedFrom: "unknown",
  };
  return updateCodeJobLifecycle(unknown, {
    status: "cancelling",
    revision: 4,
    updatedAt: "2026-08-02T06:03:00.000Z",
    execution: {
      ...unknown.execution,
      result: {
        kind: "cancelled",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:03:00.000Z",
      },
    },
  });
}

function cancelledJob() {
  const cancelling = cancellingJob();
  return updateCodeJobLifecycle(cancelling, {
    status: "cancelled",
    revision: 5,
    updatedAt: "2026-08-02T06:04:00.000Z",
    execution: {
      ...cancelling.execution,
      pendingAction: null,
      actionAdmission: null,
      pause: null,
      uncertainty: null,
    },
  });
}

test("creates a content-addressed safe Code Job memory event", () => {
  const job = completedJob();
  const event = createCodeJobMemoryEvent({
    sequence: 2,
    previousDigest: "f".repeat(64),
    job,
    kind: "completed",
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.jobId, job.jobId);
  assert.equal(event.jobRevision, job.revision);
  assert.equal(event.sourceRecordDigest, job.recordDigest);
  assert.equal(event.eventId, `code-job-memory-event-${event.eventDigest}`);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);

  const rawRecord = memoryRecordForCodeJobEvent(event);
  assert.deepEqual(Object.keys(rawRecord), [
    "schemaVersion",
    "source",
    "occurredAt",
    "roleId",
    "repository",
    "eventType",
    "title",
    "summary",
    "content",
    "evidence",
    "tags",
    "sourceUrl",
    "subjectNumber",
  ]);
  assert.equal(
    rawRecord.source.id,
    codeJobMemorySourceId(job.jobId, job.recordDigest),
  );
  assert.equal(rawRecord.source.kind, "code_job");
  assert.doesNotThrow(() => normalizeMemoryRecord(rawRecord));
  const serialized = JSON.stringify(rawRecord);
  for (const forbidden of [
    "Never project this prompt",
    "super-secret",
    "terminal-secret",
    "raw read content",
    "raw stdout",
    "raw stderr",
    "C:\\\\private",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /src\/app\.js/);
  assert.match(serialized, /node-tests/);
  assert.match(serialized, new RegExp(job.execution.result.detailDigest));
});

test("normalization rejects extra fields, accessors, cycles, and digest tampering", () => {
  const input = {
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
    kind: "completed",
  };
  const event = createCodeJobMemoryEvent(input);

  assert.throws(
    () => createCodeJobMemoryEvent({ ...input, extra: true }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  const inputAccessor = { ...input };
  Object.defineProperty(inputAccessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("input getter must not run");
    },
  });
  assert.throws(
    () => createCodeJobMemoryEvent(inputAccessor),
    (error) =>
      error?.code === "INVALID_CODE_JOB_MEMORY_EVENT" &&
      !/input getter must not run/.test(error.message),
  );

  assert.throws(
    () => normalizeCodeJobMemoryEvent({ ...event, extra: true }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  const accessor = { ...event };
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  assert.throws(
    () => normalizeCodeJobMemoryEvent(accessor),
    (error) =>
      error?.code === "INVALID_CODE_JOB_MEMORY_EVENT" &&
      !/getter must not run/.test(error.message),
  );
  const cyclicRecord = { ...event.memoryRecord };
  cyclicRecord.source = cyclicRecord;
  assert.throws(
    () => normalizeCodeJobMemoryEvent({ ...event, memoryRecord: cyclicRecord }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  assert.throws(
    () => normalizeCodeJobMemoryEvent({
      ...event,
      memoryRecord: { ...event.memoryRecord, summary: "forged summary" },
    }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
});

test("v2 memory events preserve exact PR Head evidence and reject binding tampering", () => {
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(inputBinding()),
    kind: "completed",
  });
  const record = memoryRecordForCodeJobEvent(event);
  const snapshot = JSON.parse(record.content);

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.repository, "acme/widgets");
  assert.equal(snapshot.subjectNumber, 17);
  assert.deepEqual(snapshot.inputBinding, inputBinding());
  assert.equal(snapshot.inputBinding.headRefOid, HEAD_REF_OID);
  assert.equal(record.evidence.includes(`pr-head:${HEAD_REF_OID}`), true);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);

  const headTampered = structuredClone(event);
  const headSnapshot = JSON.parse(headTampered.memoryRecord.content);
  headSnapshot.inputBinding.headRefOid = "7".repeat(40);
  headTampered.memoryRecord.content = JSON.stringify(headSnapshot);

  const repositoryMismatch = structuredClone(event);
  const repositorySnapshot = JSON.parse(repositoryMismatch.memoryRecord.content);
  repositorySnapshot.inputBinding.repository = "acme/other";
  repositoryMismatch.memoryRecord.content = JSON.stringify(repositorySnapshot);

  const pullRequestMismatch = structuredClone(event);
  const pullRequestSnapshot = JSON.parse(pullRequestMismatch.memoryRecord.content);
  pullRequestSnapshot.inputBinding.pullRequestNumber = 18;
  pullRequestMismatch.memoryRecord.content = JSON.stringify(pullRequestSnapshot);

  for (const candidate of [
    headTampered,
    repositoryMismatch,
    pullRequestMismatch,
  ]) {
    assert.throws(
      () => normalizeCodeJobMemoryEvent(candidate),
      (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
    );
  }
});

test("legacy memory events remain readable without an input binding", () => {
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
    kind: "completed",
  });
  const snapshot = JSON.parse(memoryRecordForCodeJobEvent(event).content);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(Object.hasOwn(snapshot, "inputBinding"), false);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);
});

test("classifies significant lifecycle changes without looping on projection ack", () => {
  const queued = queuedJob();
  const active = observedJob();
  const completed = completedJob();

  assert.equal(classifyCodeJobMemoryEvent(null, queued), null);
  assert.equal(classifyCodeJobMemoryEvent(null, active), "observation");
  assert.equal(classifyCodeJobMemoryEvent(queued, active), "observation");
  assert.equal(classifyCodeJobMemoryEvent(active, completed), "completed");
  assert.equal(classifyCodeJobMemoryEvent(null, completed), "completed");
  assert.equal(classifyCodeJobMemoryEvent(completed, completed), null);
});

test("classifies and creates every supported lifecycle event kind", () => {
  const queued = queuedJob();
  const active = observedJob();
  const paused = pausedJob();
  const resumed = resumedJob();
  const unknown = unknownJob();
  const reconciled = reconciledJob();
  const failed = terminalJob("failed");
  const fenced = terminalJob("fenced");
  const cancelling = cancellingJob();
  const cancelled = cancelledJob();
  const cases = [
    [null, active, "observation"],
    [queued, paused, "paused"],
    [paused, resumed, "resumed"],
    [active, unknown, "unknown"],
    [unknown, reconciled, "reconciled"],
    [unknown, cancelling, "cancelling"],
    [cancelling, cancelled, "cancelled"],
    [queued, failed, "failed"],
    [queued, fenced, "fenced"],
  ];

  for (const [previous, next, kind] of cases) {
    assert.equal(classifyCodeJobMemoryEvent(previous, next), kind);
    const event = createCodeJobMemoryEvent({
      sequence: 1,
      previousDigest: null,
      job: next,
      kind,
    });
    assert.equal(event.kind, kind);
    assert.doesNotThrow(() => normalizeCodeJobMemoryEvent(event));
    if (kind === "cancelling") {
      assert.equal(JSON.parse(event.memoryRecord.content).terminal, null);
    }
    if (kind === "cancelled") {
      assert.equal(event.occurredAt, "2026-08-02T06:04:00.000Z");
      assert.equal(
        JSON.parse(event.memoryRecord.content).terminal.recordedAt,
        "2026-08-02T06:04:00.000Z",
      );
    }
  }
});
