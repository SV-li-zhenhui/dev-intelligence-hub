import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
} from "../src/services/code-job-store.js";

class MemoryStore {
  constructor(value = null) {
    this.values = new Map();
    if (value !== null) {
      this.values.set(CODE_JOB_STATE_KEY, structuredClone(value));
    }
    this.writeCount = 0;
    this.writeThenFailAt = null;
    this.lastWriteName = null;
  }

  get value() {
    const value = this.values.get(CODE_JOB_STATE_KEY);
    return value === undefined ? null : value;
  }

  set value(value) {
    if (value === null) {
      this.values.delete(CODE_JOB_STATE_KEY);
      return;
    }
    this.values.set(CODE_JOB_STATE_KEY, structuredClone(value));
  }

  async read(name, fallback) {
    const value = this.values.get(name);
    return structuredClone(value === undefined ? fallback : value);
  }

  async write(name, value) {
    this.writeCount += 1;
    this.lastWriteName = name;
    this.values.set(name, structuredClone(value));
    if (this.writeCount === this.writeThenFailAt) {
      throw new Error("disk acknowledgement unavailable");
    }
  }
}

class ExclusiveLease {
  constructor() {
    this.runCount = 0;
  }

  run(operation) {
    this.runCount += 1;
    return operation();
  }
}

function manualClock(initial = "2026-08-02T06:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function grantInput(overrides = {}) {
  return {
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
    objective: "Find the retry race without changing source files.",
    acceptanceCriteria: ["The race is identified with file evidence."],
    evidence: ["CI intermittently reports a stale revision."],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
    ...overrides,
  };
}

function grant(overrides = {}) {
  return createCodeJobGrant(grantInput(overrides));
}

function approval(overrides = {}) {
  return {
    confirmationId: "confirmation-code-job-approval-1",
    requestId: "approval-request-0001",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant: grant(),
    ...overrides,
  };
}

function memoryProjection(job, digest = "9".repeat(64)) {
  return {
    jobId: job.jobId,
    expectedRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
    memoryRecordId: `memory-${digest}`,
    memoryRecordDigest: digest,
  };
}

function compactionRequest(
  store,
  { compactionId = "code-job-compaction-test", targetThroughSequence } = {},
) {
  return {
    compactionId,
    expectedRevision: store.value.revision,
    targetThroughSequence,
    preArchiveDigest: store.value.archive.digest,
  };
}

async function readyStore({
  store = new MemoryStore(),
  time = manualClock(),
  limits,
  memoryReceiptVerifier = {
    async verify(value) {
      return { ...structuredClone(value), persisted: true };
    },
  },
} = {}) {
  const exclusiveLease = new ExclusiveLease();
  const jobs = new CodeJobStore({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
    clock: time.clock,
    memoryReceiptVerifier,
    ...(limits ? { limits } : {}),
  });
  await jobs.recover();
  return { jobs, store, time, exclusiveLease };
}

async function preparedActionFixture(actionId) {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const starting = await fixture.jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await fixture.jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await fixture.jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "list_files",
      actionId,
      expectedWorkspaceRevision: "4".repeat(64),
      path: "",
    },
  });
  return { ...fixture, created, prepared };
}

