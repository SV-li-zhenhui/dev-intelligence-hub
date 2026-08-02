import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
} from "../src/services/code-job-store.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value === null ? null : structuredClone(value);
    this.writeCount = 0;
    this.writeThenFailAt = null;
    this.lastWriteName = null;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(name, value) {
    this.writeCount += 1;
    this.lastWriteName = name;
    this.value = structuredClone(value);
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

async function readyStore({
  store = new MemoryStore(),
  time = manualClock(),
  limits,
} = {}) {
  const exclusiveLease = new ExclusiveLease();
  const jobs = new CodeJobStore({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
    clock: time.clock,
    ...(limits ? { limits } : {}),
  });
  await jobs.recover();
  return { jobs, store, time, exclusiveLease };
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
