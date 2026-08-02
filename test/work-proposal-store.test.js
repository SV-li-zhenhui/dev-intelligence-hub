import assert from "node:assert/strict";
import test from "node:test";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  WORK_PROPOSAL_STATE_KEY,
  WorkProposalStore,
} from "../src/services/work-proposal-store.js";

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

function manualClock(initial = "2026-08-02T03:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) {
      now += milliseconds;
    },
    at(milliseconds) {
      return new Date(now + milliseconds).toISOString();
    },
  };
}

function proposal(overrides = {}) {
  return {
    proposalId: "work-intent-proposal-1",
    policyVersion: 1,
    kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    binding: { repository: "acme/widgets", workspaceId: "widgets-local" },
    payload: { operation: "inspect", objective: "Find the retry path" },
    ...overrides,
  };
}

async function readyStore({
  store = new MemoryStore(),
  time = manualClock(),
  limits,
} = {}) {
  let id = 0;
  const exclusiveLease = new ExclusiveLease();
  const proposals = new WorkProposalStore({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
    clock: time.clock,
    idFactory: () => `lease-${++id}`,
    ...(limits ? { limits } : {}),
  });
  await proposals.recover();
  return { proposals, store, time, exclusiveLease };
}

function advanceRequest(claim, transition) {
  return {
    proposalId: claim.proposal.proposalId,
    contentDigest: claim.proposal.contentDigest,
    expectedRevision: claim.revision,
    runnerId: claim.lease.runnerId,
    leaseId: claim.lease.leaseId,
    transition,
  };
}

function runnerScope(runnerId, overrides = {}) {
  return {
    runnerId,
    allowedKinds: ["code_action_proposal"],
    allowedRoleIds: ["developer"],
    ...overrides,
  };
}

function claimAs(proposals, request, scope = runnerScope(request.runnerId)) {
  return proposals.claim(request, scope);
}

function advanceAs(proposals, request, scope = runnerScope(request.runnerId)) {
  return proposals.advance(request, scope);
}

test("create persists before returning and is idempotent by ID and digest", async () => {
  const { proposals, store, exclusiveLease } = await readyStore();
  const created = await proposals.create(proposal());
  const repeated = await proposals.create(
    proposal({
      binding: { workspaceId: "widgets-local", repository: "acme/widgets" },
    }),
  );

  assert.equal(store.lastWriteName, WORK_PROPOSAL_STATE_KEY);
  assert.equal(store.writeCount, 1);
  assert.equal(exclusiveLease.runCount, 3);
  assert.deepEqual(repeated, created);
  assert.equal(store.value.proposals[0].status, "pending_delivery");
  assert.equal(store.value.proposals[0].proposal.contentDigest, created.contentDigest);

  await assert.rejects(
    proposals.create(
      proposal({ payload: { operation: "verify", objective: "Run tests" } }),
    ),
    (error) => error.code === "WORK_PROPOSAL_ID_CONFLICT",
  );
  assert.equal(store.writeCount, 1);
});

test("runner claims with a lease, binds one downstream, and emits unknown once", async () => {
  const { proposals, time } = await readyStore();
  await proposals.create(proposal());
  const firstClaim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  assert.equal(firstClaim.status, "pending_delivery");
  assert.equal(firstClaim.attempt, 1);

  const running = await advanceAs(
    proposals,
    advanceRequest(firstClaim, {
      status: "running",
      downstreamRef: "code-session-1",
      nextAttemptAt: time.at(5_000),
    }),
  );
  assert.equal(running.status, "running");
  assert.equal(running.downstreamRef, "code-session-1");
  assert.equal(
    await claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    null,
  );

  time.advance(5_000);
  const secondClaim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(secondClaim, {
        status: "running",
        downstreamRef: "different-code-session",
        nextAttemptAt: time.at(5_000),
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_DOWNSTREAM_CONFLICT",
  );
  const terminal = await advanceAs(
    proposals,
    advanceRequest(secondClaim, {
      status: "unknown",
      summary: "The code session outcome is not authoritative.",
      evidence: ["session audit reconciliation failed"],
    }),
  );
  assert.equal(terminal.status, "unknown");
  assert.match(terminal.resultId, /^work-proposal-result-[a-f0-9]{64}$/);
  assert.equal(
    await claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    null,
  );

  const batch = await proposals.readResultBatch();
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.nextSequence, 1);
  assert.equal(batch.oldestAvailableSequence, 1);
  assert.equal(batch.items[0].outcome, "unknown");
  assert.equal(batch.items[0].downstreamRef, "code-session-1");
});