test("grant sealing is canonical, deterministic, and enforces the operation matrix", () => {
  const first = grant({
    allowedActions: [
      "complete",
      "run_profile",
      "search_text",
      "read_text",
      "list_files",
    ],
    requiredProfiles: [
      { id: "typecheck", configDigest: "f".repeat(64) },
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
  });
  const second = grant({
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
      { id: "typecheck", configDigest: "f".repeat(64) },
    ],
  });

  assert.deepEqual(first.allowedActions, CODE_JOB_ACTIONS_BY_OPERATION.inspect);
  assert.deepEqual(
    first.requiredProfiles.map(({ id }) => id),
    ["node-tests", "typecheck"],
  );
  assert.equal(first.grantDigest, second.grantDigest);
  assert.equal(codeJobIdForGrant(first), codeJobIdForGrant(second));
  assert.equal(codeJobIdForGrant(first).length, 64);
  assert.match(codeJobIdForGrant(first), /^code-job-[a-f0-9]{55}$/);

  assert.throws(
    () =>
      grant({
        allowedActions: [
          ...CODE_JOB_ACTIONS_BY_OPERATION.inspect,
          "write_text",
        ],
      }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
  assert.throws(
    () =>
      grant({
        operation: "modify",
        allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
        writablePaths: [],
      }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
  assert.throws(
    () => normalizeCodeJobGrant({ ...first, grantDigest: "0".repeat(64) }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
});

test("createApprovedJob persists one queued job with all four digest bindings", async () => {
  const { jobs, store, exclusiveLease } = await readyStore();
  const request = approval();
  const created = await jobs.createApprovedJob(request);

  assert.equal(created.status, "applied");
  assert.equal(created.receipt.id, codeJobIdForGrant(request.grant));
  assert.equal(created.receipt.id.length, 64);
  assert.equal(created.job.status, "queued");
  assert.equal(store.lastWriteName, CODE_JOB_STATE_KEY);
  assert.equal(store.writeCount, 1);
  assert.equal(exclusiveLease.runCount, 2);

  const durable = store.value.jobs[0];
  assert.equal(durable.status, "queued");
  assert.equal(
    durable.approval.displayedPayloadDigest,
    request.displayedPayloadDigest,
  );
  assert.equal(
    durable.approval.approvalBindingDigest,
    request.approvalBindingDigest,
  );
  assert.equal(durable.proposal.contentDigest, request.grant.contentDigest);
  assert.equal(durable.grant.grantDigest, request.grant.grantDigest);
  assert.match(durable.recordDigest, /^[a-f0-9]{64}$/);
});

test("approval retries with a new requestId converge on the same durable job", async () => {
  const { jobs, store } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const repeated = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-0002" }),
  );

  assert.equal(repeated.status, "already");
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.equal(repeated.job.jobId, first.job.jobId);
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
  assert.equal(store.value.jobs[0].approval.requestId, "approval-request-0001");
});

test("same proposal fails closed when approval or grant binding differs", async () => {
  const { jobs, store } = await readyStore();
  await jobs.createApprovedJob(approval());

  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-0002",
        approvalBindingDigest: "f".repeat(64),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-0003",
        grant: grant({ summary: "A different authorized task" }),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
});

test("get and list return newest browser-safe copies", async () => {
  const { jobs } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
    subject: {
      id: "github:acme/widgets:pull-request:18",
      repository: "acme/widgets",
      number: 18,
    },
  });
  const second = await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: secondGrant,
    }),
  );

  const newest = await jobs.list({
    limit: "1",
    order: "newest",
    status: "queued",
  });
  assert.equal(newest.revision, 2);
  assert.equal(newest.total, 2);
  assert.equal(newest.items[0].jobId, second.job.jobId);
  assert.equal(newest.nextCursor, second.job.jobId);
  assert.equal(first.job.createdAt, second.job.createdAt);
  const older = await jobs.list({
    limit: "1",
    order: "newest",
    cursor: newest.nextCursor,
  });
  assert.equal(older.items[0].jobId, first.job.jobId);
  assert.equal(older.nextCursor, null);
  assert.equal((await jobs.listNewest()).items[1].jobId, first.job.jobId);

  const found = await jobs.get(first.job.jobId);
  assert.equal(found.jobId, first.job.jobId);
  assert.equal(found.requiredProfiles[0], "node-tests");
  assert.deepEqual(Object.keys(found), [
    "jobId",
    "status",
    "revision",
    "proposalId",
    "proposalContentDigest",
    "grantDigest",
    "requestedBy",
    "subject",
    "repository",
    "workspaceId",
    "operation",
    "objective",
    "acceptanceCriteria",
    "evidence",
    "summary",
    "reason",
    "allowedActions",
    "writablePaths",
    "requiredProfiles",
    "turn",
    "pendingActionType",
    "observationCount",
    "latestObservation",
    "terminalResult",
    "memoryProjection",
    "pause",
    "uncertainty",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal("approval" in found, false);
  assert.equal("requestId" in found, false);
  assert.equal("recordDigest" in found, false);
  assert.equal("brainDigest" in found, false);
  assert.equal(JSON.stringify(found).includes("configDigest"), false);
  found.acceptanceCriteria[0] = "tampered in browser";
  assert.notEqual(
    (await jobs.get(first.job.jobId)).acceptanceCriteria[0],
    "tampered in browser",
  );
  assert.equal(await jobs.get(`code-job-${"f".repeat(55)}`), null);
});

test("worker candidate cursors rotate bounded runnable work without starvation", async () => {
  const { jobs } = await readyStore();
  const created = [];
  for (const index of [1, 2, 3]) {
    const sealedGrant = grant({
      proposalId: `work-intent-cursor-${index}`,
      contentDigest: String(index).repeat(64),
      requestedBy: { roleId: "developer", workItemId: `cursor-work-${index}` },
      source: {
        assignmentId: `cursor-assignment-${index}`,
        eventId: `cursor-event-${index}`,
      },
      subject: {
        id: `github:acme/widgets:pull-request:${20 + index}`,
        repository: "acme/widgets",
        number: 20 + index,
      },
      summary: `Inspect retry race ${index}`,
    });
    const result = await jobs.createApprovedJob(
      approval({
        confirmationId: `confirmation-code-job-cursor-${index}`,
        requestId: `cursor-approval-request-${index}`,
        displayedPayloadDigest: String(index + 3).repeat(64),
        approvalBindingDigest: String(index + 6).repeat(64),
        grant: sealedGrant,
      }),
    );
    created.push(await jobs.getForWorker(result.job.jobId));
  }

  const middle = await jobs.listRunnable({
    limit: 2,
    afterSequence: created[0].sequence,
  });
  assert.deepEqual(
    middle.items.map(({ sequence }) => sequence),
    [created[1].sequence, created[2].sequence],
  );
  const wrapped = await jobs.listRunnable({
    limit: 2,
    afterSequence: created[2].sequence,
  });
  assert.deepEqual(
    wrapped.items.map(({ sequence }) => sequence),
    [created[0].sequence, created[1].sequence],
  );
  assert.throws(
    () => jobs.listRunnable({ afterSequence: -1 }),
    (error) => error.code === "INVALID_CODE_JOB_QUERY",
  );
});

test("durable state recovers and rejects tampering before serving queries", async () => {
  const store = new MemoryStore();
  const first = await readyStore({ store });
  const created = await first.jobs.createApprovedJob(approval());
  const recovered = await readyStore({ store });
  assert.equal((await recovered.jobs.get(created.job.jobId)).status, "queued");

  store.value.jobs[0].grant.grantDigest = "0".repeat(64);
  await assert.rejects(
    recovered.jobs.createApprovedJob(approval()),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  await assert.rejects(
    recovered.jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
  const broken = new CodeJobStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("append sequence detects deleted approvals and forged revision gaps", async () => {
  const source = new MemoryStore();
  const { jobs } = await readyStore({ store: source });
  await jobs.createApprovedJob(approval());
  await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: grant({
        proposalId: "work-intent-proposal-2",
        contentDigest: "1".repeat(64),
        requestedBy: { roleId: "tester", workItemId: "work-2" },
        source: { assignmentId: "assignment-2", eventId: "event-2" },
      }),
    }),
  );

  const withoutFirst = structuredClone(source.value);
  withoutFirst.jobs.shift();
  withoutFirst.nextJobSequence = 2;
  const withoutLatest = structuredClone(source.value);
  withoutLatest.jobs.pop();
  withoutLatest.nextJobSequence = 2;
  const forgedEmpty = {
    schemaVersion: 1,
    revision: 5,
    nextJobSequence: 1,
    jobs: [],
  };
  for (const value of [withoutFirst, withoutLatest, forgedEmpty]) {
    await assert.rejects(
      readyStore({ store: new MemoryStore(value) }),
      (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
    );
  }
});

test("failed or rolled-back repeated recovery leaves the store unavailable", async () => {
  const durable = new MemoryStore();
  const { jobs } = await readyStore({ store: durable });
  await jobs.createApprovedJob(approval());

  durable.value = { invalid: true };
  await assert.rejects(
    jobs.recover(),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  await assert.rejects(
    jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );

  durable.value = {
    schemaVersion: 1,
    revision: 0,
    nextJobSequence: 1,
    jobs: [],
  };
  await assert.rejects(
    jobs.recover(),
    (error) => error.code === "CODE_JOB_STATE_ROLLBACK",
  );
  await assert.rejects(
    jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
});

test("a persisted job is returned as already after write acknowledgement loss", async () => {
  const store = new MemoryStore();
  const { jobs } = await readyStore({ store });
  store.writeThenFailAt = 1;

  await assert.rejects(
    jobs.createApprovedJob(approval()),
    /disk acknowledgement unavailable/,
  );
  assert.equal(store.value.jobs.length, 1);
  const recovered = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-0002" }),
  );
  assert.equal(recovered.status, "already");
  assert.equal(store.writeCount, 1);
  assert.equal(
    (await jobs.reconcileApprovedJob(
      approval({ requestId: "approval-request-0003" }),
    )).status,
    "already",
  );
});

test("approval reconciliation distinguishes exact absence from conflicts", async () => {
  const { jobs } = await readyStore();
  assert.deepEqual(await jobs.reconcileApprovedJob(approval()), {
    status: "absent",
  });
  await jobs.createApprovedJob(approval());
  await assert.rejects(
    jobs.reconcileApprovedJob(
      approval({ approvalBindingDigest: "f".repeat(64) }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
});

test("concurrent exact approvals serialize through the injected queue and lease", async () => {
  const { jobs, store } = await readyStore();
  const results = await Promise.all([
    jobs.createApprovedJob(approval()),
    jobs.createApprovedJob(approval({ requestId: "approval-request-0002" })),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["already", "applied"],
  );
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
});

test("capacity and lifecycle guards do not mutate accepted durable state", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 1 } });
  await jobs.createApprovedJob(approval());
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
  });
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        confirmationId: "confirmation-code-job-approval-2",
        requestId: "approval-request-0002",
        displayedPayloadDigest: "2".repeat(64),
        approvalBindingDigest: "3".repeat(64),
        grant: secondGrant,
      }),
    ),
    (error) => error.code === "CODE_JOB_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.jobs.length, 1);

  const cold = new CodeJobStore({
    store: new MemoryStore(),
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    cold.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
  assert.throws(
    () =>
      new CodeJobStore({
        store: new MemoryStore(),
        exclusiveLease: new ExclusiveLease(),
      }),
    /operationQueue is invalid/,
  );
});

test("worker lifecycle persists deterministic session, pending action, and observations", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;

  const starting = await jobs.claimStarting({
    jobId,
    expectedRevision: created.job.revision,
  });
  assert.equal(starting.status, "applied");
  assert.equal(starting.job.status, "starting");
  assert.equal(starting.job.execution.sessionId, jobId);
  assert.equal(
    (await jobs.claimStarting({ jobId, expectedRevision: 1 })).status,
    "already",
  );

  const initialWorkspaceRevision = "4".repeat(64);
  const active = await jobs.activate({
    jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: initialWorkspaceRevision,
  });
  assert.equal(active.job.status, "active");
  await assert.rejects(
    jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action: {
        type: "write_text",
        actionId: "unauthorized-write",
        expectedWorkspaceRevision: initialWorkspaceRevision,
        path: "src/index.js",
        content: "not authorized",
        expectedSha256: null,
      },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  await assert.rejects(
    jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action: {
        type: "run_profile",
        actionId: "unknown-profile",
        expectedWorkspaceRevision: initialWorkspaceRevision,
        profileId: "untrusted-check",
      },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const action = {
    type: "list_files",
    actionId: "turn-1-list",
    expectedWorkspaceRevision: initialWorkspaceRevision,
    path: "",
  };
  const prepared = await jobs.prepareAction({
    jobId,
    expectedRevision: active.job.revision,
    action,
  });
  assert.equal(prepared.job.execution.pendingAction.actionId, "turn-1-list");
  assert.deepEqual(prepared.job.execution.pendingAction.action, action);
  assert.equal(
    (await jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action,
    })).status,
    "already",
  );

  const workerSnapshot = await jobs.getForWorker(jobId);
  assert.equal(workerSnapshot.grant.grantDigest, approval().grant.grantDigest);
  assert.equal(workerSnapshot.execution.pendingAction.actionId, "turn-1-list");
  const observed = await jobs.recordObservation({
    jobId,
    expectedRevision: prepared.job.revision,
    actionId: action.actionId,
    status: "succeeded",
    workspaceRevision: initialWorkspaceRevision,
    detail: { files: ["src/index.js"], truncated: false },
  });
  assert.equal(observed.job.execution.turn, 1);
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.observations[0].actionType, "list_files");
  assert.equal(observed.job.execution.observations[0].status, "succeeded");
  assert.match(
    observed.job.execution.observations[0].detailDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    (await jobs.recordObservation({
      jobId,
      expectedRevision: prepared.job.revision,
      actionId: action.actionId,
      status: "succeeded",
      workspaceRevision: initialWorkspaceRevision,
      detail: { truncated: false, files: ["src/index.js"] },
    })).status,
    "already",
  );

  const browser = await jobs.get(jobId);
  assert.equal(browser.turn, 1);
  assert.equal(browser.observationCount, 1);
  assert.equal(browser.latestObservation.actionType, "list_files");
  assert.equal("execution" in browser, false);
  assert.equal(JSON.stringify(browser).includes("turn-1-list"), false);
  assert.equal(store.value.jobs[0].execution.observations.length, 1);
});

