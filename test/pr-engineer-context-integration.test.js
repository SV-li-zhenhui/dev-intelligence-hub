import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequestReadFacts,
  createPullRequestReadIdentity,
} from "../src/domain/pull-request-read-facts.js";
import { createWorkGraphSnapshot } from "../src/domain/work-graph-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { PrEngineerService } from "../src/services/pr-engineer-service.js";
import {
  RoleContextAssembler,
  RoleContextAssemblerError,
} from "../src/services/role-context-assembler.js";
import { WorkflowFactSource } from "../src/services/workflow-fact-source.js";
import { createPullRequestWorkSource } from "../src/services/work-ledger-pr-source.js";

const NOW = "2026-08-08T01:02:00.000Z";
const HEAD_OID = "b".repeat(40);

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

class ExclusiveLease {
  constructor() {
    this.queue = new OperationQueue();
  }

  run(operation) {
    return this.queue.enqueue(operation);
  }
}

function eventFixture({
  scopeId = "github-account:runtime-user",
  sourceAccountId = "runtime-user",
  baseRefName = "main",
  baseRefOid = "a".repeat(40),
  headRefName = "fix/conflict",
} = {}) {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId,
    baseRepository: "acme/repo",
    baseRefName,
    baseRefOid,
    headRepository: "contributor/repo",
    headRefName,
    headRefOid: HEAD_OID,
  };
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-08T01:00:00.000Z",
    source: { provider: "github", scopeId },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { headRefOid: HEAD_OID, gitTargetAvailable: true, gitTarget },
  });
}

function roleFixture(event) {
  const source = createPullRequestWorkSource({
    sequence: 1,
    assignment: {
      assignmentId: "workflow-assignment-1",
      eventId: event.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
    },
    event,
  }).source;
  const graphTask = {
    taskId: "task-pr",
    revision: 1,
    parentTaskId: null,
    status: "in_progress",
    responsibility: { type: "role", id: "pr-engineer" },
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
    }],
    deliveries: [],
    dependsOn: [],
  };
  return {
    item: {
      itemId: "task-pr",
      revision: 1,
      inputDigest: source.current.inputDigest,
      assignmentId: "workflow-assignment-1",
      currentTarget: { type: "role", id: "pr-engineer" },
      decisionContext: null,
      event,
      source,
    },
    snapshot: {
      schemaVersion: 1,
      graph: createWorkGraphSnapshot({
        graphId: "work-ledger",
        revision: 1,
        tasks: [graphTask],
      }),
      taskStates: [{
        taskId: "task-pr",
        taskRevision: 1,
        ledgerStatus: "queued",
        ownerId: null,
        leaseUntil: null,
        availableAt: null,
        statusReason: null,
        updatedAt: "2026-08-08T01:00:00.000Z",
        work: { title: "Review PR", description: "Inspect current PR facts" },
      }],
    },
  };
}

function graphReader(snapshot) {
  return {
    async getSnapshot() {
      return structuredClone(snapshot);
    },
  };
}

function factsFor(input) {
  return createPullRequestReadFacts({
    identity: createPullRequestReadIdentity(input),
    observedAt: "2026-08-08T01:01:00.000Z",
    reviewDecision: "REVIEW_REQUIRED",
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    truncation: {
      comments: false,
      reviews: false,
      reviewThreads: false,
      checks: false,
      byteBudget: false,
    },
  });
}

test("same Head facts invalidate on provenance, account, and ref changes", async () => {
  const store = new MemoryStore();
  const identities = [];
  const engineer = new PrEngineerService({
    store,
    exclusiveLease: new ExclusiveLease(),
    clock: () => NOW,
    pullRequestFactsLoader: {
      async loadPullRequestFacts(input) {
        const facts = factsFor(input);
        identities.push(facts.identity.identityDigest);
        return facts;
      },
    },
  });
  const workflowFacts = new WorkflowFactSource({
    store: { async read(_name, fallback) { return fallback; } },
    pullRequestFacts: engineer,
    clock: () => NOW,
  });
  const variants = [
    eventFixture(),
    eventFixture({ scopeId: "github-account:other-provenance" }),
    eventFixture({ sourceAccountId: "other-account" }),
    eventFixture({ baseRefName: "release" }),
    eventFixture({ headRefName: "fix/renamed-conflict" }),
  ];
  const packets = [];
  for (const event of variants) {
    const fixture = roleFixture(event);
    const assembler = new RoleContextAssembler({
      graphReader: graphReader(fixture.snapshot),
      pullRequestContextReader: workflowFacts.pullRequestTaskContextReader(),
    });
    packets.push(await assembler.assemble({
      roleId: "pr-engineer",
      item: fixture.item,
      trigger: "employee:pr-engineer",
    }));
  }

  assert.equal(new Set(identities).size, variants.length);
  assert.equal(new Set(packets.map(({ contextDigest }) => contextDigest)).size,
    variants.length);
  assert.equal(
    new Set(packets.map(({ binding }) => binding.source.inputDigest)).size,
    variants.length,
  );
  assert.ok(packets.every(({ context }) =>
    context.code.pullRequest.identityDigest.length === 64));
  assert.deepEqual(await engineer.recover(), {
    revision: variants.length,
    records: variants.length,
  });

  const repeated = roleFixture(eventFixture());
  const repeatedAssembler = new RoleContextAssembler({
    graphReader: graphReader(repeated.snapshot),
    pullRequestContextReader: workflowFacts.pullRequestTaskContextReader(),
  });
  const repeatedPacket = await repeatedAssembler.assemble({
    roleId: "pr-engineer",
    item: repeated.item,
    trigger: "employee:pr-engineer",
  });
  assert.equal(identities.length, variants.length);
  assert.equal(repeatedPacket.contextDigest, packets[0].contextDigest);
});

test("a PR facts failure stops the sequential employee pipeline before brain use", async () => {
  const fixture = roleFixture(eventFixture());
  const assembler = new RoleContextAssembler({
    graphReader: graphReader(fixture.snapshot),
    pullRequestContextReader: {
      async read() {
        throw new Error("fact backend unavailable");
      },
    },
  });
  let brainCalls = 0;
  const runEmployee = async () => {
    const packet = await assembler.assemble({
      roleId: "pr-engineer",
      item: fixture.item,
      trigger: "employee:pr-engineer",
    });
    brainCalls += 1;
    return packet;
  };

  await assert.rejects(
    runEmployee(),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(brainCalls, 0);
});