test("retry time and expired leases bound which runner may advance", async () => {
  const { proposals, time } = await readyStore();
  await proposals.create(proposal());
  const original = await claimAs(proposals, {
    runnerId: "runner-a",
    leaseDurationMs: 1_000,
  });
  time.advance(1_000);
  const reclaimed = await claimAs(proposals, {
    runnerId: "runner-b",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, 2);
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(original, {
        status: "failed",
        summary: "old runner",
        evidence: [],
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_REVISION_CONFLICT",
  );

  await advanceAs(
    proposals,
    advanceRequest(reclaimed, {
      status: "waiting_retry",
      reason: "downstream temporarily unavailable",
      nextAttemptAt: time.at(10_000),
    }),
  );
  assert.equal(
    await claimAs(proposals, { runnerId: "runner-c", leaseDurationMs: 30_000 }),
    null,
  );
  time.advance(10_000);
  assert.equal(
    (await claimAs(proposals, { runnerId: "runner-c", leaseDurationMs: 30_000 }))
      .attempt,
    3,
  );
});

test("an acknowledged durable advance is recovered idempotently after a lost write response", async () => {
  const store = new MemoryStore();
  const { proposals, time } = await readyStore({ store });
  await proposals.create(proposal());
  const claim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  const request = advanceRequest(claim, {
    status: "running",
    downstreamRef: "code-session-1",
    nextAttemptAt: time.at(5_000),
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(proposals, request),
    /disk acknowledgement unavailable/,
  );
  assert.equal(store.value.proposals[0].status, "running");

  const recovered = await advanceAs(proposals, request);
  assert.equal(recovered.status, "running");
  assert.equal(store.writeCount, 3);
});

test("a durable claim is returned to the same scoped runner after its acknowledgement is lost", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({ store });
  await proposals.create(proposal());
  store.writeThenFailAt = 2;

  await assert.rejects(
    claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    /disk acknowledgement unavailable/,
  );
  const recovered = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });

  assert.equal(recovered.lease.leaseId, store.value.proposals[0].leaseId);
  assert.equal(recovered.revision, store.value.proposals[0].revision);
  assert.equal(store.writeCount, 2);
});

test("an exact advance retry keeps its original receipt after a later reclaim", async () => {
  const store = new MemoryStore();
  const { proposals, time } = await readyStore({ store });
  await proposals.create(proposal());
  const firstClaim = await claimAs(proposals, {
    runnerId: "runner-a",
    leaseDurationMs: 30_000,
  });
  const request = advanceRequest(firstClaim, {
    status: "running",
    downstreamRef: "code-session-1",
    nextAttemptAt: time.at(1_000),
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(proposals, request),
    /disk acknowledgement unavailable/,
  );
  const originalReceipt = structuredClone(store.value.proposals[0].lastAdvance.receipt);

  time.advance(1_000);
  await claimAs(proposals, { runnerId: "runner-b", leaseDurationMs: 30_000 });
  const recovered = await advanceAs(proposals, request);

  assert.deepEqual(recovered, originalReceipt);
  assert.equal(store.writeCount, 4);
});

test("a terminal write acknowledgement loss is visible to result consumers", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({ store });
  await proposals.create(proposal());
  const claim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(claim, {
        status: "failed",
        summary: "failed deterministically",
        evidence: [],
      }),
    ),
    /disk acknowledgement unavailable/,
  );

  const batch = await proposals.readResultBatch();
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items[0].outcome, "failed");
});

test("result batches are monotonic, bounded, and reject future cursors", async () => {
  const { proposals } = await readyStore();
  for (let index = 1; index <= 2; index += 1) {
    await proposals.create(
      proposal({
        proposalId: `work-intent-proposal-${index}`,
        requestedBy: { roleId: "developer", workItemId: `work-${index}` },
      }),
    );
    const claim = await claimAs(proposals, {
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    });
    await advanceAs(
      proposals,
      advanceRequest(claim, {
        status: "failed",
        summary: `proposal ${index} failed deterministically`,
        evidence: [],
      }),
    );
  }

  const first = await proposals.readResultBatch({ limit: 1 });
  const second = await proposals.readResultBatch({
    afterSequence: first.nextSequence,
    limit: 1,
  });
  assert.equal(first.items[0].sequence, 1);
  assert.equal(first.highWatermark, 2);
  assert.equal(second.items[0].sequence, 2);
  assert.equal(second.nextSequence, 2);

  await assert.rejects(
    proposals.readResultBatch({ afterSequence: 3 }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RESULT_CURSOR",
  );
});

test("capacity failures preserve prior state and corrupt recovery fails closed", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({
    store,
    limits: { maximumProposals: 1 },
  });
  await proposals.create(proposal());
  await assert.rejects(
    proposals.create(proposal({ proposalId: "work-intent-proposal-2" })),
    (error) => error.code === "WORK_PROPOSAL_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.proposals.length, 1);

  store.value.proposals[0].attempt = 99;
  await assert.rejects(
    claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
  await assert.rejects(
    proposals.readResultBatch(),
    (error) => error.code === "WORK_PROPOSAL_STORE_NOT_READY",
  );
  const broken = new WorkProposalStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
});