test("lifecycle CAS rejects stale divergence and acknowledgement loss retries converge", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;
  store.writeThenFailAt = 2;

  await assert.rejects(
    jobs.claimStarting({ jobId, expectedRevision: created.job.revision }),
    /disk acknowledgement unavailable/,
  );
  const reconciled = await jobs.claimStarting({
    jobId,
    expectedRevision: created.job.revision,
  });
  assert.equal(reconciled.status, "already");
  assert.equal(reconciled.job.status, "starting");

  await assert.rejects(
    jobs.activate({
      jobId,
      expectedRevision: created.job.revision,
      workspaceRevision: "4".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_REVISION_CONFLICT",
  );
  const active = await jobs.activate({
    jobId,
    expectedRevision: reconciled.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  await assert.rejects(
    jobs.activate({
      jobId,
      expectedRevision: active.job.revision,
      workspaceRevision: "5".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
});

test("pause and resume preserve a prepared trusted action for exact retry", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const paused = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    reason: "等待用户检查执行上下文",
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.pause.from, "active");
  assert.equal(paused.job.execution.pendingAction.actionId, "turn-1-read");
  assert.equal((await jobs.listRunnable()).items.length, 0);

  const resumed = await jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: paused.job.revision,
  });
  assert.equal(resumed.job.status, "active");
  assert.equal(resumed.job.execution.pendingAction.actionId, "turn-1-read");
  assert.equal((await jobs.listRunnable()).items[0].jobId, created.job.jobId);
  assert.equal(
    (await jobs.listRunnable({ roleId: "developer", limit: 1 })).items[0]
      .jobId,
    created.job.jobId,
  );
  assert.equal((await jobs.listRunnable({ roleId: "tester" })).items.length, 0);
  assert.throws(
    () => jobs.listRunnable({ roleId: "Developer" }),
    (error) => error.code === "INVALID_CODE_JOB_QUERY",
  );
  assert.equal(
    (await jobs.resume({
      jobId: created.job.jobId,
      expectedRevision: paused.job.revision,
    })).status,
    "already",
  );
});

test("an admitted action keeps pause in pausing until its result is recorded", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-admitted-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  assert.equal(
    admitted.job.execution.actionAdmission.epoch,
    admitted.job.revision,
  );

  const pausing = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    reason: "等待已入场动作安全结束",
  });
  assert.equal(pausing.job.status, "pausing");
  assert.equal(pausing.job.execution.pause.from, "active");
  assert.equal((await jobs.listRunnable()).items[0].status, "pausing");
  await assert.rejects(
    jobs.resume({
      jobId: created.job.jobId,
      expectedRevision: pausing.job.revision,
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );

  const recovered = await readyStore({ store });
  const recoveredPausing = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(recoveredPausing.status, "pausing");
  assert.deepEqual(
    recoveredPausing.execution.actionAdmission,
    pausing.job.execution.actionAdmission,
  );
  assert.equal(
    (await recovered.jobs.listRunnable()).items[0].status,
    "pausing",
  );

  const observed = await recovered.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: recoveredPausing.revision,
    actionId: pending.actionId,
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: {
      result: {
        path: "src/index.js",
        content: "export const value = 1;\n",
      },
    },
  });
  assert.equal(observed.job.status, "paused");
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.actionAdmission, null);
  assert.equal(observed.job.execution.turn, 1);

  const resumed = await recovered.jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
  });
  assert.equal(resumed.job.status, "active");
});

