import assert from "node:assert/strict";
import test from "node:test";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class BlockingStore extends MemoryStore {
  constructor() {
    super();
    this.started = deferred();
    this.release = deferred();
    this.writeCount = 0;
  }

  async write(name, value) {
    this.writeCount += 1;
    if (this.writeCount === 1) {
      this.started.resolve();
      await this.release.promise;
    }
    await super.write(name, value);
  }
}

class Guard {
  constructor(options) {
    this.options = options;
    this.acquired = false;
    this.closed = false;
  }

  async acquire() {
    this.acquired = true;
  }

  run(operation) {
    assert.equal(this.acquired, true);
    return operation();
  }

  async close() {
    this.closed = true;
  }
}

function proposal() {
  return {
    proposalId: "work-intent-proposal-1",
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    binding: { repository: "acme/widgets", pullRequestNumber: 42 },
    payload: { verdict: "comment", body: "Please add a test." },
  };
}

function runnerScopes() {
  return [
    {
      runnerId: "github-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
    {
      runnerId: "code-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer"],
    },
  ];
}

function scopedAdvanceRequest(claim, transition) {
  return {
    proposalId: claim.proposal.proposalId,
    contentDigest: claim.proposal.contentDigest,
    expectedRevision: claim.revision,
    leaseId: claim.lease.leaseId,
    transition,
  };
}

test("runtime owns one guard and exposes only least-authority frozen ports", async () => {
  let guard;
  const runtime = await createWorkProposalRuntime({
    store: new MemoryStore(),
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    idFactory: () => "lease-1",
    runnerScopes: runnerScopes(),
    createGuard(options) {
      guard = new Guard(options);
      return guard;
    },
  });

  assert.deepEqual(Object.keys(runtime).sort(), ["close", "consumer", "producer", "runners"]);
  assert.deepEqual(Object.keys(runtime.producer), ["create"]);
  assert.deepEqual(Object.keys(runtime.runners).sort(), ["code-runner", "github-runner"]);
  assert.deepEqual(Object.keys(runtime.runners["github-runner"]).sort(), ["advance", "claim"]);
  assert.deepEqual(Object.keys(runtime.consumer), ["readResultBatch"]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.producer), true);
  assert.equal(Object.isFrozen(runtime.runners), true);
  assert.equal(Object.isFrozen(runtime.runners["github-runner"]), true);
  assert.equal(Object.isFrozen(runtime.consumer), true);
  assert.equal(guard.options.name, "mydashboard-work-proposal-v1");

  assert.equal((await runtime.producer.create(proposal())).status, "pending_delivery");
  assert.equal(
    await runtime.runners["code-runner"].claim({ leaseDurationMs: 30_000 }),
    null,
  );
  const claim = await runtime.runners["github-runner"].claim({
    leaseDurationMs: 30_000,
  });
  assert.equal(claim.proposal.proposalId, proposal().proposalId);
  await assert.rejects(
    runtime.runners["code-runner"].advance(
      scopedAdvanceRequest(claim, {
        status: "failed",
        summary: "unauthorized",
        evidence: [],
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_RUNNER_FORBIDDEN",
  );
  await assert.rejects(
    runtime.runners["github-runner"].claim({
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
  );
  assert.equal((await runtime.consumer.readResultBatch()).highWatermark, 0);

  await runtime.close();
  await runtime.close();
  assert.equal(guard.closed, true);
  await assert.rejects(
    runtime.producer.create(proposal()),
    (error) => error.code === "WORK_PROPOSAL_RUNTIME_CLOSED",
  );
});

test("runtime drains every accepted proposal operation before closing its guard", async () => {
  const store = new BlockingStore();
  let guard;
  const runtime = await createWorkProposalRuntime({
    store,
    createGuard(options) {
      guard = new Guard(options);
      return guard;
    },
  });
  const first = runtime.producer.create(proposal());
  await store.started.promise;
  const second = runtime.producer.create({
    ...proposal(),
    proposalId: "work-intent-proposal-2",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-2" },
  });
  const closing = runtime.close();

  assert.equal(guard.closed, false);
  store.release.resolve();
  await Promise.all([first, second, closing]);

  assert.equal(guard.closed, true);
  assert.equal(store.value.proposals.length, 2);
});

test("runtime closes its guard when durable recovery is corrupt", async () => {
  let guard;
  await assert.rejects(
    createWorkProposalRuntime({
      store: new MemoryStore({ schemaVersion: 1, revision: "bad" }),
      createGuard(options) {
        guard = new Guard(options);
        return guard;
      },
    }),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
  assert.equal(guard.closed, true);
});