test("an admitted action cannot be failed or fenced before reconciliation", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-terminal-guard",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });

  for (const finish of ["fail", "fence"]) {
    await assert.rejects(
      jobs[finish]({
        jobId: created.job.jobId,
        expectedRevision: admitted.job.revision,
        result: { code: "UNSAFE_TERMINAL_TRANSITION" },
      }),
      (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
    );
  }
  const unchanged = await jobs.getForWorker(created.job.jobId);
  assert.equal(unchanged.status, "active");
  assert.equal(unchanged.execution.pendingAction.actionId, pending.actionId);
  assert.equal(
    unchanged.execution.actionAdmission.actionDigest,
    pending.actionDigest,
  );
});

test("an absent uncertain action returns to its requested pause before re-admission", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-absent-retry",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  const firstEpoch = admitted.job.execution.actionAdmission.epoch;
  const pausing = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    reason: "确认动作没有进入执行器",
  });
  const unknown = await jobs.markActionUnknown({
    jobId: created.job.jobId,
    expectedRevision: pausing.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: firstEpoch,
    code: "EXECUTOR_RECEIPT_UNKNOWN",
    message: "执行器结果待对账",
  });
  assert.equal(unknown.job.status, "unknown");
  assert.equal(unknown.job.execution.pause.reason, "确认动作没有进入执行器");
  assert.deepEqual(unknown.job.execution.uncertainty, {
    from: "pausing",
    code: "EXECUTOR_RECEIPT_UNKNOWN",
    message: "执行器结果待对账",
    at: unknown.job.updatedAt,
  });

  const paused = await jobs.acknowledgeAbsentAction({
    jobId: created.job.jobId,
    expectedRevision: unknown.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: firstEpoch,
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.actionAdmission, null);
  assert.equal(paused.job.execution.uncertainty, null);
  assert.equal(paused.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal((await jobs.listRunnable()).items.length, 0);

  const resumed = await jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: paused.job.revision,
  });
  const readmitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: resumed.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  assert.equal(readmitted.job.status, "active");
  assert.ok(readmitted.job.execution.actionAdmission.epoch > firstEpoch);
});

test("an uncertain admitted action is durable and isolated from normal runnable work", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-unknown-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  const admission = admitted.job.execution.actionAdmission;
  const unknown = await jobs.markActionUnknown({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    actionId: admission.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
    code: "EXECUTION_FENCED",
    message: "执行结果待对账",
  });
  assert.equal(unknown.job.status, "unknown");
  assert.equal(unknown.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal(unknown.job.execution.pause, null);
  assert.deepEqual(unknown.job.execution.uncertainty, {
    from: "active",
    code: "EXECUTION_FENCED",
    message: "执行结果待对账",
    at: unknown.job.updatedAt,
  });
  assert.equal((await jobs.listRunnable()).items.length, 0);
  assert.equal((await jobs.listReconcilable()).items[0].jobId, created.job.jobId);
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.uncertainty, unknown.job.execution.uncertainty);
  assert.equal(browser.pause, null);

  const recovered = await readyStore({ store });
  const durable = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(durable.status, "unknown");
  assert.deepEqual(
    durable.execution.uncertainty,
    unknown.job.execution.uncertainty,
  );
  assert.equal((await recovered.jobs.listRunnable()).items.length, 0);
  assert.equal((await recovered.jobs.listReconcilable()).items.length, 1);

  await assert.rejects(
    recovered.jobs.recordObservation({
      jobId: created.job.jobId,
      expectedRevision: durable.revision,
      actionId: pending.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch + 1,
      status: "succeeded",
      workspaceRevision: "4".repeat(64),
      detail: { result: { path: "src/index.js", content: "stale\n" } },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );

  const observed = await recovered.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: durable.revision,
    actionId: pending.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { result: { path: "src/index.js", content: "safe\n" } },
  });
  assert.equal(observed.job.status, "active");
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.actionAdmission, null);
  assert.equal(observed.job.execution.uncertainty, null);
  assert.equal((await recovered.jobs.listReconcilable()).items.length, 0);
});

test("starting session admission pauses only after absence or activation is reconciled", async () => {
  const absentFixture = await readyStore();
  const absentCreated = await absentFixture.jobs.createApprovedJob(approval());
  const absentStarting = await absentFixture.jobs.claimStarting({
    jobId: absentCreated.job.jobId,
    expectedRevision: absentCreated.job.revision,
  });
  const pausingAbsent = await absentFixture.jobs.pause({
    jobId: absentCreated.job.jobId,
    expectedRevision: absentStarting.job.revision,
    reason: "暂停工作区创建",
  });
  assert.equal(pausingAbsent.job.status, "pausing");
  assert.equal(pausingAbsent.job.execution.pause.from, "starting");
  const absent = await absentFixture.jobs.acknowledgeAbsentSession({
    jobId: absentCreated.job.jobId,
    expectedRevision: pausingAbsent.job.revision,
  });
  assert.equal(absent.job.status, "paused");
  assert.equal(absent.job.execution.pause.from, "starting");
  assert.equal(absent.job.execution.workspaceRevision, null);
  assert.equal(
    (await absentFixture.jobs.resume({
      jobId: absent.job.jobId,
      expectedRevision: absent.job.revision,
    })).job.status,
    "starting",
  );

  const activeFixture = await readyStore();
  const activeCreated = await activeFixture.jobs.createApprovedJob(
    approval({ requestId: "approval-request-start-active" }),
  );
  const activeStarting = await activeFixture.jobs.claimStarting({
    jobId: activeCreated.job.jobId,
    expectedRevision: activeCreated.job.revision,
  });
  const pausingActive = await activeFixture.jobs.pause({
    jobId: activeCreated.job.jobId,
    expectedRevision: activeStarting.job.revision,
    reason: "等待工作区创建完成",
  });
  const activated = await activeFixture.jobs.acknowledgeStartedSession({
    jobId: activeCreated.job.jobId,
    expectedRevision: pausingActive.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  assert.equal(activated.job.status, "paused");
  assert.equal(activated.job.execution.pause.from, "active");
  assert.equal(activated.job.execution.workspaceRevision, "4".repeat(64));
  assert.equal(
    (await activeFixture.jobs.resume({
      jobId: activated.job.jobId,
      expectedRevision: activated.job.revision,
    })).job.status,
    "active",
  );
});

test("schema v5 explicit null admission remains prepared but not admitted", async () => {
  const fixture = await preparedActionFixture("v5-prepared-action");
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 5;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const { uncertainty: _uncertainty, ...execution } = jobValue.execution;
    const content = { ...jobValue, execution };
    delete content.recordDigest;
    return { ...content, recordDigest: digestValue(content) };
  });
  const store = new MemoryStore(legacy);
  const recovered = await readyStore({ store });

  const pending = await recovered.jobs.getForWorker(fixture.created.job.jobId);
  assert.equal(pending.status, "active");
  assert.equal(pending.execution.actionAdmission, null);
  assert.equal(pending.execution.uncertainty, null);
  await recovered.jobs.pause({
    jobId: pending.jobId,
    expectedRevision: pending.revision,
    reason: "迁移后暂停",
  });
  assert.equal(store.value.schemaVersion, 6);
});

test("schema v2 and v3 outer states recover and write back as v6", async (t) => {
  for (const schemaVersion of [2, 3]) {
    await t.test(`schema v${schemaVersion}`, async () => {
      const fixture = await readyStore();
      const created = await fixture.jobs.createApprovedJob(approval());
      const legacy = structuredClone(fixture.store.value);
      legacy.schemaVersion = schemaVersion;
      delete legacy.lastCompaction;
      if (schemaVersion === 2) delete legacy.archiveIndex;
      legacy.jobs = legacy.jobs.map((jobValue) => {
        if (schemaVersion === 2) {
          const { execution: _execution, recordDigest: _recordDigest, ...content } =
            jobValue;
          return { ...content, recordDigest: digestValue(content) };
        }
        const {
          memoryProjection: _memoryProjection,
          actionAdmission: _actionAdmission,
          uncertainty: _uncertainty,
          ...execution
        } = jobValue.execution;
        const content = { ...jobValue, execution };
        delete content.recordDigest;
        return { ...content, recordDigest: digestValue(content) };
      });
      const store = new MemoryStore(legacy);
      const recovered = await readyStore({ store });

      const pending = await recovered.jobs.getForWorker(created.job.jobId);
      assert.equal(pending.status, "queued");
      await recovered.jobs.pause({
        jobId: pending.jobId,
        expectedRevision: pending.revision,
        reason: `升级 schema v${schemaVersion}`,
      });

      assert.equal(store.value.schemaVersion, 6);
      assert.ok(Array.isArray(store.value.archiveIndex));
      assert.equal(Object.hasOwn(store.value, "lastCompaction"), true);
    });
  }
});

test("legacy pending actions migrate to explicit admitted uncertainty", async () => {
  const fixture = await preparedActionFixture("legacy-pending-action");
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 4;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const {
      actionAdmission: _actionAdmission,
      uncertainty: _uncertainty,
      ...execution
    } = jobValue.execution;
    const content = { ...jobValue, execution };
    delete content.recordDigest;
    return { ...content, recordDigest: digestValue(content) };
  });
  const store = new MemoryStore(legacy);
  const recovered = await readyStore({ store });

  const uncertain = await recovered.jobs.getForWorker(
    fixture.created.job.jobId,
  );
  const pending = uncertain.execution.pendingAction;
  const admission = uncertain.execution.actionAdmission;
  assert.equal(uncertain.status, "unknown");
  assert.deepEqual(admission, {
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: uncertain.revision,
    admittedAt: pending.preparedAt,
  });
  assert.deepEqual(uncertain.execution.uncertainty, {
    from: "active",
    code: "LEGACY_ACTION_RESULT_UNKNOWN",
    message: "Legacy pending action requires executor reconciliation",
    at: uncertain.updatedAt,
  });
  assert.equal(uncertain.execution.pause, null);

  const browser = await recovered.jobs.get(uncertain.jobId);
  assert.deepEqual(browser.uncertainty, uncertain.execution.uncertainty);
  const pausingUnknown = await recovered.jobs.pause({
    jobId: uncertain.jobId,
    expectedRevision: uncertain.revision,
    reason: "迁移后等待人工核验",
  });
  assert.equal(pausingUnknown.job.status, "unknown");
  assert.equal(pausingUnknown.job.execution.uncertainty.from, "pausing");
  assert.equal(
    pausingUnknown.job.execution.uncertainty.code,
    "LEGACY_ACTION_RESULT_UNKNOWN",
  );
  assert.equal(pausingUnknown.job.execution.pause.reason, "迁移后等待人工核验");

  const paused = await recovered.jobs.acknowledgeAbsentAction({
    jobId: uncertain.jobId,
    expectedRevision: pausingUnknown.job.revision,
    actionId: admission.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.uncertainty, null);
  assert.equal(paused.job.execution.actionAdmission, null);
  assert.equal(paused.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal(store.value.schemaVersion, 6);
});

test("terminal transitions are sealed, idempotent, and browser-safe", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const result = {
    summary: "Inspection completed",
    manifest: { workspaceRevision: "4".repeat(64), checks: ["node-tests"] },
  };
  await assert.rejects(
    jobs.complete({
      jobId: created.job.jobId,
      expectedRevision: active.job.revision,
      result,
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId: "turn-1-complete",
      expectedWorkspaceRevision: "4".repeat(64),
    },
  });
  const observed = await jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: "turn-1-complete",
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: result.manifest,
  });
  const completed = await jobs.complete({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
    result,
  });
  assert.equal(completed.job.status, "completed");
  assert.deepEqual(completed.job.execution.result.detail, result);
  assert.equal(
    (await jobs.complete({
      jobId: created.job.jobId,
      expectedRevision: observed.job.revision,
      result: { manifest: result.manifest, summary: result.summary },
    })).status,
    "already",
  );
  await assert.rejects(
    jobs.fail({
      jobId: created.job.jobId,
      expectedRevision: completed.job.revision,
      result: { code: "LATE_FAILURE" },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.terminalResult, {
    kind: "completed",
    recordedAt: completed.job.execution.result.recordedAt,
  });
  assert.equal(JSON.stringify(browser).includes("Inspection completed"), false);
});

test("memory projection receipt is exact, CAS-bound, and idempotent after acknowledgement loss", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const failed = await jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "BRAIN_UNAVAILABLE" },
  });
  const request = memoryProjection(failed.job);
  assert.throws(
    () =>
      jobs.markMemoryProjected({
        ...request,
        memoryRecordId: `memory-${"8".repeat(64)}`,
      }),
    (error) => error.code === "INVALID_CODE_JOB_MUTATION",
  );
  store.writeThenFailAt = store.writeCount + 1;
  await assert.rejects(
    jobs.markMemoryProjected(request),
    /disk acknowledgement unavailable/,
  );
  const repeated = await jobs.markMemoryProjected(request);
  assert.equal(repeated.status, "already");
  assert.equal(
    repeated.job.execution.memoryProjection.sourceRecordDigest,
    failed.job.recordDigest,
  );
  assert.equal(
    repeated.job.execution.memoryProjection.sourceRevision,
    failed.job.revision,
  );
  assert.equal(
    repeated.job.execution.memoryProjection.memoryRecordId,
    request.memoryRecordId,
  );
  await assert.rejects(
    jobs.markMemoryProjected({
      ...request,
      memoryRecordId: `memory-${"8".repeat(64)}`,
      memoryRecordDigest: "8".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_MEMORY_BINDING_CONFLICT",
  );
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.memoryProjection, {
    recordId: request.memoryRecordId,
    projectedAt: repeated.job.execution.memoryProjection.projectedAt,
  });
  assert.equal(JSON.stringify(browser).includes(failed.job.recordDigest), false);
});

test("schema v5 terminal digest and memory receipt recover without uncertainty", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const failed = await fixture.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "LEGACY_MEMORY_SOURCE" },
  });
  await fixture.jobs.markMemoryProjected(memoryProjection(failed.job));

  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 5;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const { recordDigest: _recordDigest, ...projectedContent } = jobValue;
    const receipt = projectedContent.execution.memoryProjection;
    const {
      uncertainty: _sourceUncertainty,
      ...sourceExecution
    } = {
      ...projectedContent.execution,
      memoryProjection: null,
    };
    const oldSourceContent = {
      ...projectedContent,
      revision: receipt.sourceRevision,
      updatedAt: receipt.sourceUpdatedAt,
      execution: sourceExecution,
    };
    const oldSourceRecordDigest = digestValue(oldSourceContent);
    const {
      uncertainty: _projectedUncertainty,
      ...projectedExecution
    } = projectedContent.execution;
    projectedExecution.memoryProjection = {
      ...projectedExecution.memoryProjection,
      sourceRecordDigest: oldSourceRecordDigest,
    };
    const oldProjectedContent = {
      ...projectedContent,
      execution: projectedExecution,
    };
    return {
      ...oldProjectedContent,
      recordDigest: digestValue(oldProjectedContent),
    };
  });

  const legacyReceipt = structuredClone(
    legacy.jobs[0].execution.memoryProjection,
  );
  const recovered = await readyStore({ store: new MemoryStore(legacy) });
  const terminal = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.execution.uncertainty, null);
  assert.deepEqual(
    terminal.execution.memoryProjection,
    legacyReceipt,
  );
  assert.notEqual(terminal.recordDigest, legacy.jobs[0].recordDigest);
});

test("unprojected terminal work cannot be compacted or silently evicted for capacity", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 1 } });
  const first = await jobs.createApprovedJob(approval());
  const failed = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    result: { code: "STOPPED_BEFORE_MEMORY" },
  });
  await assert.rejects(
    jobs.compactTerminalPrefix(
      compactionRequest(store, { targetThroughSequence: failed.job.sequence }),
    ),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );
  assert.equal(store.value.archive.throughSequence, 0);
  const secondRequest = approval({
    confirmationId: "confirmation-code-job-approval-2",
    requestId: "approval-request-0002",
    displayedPayloadDigest: "2".repeat(64),
    approvalBindingDigest: "3".repeat(64),
    grant: grant({
      proposalId: "work-intent-proposal-2",
      contentDigest: "1".repeat(64),
      requestedBy: { roleId: "tester", workItemId: "work-2" },
      source: { assignmentId: "assignment-2", eventId: "event-2" },
    }),
  });
  await assert.rejects(
    jobs.createApprovedJob(secondRequest),
    (error) => error.code === "CODE_JOB_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.jobs[0].jobId, first.job.jobId);
  const projected = await jobs.markMemoryProjected(memoryProjection(failed.job));
  assert.equal(projected.status, "applied");
  assert.equal((await jobs.createApprovedJob(secondRequest)).status, "applied");
  assert.equal(store.value.archive.throughSequence, 1);
});

test("terminal prefix retention frees capacity and seals archive continuity", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 2 } });
  const first = await jobs.createApprovedJob(approval());
  const failedFirst = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    result: { code: "BRAIN_UNAVAILABLE", summary: "Could not start" },
  });
  await jobs.markMemoryProjected(memoryProjection(failedFirst.job));
  const liveFirst = await jobs.get(first.job.jobId);
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
  });
  await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: secondGrant,
    }),
  );
  const thirdGrant = grant({
    proposalId: "work-intent-proposal-3",
    contentDigest: "6".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-3" },
    source: { assignmentId: "assignment-3", eventId: "event-3" },
  });
  const third = await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-3",
      requestId: "approval-request-0003",
      displayedPayloadDigest: "7".repeat(64),
      approvalBindingDigest: "8".repeat(64),
      grant: thirdGrant,
    }),
  );

  assert.equal(third.status, "applied");
  assert.equal(store.value.jobs.length, 2);
  assert.deepEqual(store.value.jobs.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(store.value.archive.throughSequence, 1);
  assert.equal(store.value.archive.jobCount, 1);
  assert.match(store.value.archive.digest, /^[a-f0-9]{64}$/);
  const archivedFirst = await jobs.get(first.job.jobId);
  assert.equal(archivedFirst.status, "failed");
  assert.equal(archivedFirst.uncertainty, null);
  assert.deepEqual(archivedFirst, liveFirst);
  const archivedRetry = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-archived-retry" }),
  );
  assert.equal(archivedRetry.status, "already");
  assert.equal(archivedRetry.job.status, "failed");
  assert.equal(
    (await jobs.reconcileApprovedJob(
      approval({ requestId: "approval-request-archived-reconcile" }),
    )).status,
    "already",
  );
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-archived-conflict",
        approvalBindingDigest: "0".repeat(64),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  await assert.rejects(
    jobs.reconcileApprovedJob(
      approval({
        requestId: "approval-request-archived-grant-conflict",
        grant: grant({ summary: "Changed after archive" }),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  assert.equal(store.value.jobs.length, 2);
  const recovered = await readyStore({
    store,
    limits: { maximumJobs: 2 },
  });
  assert.equal((await recovered.jobs.list()).archive.throughSequence, 1);

  const tampered = structuredClone(store.value);
  tampered.archive.digest = "0".repeat(64);
  await assert.rejects(
    readyStore({
      store: new MemoryStore(tampered),
      limits: { maximumJobs: 2 },
    }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("a queued job can fail closed as fenced without creating an executor session", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const fenced = await jobs.fence({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: {
      code: "AUTHORITY_CHANGED",
      summary: "Workspace authority changed before start",
    },
  });
  assert.equal(fenced.job.status, "fenced");
  assert.equal(fenced.job.execution.sessionId, null);
  assert.equal(fenced.job.execution.result.kind, "fenced");
  assert.equal((await jobs.list({ status: "fenced" })).total, 1);
  assert.equal((await jobs.listRunnable()).items.length, 0);
});

test("explicit compaction archives only a terminal prefix, never paused work", async () => {
  const { jobs, store } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const paused = await jobs.pause({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    reason: "用户暂停",
  });
  await assert.rejects(
    jobs.compactTerminalPrefix(
      compactionRequest(store, { targetThroughSequence: paused.job.sequence }),
    ),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );
  assert.equal(store.value.archive.throughSequence, 0);

  const resumed = await jobs.resume({
    jobId: first.job.jobId,
    expectedRevision: paused.job.revision,
  });
  const failed = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: resumed.job.revision,
    result: { code: "STOPPED" },
  });
  const projected = await jobs.markMemoryProjected(memoryProjection(failed.job));
  const compacted = await jobs.compactTerminalPrefix(
    compactionRequest(store, {
      compactionId: "code-job-compaction-projected",
      targetThroughSequence: projected.job.sequence,
    }),
  );
  assert.equal(compacted.status, "applied");
  assert.equal(compacted.receipt.archived, 1);
  assert.equal(compacted.receipt.targetThroughSequence, 1);
  assert.equal((await jobs.list()).archive.throughSequence, 1);
  assert.equal((await jobs.list()).total, 0);
});
