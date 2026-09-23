import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { normalizeAttentionRequest } from "../src/domain/attention-contract.js";
import {
  createAttentionItem,
  resolveAttentionItem,
} from "../src/services/attention-inbox-state.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
  workProposalDigest,
} from "../src/domain/work-proposal-contract.js";
import {
  createDeliveryEvidenceTarget,
} from "../src/domain/delivery-evidence-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerIssueEvent } from "../src/domain/owner-work-request.js";
import { createWorkIntentDispatchBinding } from "../src/domain/work-intent-dispatch-binding.js";
import {
  createPullRequestExecutionBinding,
} from "../src/domain/pull-request-execution-binding.js";
import {
  PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
  PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
  PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
  PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
} from "../src/domain/pull-request-scope-lifecycle.js";
import {
  AUTHORED_PR_APPROVED_RULE_ID,
  AUTHORED_PR_SELF_FIX_RULE_ID,
  REVIEWED_PR_APPROVED_RULE_ID,
} from "../src/domain/pr-lifecycle-routing.js";
import {
  createLegacyWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";
import { MemoryAnswerService } from "../src/services/memory-answer-service.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";
import { MemoryProjector } from "../src/services/memory-projector.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import {
  createLocalWorkLedgerCandidateProcessor,
  createWorkerWorkLedgerCandidateProcessor,
} from
  "../src/services/work-ledger-candidate-processor.js";
import {
  createWorkDecisionContext,
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
  WORK_LEDGER_STATE_SCHEMA_VERSION,
} from "../src/services/work-ledger-state.js";
import { ledgerDigest } from "../src/services/work-ledger-values.js";
import { validateWorkLedgerGraphTransition } from "../src/services/work-ledger-graph.js";
import {
  migrateWorkGraphMemoryProjection,
} from "../src/services/work-ledger-graph-memory.js";
import {
  appendPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "../src/services/work-ledger-pr-source.js";
import {
  crossRootPullRequestCutoverBlockerReason,
  crossRootPullRequestCutoverCandidate,
} from "../src/services/work-ledger-pr-cutover-commands.js";
import {
  appendWorkLedgerTimeline,
  createAssignmentWorkItem,
  createGraphChildWorkItem,
  createPullRequestSourceRootWorkItem,
  createWorkIntentRecord,
} from "../src/services/work-ledger-records.js";

const STATE_KEY = "work-ledger-state";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([key, value]) => [key, clone(value)]),
    );
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? clone(this.values.get(name)) : clone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copied = clone(value);
    this.values.set(name, copied);
    this.writes.push({ name, value: copied });
  }

  failNextWrite(error = new Error("durable write unavailable")) {
    this.nextWriteError = error;
  }

  stored(name = STATE_KEY) {
    return clone(this.values.get(name));
  }

  replaceStored(value, name = STATE_KEY) {
    this.values.set(name, clone(value));
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

class FakeAssignmentSource {
  constructor(records = []) {
    this.records = records.map(clone);
    this.calls = [];
    this.oldestAvailableSequence = records.length ? records[0].sequence : 1;
    this.highWatermark = records.length ? records.at(-1).sequence : 0;
    this.override = null;
  }

  async readAssignmentBatch(request) {
    this.calls.push(clone(request));
    if (this.override) return this.override(request);
    const items = this.records
      .filter(({ sequence }) => sequence > request.afterSequence)
      .slice(0, request.limit);
    return clone({
      items,
      nextSequence: items.at(-1)?.sequence ?? request.afterSequence,
      highWatermark: this.highWatermark,
      oldestAvailableSequence: this.oldestAvailableSequence,
    });
  }
}

function assignment(sequence, target = { type: "role", id: "pr-reviewer" }) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: `workflow-event-${sequence}`,
      target,
      reason: `route-${sequence}`,
      createdAt: "2026-08-02T01:00:00.000Z",
    },
    event: {
      schemaVersion: 1,
      eventId: `workflow-event-${sequence}`,
      eventType: sequence % 2 ? "pull_request.created" : "issue.created",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: { id: `subject-${sequence}` },
      payload: { number: sequence, title: `Work ${sequence}` },
    },
  };
}

function issueAssignment(
  sequence,
  {
    eventType = "issue.updated",
    occurredAt = "2026-08-02T01:00:00.000Z",
    repository = "acme/product",
    issueNumber = 42,
    state = "open",
  } = {},
) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType,
    occurredAt,
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: `github:issue:${repository}#${issueNumber}`,
      repository,
      number: issueNumber,
    },
    payload: {
      title: `Issue ${issueNumber}`,
      state,
      updatedAt: occurredAt,
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-issue-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "requirements-analyst" },
      reason: "issue-events-to-requirements",
      createdAt: occurredAt,
    },
    event,
  };
}

class ContentVersionMemoryStore extends MemoryStore {
  constructor(entries = {}) {
    super(entries);
    this.versions = new Map();
    this.versionedValueReads = 0;
  }

  async readVersioned(name, fallback = null, { ifVersion } = {}) {
    const version = this.#versionFor(name);
    if (ifVersion === version) return { changed: false, version };
    this.versionedValueReads += 1;
    return {
      changed: true,
      version,
      value: await super.read(name, fallback),
    };
  }

  async write(name, value) {
    await super.write(name, value);
    return this.#replaceVersion(name);
  }

  replaceStored(value, name = STATE_KEY) {
    super.replaceStored(value, name);
    this.#replaceVersion(name);
  }

  #versionFor(name) {
    if (!this.versions.has(name)) this.#replaceVersion(name);
    return this.versions.get(name);
  }

  #replaceVersion(name) {
    const version = Object.freeze({});
    this.versions.set(name, version);
    return version;
  }
}

function ownerRequestedIssueAssignment(sequence, issueNumber) {
  const occurredAt = `2026-08-02T01:${String(sequence).padStart(2, "0")}:00.000Z`;
  const event = createOwnerIssueEvent({
    schemaVersion: 6,
    requestId:
      `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workType: "requirements",
    priority: "high",
    title: `Owner Issue ${issueNumber}`,
    description: "Keep this manually selected Issue in daily work.",
    acceptanceCriteria: ["Preserve the selected Issue independently"],
    issue: { repository: "acme/product", number: issueNumber },
  }, occurredAt);
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-owner-issue-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "requirements-analyst" },
      reason: "owner-issue-to-requirements",
      createdAt: occurredAt,
    },
    event,
  };
}

function persistLegacyIssueLifecycleAssignment(fixture, record) {
  const durable = fixture.store.stored();
  const createdAt = record.event.occurredAt;
  const item = createAssignmentWorkItem(record, createdAt);
  const appended = appendWorkLedgerTimeline(
    durable,
    [{
      itemId: item.itemId,
      type: "assignment_intaken",
      at: createdAt,
      actorId: "work-ledger-system",
      details: {
        assignmentId: item.assignmentId,
        sourceSequence: item.sourceSequence,
      },
    }],
    normalizeWorkLedgerLimits().timelineLimit,
  );
  durable.revision += 1;
  durable.intakeCursor = record.sequence;
  durable.sourceHighWatermark = record.sequence;
  durable.items.push(item);
  durable.timeline = appended.timeline;
  durable.timelineStartSequence = appended.timelineStartSequence;
  durable.nextTimelineSequence = appended.nextTimelineSequence;
  durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
    durable.items,
    durable.revision,
    normalizeWorkLedgerLimits(),
  );
  fixture.store.replaceStored(durable);
  return item;
}

const PR_HEAD_A = "a".repeat(40);
const PR_HEAD_B = "b".repeat(40);
const PR_HEAD_C = "c".repeat(40);

function prGitFacts(headRefOid, overrides = {}) {
  return {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid,
      ...overrides,
    },
  };
}

function prAssignment(
  sequence,
  {
    eventType = "pull_request.updated",
    occurredAt = "2026-08-02T01:00:00.000Z",
    headRefOid = PR_HEAD_A,
    previousHeadRefOid,
    changedFields = ["ciStatus"],
    ciStatus = "PENDING",
    author,
    title = "PR 42",
    repository = "acme/repo",
    pullRequestNumber = 42,
    sourceScopeId = "github-dashboard",
    sourceProvider = "github",
    gitFacts = {},
  } = {},
) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType,
    occurredAt,
    source: { provider: sourceProvider, scopeId: sourceScopeId },
    subject: {
      id: `github:pr:${repository}#${pullRequestNumber}`,
      repository,
      number: pullRequestNumber,
    },
    payload: {
      title,
      headRefOid,
      ciStatus,
      ...(author === undefined ? {} : { author }),
      changedFields,
      ...gitFacts,
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

function ownerRequestedPrAssignment(sequence, overrides = {}) {
  return prAssignment(sequence, {
    eventType: "pull_request.owner_requested",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceProvider: "local-owner",
    sourceScopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000",
    gitFacts: prGitFacts(PR_HEAD_A),
    ...overrides,
  });
}

function prScopeLifecycleAssignment(sequence, event) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-scope-${sequence}`,
      eventId: event.eventId,
      eventType: event.eventType,
      subject: clone(event.subject),
      configVersion: 1,
      configDigest: "1".repeat(64),
      ruleId: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
      target: PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
      priority: PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
      reason: PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
      createdAt: event.occurredAt,
    },
    event: clone(event),
  };
}

function prGraphChildCommand(parent, graphRevision, childKey = "resolve-conflict") {
  return {
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: parent.itemId,
    },
    command: {
      parentTaskId: parent.itemId,
      childKey,
      work: {
        title: "解决 PR 冲突",
        description: "在绑定的 PR Head 上生成并验证冲突修复。",
      },
      target: { type: "role", id: "developer" },
      dependsOnTaskIds: [],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      leaseId: null,
      expectedGraphRevision: graphRevision,
      expectedTaskRevisions: [{
        taskId: parent.itemId,
        revision: parent.revision,
      }],
    },
  };
}

function prExecutionBinding(item) {
  return createPullRequestExecutionBinding({
    sourceBinding: currentWorkItemInputBinding(item),
    event: currentWorkItemEvent(item),
  });
}

function controlledClock(initial = "2026-08-02T02:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now).toISOString(),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function incrementingIds() {
  let next = 1;
  return () => `lease-${String(next++).padStart(4, "0")}`;
}

async function createFixture({
  records = [],
  source = new FakeAssignmentSource(records),
  store = new MemoryStore(),
  lease = new ExclusiveLease(),
  time = controlledClock(),
  limits,
  actionAdmissionGate,
  postCommitYield,
  candidateProcessor,
} = {}) {
  const service = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: time.clock,
    idFactory: incrementingIds(),
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
    ...(limits ? { limits } : {}),
    ...(postCommitYield === undefined ? {} : { postCommitYield }),
    ...(candidateProcessor === undefined ? {} : { candidateProcessor }),
  });
  await service.recover();
  return { service, source, store, lease, time };
}

async function createLedgerMemoryPipeline(service, options = {}) {
  const store = options.store ?? new MemoryStore();
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: new ExclusiveLease(),
    ...(options.maximumRecords === undefined
      ? {}
      : { maximumRecords: options.maximumRecords }),
  });
  await journal.recover();
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: {
      readSnapshot: (request) => service.readMemoryAuthoritySnapshot(request),
    },
    graphProjectionSource: {
      ackBatch: (request) =>
        service.acknowledgeGraphMemoryProjectionBatch(request),
    },
    store,
  });
  return { store, journal, projector };
}

async function restartMemoryRuntime(service, store) {
  return createMemoryRuntime({
    store,
    authoritySource: {
      readStatus: () => service.readMemoryAuthorityStatus(),
    },
    createGuard: () => ({
      async acquire() {},
      async run(operation) { return operation(); },
      async close() {},
    }),
  });
}

async function restartStandaloneMemoryRuntime(store) {
  return createMemoryRuntime({
    store,
    createGuard: () => ({
      async acquire() {},
      async run(operation) { return operation(); },
      async close() {},
    }),
  });
}

function memoryAnswerForRuntime(runtime, generateCalls) {
  const brain = {
    provider: "local-test",
    model: "authority-test",
    remoteData: { requirements: false, code: false, memory: false },
  };
  return new MemoryAnswerService({
    contextRetriever: new MemoryContextRetriever({
      memorySearch: { search: runtime.search.search },
      contextReader: runtime.contextReader,
    }),
    brainRouter: {
      describe(value) {
        return {
          provider: value.provider,
          model: value.model,
          remote: false,
          remoteData: structuredClone(value.remoteData),
        };
      },
      async generate() {
        generateCalls.push("generate");
        return JSON.stringify({
          schemaVersion: 1,
          status: "insufficient_evidence",
          claims: [],
        });
      },
    },
    configuredBrain: brain,
    localBrain: brain,
  });
}

function ordinaryMemoryFact(index) {
  return {
    schemaVersion: 1,
    source: { kind: "local-session", id: `capacity-fill-${index}` },
    occurredAt: "2026-08-02T03:00:00.000Z",
    roleId: null,
    repository: null,
    eventType: "memory.capacity_fixture",
    title: `Capacity filler ${index}`,
    summary: "Ordinary memory must not overtake authority lifecycle.",
    content: "local filler",
    evidence: [],
    tags: ["capacity"],
    sourceUrl: null,
    subjectNumber: null,
  };
}

function legacySingleEventProjection(state, item, kind, graphRecord) {
  const event = createLegacyWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: state.revision,
    taskRevision: item.revision,
    item,
    kind,
    record: graphRecord,
  });
  return {
    revision: state.revision,
    nextSequence: 2,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: state.graphMemoryProjection.sourceHistoryDigest,
    lastAcknowledgement: null,
    pending: [event],
  };
}

test("an explicit invalid ledger admission gate never degrades to direct mode", async () => {
  await assert.rejects(
    createFixture({ actionAdmissionGate: null }),
    /actionAdmissionGate must provide run\(operation\)/,
  );
});

test("intake atomically advances its cursor and preserves unresolved targets", async () => {
  const records = [
    assignment(1, { type: "role", id: "missing-role" }),
    assignment(2, { type: "person", id: "missing-person" }),
    assignment(3, { type: "node", id: "missing-node" }),
  ];
  const { service, source, store } = await createFixture({ records });

  const result = await service.intake({ limit: 10 });
  const page = await service.listItems({ limit: 10 });
  const timeline = await service.listTimeline({ limit: 20 });
  const summary = await service.getSummary();

  assert.deepEqual(source.calls, [{ afterSequence: 0, limit: 10 }]);
  assert.equal(result.received, 3);
  assert.equal(result.deduplicated, 0);
  assert.equal(result.cursor, 3);
  assert.equal(result.gap, null);
  assert.equal(summary.intakeCursor, 3);
  assert.equal(summary.itemCounts.queued, 3);
  assert.deepEqual(
    page.items.map(({ assignmentId, status, currentTarget }) => ({
      assignmentId,
      status,
      currentTarget,
    })),
    records.map(({ assignment }) => ({
      assignmentId: assignment.assignmentId,
      status: "queued",
      currentTarget: assignment.target,
    })),
  );
  assert.equal(page.items.every((item) => item.inputDigest.length === 64), true);
  assert.equal(
    timeline.items.filter(({ type }) => type === "assignment_intaken").length,
    3,
  );
  assert.equal(timeline.items.at(-1).type, "intake_completed");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].name, STATE_KEY);
  assert.equal(store.writes[0].value.intakeCursor, 3);
  assert.equal(store.writes[0].value.items.length, 3);
});

test("role workloads expose exact counts and bounded recent task summaries", async () => {
  const records = [
    assignment(1, { type: "role", id: "developer" }),
    assignment(2, { type: "role", id: "pr-engineer" }),
    assignment(3, { type: "role", id: "developer" }),
    assignment(4, { type: "node", id: "system-node" }),
  ];
  const { service } = await createFixture({ records });
  await service.intake({ limit: 10 });

  const workloads = await service.getRoleWorkloads();
  const developerPage = await service.listItems({
    roleId: "developer",
    order: "newest",
  });

  assert.deepEqual(
    workloads.items.map(({ roleId, counts }) => ({ roleId, counts })),
    [
      {
        roleId: "developer",
        counts: { queued: 2, working: 0, waiting: 0, blocked: 0 },
      },
      {
        roleId: "pr-engineer",
        counts: { queued: 1, working: 0, waiting: 0, blocked: 0 },
      },
    ],
  );
  assert.deepEqual(
    workloads.items[0].tasks.map(({ title, status, statusReason }) => ({ title, status, statusReason })),
    [
      { title: "Work 3", status: "queued", statusReason: null },
      { title: "Work 1", status: "queued", statusReason: null },
    ],
  );
  assert.deepEqual(
    developerPage.items.map(({ currentTarget }) => currentTarget.id),
    ["developer", "developer"],
  );
  await assert.rejects(
    service.listItems({ roleId: "../developer" }),
    { code: "WORK_LEDGER_QUERY_INVALID" },
  );
  workloads.items[0].counts.queued = 999;
  assert.equal((await service.getRoleWorkloads()).items[0].counts.queued, 2);
});

test("claim candidate pages exclude durable history and active leases by role", async () => {
  const fixture = await createFixture({
    records: [
      assignment(1, { type: "role", id: "developer" }),
      assignment(2, { type: "role", id: "developer" }),
      assignment(3, { type: "role", id: "developer" }),
      assignment(4, { type: "role", id: "tester" }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  await fixture.service.claim({
    itemId: items[1].itemId,
    expectedRevision: items[1].revision,
    workerId: "employee-developer-active",
    leaseDurationMs: 60_000,
  });
  await fixture.service.claim({
    itemId: items[2].itemId,
    expectedRevision: items[2].revision,
    workerId: "employee-developer-expired",
    leaseDurationMs: 1_000,
  });
  fixture.time.advance(2_000);

  const page = await fixture.service.listClaimCandidates({
    at: fixture.time.clock(),
    roleId: "developer",
    limit: 10,
  });

  assert.deepEqual(
    page.items.map(({ itemId, status }) => ({ itemId, status })),
    [
      { itemId: items[0].itemId, status: "queued" },
      { itemId: items[2].itemId, status: "working" },
    ],
  );
  assert.deepEqual(page.facts, page.items.map(({ itemId }) => ({
    itemId,
    graphBlocked: false,
    submittedChildren: 0,
    satisfiedChildren: 0,
  })));
  assert.deepEqual(page.activeQuestionTargets, []);
  assert.equal(page.nextCursor, null);
  await assert.rejects(
    fixture.service.listClaimCandidates({
      at: fixture.time.clock(),
      roleId: "../developer",
    }),
    { code: "WORK_LEDGER_QUERY_INVALID" },
  );
});

test("claim candidate pagination survives its cursor being claimed", async () => {
  const fixture = await createFixture({
    records: Array.from(
      { length: 3 },
      (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
    ),
  });
  await fixture.service.intake({ limit: 10 });
  const expectedItemIds = (await fixture.service.listItems({ limit: 10 }))
    .items.map(({ itemId }) => itemId);
  const at = fixture.time.clock();

  const firstPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
  });
  await fixture.service.claim({
    itemId: firstPage.items[0].itemId,
    expectedRevision: firstPage.items[0].revision,
    workerId: "employee-developer-concurrent",
    leaseDurationMs: 60_000,
  });
  const secondPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  const thirdPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: secondPage.nextCursor,
  });
  const observedItemIds = [
    ...firstPage.items,
    ...secondPage.items,
    ...thirdPage.items,
  ].map(({ itemId }) => itemId);

  assert.deepEqual(observedItemIds, expectedItemIds);
  assert.equal(new Set(observedItemIds).size, expectedItemIds.length);
  assert.deepEqual(
    [firstPage, secondPage, thirdPage].flatMap(({ facts }) => facts),
    expectedItemIds.map((itemId) => ({
      itemId,
      graphBlocked: false,
      submittedChildren: 0,
      satisfiedChildren: 0,
    })),
  );
  assert.equal(thirdPage.nextCursor, null);
});

test("claim candidate pages retain facts from the complete dependency graph", async () => {
  const fixture = await createFixture({
    records: Array.from(
      { length: 4 },
      (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
    ),
  });
  await fixture.service.intake({ limit: 10 });
  const durable = fixture.store.stored();
  const [parent, cancelledChild, cancelledDependency, consumer] = durable.items;
  cancelledChild.graph.parentItemId = parent.itemId;
  cancelledChild.status = "cancelled";
  cancelledChild.statusReason = "child-scope-retired";
  cancelledDependency.status = "cancelled";
  cancelledDependency.statusReason = "dependency-retired";
  consumer.graph.parentItemId = parent.itemId;
  consumer.graph.dependsOnItemIds = [cancelledDependency.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const at = fixture.time.clock();

  const firstPage = await recovered.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
  });
  const secondPage = await recovered.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: firstPage.nextCursor,
  });

  assert.deepEqual(firstPage.items.map(({ itemId }) => itemId), [parent.itemId]);
  assert.deepEqual(firstPage.facts, [{
    itemId: parent.itemId,
    graphBlocked: true,
    submittedChildren: 0,
    satisfiedChildren: 1,
  }]);
  assert.deepEqual(secondPage.items.map(({ itemId }) => itemId), [consumer.itemId]);
  assert.deepEqual(secondPage.facts, [{
    itemId: consumer.itemId,
    graphBlocked: true,
    submittedChildren: 0,
    satisfiedChildren: 0,
  }]);
  assert.equal(secondPage.nextCursor, null);
});

test("role workloads group active states and retain only the three highest-priority tasks", async () => {
  const records = Array.from(
    { length: 6 },
    (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
  );
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems()).items;
  const claim = (item, workerId) => fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });

  await claim(items[0], "employee-working");
  fixture.time.advance(1);
  const waiting = await claim(items[1], "employee-waiting");
  await fixture.service.transition({
    itemId: waiting.itemId,
    expectedRevision: waiting.revision,
    leaseId: waiting.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-waiting",
    reason: "await-test-condition",
    details: { conditionRef: "test:role-workload" },
  });
  fixture.time.advance(1);
  const retry = await claim(items[2], "employee-retry");
  await fixture.service.scheduleRetry({
    itemId: retry.itemId,
    expectedRevision: retry.revision,
    leaseId: retry.leaseId,
    actorId: "employee-retry",
    availableAt: "2026-08-02T02:02:00.000Z",
    reason: "temporary-test-failure",
  });
  fixture.time.advance(1);
  const blocked = await claim(items[3], "employee-blocked");
  await fixture.service.transition({
    itemId: blocked.itemId,
    expectedRevision: blocked.revision,
    leaseId: blocked.leaseId,
    toStatus: "blocked",
    actorId: "employee-blocked",
    reason: "terminal-test-failure",
  });

  const workload = (await fixture.service.getRoleWorkloads()).items[0];
  assert.deepEqual(workload.counts, {
    queued: 2,
    working: 1,
    waiting: 2,
    blocked: 1,
  });
  assert.deepEqual(
    workload.tasks.map(({ status }) => status),
    ["working", "retry_wait", "waiting_condition"],
  );
});

test("PR execution context returns the current author with the verified binding", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        author: "review-account",
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
    ],
  });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const inputBinding = prExecutionBinding(item);

  assert.deepEqual(
    await fixture.service.readPullRequestExecutionContext(inputBinding),
    { inputBinding, author: "review-account" },
  );
});

test("PR engineer intake keeps one durable task across events on the same Head", async () => {
  const records = [
    prAssignment(1, {
      eventType: "pull_request.updated",
      changedFields: ["labels", "ciStatus"],
    }),
    prAssignment(2, {
      eventType: "pull_request.classified",
      changedFields: ["labels"],
    }),
    prAssignment(3, {
      eventType: "pull_request.status",
      changedFields: ["ciStatus"],
      title: "PR 42 latest source facts",
    }),
  ];
  const { service } = await createFixture({ records });

  const result = await service.intake({ limit: 10 });
  const items = (await service.listItems({ limit: 10 })).items;

  assert.equal(result.received, 3);
  assert.equal(items.length, 1);
  assert.equal(items[0].currentTarget.id, "pr-engineer");
  assert.equal(items[0].source.kind, "pull_request");
  assert.equal(items[0].source.inputRevision, 3);
  assert.equal(items[0].source.activeRevision, 3);
  assert.equal(items[0].source.headRevision, 1);
  assert.equal(items[0].source.current.sourceSequence, 3);
  assert.equal(items[0].source.current.headRefOid, PR_HEAD_A);
  assert.equal(items[0].source.current.event.eventType, "pull_request.status");
  const currentGraph = await service.getGraphSnapshot();
  const projectedRoot = currentGraph.taskStates.find(
    ({ taskId }) => taskId === items[0].itemId,
  );
  assert.equal(projectedRoot.work.title, "PR 42 latest source facts");
  assert.deepEqual(
    items[0].source.revisions.map(({ disposition, headRevision }) => ({
      disposition,
      headRevision,
    })),
    [
      { disposition: "accepted", headRevision: 1 },
      { disposition: "accepted", headRevision: 1 },
      { disposition: "accepted", headRevision: 1 },
    ],
  );
  const memoryBaseline = await service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(memoryBaseline.cursor, 0);
  assert.equal(memoryBaseline.highWatermark, 1);
  assert.equal(memoryBaseline.items.length, 1);
  assert.equal(memoryBaseline.items[0].kind, "authority_observed");
  assert.equal(memoryBaseline.items[0].sourceAuthority.citable, false);
  assert.equal(
    memoryBaseline.items[0].authorityStateDigest,
    memoryBaseline.authorityStateDigest,
  );
  await service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: items[0].itemId,
    },
    command: {
      taskId: items[0].itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "fixed-head-reviewed",
          description: "在固定 PR Head 上完成审查。",
        }],
        expectedDeliverables: [],
      },
      reason: "bind-real-pr-acceptance",
      expectedGraphRevision: (await service.getSummary()).revision,
      expectedTaskRevision: items[0].revision,
    },
  });
  const projected = await service.readGraphMemoryProjectionBatch({ limit: 10 });
  assert.equal(projected.highWatermark, 2);
  assert.equal(projected.items.at(-1).kind, "acceptance_contract");
  assert.equal(projected.items.at(-1).recordRevision, 2);
  assert.match(
    projected.items.at(-1).memoryRecord.title,
    /PR 42 latest source facts/,
  );
});

test("empty assignment feed replay performs no durable ledger write", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const before = fixture.store.stored();
  fixture.store.writes.length = 0;

  const replay = await fixture.service.intake();

  assert.equal(replay.received, 0);
  assert.equal(replay.deduplicated, 0);
  assert.equal(fixture.store.writes.length, 0);
  assert.deepEqual(fixture.store.stored(), before);
});

test("a new PR Head advances the epoch without creating another task", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const items = (await fixture.service.listItems({ limit: 10 })).items;

  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, before.itemId);
  assert.equal(items[0].source.inputRevision, 2);
  assert.equal(items[0].source.headRevision, 2);
  assert.equal(items[0].source.current.headRefOid, PR_HEAD_B);
});

test("leaving and re-entering automatic PR scope fences every older authority epoch", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(before);

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const inactive = (await fixture.service.listItems()).items[0];
  assert.deepEqual(inactive.source.scope, {
    kind: "automatic",
    active: false,
    revision: 2,
    lastLifecycleEventId: leftEvent.eventId,
  });
  assert.equal(inactive.source.authorityEpoch, 2);
  assert.equal(inactive.source.headRevision, 2);
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  assert.equal(inactive.ownerId, null);
  assert.equal(inactive.leaseId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const createdOrdinary = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, createdOrdinary.event),
    createdOrdinary,
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  const active = (await fixture.service.listItems()).items[0];
  assert.deepEqual(active.source.scope, {
    kind: "automatic",
    active: true,
    revision: 3,
    lastLifecycleEventId: createdOrdinary.event.eventId,
  });
  assert.equal(active.source.authorityEpoch, 3);
  assert.equal(active.source.headRevision, 3);
  assert.equal(active.status, "queued");
  assert.equal(active.statusReason, "pr_source_reentered_scope");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = prExecutionBinding(active);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );

  fixture.source.records.push(prAssignment(5, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 5;
  const updatedIntake = await fixture.service.intake();
  const updated = (await fixture.service.listItems()).items[0];

  assert.equal(updatedIntake.cursor, 5);
  assert.equal(updated.source.current.event.eventType, "pull_request.updated");
  assert.deepEqual(updated.source.scope, active.source.scope);
  assert.equal(updated.source.authorityEpoch, active.source.authorityEpoch);
});

test("a changed Head cannot restore automatic PR scope without causal proof", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const changedHead = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, changedHead.event),
    changedHead,
  );
  fixture.source.highWatermark = 4;

  const intake = await fixture.service.intake({ limit: 10 });
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(intake.cursor, 4);
  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.revisions.at(-1).headRefOid, PR_HEAD_B);
  assert.equal(
    root.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a rejected changed-Head left-scope still revokes automatic authority", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(before);
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const inactive = (await fixture.service.listItems()).items[0];

  assert.equal(inactive.source.scope.active, false);
  assert.equal(inactive.source.scope.revision, 2);
  assert.equal(inactive.source.scope.lastLifecycleEventId, leftEvent.eventId);
  assert.equal(inactive.source.current.headRefOid, PR_HEAD_A);
  assert.equal(
    inactive.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const restarted = await createFixture({ store: fixture.store });
  const recoveredInactive = (await restarted.service.listItems()).items[0];
  assert.equal(recoveredInactive.source.scope.active, false);
  assert.equal(
    recoveredInactive.source.scope.lastLifecycleEventId,
    leftEvent.eventId,
  );
  assert.equal(recoveredInactive.source.current.headRefOid, PR_HEAD_A);

  const reentered = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, reentered.event),
    reentered,
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  const active = (await fixture.service.listItems()).items[0];

  assert.equal(active.source.scope.active, true);
  assert.equal(active.source.scope.revision, 3);
  assert.equal(active.source.current.headRefOid, PR_HEAD_A);
  assert.equal(active.source.authorityEpoch, before.source.authorityEpoch + 1);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a stale lifecycle replay cannot recover an unresolved authority fence", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:20:00.000Z",
      gitFacts: { gitTargetAvailable: false },
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const staleCreated = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(4, staleCreated));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.eventId, leftEvent.eventId);
  assert.equal(root.source.revisions.at(-1).disposition, "ignored_stale");
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("rebinding an accepted lifecycle event cannot restore revoked PR scope", async () => {
  const initial = prAssignment(1, {
    eventType: "pull_request.created",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  fixture.source.records.push(prScopeLifecycleAssignment(3, initial.event));
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(intake.cursor, 3);
  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.eventId, leftEvent.eventId);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a completed automatic PR root can leave scope without blocking later intake", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.complete({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-scope-exit" },
  });
  assert.equal(root.status, "completed");

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    assignment(3),
  );
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const inactive = items.find(({ itemId }) => itemId === root.itemId);

  assert.equal(intake.received, 2);
  assert.equal((await fixture.service.getSummary()).intakeCursor, 3);
  assert.notEqual(items.find(({ assignmentId }) => assignmentId === "workflow-assignment-3"), undefined);
  assert.equal(inactive.source.scope.active, false);
  assert.equal(inactive.source.authorityEpoch, root.source.authorityEpoch + 1);
  assert.equal(inactive.source.inputRevision, root.source.inputRevision + 1);
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  assert.equal(inactive.ownerId, null);
  assert.equal(inactive.leaseId, null);
  assert.equal(inactive.activeIntentId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const created = prAssignment(5, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(4, created.event),
    created,
  );
  fixture.source.highWatermark = 5;
  await fixture.service.intake({ limit: 10 });

  const reentered = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === root.itemId,
  );
  assert.equal(reentered.source.scope.active, true);
  assert.equal(reentered.source.authorityEpoch, inactive.source.authorityEpoch + 1);
  assert.equal(reentered.status, "queued");
  assert.equal(reentered.statusReason, "pr_source_reentered_scope");
});

test("a redundant scope-created event preserves completed PR work", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.complete({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-redundant-created" },
  });

  const repeatedCreated = prAssignment(2, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, repeatedCreated),
    assignment(3),
  );
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const preserved = items.find(({ itemId }) => itemId === root.itemId);

  assert.equal(intake.received, 2);
  assert.equal(intake.cursor, 3);
  assert.equal(preserved.status, "completed");
  assert.equal(preserved.revision, root.revision);
  assert.deepEqual(preserved.source, root.source);
  assert.notEqual(
    items.find(({ assignmentId }) => assignmentId === "workflow-assignment-3"),
    undefined,
  );
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  assert.notEqual(
    timeline.items.find((entry) =>
      entry.type === "pr_source_ignored" &&
      entry.details.disposition === "ignored_redundant_scope_lifecycle"
    ),
    undefined,
  );
});

test("a batch of old completed PR roots leaves scope with mixed Head proof", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        pullRequestNumber: 41,
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
      prAssignment(2, {
        pullRequestNumber: 42,
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const completedRoots = [];
  for (const queued of (await fixture.service.listItems({ limit: 10 })).items) {
    const claimed = await fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: queued.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    completedRoots.push(await fixture.service.complete({
      itemId: claimed.itemId,
      expectedRevision: claimed.revision,
      leaseId: claimed.leaseId,
      actorId: "employee-pr-engineer",
      result: { outcome: "completed-before-batch-scope-exit" },
    }));
  }
  const previousByNumber = new Map(
    completedRoots.map((root) => [root.source.identity.pullRequestNumber, root]),
  );
  const acceptedLeftEvent = prAssignment(3, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    pullRequestNumber: 41,
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const unprovenLeftEvent = prAssignment(4, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    pullRequestNumber: 42,
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, acceptedLeftEvent),
    prScopeLifecycleAssignment(4, unprovenLeftEvent),
  );
  fixture.source.highWatermark = 4;

  const intake = await fixture.service.intake({ limit: 10 });
  const inactiveByNumber = new Map(
    (await fixture.service.listItems({ limit: 10 })).items.map((root) => [
      root.source.identity.pullRequestNumber,
      root,
    ]),
  );
  const accepted = inactiveByNumber.get(41);
  const unproven = inactiveByNumber.get(42);

  assert.equal(intake.received, 2);
  assert.equal(intake.cursor, 4);
  assert.equal(accepted.status, "blocked");
  assert.equal(accepted.statusReason, "pr_source_left_scope");
  assert.equal(unproven.source.scope.active, false);
  assert.equal(
    unproven.source.activeRevision,
    previousByNumber.get(42).source.activeRevision,
  );
  assert.equal(
    unproven.source.authorityEpoch,
    previousByNumber.get(42).source.authorityEpoch,
  );
  assert.equal(
    unproven.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(
    unproven.source.revisions.at(-1).scopeRevocationApplied,
    true,
  );
  assert.equal(unproven.status, "blocked");
  assert.equal(unproven.statusReason, "pr_source_left_scope");
});

test("an explicit owner PR source survives automatic left-scope and never reuses its old binding", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    ownerRequestedPrAssignment(3),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const inactiveAutomatic = roots.find(
    ({ source }) => source.scope.kind === "automatic",
  );
  assert.notEqual(owner, undefined);
  assert.equal(owner.source.scope.active, true);
  assert.equal(owner.status, "queued");
  assert.equal(inactiveAutomatic.source.scope.active, false);
  assert.equal(inactiveAutomatic.status, "blocked");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const ownerBinding = prExecutionBinding(owner);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("owner-requested PR work reaches developer and tester with the exact PR source", async () => {
  for (const roleId of ["developer", "tester"]) {
    const assignment = ownerRequestedPrAssignment(1);
    assignment.assignment.target = { type: "role", id: roleId };
    assignment.assignment.reason = `owner-pr-${roleId}`;
    const fixture = await createFixture({ records: [assignment] });

    await fixture.service.intake({ limit: 10 });

    const [item] = (await fixture.service.listItems({ limit: 10 })).items;
    assert.deepEqual(
      {
        roleId: item.currentTarget.id,
        targetRoleId: item.source.identity.targetRoleId,
        headRefOid: item.source.current.headRefOid,
        scopeKind: item.source.scope.kind,
      },
      {
        roleId,
        targetRoleId: roleId,
        headRefOid: PR_HEAD_A,
        scopeKind: "owner_requested",
      },
    );
  }
});

test("trusted authored PR lifecycle work reaches its developer and tester", async () => {
  const cases = [
    {
      roleId: "developer",
      ruleId: AUTHORED_PR_SELF_FIX_RULE_ID,
      payload: {
        relation: "authored",
        actionState: "action_now",
        nextAction: "address_review",
      },
    },
    {
      roleId: "tester",
      ruleId: AUTHORED_PR_APPROVED_RULE_ID,
      payload: {
        relation: "authored",
        actionState: "waiting_other",
        nextAction: "wait_merge",
        reviewDecision: "APPROVED",
      },
    },
    {
      roleId: "tester",
      ruleId: REVIEWED_PR_APPROVED_RULE_ID,
      payload: {
        relation: "review_requested",
        actionState: "waiting_other",
        nextAction: "wait_merge",
        myReviewState: "APPROVED",
      },
    },
  ];
  for (const { roleId, ruleId, payload } of cases) {
    const assignment = prAssignment(1, { gitFacts: payload });
    assignment.assignment.target = { type: "role", id: roleId };
    assignment.assignment.ruleId = ruleId;
    assignment.assignment.reason = `authored-pr-${roleId}`;
    const fixture = await createFixture({ records: [assignment] });

    await fixture.service.intake({ limit: 10 });

    const [item] = (await fixture.service.listItems({ limit: 10 })).items;
    assert.equal(item.currentTarget.id, roleId);
    assert.equal(item.source.identity.targetRoleId, roleId);
    assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  }
});

test("automatic scope lifecycle ignores a same-PR specialist root with a different work key", async () => {
  const developer = prAssignment(1, {
    gitFacts: {
      relation: "authored",
      actionState: "action_now",
      nextAction: "address_review",
    },
  });
  developer.assignment.target = { type: "role", id: "developer" };
  developer.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  developer.assignment.reason = "authored-pr-self-fix";
  const fixture = await createFixture({ records: [developer] });
  await fixture.service.intake();

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  const result = await fixture.service.intake();
  const [root] = (await fixture.service.listItems()).items;

  assert.equal(result.cursor, 2);
  assert.equal(root.currentTarget.id, "developer");
  assert.equal(root.source.identity.targetRoleId, "developer");
  assert.equal(root.source.scope.active, true);
});

test("an authored PR can hand off from review to self-fix and then testing", async () => {
  const review = prAssignment(1, {
    gitFacts: {
      relation: "authored",
      actionState: "waiting_other",
      nextAction: "wait_review",
    },
  });
  const fixture = await createFixture({ records: [review] });
  await fixture.service.intake({ limit: 10 });

  const selfFix = prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: {
      relation: "authored",
      actionState: "action_now",
      nextAction: "address_review",
      reviewDecision: "CHANGES_REQUESTED",
    },
  });
  selfFix.assignment.target = { type: "role", id: "developer" };
  selfFix.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  selfFix.assignment.reason = "authored-pr-self-fix";
  fixture.source.records.push(selfFix);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });

  const testing = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    gitFacts: {
      ...prGitFacts(PR_HEAD_B, { headRefName: "fix/review-feedback" }),
      relation: "authored",
      actionState: "waiting_other",
      nextAction: "wait_merge",
      reviewDecision: "APPROVED",
    },
  });
  testing.assignment.target = { type: "role", id: "tester" };
  testing.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  testing.assignment.reason = "authored-pr-approved";
  fixture.source.records.push(testing);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });

  const roots = (await fixture.service.listItems({ limit: 10 })).items.filter(
    (item) => item.kind === "source_root",
  );
  const active = roots.filter((item) => item.status === "queued");
  assert.equal(active.length, 1);
  assert.equal(active[0].currentTarget.id, "tester");
  assert.equal(active[0].source.current.headRefOid, PR_HEAD_B);
  assert.equal(
    roots.filter(
      (item) =>
        item.status === "blocked" &&
        item.statusReason === "pr_source_cross_root_cutover_retired",
    ).length,
    2,
  );
});

test("automatic left-scope after an owner request revokes only the automatic source", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const ownerBeforeExit = roots.find(
    ({ source }) => source.scope.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(ownerBeforeExit);

  const leftEvent = prAssignment(3, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(3, leftEvent));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const automatic = roots.find(({ source }) => source.scope.kind === "automatic");
  assert.equal(owner.status, "queued");
  assert.equal(owner.source.scope.active, true);
  assert.equal(automatic.status, "blocked");
  assert.equal(automatic.source.scope.active, false);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("cross-source assignment order outranks an older owner event timestamp", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      occurredAt: "2026-08-02T01:20:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);
  fixture.source.records.push(ownerRequestedPrAssignment(2, {
    occurredAt: "2026-08-02T01:10:00.000Z",
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("an owner-requested dual read anchors a new Head before automatic discovery catches up", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      headRefOid: PR_HEAD_A,
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);
  fixture.source.records.push(ownerRequestedPrAssignment(2, {
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);
  assert.equal(owner.source.current.headRefOid, PR_HEAD_B);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("an unavailable automatic source cannot revoke a valid owner source", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);

  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("a retired owner source never revives its old binding when the successor is fenced", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const ownerBinding = prExecutionBinding(owner);

  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const automatic = roots.find(({ source }) => source.scope.kind === "automatic");
  const automaticBinding = prExecutionBinding(automatic);
  assert.equal(
    roots.find(({ source }) => source.scope.kind === "owner_requested")
      .statusReason,
    "pr_source_cross_root_cutover_retired",
  );

  fixture.source.records.push(prAssignment(4, {
    occurredAt: "2026-08-02T01:20:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  for (const binding of [ownerBinding, automaticBinding]) {
    await assert.rejects(
      fixture.service.verifyPullRequestExecutionBinding(binding),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
});

test("a forged PR scope lifecycle assignment cannot revoke automatic authority", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const forgedEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const forged = prScopeLifecycleAssignment(2, forgedEvent);
  forged.assignment.priority -= 1;
  const fixture = await createFixture({ records: [initial, forged] });

  await fixture.service.intake();
  const items = (await fixture.service.listItems()).items;
  const root = items.find(({ kind }) => kind === "source_root");

  assert.equal(root.source.scope.active, true);
  assert.equal(root.source.authorityEpoch, 1);
  assert.equal(items.length, 1);
  assert.equal((await fixture.service.getSummary()).intakeCursor, 2);
});

test("inactive PR scope and its authority epoch survive restart", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const source = new FakeAssignmentSource([
    initial,
    prScopeLifecycleAssignment(2, leftEvent),
  ]);
  const store = new MemoryStore();
  const first = await createFixture({ source, store });
  await first.service.intake();

  const recovered = await createFixture({ source, store });
  const root = (await recovered.service.listItems()).items[0];

  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.authorityEpoch, 2);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a re-entry route split across intake pages still restores queued work", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const created = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, created.event),
    created,
  );
  fixture.source.highWatermark = 4;

  await fixture.service.intake({ limit: 1 });
  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_reentered_scope_without_route");
  await fixture.service.intake({ limit: 1 });
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.statusReason, "pr_source_reentered_scope");
  assert.equal(root.source.authorityEpoch, 3);
});

test("a backlog may leave and re-enter PR scope in one atomic intake", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const created = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    prScopeLifecycleAssignment(3, created.event),
    created,
  );
  fixture.source.highWatermark = 4;

  await fixture.service.intake({ limit: 10 });
  const root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, true);
  assert.equal(root.source.scope.revision, 3);
  assert.equal(root.source.authorityEpoch, 3);
  assert.equal(root.status, "queued");
});

test("leaving PR scope atomically fails an unsealed pending action", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  const outbox = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "blocked");
  assert.equal(root.activeIntentId, null);
  assert.equal(outbox.status, "failed");
  assert.equal(
    outbox.outcome.details.reason,
    "pr_source_superseded_before_dispatch",
  );
});

test("a sealed action can settle after scope exit but cannot restore PR authority", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "dispatch_pending");
  assert.equal(root.statusReason, "pr_source_left_scope_pending_settlement");
  assert.equal(root.activeIntentId, sealed.intentId);

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "sealed-before-left-scope" },
  });
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "completed");
  assert.equal(root.activeIntentId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(
      oldBinding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("PR execution verification rereads shared durable state before every decision", async () => {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new FakeAssignmentSource([prAssignment(1)]);
  const first = await createFixture({ store, lease, source });
  await first.service.intake();
  const headAItem = (await first.service.listItems()).items[0];
  const headABinding = prExecutionBinding(headAItem);

  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBinding(headABinding),
    headABinding,
  );

  source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  source.highWatermark = 2;
  const second = await createFixture({ store, lease, source });
  await second.service.intake();
  const headBItem = (await second.service.listItems()).items[0];
  const headBBinding = prExecutionBinding(headBItem);

  await assert.rejects(
    first.service.verifyPullRequestExecutionBinding(headABinding),
    (error) => error?.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBinding(headBBinding),
    headBBinding,
  );
});

test("PR execution bindings are batch-verified against one exact ledger revision", async () => {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new FakeAssignmentSource([prAssignment(1)]);
  const first = await createFixture({ store, lease, source });
  await first.service.intake();
  const headAItem = (await first.service.listItems()).items[0];
  const headABinding = prExecutionBinding(headAItem);
  const headASnapshot = await first.service.readMemoryAuthoritySnapshot();

  source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  source.highWatermark = 2;
  const second = await createFixture({ store, lease, source });
  await second.service.intake();
  const headBItem = (await second.service.listItems()).items[0];
  const headBBinding = prExecutionBinding(headBItem);

  await assert.rejects(
    first.service.verifyPullRequestExecutionBindings({
      ledgerRevision: headASnapshot.ledgerRevision,
      bindings: [headABinding],
    }),
    (error) =>
      error?.code === "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE" &&
      error?.statusCode === 409,
  );
  const currentSnapshot = await first.service.readMemoryAuthoritySnapshot();
  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBindings({
      ledgerRevision: currentSnapshot.ledgerRevision,
      bindings: [headABinding, headBBinding],
    }),
    {
      ledgerRevision: currentSnapshot.ledgerRevision,
      current: [false, true],
    },
  );
});

test("a new PR Head clears an answered old-Head decision while same-Head facts preserve it", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const attentionResult = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [attentionResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let root = (await fixture.service.listItems()).items[0];
  const oldHeadDecision = structuredClone(root.decisionContext);
  assert.equal(oldHeadDecision.source, "attention");
  assert.deepEqual(oldHeadDecision.value.answer, {
    type: "choice",
    choiceId: "yes",
  });

  fixture.source.records.push(
    prAssignment(2, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "SUCCESS",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.activeRevision, 2);
  assert.equal(root.source.headRevision, 1);
  assert.deepEqual(root.decisionContext, oldHeadDecision);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.activeRevision, 3);
  assert.equal(root.source.headRevision, 2);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.decisionContext, null);
});

test("a new PR Head clears a completed old-Head proposal result", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const proposalResult = await prepareProposalResult(fixture, {
    roleId: "pr-engineer",
    workerId: "employee-pr-engineer",
  });
  await fixture.service.applyProposalBatch({
    items: [proposalResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "completed");
  assert.equal(root.decisionContext.source, "proposal");

  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.decisionContext, null);
});

for (const claimedByDispatcher of [false, true]) {
  const stateName = claimedByDispatcher ? "unbound dispatching" : "pending";
  test(`a new PR Head atomically supersedes a ${stateName} old-Head intent`, async () => {
    const fixture = await createFixture({ records: [prAssignment(1)] });
    await fixture.service.intake();
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    const staged = await fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-engineer",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    });
    if (claimedByDispatcher) {
      await fixture.service.claimIntent({
        intentId: staged.outbox.intentId,
        expectedRevision: staged.outbox.revision,
        dispatcherId: "work-intent-dispatcher",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(
      prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: PR_HEAD_B,
        previousHeadRefOid: PR_HEAD_A,
        changedFields: ["headRefOid"],
      }),
    );
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    const root = (await fixture.service.listItems()).items[0];
    const outbox = (await fixture.service.listOutbox()).items[0];
    assert.equal(root.itemId, item.itemId);
    assert.equal(root.status, "queued");
    assert.equal(root.activeIntentId, null);
    assert.equal(root.source.activeRevision, 2);
    assert.equal(root.source.pendingRevision, null);
    assert.equal(root.source.current.headRefOid, PR_HEAD_B);
    assert.equal(outbox.status, "failed");
    assert.equal(outbox.sourceBinding.inputRevision, 1);
    assert.equal(outbox.sourceBinding.headRevision, 1);
    assert.equal(outbox.sourceBinding.headRefOid, PR_HEAD_A);
    assert.equal(
      outbox.outcome.details.reason,
      "pr_source_superseded_before_dispatch",
    );
    assert.equal(outbox.dispatchLeaseId, null);

    const recovered = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await recovered.recover();
    assert.equal(
      (await recovered.listOutbox()).items[0].sourceBinding.headRefOid,
      PR_HEAD_A,
    );
  });
}

test("a sealed old-Head intent blocks cutover until its result is reconciled", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const attentionResult = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [attentionResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let item = (await fixture.service.listItems()).items[0];
  assert.equal(item.decisionContext.source, "attention");
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  assert.equal(root.activeIntentId, sealed.intentId);
  const pendingTimeline = (await fixture.service.listTimeline({
    limit: 100,
    order: "newest",
  })).items.find(({ type }) => type === "pr_source_revised");
  assert.deepEqual(
    {
      currentHeadRevision: pendingTimeline.details.currentHeadRevision,
      currentHeadRefOid: pendingTimeline.details.currentHeadRefOid,
      pendingHeadRevision: pendingTimeline.details.pendingHeadRevision,
      pendingHeadRefOid: pendingTimeline.details.pendingHeadRefOid,
    },
    {
      currentHeadRevision: 1,
      currentHeadRefOid: PR_HEAD_A,
      pendingHeadRevision: 2,
      pendingHeadRefOid: PR_HEAD_B,
    },
  );
  assert.equal(
    pendingTimeline.details.headRevision,
    pendingTimeline.details.currentHeadRevision,
  );
  assert.equal(
    pendingTimeline.details.headRefOid,
    pendingTimeline.details.currentHeadRefOid,
  );
  const writesBeforeBlockedReconciliation = fixture.store.writes.length;
  assert.deepEqual(
    await fixture.service.reconcilePullRequestSourceBatch({
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      items: [{
        itemId: root.itemId,
        expectedRevision: root.revision,
        expectedPendingRevision: 2,
      }],
    }),
    {
      outcomes: [{ itemId: root.itemId, status: "blocked" }],
      stoppedAfterWrite: false,
    },
  );
  assert.equal(fixture.store.writes.length, writesBeforeBlockedReconciliation);
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(blocked.applied, false);
  assert.deepEqual(blocked.blockers, [{
      itemId: root.itemId,
      status: "dispatch_pending",
      reason: "active_intent",
      activeIntentId: sealed.intentId,
    }]);
  assert.equal(fixture.store.writes.length, writesBeforeBlockedReconciliation);

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-1" },
  });
  root = (await fixture.service.listItems()).items[0];
  const activationCommand = {
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  assert.deepEqual(
    await fixture.service.reconcilePullRequestSourceBatch({
      expectedGraphRevision: activationCommand.expectedGraphRevision,
      items: [{
        itemId: activationCommand.itemId,
        expectedRevision: activationCommand.expectedRevision,
        expectedPendingRevision: activationCommand.expectedPendingRevision,
      }],
    }),
    {
      outcomes: [{ itemId: root.itemId, status: "applied" }],
      stoppedAfterWrite: true,
    },
  );
  const writesAfterActivation = fixture.store.writes.length;
  const timelineAfterActivation = (await fixture.service.listTimeline({
    limit: 100,
  })).items.length;
  const replay = await fixture.service.reconcilePullRequestSource(
    activationCommand,
  );
  assert.equal(replay.applied, false);
  assert.equal(replay.activeRevision, 2);
  assert.equal(fixture.store.writes.length, writesAfterActivation);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 100 })).items.length,
    timelineAfterActivation,
  );

  root = (await fixture.service.listItems()).items[0];
  const historical = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pending, null);
  assert.equal(root.decisionContext, null);
  assert.equal(historical.status, "delivered");
  assert.equal(historical.sourceBinding.headRefOid, PR_HEAD_A);
});

test("pending PR source discovery is filtered before paging and survives restart", async () => {
  const ordinary = Array.from({ length: 130 }, (_, index) =>
    assignment(index + 1, { type: "role", id: "requirements-analyst" })
  );
  const fixture = await createFixture({
    records: [...ordinary, prAssignment(131)],
  });
  await fixture.service.intake({ limit: 100 });
  await fixture.service.intake({ limit: 100 });
  let root = (await fixture.service.listItems({ limit: 100, order: "newest" }))
    .items.find(({ source }) => source?.kind === "pull_request");
  assert.ok(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(prAssignment(132, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 132;
  await fixture.service.intake({ limit: 100 });

  assert.equal(
    (await fixture.service.listItems({ limit: 100 })).items.some(
      ({ source }) =>
        source?.kind === "pull_request" && source.pendingRevision !== null,
    ),
    false,
  );
  let pending = await fixture.service.listPendingPullRequestSources({
    limit: 100,
  });
  assert.deepEqual(pending.items.map(({ itemId }) => itemId), [root.itemId]);
  assert.equal(pending.nextCursor, null);

  const recovered = await createFixture({
    source: fixture.source,
    store: fixture.store,
    time: fixture.time,
  });
  pending = await recovered.service.listPendingPullRequestSources({ limit: 1 });
  assert.deepEqual(pending.items.map(({ itemId }) => itemId), [root.itemId]);
  root = pending.items[0];
  await recovered.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    itemExpectedRevision: root.revision,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-paged" },
  });
  root = (await recovered.service.listPendingPullRequestSources({ limit: 1 }))
    .items[0];
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: (await recovered.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: root.source.pendingRevision,
  };
  const outcomes = await Promise.all([
    recovered.service.reconcilePullRequestSource(command),
    recovered.service.reconcilePullRequestSource(command),
  ]);
  assert.deepEqual(outcomes.map(({ applied }) => applied).sort(), [false, true]);
  assert.deepEqual(
    await recovered.service.listPendingPullRequestSources({ limit: 100 }),
    { items: [], nextCursor: null },
  );
});

async function stageSealedPrReview(fixture, itemId = null) {
  await fixture.service.intake();
  const items = (await fixture.service.listItems({ limit: 100 })).items;
  let root = itemId === null
    ? items[0]
    : items.find((item) => item.itemId === itemId);
  assert.notEqual(root, undefined);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const outbox = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  return { outbox, rootItemId: staged.item.itemId };
}

async function stageSealedPrChildReview(fixture) {
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    roleId: "developer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const outbox = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "developer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  return { childItemId: child.itemId, outbox };
}

test("same-root cutover releases durably rejected attention", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const result = await prepareAttentionResult(
    fixture,
    { type: "reject", reason: "需求需要重新梳理" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pendingRevision, null);
});

for (const nextStatus of ["blocked", "retry_wait"]) {
  test(`same-root cutover releases a definitively failed ${nextStatus} action`, async () => {
    const fixture = await createFixture({ records: [prAssignment(1)] });
    const sealed = await stageSealedPrReview(fixture);
    let root = (await fixture.service.listItems()).items.find(
      ({ itemId }) => itemId === sealed.rootItemId,
    );
    await fixture.service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: root.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "failed",
      nextStatus,
      ...(nextStatus === "retry_wait"
        ? { availableAt: "2026-08-02T02:01:00.000Z" }
        : {}),
      details: { code: "definite_downstream_rejection" },
    });
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }));
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    root = (await fixture.service.listItems()).items[0];
    assert.equal(root.status, "queued");
    assert.equal(root.source.current.headRefOid, PR_HEAD_B);
    assert.equal(root.source.pendingRevision, null);
  });
}

for (const [destination, initialStatus] of [
  ["new", "queued"], ["existing", "queued"],
  ["new", "completed"], ["existing", "completed"],
]) {
  test(`one intake batch revises and retires a ${initialStatus} PR root once when moving to a ${destination} root`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    });
    await fixture.service.intake();
    let sequence = 1;
    if (destination === "existing") {
      for (const sourceScopeId of ["github-secondary", "github-dashboard"]) {
        sequence += 1;
        fixture.source.records.push(prAssignment(sequence, {
          sourceScopeId,
          occurredAt: `2026-08-02T01:0${sequence}:00.000Z`,
          gitFacts: prGitFacts(PR_HEAD_A),
        }));
        fixture.source.highWatermark = sequence;
        await fixture.service.intake();
      }
    }
    fixture.source.records.push(issueAssignment(++sequence, { issueNumber: 99 }));
    fixture.source.highWatermark = sequence;
    await fixture.service.intake();
    let before = (await fixture.service.listItems({ limit: 10 })).items.find(
      ({ source }) => source?.identity.scopeId === "github-dashboard",
    );
    if (initialStatus === "completed") {
      const claimed = await fixture.service.claim({
        itemId: before.itemId,
        expectedRevision: before.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
      before = await fixture.service.complete({
        itemId: claimed.itemId,
        expectedRevision: claimed.revision,
        leaseId: claimed.leaseId,
        actorId: "employee-pr-engineer",
        result: { outcome: "completed-before-new-observations" },
      });
    }
    const previousState = fixture.store.stored();
    const update = prAssignment(++sequence, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      ciStatus: "SUCCESS",
      gitFacts: prGitFacts(PR_HEAD_A),
    });
    const replacement = prAssignment(++sequence, {
      sourceScopeId: "github-secondary",
      occurredAt: "2026-08-02T01:11:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    });
    const following = issueAssignment(++sequence);
    fixture.source.records.push(update, replacement, following);
    fixture.source.highWatermark = sequence;

    const result = await fixture.service.intake();

    assert.equal(result.error, undefined);
    assert.equal(result.received, 3);
    assert.equal(result.cursor, sequence);
    const items = (await fixture.service.listItems({ limit: 10 })).items;
    const retired = items.find(({ itemId }) => itemId === before.itemId);
    assert.equal(retired.revision, before.revision + 1);
    assert.equal(retired.statusReason, "pr_source_cross_root_cutover_retired");
    assert.ok(retired.source.bindings.some(
      ({ assignmentId }) => assignmentId === update.assignment.assignmentId,
    ));
    assert.ok(items.some(
      ({ assignmentId }) => assignmentId === following.assignment.assignmentId,
    ));
    assert.equal(items.filter(({ source }) =>
      source?.kind === "pull_request" && source.identity.scopeId === "github-secondary"
    ).length, 1);
    if (initialStatus === "completed") {
      const committed = fixture.store.stored();
      for (const tamper of [
        (state) => {
          state.items.find(({ itemId }) => itemId === retired.itemId)
            .source.activeRevision = before.source.activeRevision;
        },
        (state) => {
          const successor = state.items.find(({ source }) =>
            source?.identity.scopeId === "github-secondary"
          );
          successor.source.current.sourceSequence = retired.source.current.sourceSequence;
        },
      ]) {
        const forged = clone(committed);
        tamper(forged);
        assert.throws(() => validateWorkLedgerGraphTransition(previousState, forged));
      }
    }
    assert.equal((await fixture.service.intake()).received, 0);
  });
}

for (const predecessorStatus of ["queued", "working"]) {
  test(`cross-root cutover retires a ${predecessorStatus} predecessor atomically`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    });
    await fixture.service.intake();
    let predecessor = (await fixture.service.listItems()).items[0];
    if (predecessorStatus === "working") {
      predecessor = await fixture.service.claim({
        itemId: predecessor.itemId,
        expectedRevision: predecessor.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    const roots = (await fixture.service.listItems({ limit: 10 })).items;
    const retired = roots.find(({ itemId }) => itemId === predecessor.itemId);
    const active = roots.find(({ itemId }) => itemId !== predecessor.itemId);
    assert.equal(retired.status, "blocked");
    assert.equal(retired.ownerId, null);
    assert.equal(retired.leaseId, null);
    assert.equal(retired.leaseUntil, null);
    assert.equal(retired.activeIntentId, null);
    assert.equal(active.status, "queued");
    const claimed = await fixture.service.claim({
      itemId: active.itemId,
      expectedRevision: active.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    assert.equal(claimed.status, "working");
  });
}

async function rejectBoundPullRequestProposal(fixture, sealed) {
  const {
    intentId: proposalId,
    ...proposalContent
  } = sealed.outbox.dispatchBinding.boundIntent;
  const proposal = normalizeBoundWorkProposal({
    proposalId,
    ...proposalContent,
  });
  const sealedItemId = sealed.rootItemId ?? sealed.childItemId;
  let predecessor = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === sealedItemId,
  );
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: predecessor.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "waiting_external",
    details: {
      downstreamRef: proposal.proposalId,
      proposalDigest: proposal.contentDigest,
    },
  });
  await fixture.service.applyProposalBatch({
    items: [createWorkProposalResult({
      proposal,
      sequence: 1,
      transition: {
        status: "rejected",
        summary: "所有者拒绝旧提案",
        evidence: [],
      },
      downstreamRef: "confirmation-rejected-cross-root",
      at: fixture.time.clock(),
    })],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  predecessor = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  assert.equal(predecessor.status, "blocked");
  assert.equal(predecessor.statusReason, "proposal_rejected");
  return predecessor;
}

async function rejectSealedPullRequestProposal(fixture) {
  return rejectBoundPullRequestProposal(
    fixture,
    await stageSealedPrReview(fixture),
  );
}

test("an owner-requested PR root retires a durably rejected proposal predecessor", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);

  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const retired = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const active = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(retired.status, "blocked");
  assert.equal(retired.statusReason, "pr_source_cross_root_cutover_retired");
  assert.equal(active.status, "queued");
  assert.equal(active.statusReason, null);
});

test("an owner-requested PR root supersedes a child with a durably rejected proposal", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrChildReview(fixture);
  const rejectedChild = await rejectBoundPullRequestProposal(fixture, sealed);
  const predecessor = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ kind }) => kind === "source_root");
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const retired = items.find(({ itemId }) => itemId === predecessor.itemId);
  const child = items.find(({ itemId }) => itemId === rejectedChild.itemId);
  const active = items.find(
    ({ kind, itemId }) => kind === "source_root" && itemId !== retired.itemId,
  );
  assert.equal(
    retired.statusReason,
    "pr_source_cross_root_cutover_retired",
  );
  assert.equal(child.status, "superseded");
  assert.equal(child.statusReason, "pr_head_superseded");
  assert.equal(active.status, "queued");
});

test("an intervening source audit in the same intake batch keeps rejected proposal cutover blocked", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  fixture.source.records.push(
    prAssignment(2, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T00:59:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "FAILURE",
    }),
    ownerRequestedPrAssignment(3),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.match(blocked.source.revisions.at(-1).disposition, /^ignored_/);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
  );
});

test("a persisted rejected-proposal blocker recovers through restart and real reconciliation", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const predecessorId = sealed.rootItemId;
  const pendingId = roots.find(({ itemId }) => itemId !== predecessorId).itemId;
  await rejectBoundPullRequestProposal(fixture, sealed);

  const legacy = fixture.store.stored();
  const legacyPredecessor = legacy.items.find(
    ({ itemId }) => itemId === predecessorId,
  );
  legacyPredecessor.statusReason = crossRootPullRequestCutoverBlockerReason(
    pendingId,
  );
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let pending = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingId,
  );

  const result = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pending.revision,
    expectedPendingRevision:
      pending.source.pendingRevision ?? pending.source.activeRevision,
  });

  assert.equal(result.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const predecessor = roots.find(({ itemId }) => itemId === predecessorId);
  pending = roots.find(({ itemId }) => itemId === pendingId);
  assert.equal(
    predecessor.statusReason,
    "pr_source_cross_root_cutover_retired",
  );
  assert.equal(pending.status, "queued");
  assert.equal(pending.statusReason, "pr_source_cutover_activated");
});

test("a rejected proposal stays blocked after its retained proof rotates out", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit: 6 },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  fixture.source.records.push(
    ...Array.from({ length: 7 }, (_, index) => assignment(index + 2)),
  );
  fixture.source.highWatermark = 8;
  await fixture.service.intake();
  assert.equal(
    (await fixture.service.listTimeline({ limit: 20 })).items.some(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    ),
    false,
  );

  fixture.source.records.push(ownerRequestedPrAssignment(9));
  fixture.source.highWatermark = 9;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
  );
});

test("same-intake retention rotation cannot release a rejected proposal cutover", async () => {
  const timelineLimit = 6;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 2),
    ),
    ownerRequestedPrAssignment(fillerCount + 2),
  );
  fixture.source.highWatermark = fillerCount + 2;

  await fixture.service.intake();

  const retainedTimeline = (await fixture.service.listTimeline({ limit: 20 }))
    .items;
  assert.equal(
    retainedTimeline.some(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    ),
    false,
  );
  const roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
  );
});

for (const targetPosition of ["first", "middle", "boundary"]) {
  test(`same-intake ${targetPosition} cutover cannot rely on proof evicted before commit`, async () => {
    const timelineLimit = 6;
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
      limits: { timelineLimit },
    });
    const predecessor = await rejectSealedPullRequestProposal(fixture);
    const before = fixture.store.stored();
    const proofIndex = before.timeline.findIndex(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    );
    assert.notEqual(proofIndex, -1);
    const eventsAfterProof = before.timeline.length - proofIndex - 1;
    const eventsNeededToEvict = timelineLimit - eventsAfterProof;
    assert.ok(eventsNeededToEvict > 1);
    const beforeCount = targetPosition === "first"
      ? 0
      : targetPosition === "middle"
        ? Math.floor(eventsNeededToEvict / 2)
        : eventsNeededToEvict - 1;
    const afterCount = targetPosition === "boundary"
      ? 0
      : eventsNeededToEvict - beforeCount;
    let nextSequence = 2;
    const beforeAssignments = Array.from(
      { length: beforeCount },
      () => assignment(nextSequence++),
    );
    const ownerAssignment = ownerRequestedPrAssignment(nextSequence++);
    const afterAssignments = Array.from(
      { length: afterCount },
      () => assignment(nextSequence++),
    );
    fixture.source.records.push(
      ...beforeAssignments,
      ownerAssignment,
      ...afterAssignments,
    );
    fixture.source.highWatermark = nextSequence - 1;

    await fixture.service.intake();

    const retainedTimeline = (
      await fixture.service.listTimeline({ limit: 20 })
    ).items;
    assert.equal(
      retainedTimeline.some(
        ({ itemId, type }) =>
          itemId === predecessor.itemId && type === "proposal_result_applied",
      ),
      false,
    );
    const roots = (await fixture.service.listItems({ limit: 20 })).items
      .filter(({ kind }) => kind === "source_root");
    const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
    const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
    assert.equal(
      blocked.statusReason,
      `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
    );
    assert.equal(pending.status, "blocked");
    assert.equal(
      pending.statusReason,
      `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
    );
  });
}

test("direct reconciliation cannot rely on proof evicted by its activation event", async () => {
  const timelineLimit = 12;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const predecessor = await rejectBoundPullRequestProposal(fixture, sealed);
  let stored = fixture.store.stored();
  const pending = stored.items.find(
    ({ kind, itemId }) =>
      kind === "source_root" && itemId !== predecessor.itemId,
  );
  const proofIndex = stored.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = stored.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 3),
    ),
  );
  fixture.source.highWatermark = fillerCount + 2;
  await fixture.service.intake();
  stored = fixture.store.stored();
  const storedPredecessor = stored.items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  storedPredecessor.statusReason = crossRootPullRequestCutoverBlockerReason(
    pending.itemId,
  );
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { timelineLimit },
  });
  await recovered.recover();
  const currentPending = (await recovered.listItems({ limit: 20 })).items
    .find(({ itemId }) => itemId === pending.itemId);

  const result = await recovered.reconcilePullRequestSource({
    itemId: currentPending.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: currentPending.revision,
    expectedPendingRevision:
      currentPending.source.pendingRevision ??
      currentPending.source.activeRevision,
  });

  assert.equal(result.applied, false);
  const roots = (await recovered.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === pending.itemId).statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("a new authority fence registers a predecessor whose proof expires before commit", async () => {
  const timelineLimit = 24;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    prAssignment(2, {
      sourceScopeId: "github-secondary",
      gitFacts: { gitTargetAvailable: false },
    }),
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 3),
    ),
  );
  fixture.source.highWatermark = fillerCount + 2;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 50 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("an existing authority fence registers a predecessor whose proof expires before commit", async () => {
  const timelineLimit = 24;
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
    limits: { timelineLimit },
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const existing = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const predecessorRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const predecessor = await rejectBoundPullRequestProposal(
    fixture,
    await stageSealedPrReview(fixture, predecessorRoot.itemId),
  );
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    prAssignment(3, {
      sourceScopeId: "github-dashboard",
      gitFacts: { gitTargetAvailable: false },
    }),
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 4),
    ),
  );
  fixture.source.highWatermark = fillerCount + 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 50 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const pending = roots.find(({ itemId }) => itemId === existing.itemId);
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("a later durable transition keeps stale rejected-proposal context blocked across restart", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  let predecessor = await rejectSealedPullRequestProposal(fixture);
  predecessor = await fixture.service.transition({
    itemId: predecessor.itemId,
    expectedRevision: predecessor.revision,
    leaseId: null,
    actorId: "work-ledger-system",
    toStatus: "queued",
    reason: "owner_reopened_after_rejection",
  });
  predecessor = await fixture.service.transition({
    itemId: predecessor.itemId,
    expectedRevision: predecessor.revision,
    leaseId: null,
    actorId: "work-ledger-system",
    toStatus: "blocked",
    reason: "proposal_rejected",
  });
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await recovered.intake();

  const roots = (await recovered.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
});

test("a self-consistent forged rejected-proposal context without matching evidence stays blocked", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const forged = fixture.store.stored();
  const forgedItem = forged.items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  forgedItem.decisionContext = createWorkDecisionContext({
    source: "proposal",
    referenceId: `work-intent-${"f".repeat(64)}`,
    outcome: "rejected",
    value: { summary: "self-consistent but unattested replacement" },
    observedAt: fixture.time.clock(),
  });
  fixture.store.replaceStored(forged);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await recovered.intake();

  const roots = (await recovered.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
});

for (const cutover of ["same-root-head", "cross-provenance-root"]) {
  test(`${cutover} invalidates old PR memory through the durable system pipeline`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        title: "PR authority memory fixture",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    let root = (await fixture.service.listItems({ limit: 10 })).items[0];
    await fixture.service.reviseGraphAcceptance({
      authority: {
        actorId: "employee-orchestrator",
        scopeRootTaskId: root.itemId,
      },
      command: {
        taskId: root.itemId,
        acceptanceContract: {
          revision: 2,
          acceptanceCriteria: [{
            criterionId: "old-authority-proof",
            description: "Old authority conclusion must never survive cutover",
          }],
          expectedDeliverables: [],
        },
        reason: "memory-authority-integration",
        expectedGraphRevision: (await fixture.service.getSummary()).revision,
        expectedTaskRevision: root.revision,
      },
    });
    const pendingBeforeProjection =
      await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 });
    const contractEvent = pendingBeforeProjection.items.find(
      ({ kind }) => kind === "acceptance_contract",
    );
    assert.notEqual(contractEvent, undefined);
    const oldContractId = workGraphMemoryRecordReceipt(contractEvent)
      .memoryRecordId;
    const memory = await createLedgerMemoryPipeline(fixture.service);
    await memory.projector.runCycle();
    const oldWorkId = memory.journal.search({
      eventType: "work.queued",
      repository: "acme/repo",
    }).items[0].id;
    const sealedWork = memory.journal.readRecords({
      recordIds: [oldWorkId],
    }).items[0].record;
    const sealedAuthority = JSON.parse(sealedWork.content).sourceAuthority;
    assert.equal(sealedAuthority.executionBinding.schemaVersion, 2);
    assert.equal(sealedAuthority.executionBinding.gitTarget.headRefOid, PR_HEAD_A);
    assert.deepEqual(sealedAuthority.provenance, {
      provider: "github",
      scopeId: "github-dashboard",
    });
    const prTimeline = memory.journal.search({
      q: "工作时间线",
      repository: "acme/repo",
    });
    assert.equal(prTimeline.items.length, 0);
    assert.deepEqual(
      memory.journal.readRecords({ recordIds: [oldWorkId, oldContractId] })
        .items.map(({ labels }) => labels.lifecycle),
      ["current", "current"],
    );

    fixture.source.records.push(
      cutover === "same-root-head"
        ? prAssignment(2, {
            occurredAt: "2026-08-02T01:05:00.000Z",
            title: "PR authority memory fixture",
            headRefOid: PR_HEAD_B,
            previousHeadRefOid: PR_HEAD_A,
            changedFields: ["headRefOid"],
            gitFacts: prGitFacts(PR_HEAD_B),
          })
        : prAssignment(2, {
            occurredAt: "2026-08-02T01:05:00.000Z",
            title: "PR authority memory fixture",
            sourceScopeId: "github-secondary",
            gitFacts: prGitFacts(PR_HEAD_A),
          }),
    );
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    const authorityTail =
      await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 });
    assert.equal(
      authorityTail.items.some(({ kind }) => kind === "authority_invalidated"),
      true,
    );

    const standalone = await restartStandaloneMemoryRuntime(memory.store);
    for (const operation of [
      () => standalone.search.search({
        q: "Old authority conclusion must never survive cutover",
        repository: "acme/repo",
      }),
      () => standalone.contextReader.readRecords({
        recordIds: [oldWorkId, oldContractId],
      }),
    ]) {
      await assert.rejects(
        operation,
        (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
      );
    }
    const generateCalls = [];
    await assert.rejects(
      memoryAnswerForRuntime(standalone, generateCalls).answer({
        schemaVersion: 1,
        question: "Can the old PR conclusion still be used?",
        mode: "configured",
        retrieval: {
          kind: "query",
          filters: {
            query: "Old authority conclusion must never survive cutover",
            repository: "acme/repo",
          },
        },
      }),
      (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
    );
    assert.deepEqual(generateCalls, []);
    await standalone.close();

    const staleAuthoritativeRuntime = await restartMemoryRuntime(
      fixture.service,
      memory.store,
    );
    await assert.rejects(
      staleAuthoritativeRuntime.search.search({ repository: "acme/repo" }),
      (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
    );
    await staleAuthoritativeRuntime.close();

    await memory.projector.runCycle();
    assert.deepEqual(
      memory.journal.readRecords({ recordIds: [oldWorkId, oldContractId] })
        .items.map(({ labels }) => labels.lifecycle),
      ["obsolete", "obsolete"],
    );

    const runtime = await restartMemoryRuntime(fixture.service, memory.store);
    const currentWork = await runtime.search.search({
      q: "PR authority memory fixture",
      eventType: "work.queued",
      repository: "acme/repo",
    });
    const currentContext = await runtime.contextReader.readRecords({
      recordIds: currentWork.items.map(({ id }) => id),
    });
    assert.equal(
      currentContext.items.some(
        ({ labels }) => labels.lifecycle === "current",
      ),
      true,
    );
    const packet = await new MemoryContextRetriever({
      memorySearch: { search: runtime.search.search },
      contextReader: runtime.contextReader,
    }).retrieve({
      question: "Can the old authority conclusion still be used?",
      retrieval: {
        kind: "query",
        filters: {
          query: "Old authority conclusion must never survive cutover",
          repository: "acme/repo",
        },
      },
    });
    assert.equal(
      packet.records.some(({ recordId }) => recordId === oldContractId),
      true,
    );
    assert.equal(packet.citableRecordIds.includes(oldContractId), false);
    await runtime.close();
  });
}

test("a fenced pending Head immediately makes the active Head memory non-citable", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "Pending Head memory fixture",
    })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "pending-head",
          description: "Pending Head must fence this conclusion",
        }],
        expectedDeliverables: [],
      },
      reason: "pending-head-memory",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const contractEvent = (await fixture.service.readGraphMemoryProjectionBatch({
    limit: 10,
  })).items.find(({ kind }) => kind === "acceptance_contract");
  const contractId = workGraphMemoryRecordReceipt(contractEvent).memoryRecordId;
  const memory = await createLedgerMemoryPipeline(fixture.service);
  await memory.projector.runCycle();
  const sealed = await stageSealedPrReview(fixture, root.itemId);
  await memory.projector.runCycle();

  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    title: "Pending Head memory fixture",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === sealed.rootItemId,
  );
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  const authorityTail = await fixture.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(authorityTail.items.at(-1).kind, "authority_invalidated");
  await memory.projector.runCycle();
  assert.equal(
    memory.journal.readRecords({ recordIds: [contractId] })
      .items[0].labels.lifecycle,
    "obsolete",
  );
  const runtime = await restartMemoryRuntime(fixture.service, memory.store);
  const packet = await new MemoryContextRetriever({
    memorySearch: { search: runtime.search.search },
    contextReader: runtime.contextReader,
  }).retrieve({
    question: "May the active old Head conclusion be cited?",
    retrieval: {
      kind: "query",
      filters: {
        query: "Pending Head must fence this conclusion",
        repository: "acme/repo",
      },
    },
  });
  assert.equal(packet.citableRecordIds.includes(contractId), false);
  await runtime.close();
});

test("memory capacity failure leaves the ledger HWM pending and every read fails closed", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "PR memory capacity fixture",
    })],
  });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "capacity-authority",
          description: "Authority lifecycle must be persisted before ack",
        }],
        expectedDeliverables: [],
      },
      reason: "memory-capacity-integration",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const maximumRecords = 40;
  const memory = await createLedgerMemoryPipeline(fixture.service, {
    maximumRecords,
  });
  await memory.projector.runCycle();
  const initialAuthority = await fixture.service.readMemoryAuthorityStatus();
  const initialCount = memory.journal.getHealth().recordCount;
  await memory.journal.appendBatch({
    records: Array.from(
      { length: maximumRecords - initialCount },
      (_, index) => ordinaryMemoryFact(index + 1),
    ),
  });
  assert.equal(memory.journal.getHealth().recordCount, maximumRecords);

  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const pendingAuthority = await fixture.service.readMemoryAuthorityStatus();
  assert.equal(pendingAuthority.graph.cursor, initialAuthority.graph.cursor);
  assert.equal(
    pendingAuthority.graph.highWatermark > pendingAuthority.graph.cursor,
    true,
  );
  await assert.rejects(
    memory.projector.runCycle(),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED",
  );
  const afterFailure = await fixture.service.readMemoryAuthorityStatus();
  assert.equal(afterFailure.graph.cursor, initialAuthority.graph.cursor);
  assert.equal(memory.journal.getHealth().recordCount, maximumRecords);

  const runtime = await restartMemoryRuntime(fixture.service, memory.store);
  await assert.rejects(
    runtime.search.search({}),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  await runtime.close();
});

test("a new PR provenance waits for the old sealed action across restart", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  let pendingRoot = roots.find(({ itemId }) => itemId !== oldRoot.itemId);
  assert.equal(oldRoot.status, "dispatch_pending");
  assert.match(oldRoot.statusReason, /^pr_source_cross_root_cutover_blocker:/);
  assert.equal(pendingRoot.status, "blocked");
  assert.equal(
    pendingRoot.statusReason,
    `pr_source_cross_root_cutover_pending:${oldRoot.itemId}`,
  );
  await assert.rejects(
    fixture.service.claim({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );
  await assert.rejects(
    fixture.service.transition({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      leaseId: null,
      actorId: "work-ledger-system",
      toStatus: "queued",
      reason: "bypass-cross-root-cutover",
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 10 })).items;
  oldRoot = roots.find(({ itemId }) => itemId === oldRoot.itemId);
  pendingRoot = roots.find(({ itemId }) => itemId === pendingRoot.itemId);
  await assert.rejects(
    recovered.claim({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: oldRoot.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-cross-root" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });

  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  oldRoot = roots.find(({ itemId }) => itemId === oldRoot.itemId);
  pendingRoot = roots.find(({ itemId }) => itemId === pendingRoot.itemId);
  assert.equal(oldRoot.status, "completed");
  assert.equal(pendingRoot.status, "queued");
  assert.equal(pendingRoot.statusReason, "pr_source_cutover_activated");
});

test("a newer provenance chains behind the same sealed predecessor", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  const pending = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  const olderPending = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  assert.equal(roots.length, 3);
  assert.equal(pending.source.identity.scopeId, "github-tertiary");
  assert.equal(pending.status, "blocked");
  assert.equal(olderPending.status, "blocked");
  assert.equal(
    olderPending.statusReason,
    `pr_source_cross_root_cutover_pending:${oldRoot.itemId}`,
  );
  assert.equal(
    oldRoot.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: olderPending.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: olderPending.revision,
      expectedPendingRevision: olderPending.source.activeRevision,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const currentOldRoot = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === oldRoot.itemId);
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: currentOldRoot.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-latest-source" },
  });
  const currentPending = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === pending.itemId);
  await fixture.service.reconcilePullRequestSource({
    itemId: currentPending.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: currentPending.revision,
    expectedPendingRevision: currentPending.source.activeRevision,
  });
  const activatedRoots = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(
    activatedRoots.find(({ itemId }) => itemId === pending.itemId).status,
    "queued",
  );
  assert.equal(
    activatedRoots.find(({ itemId }) => itemId === olderPending.itemId).status,
    "superseded",
  );
});

async function createAuditedCrossRootCandidateRace({ restart }) {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const staleA = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:06:00.000Z",
    sourceScopeId: "github-dashboard",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  const staleB = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:04:00.000Z",
    sourceScopeId: "github-secondary",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  const staleC = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:07:00.000Z",
    sourceScopeId: "github-tertiary",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(4, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(5, staleA),
    prAssignment(6, staleB),
    prAssignment(7, staleC),
    prAssignment(8, staleA),
    prAssignment(9, staleB),
    prAssignment(10, staleC),
  );
  fixture.source.highWatermark = 10;
  await fixture.service.intake();

  const service = restart
    ? new WorkLedgerService({
        store: fixture.store,
        assignmentSource: fixture.source,
        exclusiveLease: new ExclusiveLease(),
        clock: fixture.time.clock,
        idFactory: incrementingIds(),
      })
    : fixture.service;
  if (restart) await service.recover();
  roots = (await service.listItems({ limit: 10 })).items;
  const pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const pendingC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  return { pendingA, pendingC, sealed, sealedB, service };
}

for (const scenario of [
  { reconcileOrder: "older-first", restart: false },
  { reconcileOrder: "newer-first", restart: true },
]) {
  test(`audit-only bindings preserve cross-root candidate order (${scenario.reconcileOrder}, restart=${scenario.restart})`, async () => {
    const {
      pendingA,
      pendingC,
      sealed,
      sealedB,
      service,
    } = await createAuditedCrossRootCandidateRace(scenario);

    assert.deepEqual(crossRootPullRequestCutoverCandidate(pendingA), {
      inputRevision: 2,
      sourceSequence: 3,
    });
    assert.deepEqual(crossRootPullRequestCutoverCandidate(pendingC), {
      inputRevision: 1,
      sourceSequence: 4,
    });
    const tamperedPending = structuredClone(pendingA);
    tamperedPending.source.pending.sourceSequence = 8;
    assert.throws(
      () => crossRootPullRequestCutoverCandidate(tamperedPending),
      (error) =>
        error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    );
    assert.equal(pendingA.source.bindings.at(-1).sourceSequence, 8);
    assert.equal(pendingC.source.bindings.at(-1).sourceSequence, 10);
    assert.equal(sealedB.source.current.sourceSequence, 2);
    assert.equal(sealedB.source.bindings.at(-1).sourceSequence, 9);
    assert.equal(pendingA.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(pendingC.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(sealedB.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(pendingA.source.bindings.length, 4);
    assert.equal(pendingA.source.revisions.length, 3);
    assert.equal(pendingC.source.bindings.length, 3);
    assert.equal(pendingC.source.revisions.length, 2);
    assert.equal(sealedB.source.bindings.length, 3);
    assert.equal(sealedB.source.revisions.length, 2);
    assert.equal(
      sealedB.statusReason,
      `pr_source_cross_root_cutover_blocker:${pendingC.itemId}`,
    );
    const summaryBeforeAck = await service.getSummary();
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision,
        expectedRevision: pendingC.revision,
        expectedPendingRevision: pendingC.source.activeRevision + 1,
      }),
      (error) =>
        error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    );
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision - 1,
        expectedRevision: pendingC.revision,
        expectedPendingRevision: pendingC.source.activeRevision,
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision,
        expectedRevision: pendingC.revision + 1,
        expectedPendingRevision: pendingC.source.activeRevision,
      }),
      (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
    );
    await service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: sealedB.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "latest-candidate-after-audit-only-inputs" },
    });

    const graphRevision = (await service.getSummary()).revision;
    const olderCommand = {
      itemId: pendingA.itemId,
      expectedGraphRevision: graphRevision,
      expectedRevision: pendingA.revision,
      expectedPendingRevision: pendingA.source.pendingRevision,
    };
    const newerCommand = {
      itemId: pendingC.itemId,
      expectedGraphRevision: graphRevision,
      expectedRevision: pendingC.revision,
      expectedPendingRevision: pendingC.source.activeRevision,
    };
    let activated;
    if (scenario.reconcileOrder === "older-first") {
      await assert.rejects(
        service.reconcilePullRequestSource(olderCommand),
        (error) =>
          error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      );
      activated = await service.reconcilePullRequestSource(newerCommand);
    } else {
      activated = await service.reconcilePullRequestSource(newerCommand);
      await assert.rejects(
        service.reconcilePullRequestSource(olderCommand),
        (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
      );
    }

    assert.equal(activated.applied, true);
    const roots = (await service.listItems({ limit: 10 })).items;
    assert.equal(
      roots.find(({ itemId }) => itemId === pendingC.itemId).status,
      "queued",
    );
    assert.equal(
      roots.find(({ itemId }) => itemId === pendingA.itemId).status,
      "superseded",
    );
    assert.equal(
      roots.find(({ itemId }) => itemId === sealedB.itemId).status,
      "completed",
    );
  });
}

test("an existing-root return supersedes an older cross-root candidate", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  let rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  assert.equal(rootA.source.pendingRevision, 2);
  assert.equal(rootA.status, "dispatch_pending");
  assert.equal(rootA.statusReason, "pr_source_revised");
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const staleReconcile = await recovered.reconcilePullRequestSource({
    itemId: rootB.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootB.revision,
    expectedPendingRevision: rootB.source.activeRevision,
  });
  assert.equal(staleReconcile.applied, false);
  assert.equal(
    (await recovered.listItems({ limit: 10 })).items.find(
      ({ itemId }) => itemId === rootB.itemId,
    ).status,
    "superseded",
  );

  rootA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootA.itemId,
  );
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-returned-root" },
  });
  rootA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootA.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: rootA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootA.revision,
    expectedPendingRevision: 2,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  rootA = roots.find(({ itemId }) => itemId === rootA.itemId);
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(rootA.status, "queued");
  assert.equal(rootA.source.pendingRevision, null);
  assert.equal(rootB.status, "superseded");
  const claimed = await recovered.claim({
    itemId: rootA.itemId,
    expectedRevision: rootA.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");
});

test("a superseded automatic PR root ignores a later scope exit without blocking intake", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const supersededBefore = (await fixture.service.listItems({ limit: 10 }))
    .items.find(
      ({ source }) => source?.identity?.scopeId === "github-secondary",
    );
  assert.equal(supersededBefore.status, "superseded");
  assert.equal(
    supersededBefore.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );

  const leftEvent = prAssignment(4, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(4, leftEvent));
  fixture.source.highWatermark = 4;

  const result = await fixture.service.intake();
  const supersededAfter = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ itemId }) => itemId === supersededBefore.itemId);

  assert.equal(result.cursor, 4);
  assert.equal(supersededAfter.status, "superseded");
  assert.equal(supersededAfter.statusReason, supersededBefore.statusReason);
  assert.equal(supersededAfter.revision, supersededBefore.revision);
  assert.equal(supersededAfter.source.scope.active, true);
});

for (const sameScopeRoleTransfer of [false, true]) {
test(`a completed PR root returning behind sealed provenance waits without poisoning intake (same scope role transfer=${sameScopeRoleTransfer})`, async () => {
  const approvedFacts = {
    ...prGitFacts(PR_HEAD_A), relation: "authored", actionState: "waiting_other",
    nextAction: "wait_merge", reviewDecision: "APPROVED",
  };
  const initial = prAssignment(1, {
    sourceScopeId: "github-dashboard", gitFacts: approvedFacts,
  });
  if (sameScopeRoleTransfer) {
    initial.assignment.target.id = "tester";
    initial.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  }
  const fixture = await createFixture({
    records: [initial],
  });
  await fixture.service.intake();
  let rootA = (await fixture.service.listItems()).items[0];
  rootA = await fixture.service.claim({
    itemId: rootA.itemId, expectedRevision: rootA.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000,
  });
  rootA = await fixture.service.complete({
    itemId: rootA.itemId, expectedRevision: rootA.revision,
    leaseId: rootA.leaseId, actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-provenance-return" },
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: sameScopeRoleTransfer ? "github-dashboard" : "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const rootB = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId !== rootA.itemId,
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const before = fixture.store.stored();
  assert.equal(before.items.find(({ itemId }) => itemId === rootA.itemId).status, "completed");
  const returned = prAssignment(3, {
    eventType: "pull_request.status", occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard", gitFacts: approvedFacts,
  });
  if (sameScopeRoleTransfer) {
    returned.assignment.target.id = "tester";
    returned.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  }
  fixture.source.records.push(returned, assignment(4));
  if (sameScopeRoleTransfer) {
    fixture.source.records.push(prScopeLifecycleAssignment(5, prAssignment(5, {
      eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-dashboard", gitFacts: prGitFacts(PR_HEAD_A),
    }).event));
  }
  fixture.source.highWatermark = sameScopeRoleTransfer ? 5 : 4;
  const intake = await fixture.service.intake();
  assert.equal(intake.cursor, fixture.source.highWatermark);
  const after = fixture.store.stored();
  const pending = after.items.find(({ itemId }) => itemId === rootA.itemId);
  assert.equal(pending.status, "blocked");
  assert.equal(pending.source.activeRevision, rootA.source.activeRevision);
  assert.ok(pending.source.pendingRevision > pending.source.activeRevision);
  assert.equal(pending.statusReason, `pr_source_cross_root_cutover_pending:${rootB.itemId}`);
  assert.deepEqual(pending.source.current, rootA.source.current);
  assert.equal(pending.activeIntentId, null);
  assert.equal(pending.leaseId, null);
  for (const mutate of [
    (item) => { item.statusReason = "pr_source_cross_root_cutover_pending:missing-root"; },
    (item) => { item.source.pendingRevision = item.source.activeRevision; },
    (item) => { item.source.pending.sourceSequence = item.source.current.sourceSequence; },
    (item) => { item.source.current.headRefOid = PR_HEAD_B; },
    (item) => { item.ownerId = "unreleased-owner"; },
    (item) => { item.activeIntentId = "unsettled-intent"; },
  ]) {
    const invalid = clone(after);
    mutate(invalid.items.find(({ itemId }) => itemId === rootA.itemId));
    assert.throws(() => validateWorkLedgerGraphTransition(before, invalid));
  }
  const recovered = (await createFixture({ store: fixture.store, source: fixture.source })).service;
  const pendingAfterRestart = (await recovered.listItems()).items.find(({ itemId }) => itemId === pending.itemId);
  if (sameScopeRoleTransfer) {
    const exited = after.items.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(exited.source.scope.active, false);
    assert.equal(exited.statusReason, "pr_source_left_scope_pending_settlement");
    assert.equal(exited.activeIntentId, sealed.outbox.intentId);
    for (const mutate of [
      (item) => { item.activeIntentId = null; },
      (item) => { item.source.scope.active = true; },
      (item) => { item.source.scope.revision -= 1; },
    ]) {
      const invalid = clone(after);
      mutate(invalid.items.find(({ itemId }) => itemId === rootB.itemId));
      assert.throws(() => validateWorkLedgerGraphTransition(before, invalid));
    }
    // The newer scope exit must not grant stale pending work execution rights.
    // A new trusted source observation is required before it can be activated.
    await assert.rejects(recovered.claim({
      itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
      workerId: "employee-tester", leaseDurationMs: 30_000,
    }));
    return;
  }
  const blocked = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedPendingRevision: pendingAfterRestart.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  const predecessor = (await recovered.listItems()).items.find(({ itemId }) => itemId === rootB.itemId);
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId, expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: predecessor.revision, dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "completed",
    details: { downstreamRef: "completed-root-return-review" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedPendingRevision: pendingAfterRestart.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
});
}

test("an existing root returning behind an active sealed provenance waits for settlement", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingBeforeReturn = (
    await fixture.service.listItems({ limit: 10 })
  ).items.find(({ itemId }) => itemId === rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const returnedA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(returnedA.status, "blocked");
  assert.equal(returnedA.source.activeRevision, 1);
  assert.equal(returnedA.source.pendingRevision, 2);
  assert.equal(
    returnedA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(sealedB.status, "dispatch_pending");
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${returnedA.itemId}`,
  );
  assert.equal(sealedB.revision, dispatchingBeforeReturn.revision + 1);
  assert.equal(sealed.outbox.itemId, sealedB.itemId);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const stillBlocked = await recovered.reconcilePullRequestSource({
    itemId: returnedA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: returnedA.revision,
    expectedPendingRevision: returnedA.source.pendingRevision,
  });
  assert.equal(stillBlocked.applied, false);
  assert.deepEqual(
    stillBlocked.blockers.map(({ itemId }) => itemId),
    [sealedB.itemId],
  );
  await assert.rejects(
    recovered.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: dispatchingBeforeReturn.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "stale-before-return-marker" },
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-return-cutover" },
  });
  const pendingA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === returnedA.itemId,
  );
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === returnedA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(completedB.status, "completed");
});

for (const predecessorStatus of ["queued", "working"]) {
  test(`an existing root return atomically retires an active ${predecessorStatus} provenance`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    let roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    let rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    if (predecessorStatus === "working") {
      rootB = await fixture.service.claim({
        itemId: rootB.itemId,
        expectedRevision: rootB.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 3;

    await fixture.service.intake();

    roots = (await fixture.service.listItems({ limit: 10 })).items;
    const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
    const retiredB = roots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(activeA.status, "queued");
    assert.equal(activeA.source.activeRevision, 2);
    assert.equal(activeA.source.pendingRevision, null);
    assert.equal(retiredB.status, "blocked");
    assert.equal(
      retiredB.statusReason,
      "pr_source_cross_root_cutover_retired",
    );
    assert.equal(retiredB.ownerId, null);
    assert.equal(retiredB.leaseId, null);
    assert.equal(retiredB.leaseUntil, null);
    assert.equal(retiredB.activeIntentId, null);
  });
}

test("an acknowledgement before an existing-root return permits immediate activation", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingB = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === rootB.itemId);
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: dispatchingB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-before-return" },
  });
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(activeA.statusReason, "pr_source_revised");
  assert.equal(completedB.status, "completed");
});

test("an expired sealed active provenance is reclaimable after an existing-root return", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 10 })).items;
  const pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-return-crash",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, sealed.outbox.attempt + 1);
  assert.deepEqual(reclaimed.dispatchBinding, sealed.outbox.dispatchBinding);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-return-recovered" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  assert.equal(
    roots.find(({ itemId }) => itemId === pendingA.itemId).status,
    "queued",
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === sealedB.itemId).status,
    "completed",
  );
});

for (const fence of [
  {
    name: "unavailable target",
    input: { gitFacts: { gitTargetAvailable: false } },
  },
  {
    name: "legacy target",
    input: { gitFacts: {} },
  },
  {
    name: "unproven Head",
    input: {
      headRefOid: PR_HEAD_C,
      gitFacts: prGitFacts(PR_HEAD_C),
    },
  },
]) {
  test(`an ${fence.name} fence registers the last operational sealed provenance`, async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const rootB = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-tertiary",
    ...fence.input,
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const fencedC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  assert.equal(fencedC.status, "blocked");
  assert.equal(
    fencedC.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${fencedC.itemId}`,
  );
  const fencedReconciliation = await fixture.service
    .reconcilePullRequestSource({
      itemId: fencedC.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: fencedC.revision,
      expectedPendingRevision: fencedC.source.activeRevision,
    });
  assert.equal(fencedReconciliation.applied, false);
  assert.equal(
    fencedReconciliation.blockers[0].reason,
    "source_authority_fenced",
  );
  });
}

for (const fence of [
  {
    name: "unavailable target",
    input: { gitFacts: { gitTargetAvailable: false } },
    disposition: "ignored_authority_fence",
  },
  {
    name: "legacy target",
    input: { gitFacts: {} },
    disposition: "ignored_legacy_downgrade",
  },
  {
    name: "unproven Head",
    input: {
      headRefOid: PR_HEAD_C,
      gitFacts: prGitFacts(PR_HEAD_C),
    },
    disposition: "ignored_unproven_head",
  },
]) {
  test(`an existing ${fence.name} fence registers its operational sealed predecessor`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    const roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    const rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    await stageSealedPrReview(fixture, rootB.itemId);
    fixture.source.records.push(prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      ...fence.input,
    }));
    fixture.source.highWatermark = 3;

    await fixture.service.intake();

    const fencedRoots = (await fixture.service.listItems({ limit: 10 })).items;
    const fencedA = fencedRoots.find(({ itemId }) => itemId === rootA.itemId);
    const sealedB = fencedRoots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(fencedA.status, "blocked");
    assert.equal(fencedA.source.pendingRevision, null);
    assert.equal(fencedA.source.revisions.at(-1).disposition, fence.disposition);
    assert.equal(
      fencedA.statusReason,
      `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
    );
    assert.equal(
      sealedB.statusReason,
      `pr_source_cross_root_cutover_blocker:${fencedA.itemId}`,
    );
    const fencedReconciliation = await fixture.service
      .reconcilePullRequestSource({
        itemId: fencedA.itemId,
        expectedGraphRevision: (await fixture.service.getSummary()).revision,
        expectedRevision: fencedA.revision,
        expectedPendingRevision: fencedA.source.activeRevision,
      });
    assert.equal(fencedReconciliation.applied, false);
    assert.equal(
      fencedReconciliation.blockers[0].reason,
      "source_authority_fenced",
    );
  });
}

async function createExistingFenceScenario() {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const oldBinding = prExecutionBinding(rootB);
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingBeforeFence = (
    await fixture.service.listItems({ limit: 10 })
  ).items.find(({ itemId }) => itemId === rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  return {
    fixture,
    rootA: roots.find(({ itemId }) => itemId === rootA.itemId),
    rootB: roots.find(({ itemId }) => itemId === rootB.itemId),
    dispatchingBeforeFence,
    oldBinding,
    sealed,
  };
}

test("a fenced candidate keeps its exact observation across audit-only bindings", async () => {
  const { fixture, rootA, rootB } = await createExistingFenceScenario();
  const staleAudit = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T00:59:00.000Z",
    sourceScopeId: "github-dashboard",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A, {
      sourceAccountId: "audit-only-account",
    }),
  };
  fixture.source.records.push(
    prAssignment(4, staleAudit),
    prAssignment(5, staleAudit),
  );
  fixture.source.highWatermark = 5;
  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const roots = (await recovered.listItems({ limit: 10 })).items;
  const fencedA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(fencedA.source.pendingRevision, null);
  assert.equal(fencedA.source.revisions.at(-1).disposition, "ignored_stale");
  assert.equal(fencedA.source.bindings.at(-1).sourceSequence, 5);
  assert.deepEqual(crossRootPullRequestCutoverCandidate(fencedA), {
    inputRevision: 2,
    sourceSequence: 3,
  });
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${fencedA.itemId}`,
  );

  const tampered = structuredClone(fencedA);
  const fenceBinding = tampered.source.bindings.find(
    ({ inputRevision }) => inputRevision === 2,
  );
  fenceBinding.inputRevision = 3;
  assert.throws(
    () => crossRootPullRequestCutoverCandidate(tampered),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const fenced = await recovered.reconcilePullRequestSource({
    itemId: fencedA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: fencedA.revision,
    expectedPendingRevision: fencedA.source.activeRevision,
  });
  assert.equal(fenced.applied, false);
  assert.equal(fenced.blockers[0].reason, "source_authority_fenced");
});

test("an active acknowledgement after an existing fence permits trusted return", async () => {
  const { fixture, rootA, rootB, sealed } =
    await createExistingFenceScenario();
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: rootB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "existing-fence-active-ack" },
  });
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 3);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(completedB.status, "completed");
});

test("an existing fence transfers to trusted pending input and survives restart recovery", async () => {
  const {
    fixture,
    rootA: fencedA,
    rootB: fencedB,
    dispatchingBeforeFence,
    oldBinding,
    sealed,
  } = await createExistingFenceScenario();
  assert.equal(fencedB.revision, dispatchingBeforeFence.revision + 1);
  await assert.rejects(
    fixture.service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: dispatchingBeforeFence.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "stale-existing-fence-ack" },
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let pendingA = roots.find(({ itemId }) => itemId === fencedA.itemId);
  let sealedB = roots.find(({ itemId }) => itemId === fencedB.itemId);
  assert.equal(pendingA.status, "blocked");
  assert.equal(pendingA.source.pendingRevision, 3);
  assert.equal(
    pendingA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: pendingA.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: pendingA.revision,
      expectedPendingRevision: fencedA.source.activeRevision,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  fixture.time.advance(30_000);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-existing-fence",
    leaseDurationMs: 30_000,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  pendingA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  sealedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "existing-fence-reclaimed" },
  });
  await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 3);
  assert.equal(activeA.source.pendingRevision, null);
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(activeA);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
});

test("a trusted return transfers a fenced sealed predecessor into recoverable cutover", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const oldBinding = prExecutionBinding(rootB);
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-tertiary",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  let pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  let sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const fencedC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  assert.equal(pendingA.status, "blocked");
  assert.equal(pendingA.source.pendingRevision, 2);
  assert.equal(
    pendingA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${pendingA.itemId}`,
  );
  assert.equal(fencedC.status, "superseded");
  assert.equal(
    fencedC.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  fixture.time.advance(30_000);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-authority-fence",
    leaseDurationMs: 30_000,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  pendingA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  sealedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-fenced-recovered" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(
      prExecutionBinding(activeA),
    ),
    prExecutionBinding(activeA),
  );
});

for (const acknowledgementOrder of ["before", "after"]) {
  test(`a trusted return converges when sealed work is acknowledged ${acknowledgementOrder} its fence`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    let roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    const rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    const sealed = await stageSealedPrReview(fixture, rootB.itemId);
    const acknowledge = async () => {
      const currentB = (
        await fixture.service.listItems({ limit: 10 })
      ).items.find(({ itemId }) => itemId === rootB.itemId);
      await fixture.service.ackIntent({
        intentId: sealed.outbox.intentId,
        expectedRevision: sealed.outbox.revision,
        itemExpectedRevision: currentB.revision,
        dispatchLeaseId: sealed.outbox.dispatchLeaseId,
        actorId: "work-intent-dispatcher",
        outcome: "delivered",
        nextStatus: "completed",
        details: { downstreamRef: `ack-${acknowledgementOrder}-fence` },
      });
    };
    if (acknowledgementOrder === "before") await acknowledge();
    fixture.source.records.push(prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: { gitTargetAvailable: false },
    }));
    fixture.source.highWatermark = 3;
    await fixture.service.intake();
    if (acknowledgementOrder === "after") await acknowledge();
    fixture.source.records.push(prAssignment(4, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 4;

    await fixture.service.intake();

    roots = (await fixture.service.listItems({ limit: 10 })).items;
    const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
    const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(activeA.status, "queued");
    assert.equal(activeA.source.activeRevision, 2);
    assert.equal(activeA.source.pendingRevision, null);
    assert.equal(completedB.status, "completed");
  });
}

async function createReplacedPendingRootScenario() {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealedA = await stageSealedPrReview(fixture);
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(({ itemId }) => itemId === sealedA.rootItemId);
  let rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  let rootC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  await fixture.service.ackIntent({
    intentId: sealedA.outbox.intentId,
    expectedRevision: sealedA.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealedA.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-before-c" },
  });
  await fixture.service.reconcilePullRequestSource({
    itemId: rootC.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: rootC.revision,
    expectedPendingRevision: rootC.source.activeRevision,
  });
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  assert.equal(rootC.status, "queued");
  return { fixture, rootB, rootC };
}

for (const predecessorStatus of ["queued", "working", "completed", "sealed"]) {
  test(`a replaced pending source root returns after a ${predecessorStatus} successor`, async () => {
  const { fixture, rootB: replacedB, rootC: queuedC } =
    await createReplacedPendingRootScenario();
  let rootC = queuedC;
  let sealedC = null;
  if (["working", "completed"].includes(predecessorStatus)) {
    rootC = await fixture.service.claim({
      itemId: rootC.itemId,
      expectedRevision: rootC.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
  }
  if (predecessorStatus === "completed") {
    rootC = await fixture.service.complete({
      itemId: rootC.itemId,
      expectedRevision: rootC.revision,
      leaseId: rootC.leaseId,
      actorId: "employee-pr-engineer",
      result: { outcome: "successor-completed" },
    });
  }
  if (predecessorStatus === "sealed") {
    sealedC = await stageSealedPrReview(fixture, rootC.itemId);
    rootC = (await fixture.service.listItems({ limit: 10 })).items.find(
      ({ itemId }) => itemId === rootC.itemId,
    );
  }
  const oldBinding = prExecutionBinding(replacedB);
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let rootB = roots.find(({ itemId }) => itemId === replacedB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  if (sealedC !== null) {
    assert.equal(rootB.status, "blocked");
    assert.equal(rootB.source.pendingRevision, 2);
    await recovered.ackIntent({
      intentId: sealedC.outbox.intentId,
      expectedRevision: sealedC.outbox.revision,
      itemExpectedRevision: rootC.revision,
      dispatchLeaseId: sealedC.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "github-review-proposal-before-b-return" },
    });
    await recovered.reconcilePullRequestSource({
      itemId: rootB.itemId,
      expectedGraphRevision: (await recovered.getSummary()).revision,
      expectedRevision: rootB.revision,
      expectedPendingRevision: rootB.source.pendingRevision,
    });
    roots = (await recovered.listItems({ limit: 10 })).items;
    rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
    rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  }
  assert.equal(rootB.status, "queued");
  assert.equal(
    rootB.statusReason,
    predecessorStatus === "sealed"
      ? "pr_source_cutover_activated"
      : "pr_source_revised",
  );
  assert.equal(rootB.source.activeRevision, 2);
  assert.equal(rootB.source.pendingRevision, null);
  assert.equal(rootC.ownerId, null);
  assert.equal(rootC.leaseId, null);
  assert.equal(rootC.leaseUntil, null);
  assert.equal(
    rootC.status,
    ["completed", "sealed"].includes(predecessorStatus)
      ? "completed"
      : "blocked",
  );
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(rootB);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
  const claimedB = await recovered.claim({
    itemId: rootB.itemId,
    expectedRevision: rootB.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedB.status, "working");
  });
}

test("a durable replaced root activates its pending return after successor settlement", async () => {
  const { fixture, rootB: replacedB, rootC: queuedC } =
    await createReplacedPendingRootScenario();
  const sealedC = await stageSealedPrReview(fixture, queuedC.itemId);
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  const durable = fixture.store.stored();
  const pendingB = durable.items.find(
    ({ itemId }) => itemId === replacedB.itemId,
  );
  assert.equal(pendingB.status, "blocked");
  assert.equal(pendingB.source.pendingRevision, 2);
  pendingB.status = "superseded";
  pendingB.statusReason = "pr_source_cross_root_cutover_replaced";
  fixture.store.replaceStored(durable);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let rootC = roots.find(({ itemId }) => itemId === queuedC.itemId);
  await recovered.ackIntent({
    intentId: sealedC.outbox.intentId,
    expectedRevision: sealedC.outbox.revision,
    itemExpectedRevision: rootC.revision,
    dispatchLeaseId: sealedC.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "settled-before-durable-return" },
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  const rootB = roots.find(({ itemId }) => itemId === replacedB.itemId);

  await recovered.reconcilePullRequestSource({
    itemId: rootB.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootB.revision,
    expectedPendingRevision: rootB.source.pendingRevision,
  });

  const activated = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootB.itemId,
  );
  assert.equal(activated.status, "queued");
  assert.equal(activated.statusReason, "pr_source_cutover_activated");
  assert.equal(activated.source.activeRevision, 2);
  assert.equal(activated.source.pendingRevision, null);
});

test("reactivating a replaced source root never revives its old child or intent", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let rootB = roots[0];
  const childResult = await fixture.service.createGraphChild(
    prGraphChildCommand(
      rootB,
      (await fixture.service.getSummary()).revision,
      "historic-b-child",
    ),
  );
  let child = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === childResult.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  child = await fixture.service.complete({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    result: { outcome: "historic-child-completed" },
  });
  const oldChildBinding = prExecutionBinding(child);
  const sealedB = await stageSealedPrReview(fixture, rootB.itemId);
  rootB = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootB.itemId,
  );
  const oldRootBinding = prExecutionBinding(rootB);
  await fixture.service.ackIntent({
    intentId: sealedB.outbox.intentId,
    expectedRevision: sealedB.outbox.revision,
    itemExpectedRevision: rootB.revision,
    dispatchLeaseId: sealedB.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T03:00:00.000Z",
    details: { code: "historic-b-intent-failed" },
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let rootA = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.identity?.scopeId === "github-dashboard",
  );
  const sealedA = await stageSealedPrReview(fixture, rootA.itemId);
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(4, {
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootA = roots.find(({ itemId }) => itemId === rootA.itemId);
  let rootC = roots.find(
    ({ source }) => source?.identity?.scopeId === "github-tertiary",
  );
  await fixture.service.ackIntent({
    intentId: sealedA.outbox.intentId,
    expectedRevision: sealedA.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealedA.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "a-before-c-activation" },
  });
  await fixture.service.reconcilePullRequestSource({
    itemId: rootC.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: rootC.revision,
    expectedPendingRevision: rootC.source.activeRevision,
  });
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  fixture.source.records.push(prAssignment(5, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:20:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 5;
  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 20 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  child = roots.find(({ itemId }) => itemId === child.itemId);
  const historicalOutbox = (await recovered.listOutbox({ limit: 20 })).items
    .find(({ intentId }) => intentId === sealedB.outbox.intentId);
  assert.equal(rootB.status, "queued");
  assert.equal(rootB.source.activeRevision, 3);
  assert.equal(rootB.activeIntentId, null);
  assert.equal(rootC.status, "blocked");
  assert.equal(child.status, "completed");
  assert.equal(historicalOutbox.status, "failed");
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldRootBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldChildBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(rootB);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
  const claimedB = await recovered.claim({
    itemId: rootB.itemId,
    expectedRevision: rootB.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedB.status, "working");
});

test("a crashed cross-root sealed action can be reclaimed only for settlement", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  let pendingRoot = roots.find(({ itemId }) => itemId !== oldRoot.itemId);
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-crash",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, sealed.outbox.attempt + 1);
  assert.deepEqual(reclaimed.dispatchBinding, sealed.outbox.dispatchBinding);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: oldRoot.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-recovered" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  assert.equal(
    roots.find(({ itemId }) => itemId === pendingRoot.itemId).status,
    "queued",
  );
});

test("a crashed sealed child registered in cross-root cutover can settle", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrChildReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let items = (await recovered.listItems({ limit: 10 })).items;
  let child = items.find(({ itemId }) => itemId === sealed.childItemId);
  let pendingRoot = items.find(
    ({ source }) => source?.identity?.scopeId === "github-secondary",
  );
  assert.equal(
    child.statusReason,
    `pr_source_cross_root_cutover_blocker:${pendingRoot.itemId}`,
  );
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-child-crash",
    leaseDurationMs: 30_000,
  });
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: child.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-child-recovered" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });
  items = (await recovered.listItems({ limit: 10 })).items;
  child = items.find(({ itemId }) => itemId === child.itemId);
  assert.equal(child.status, "completed");
  assert.equal(
    items.find(({ itemId }) => itemId === pendingRoot.itemId).status,
    "queued",
  );
});

test("an expired sealed old-Head intent is reclaimed and settled before cutover", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "dispatcher-before-crash",
    leaseDurationMs: 1_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(1_000);

  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const reclaimed = await fixture.service.claimIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    dispatcherId: "dispatcher-after-crash",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(reclaimed.dispatchBinding, sealed.dispatchBinding);
  assert.equal(reclaimed.attempt, sealed.attempt + 1);
  await fixture.service.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-recovered" },
  });
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const activated = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });

  assert.equal(activated.applied, true);
  assert.equal(activated.activeRevision, 2);
  assert.equal(
    (await fixture.service.listOutbox()).items[0].sourceBinding.headRefOid,
    PR_HEAD_A,
  );
});

test("PR source reconciliation is targeted by graph, item, and pending revision CAS", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "blocked",
    actorId: "work-ledger-system",
    reason: "hold-for-cutover-cas-test",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  const graphRevision = (await fixture.service.getSummary()).revision;
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: graphRevision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      ...command,
      expectedGraphRevision: graphRevision - 1,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      ...command,
      expectedRevision: root.revision + 1,
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  assert.equal(fixture.store.writes.length, writesBefore);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: root.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: root.revision,
      expectedPendingRevision: 2,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  assert.equal(root.source.activeRevision, 1);
  assert.equal(root.source.pendingRevision, 3);
});

test("PR source reconciliation converges after a lost durable acknowledgement", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "blocked",
    actorId: "work-ledger-system",
    reason: "hold-before-new-head",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "queued",
    actorId: "work-ledger-system",
    reason: "local-work-is-quiescent",
  });
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  const durableWrite = fixture.store.write.bind(fixture.store);
  let loseAcknowledgement = true;
  fixture.store.write = async (...args) => {
    await durableWrite(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("durable acknowledgement lost");
    }
  };

  await assert.rejects(
    fixture.service.reconcilePullRequestSource(command),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  const writesAfterLostAcknowledgement = fixture.store.writes.length;
  const durableRoot = fixture.store.stored().items.find(
    ({ itemId }) => itemId === root.itemId,
  );
  assert.equal(durableRoot.source.activeRevision, 2);
  assert.equal(durableRoot.source.pendingRevision, null);

  const replay = await fixture.service.reconcilePullRequestSource(command);
  assert.equal(replay.applied, false);
  assert.equal(replay.activeRevision, 2);
  assert.equal(fixture.store.writes.length, writesAfterLostAcknowledgement);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 100 })).items
      .filter(({ type }) => type === "pr_source_activated").length,
    1,
  );
});

test("PR graph children are Head-bound and old epochs become neutral superseded work", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const first = await fixture.service.createGraphChild(
    prGraphChildCommand(root, 1),
  );
  let firstChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === first.taskId,
  );
  const graph = await fixture.service.getGraphSnapshot();
  const projectedChild = graph.graph.tasks.find(
    ({ taskId }) => taskId === first.taskId,
  );
  assert.equal(
    graph.graph.tasks.some(({ taskId }) => taskId === root.itemId),
    true,
  );
  assert.equal(projectedChild.parentTaskId, root.itemId);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.rootItemId, root.itemId);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.headRevision, 1);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_A);

  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const afterCutover = (await fixture.service.listItems()).items;
  root = afterCutover.find(({ kind }) => kind === "source_root");
  firstChild = afterCutover.find(({ itemId }) => itemId === first.taskId);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(firstChild.status, "superseded");
  assert.equal(firstChild.statusReason, "pr_head_superseded");
  const claimedRoot = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.handoff({
    itemId: claimedRoot.itemId,
    expectedRevision: claimedRoot.revision,
    leaseId: claimedRoot.leaseId,
    actorId: "employee-pr-engineer",
    target: { type: "role", id: "pr-engineer" },
    reason: "decompose-new-head",
  });
  const crossEpochDependency = prGraphChildCommand(
    root,
    (await fixture.service.getSummary()).revision,
    "must-not-depend-on-old-head",
  );
  crossEpochDependency.command.dependsOnTaskIds = [first.taskId];
  crossEpochDependency.command.expectedTaskRevisions.push({
    taskId: first.taskId,
    revision: firstChild.revision,
  });
  await assert.rejects(
    fixture.service.createGraphChild(crossEpochDependency),
    (error) => error.code === "WORK_LEDGER_GRAPH_SOURCE_EPOCH_CONFLICT",
  );
  const second = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  const secondChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === second.taskId,
  );
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(secondChild.assignment.graphTask.sourceBinding.headRevision, 2);
  assert.equal(secondChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_B);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const third = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  const thirdChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === third.taskId,
  );
  assert.notEqual(third.taskId, first.taskId);
  assert.notEqual(third.taskId, second.taskId);
  assert.equal(thirdChild.assignment.graphTask.sourceBinding.headRevision, 3);
  assert.equal(thirdChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_A);
});

test("a cancelled old-Head child becomes neutral when the next Head activates", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  await fixture.service.cancelGraphTask({
    itemId: child.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: child.revision,
    actorId: "employee-orchestrator",
    reason: "obsolete-old-head-plan",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const items = (await fixture.service.listItems()).items;
  root = items.find(({ kind }) => kind === "source_root");
  child = items.find(({ itemId }) => itemId === child.itemId);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(child.status, "superseded");
  assert.equal(child.statusReason, "pr_head_superseded");
  const claimedRoot = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedRoot.status, "working");
});

test("a sealed old-Head child blocks root activation until its action is settled", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, 1),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    roleId: "developer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "developer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(blocked.applied, false);
  assert.deepEqual(blocked.blockers, [{
      itemId: child.itemId,
      status: "dispatch_pending",
      reason: "active_intent",
      activeIntentId: sealed.intentId,
    }]);
  await assert.rejects(
    fixture.service.claim({
      itemId: root.itemId,
      expectedRevision: root.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-child-1" },
  });
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const activated = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(activated.applied, true);
  assert.equal(activated.activeRevision, 2);
  assert.deepEqual(activated.blockers, []);

  const settledItems = (await fixture.service.listItems()).items;
  root = settledItems.find(({ kind }) => kind === "source_root");
  child = settledItems.find(({ itemId }) => itemId === child.itemId);
  const historical = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(child.status, "superseded");
  assert.equal(historical.sourceBinding.rootItemId, root.itemId);
  assert.equal(historical.sourceBinding.headRevision, 1);
  assert.equal(historical.sourceBinding.headRefOid, PR_HEAD_A);
});

test("an unproven newer PR Head is audited but never activated", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(item.source.inputRevision, 2);
  assert.equal(item.source.activeRevision, 1);
  assert.equal(item.source.headRevision, 1);
  assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  assert.equal(
    item.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
});

test("recovery blocks legacy queued PR roots whose source authority is fenced", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  legacy.items[0].status = "queued";
  legacy.items[0].statusReason = null;
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const item = (await recovered.service.listItems()).items[0];

  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
  assert.equal(item.revision, legacy.items[0].revision + 1);
  assert.equal((await recovered.service.getSummary()).revision, legacy.revision + 1);
});

test("recovery blocks legacy retry-wait PR roots whose source authority is fenced", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  legacy.items[0].status = "retry_wait";
  legacy.items[0].availableAt = "2026-08-02T01:00:00.000Z";
  legacy.items[0].statusReason = "decision_failed";
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const item = (await recovered.service.listItems()).items[0];

  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
  assert.equal(item.availableAt, null);
});

test("recovery isolates PR authority fences by subject", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1),
      prAssignment(2, {
        pullRequestNumber: 43,
        title: "PR 43 remains trusted",
      }),
    ],
  });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  const fenced = legacy.items.find(
    ({ source }) => source?.identity?.pullRequestNumber === 42,
  );
  fenced.status = "queued";
  fenced.statusReason = null;
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const roots = (await recovered.service.listItems({ limit: 10 })).items;
  const byNumber = new Map(
    roots.map((item) => [item.source.identity.pullRequestNumber, item]),
  );

  assert.equal(byNumber.get(42).status, "blocked");
  assert.equal(byNumber.get(42).statusReason, "pr_source_authority_fenced");
  assert.equal(byNumber.get(43).status, "queued");
});

test("a legitimate A to B to A force-push creates three distinct Head epochs", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(item.source.activeRevision, 3);
  assert.equal(item.source.headRevision, 3);
  assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  assert.deepEqual(
    item.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("provenance return intake follows the global PR Head chain", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      headRefOid: PR_HEAD_A,
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      sourceScopeId: "replacement-scope",
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_C,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const returnedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const replacedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "replacement-scope",
  );

  assert.equal(roots.length, 2);
  assert.equal(returnedRoot.source.current.headRefOid, PR_HEAD_C);
  assert.equal(returnedRoot.source.revisions.at(-1).disposition, "accepted");
  assert.equal(
    returnedRoot.source.revisions.at(-1).causalHeadRefOid,
    PR_HEAD_B,
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(returnedRoot),
    ),
    prExecutionBinding(returnedRoot),
  );
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(replacedRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a status-only provenance return catches up to the trusted Head and recovers", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      headRefOid: PR_HEAD_A,
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      sourceScopeId: "replacement-scope",
    }),
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["ciStatus"],
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const recovered = await createFixture({ records, store: fixture.store });
  const roots = (await recovered.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const returnedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const replacedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "replacement-scope",
  );

  assert.equal(returnedRoot.source.current.headRefOid, PR_HEAD_B);
  assert.equal(returnedRoot.source.revisions.at(-1).previousHeadRefOid, null);
  assert.equal(
    returnedRoot.source.revisions.at(-1).causalHeadRefOid,
    PR_HEAD_B,
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(returnedRoot),
    ),
    prExecutionBinding(returnedRoot),
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(replacedRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("provenance round trips never resurrect an earlier exact binding", async (t) => {
  for (const scenario of [
    {
      name: "same Head",
      replacementHead: PR_HEAD_A,
      returnOptions: {},
      replacementOptions: {},
    },
    {
      name: "A to B to A",
      replacementHead: PR_HEAD_B,
      replacementOptions: {
        previousHeadRefOid: PR_HEAD_A,
        changedFields: ["headRefOid"],
      },
      returnOptions: {
        previousHeadRefOid: PR_HEAD_B,
        changedFields: ["headRefOid"],
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const initial = prAssignment(1, {
        occurredAt: "2026-08-02T01:00:00.000Z",
        headRefOid: PR_HEAD_A,
        gitFacts: prGitFacts(PR_HEAD_A),
      });
      const fixture = await createFixture({ records: [initial] });
      await fixture.service.intake({ limit: 10 });
      const initialRoot = (await fixture.service.listItems({ limit: 10 }))
        .items.find(({ kind }) => kind === "source_root");
      const oldBinding = prExecutionBinding(initialRoot);
      const replacement = prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: scenario.replacementHead,
        sourceScopeId: "replacement-scope",
        gitFacts: prGitFacts(scenario.replacementHead),
        ...scenario.replacementOptions,
      });
      const returned = prAssignment(3, {
        occurredAt: "2026-08-02T01:10:00.000Z",
        headRefOid: PR_HEAD_A,
        gitFacts: prGitFacts(PR_HEAD_A),
        ...scenario.returnOptions,
      });
      fixture.source.records.push(replacement, returned);
      fixture.source.highWatermark = 3;
      await fixture.service.intake({ limit: 10 });

      const recovered = await createFixture({
        records: [initial, replacement, returned],
        store: fixture.store,
      });
      const roots = (await recovered.service.listItems({ limit: 10 })).items
        .filter(({ kind }) => kind === "source_root");
      const returnedRoot = roots.find(
        ({ source }) => source.identity.scopeId === "github-dashboard",
      );
      const currentBinding = prExecutionBinding(returnedRoot);

      assert.deepEqual(
        returnedRoot.source.revisions.map(({ headRevision }) => headRevision),
        [1, 2],
      );
      assert.deepEqual(
        returnedRoot.source.revisions.map(
          ({ authorityEpochChanged }) => authorityEpochChanged,
        ),
        [false, true],
      );
      await assert.rejects(
        recovered.service.verifyPullRequestExecutionBinding(oldBinding),
        (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
      );
      assert.deepEqual(
        await recovered.service.verifyPullRequestExecutionBinding(
          currentBinding,
        ),
        currentBinding,
      );
    });
  }
});

test("an exact target rollback stays in a newer authority epoch after restart", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const changed = prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A, { baseRefOid: "e".repeat(40) }),
  });
  const rolledBack = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(changed, rolledBack);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });

  const recovered = await createFixture({
    records: [initial, changed, rolledBack],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("restart cuts over ambiguous legacy target history before authorizing bindings", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A, { baseRefOid: "e".repeat(40) }),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const beforeUpgrade = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const preparedBeforeUpgrade = prExecutionBinding(beforeUpgrade);
  const legacy = fixture.store.stored();
  const legacyRoot = legacy.items.find(({ kind }) => kind === "source_root");
  for (const revision of legacyRoot.source.revisions) {
    delete revision.causalHeadRefOid;
    delete revision.authorityEpochChanged;
    delete revision.authorityEpochCutover;
  }
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({ records, store: fixture.store });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 4],
  );
  assert.equal(
    currentRoot.source.revisions.at(-1).authorityEpochCutover,
    true,
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(preparedBeforeUpgrade),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = prExecutionBinding(currentRoot);
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a new provenance with an unproven Head fences the whole PR", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        occurredAt: "2026-08-02T01:00:00.000Z",
        headRefOid: PR_HEAD_A,
      }),
      prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: PR_HEAD_B,
        changedFields: ["headRefOid"],
        sourceScopeId: "unproven-scope",
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");

  assert.equal(roots.length, 2);
  for (const root of roots) {
    await assert.rejects(
      fixture.service.verifyPullRequestExecutionBinding(
        prExecutionBinding(root),
      ),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
});

test("a future-dated unproven provenance cannot permanently block recovery", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const unprovenFuture = prAssignment(2, {
    occurredAt: "2026-08-02T01:50:00.000Z",
    headRefOid: PR_HEAD_B,
    changedFields: ["headRefOid"],
    sourceScopeId: "future-unproven-scope",
    gitFacts: prGitFacts(PR_HEAD_B),
  });
  fixture.source.records.push(unprovenFuture);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const recoveredObservation = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(recoveredObservation);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });
  const recovered = await createFixture({
    records: [initial, unprovenFuture, recoveredObservation],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(
      ({ kind, source }) =>
        kind === "source_root" &&
        source.identity.scopeId === "github-dashboard",
    );
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2],
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("future unavailable facts fence locally and exact normal-time recovery survives restart", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const unavailableFuture = prAssignment(2, {
    occurredAt: "2099-01-01T00:00:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  });
  fixture.source.records.push(unavailableFuture);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const exactRecovery = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(exactRecovery);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });
  const recoveredBeforeRestart = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  assert.equal(recoveredBeforeRestart.status, "queued");
  const recovered = await createFixture({
    records: [initial, unavailableFuture, exactRecovery],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ disposition }) => disposition),
    ["accepted", "ignored_authority_fence", "accepted"],
  );
  assert.equal(currentRoot.status, "queued");
  assert.equal(currentRoot.source.headRevision, 2);
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a trusted provenance recovers exactly after another source fences it", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      occurredAt: "2099-01-01T00:00:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const initialRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const oldBinding = prExecutionBinding(initialRoot);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const recoveredRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const currentBinding = prExecutionBinding(recoveredRoot);
  assert.equal(recoveredRoot.status, "queued");
  assert.deepEqual(
    recoveredRoot.source.revisions.map(({ disposition }) => disposition),
    ["accepted", "accepted"],
  );
  assert.equal(recoveredRoot.source.headRevision, 2);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
  assert.deepEqual(
    await restarted.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a late old-Head event is audited without rolling the PR task back", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const headB = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:01:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "FAILURE",
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal((await fixture.service.getSummary()).intakeCursor, 3);
  assert.equal(item.itemId, headB.itemId);
  assert.equal(item.source.inputRevision, 3);
  assert.equal(item.source.activeRevision, 2);
  assert.equal(item.source.headRevision, 2);
  assert.equal(item.source.current.headRefOid, PR_HEAD_B);
  assert.equal(item.source.revisions.at(-1).disposition, "ignored_stale");
});

test("a full limit-one v1 PR outbox gains one v2 baseline, restarts, and drains", async () => {
  const input = prAssignment(1, {
    gitFacts: prGitFacts(PR_HEAD_A),
    title: "Legacy v1 PR memory",
  });
  const fixture = await createFixture({ records: [input] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "legacy-v1",
          description: "Legacy v1 graph conclusion",
        }],
        expectedDeliverables: [],
      },
      reason: "legacy-v1-fixture",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const legacy = fixture.store.stored();
  root = legacy.items.find(({ kind }) => kind === "source_root");
  legacy.graphMemoryProjection = legacySingleEventProjection(
    legacy,
    root,
    "acceptance_contract",
    root.graph.acceptanceContracts.at(-1),
  );
  fixture.store.replaceStored(legacy);
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 1 });

  const recovered = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  const firstBatch = await recovered.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(firstBatch.highWatermark, 2);
  assert.deepEqual(
    firstBatch.items.map(({ schemaVersion, kind }) => ({ schemaVersion, kind })),
    [
      { schemaVersion: 1, kind: "acceptance_contract" },
      { schemaVersion: 2, kind: "authority_observed" },
    ],
  );
  const restartedBeforeDrain = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  assert.deepEqual(
    await restartedBeforeDrain.service.readGraphMemoryProjectionBatch({
      limit: 10,
    }),
    firstBatch,
  );

  const memory = await createLedgerMemoryPipeline(
    restartedBeforeDrain.service,
  );
  await memory.projector.runCycle();
  const v1RecordId = workGraphMemoryRecordReceipt(firstBatch.items[0])
    .memoryRecordId;
  assert.equal(
    memory.journal.readRecords({ recordIds: [v1RecordId] })
      .items[0].labels.lifecycle,
    "obsolete",
  );
  const afterDrain = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  assert.deepEqual(
    await afterDrain.service.readGraphMemoryProjectionBatch({ limit: 10 }),
    {
      cursor: 2,
      highWatermark: 2,
      checkpointDigest: firstBatch.highWatermarkDigest,
      highWatermarkDigest: firstBatch.highWatermarkDigest,
      authorityStateDigest: firstBatch.authorityStateDigest,
      items: [],
    },
  );
  root = (await afterDrain.service.listItems()).items[0];
  await afterDrain.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 3,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      reason: "cap-restored-after-drain",
      expectedGraphRevision: (await afterDrain.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const ordinaryAfterDrain =
    await afterDrain.service.readGraphMemoryProjectionBatch({ limit: 10 });
  assert.equal(ordinaryAfterDrain.items.length, 1);
  assert.equal(ordinaryAfterDrain.items[0].kind, "acceptance_contract");
});

test("v1 non-PR graph memory drains without synthesizing a PR authority baseline", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  const item = legacy.items[0];
  legacy.graphMemoryProjection = legacySingleEventProjection(
    legacy,
    item,
    "acceptance_contract",
    item.graph.acceptanceContracts[0],
  );
  fixture.store.replaceStored(legacy);
  const recovered = await createFixture({
    records: [assignment(1)],
    store: fixture.store,
    limits: normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 1 }),
  });
  const batch = await recovered.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].schemaVersion, 1);
  assert.equal(batch.items.some(({ kind }) => kind === "authority_observed"), false);
});

test("recovery rejects deleting an authority invalidation tail with nextSequence rollback", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  const memory = await createLedgerMemoryPipeline(fixture.service);
  await memory.projector.runCycle();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const tampered = fixture.store.stored();
  assert.equal(
    tampered.graphMemoryProjection.pending.at(-1).kind,
    "authority_invalidated",
  );
  tampered.graphMemoryProjection.pending.pop();
  tampered.graphMemoryProjection.nextSequence -= 1;
  fixture.store.replaceStored(tampered);

  await assert.rejects(
    createFixture({
      records: fixture.source.records,
      store: fixture.store,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema v8 safely consolidates queued PR assignments into one source root", async () => {
  const records = [
    prAssignment(1, { eventType: "pull_request.updated" }),
    prAssignment(2, { eventType: "pull_request.classified" }),
    prAssignment(3, { eventType: "pull_request.status" }),
  ];
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(
      record,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 3 });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 3,
    sourceHighWatermark: 3,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({
    records,
    store,
    limits,
  });

  const migrated = (await fixture.service.listItems({ limit: 10 })).items;
  const roots = migrated.filter(({ kind }) => kind === "source_root");
  const oldAssignments = migrated.filter(({ kind }) => kind === "assignment");

  assert.equal(store.writes.length, 0);
  assert.equal(store.stored().schemaVersion, 8);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status, "queued");
  assert.equal(roots[0].source.inputRevision, 3);
  assert.equal(roots[0].source.headRevision, 1);
  assert.equal(oldAssignments.length, 3);
  assert.equal(oldAssignments.every(({ status }) => status === "cancelled"), true);
  assert.equal(
    (await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 }))
      .highWatermark,
    4,
  );

  await fixture.service.claim({
    itemId: roots[0].itemId,
    expectedRevision: roots[0].revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.equal(store.stored().graphMemoryProjection.nextSequence, 5);
  assert.equal(
    store.stored().graphMemoryProjection.pending.at(-1).kind,
    "authority_observed",
  );
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits,
  });
  await recovered.recover();
  assert.equal(
    (await recovered.readGraphMemoryProjectionBatch({ limit: 10 }))
      .highWatermark,
    4,
  );
});

test("full schema v8 outbox with multiple PR roots only overflows for one trusted baseline", async () => {
  const records = [
    prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "PR 42 migration",
    }),
    prAssignment(2, {
      pullRequestNumber: 43,
      sourceScopeId: "github-secondary",
      headRefOid: PR_HEAD_B,
      gitFacts: prGitFacts(PR_HEAD_B),
      title: "PR 43 migration",
    }),
  ];
  const items = records.map((entry) => {
    const item = createAssignmentWorkItem(
      entry,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 2 });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 2,
    sourceHighWatermark: 2,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(items, 1, limits),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const first = await createFixture({ records, store, limits });
  const firstBatch = await first.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal((await first.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root").length, 2);
  assert.equal(firstBatch.items.length, 3);
  assert.equal(firstBatch.items.at(-1).kind, "authority_observed");
  assert.equal(
    firstBatch.items.slice(0, 2).every(
      ({ kind }) => kind === "acceptance_contract",
    ),
    true,
  );

  const restarted = await createFixture({ records, store, limits });
  assert.deepEqual(
    await restarted.service.readGraphMemoryProjectionBatch({ limit: 10 }),
    firstBatch,
  );
  let root = (await restarted.service.listItems({ limit: 10 })).items.find(
    ({ kind }) => kind === "source_root",
  );
  const writesBeforeRejectedGraphAppend = store.writes.length;
  await assert.rejects(
    restarted.service.reviseGraphAcceptance({
      authority: {
        actorId: "employee-orchestrator",
        scopeRootTaskId: root.itemId,
      },
      command: {
        taskId: root.itemId,
        acceptanceContract: {
          revision: 2,
          acceptanceCriteria: [{
            criterionId: "migration-capacity",
            description: "Migration authority tail has drained",
          }],
          expectedDeliverables: [],
        },
        reason: "ordinary-append-before-migration-drain",
        expectedGraphRevision: (await restarted.service.getSummary()).revision,
        expectedTaskRevision: root.revision,
      },
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED",
  );
  assert.equal(store.writes.length, writesBeforeRejectedGraphAppend);

  const memory = await createLedgerMemoryPipeline(restarted.service);
  await memory.projector.runCycle();
  const afterDrain = await createFixture({ records, store, limits });
  root = (await afterDrain.service.listItems({ limit: 10 })).items.find(
    ({ kind }) => kind === "source_root",
  );
  await afterDrain.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "migration-capacity",
          description: "Migration authority tail has drained",
        }],
        expectedDeliverables: [],
      },
      reason: "ordinary-append-after-migration-drain",
      expectedGraphRevision: (await afterDrain.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const ordinary = await afterDrain.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(ordinary.cursor, 3);
  assert.equal(ordinary.items.length, 1);
  assert.equal(ordinary.items[0].kind, "acceptance_contract");
});

test("schema v8 mixed-Head PR work is durably fenced from new actions", async () => {
  const records = [
    prAssignment(1, { headRefOid: PR_HEAD_A }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  ];
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(
      record,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  Object.assign(items[0], {
    status: "working",
    ownerId: "legacy-pr-worker",
    leaseId: "legacy-pr-lease",
    leaseUntil: "2026-08-03T02:00:00.000Z",
    attempt: 1,
  });
  const legacyChild = createGraphChildWorkItem(
    {
      parentItemId: items[0].itemId,
      childKey: "legacy-conflict-fix",
      work: {
        title: "旧版冲突修复",
        description: "不得绕过 PR Head 切换继续执行。",
      },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: items[0].event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  delete legacyChild.source;
  delete legacyChild.sourceQuarantine;
  delete legacyChild.assignment.graphTask.sourceBinding;
  items.push(legacyChild);
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 2,
    sourceHighWatermark: 2,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({ records, store, limits });
  const migrated = (await fixture.service.listItems({ limit: 10 })).items;
  const working = migrated.find(
    ({ assignmentId }) => assignmentId === items[0].assignmentId,
  );
  const root = migrated.find(({ kind }) => kind === "source_root");
  const child = migrated.find(({ itemId }) => itemId === legacyChild.itemId);

  assert.equal(store.writes.length, 0);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_legacy_cutover");
  assert.equal(working.status, "working");
  assert.equal(working.statusReason, "pr_source_legacy_cutover");
  assert.equal(child.status, "blocked");
  assert.equal(child.statusReason, "pr_source_legacy_cutover");
  await assert.rejects(
    fixture.service.claim({
      itemId: child.itemId,
      expectedRevision: child.revision,
      workerId: "legacy-developer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: working.leaseId,
      actorId: "legacy-pr-worker",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  assert.equal(store.writes.length, 0);

  fixture.source.records.push(assignment(3));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);

  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const persisted = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === working.itemId,
  );
  assert.equal(persisted.statusReason, "pr_source_legacy_cutover");
  await assert.rejects(
    recovered.stageIntent({
      itemId: persisted.itemId,
      expectedRevision: persisted.revision,
      leaseId: persisted.leaseId,
      actorId: "legacy-pr-worker",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

test("schema v8 quarantine closes over cross-tree and transitive dependency consumers", async () => {
  const firstPr = prAssignment(1);
  const secondPr = prAssignment(2, {
    repository: "acme/other-repo",
    pullRequestNumber: 7,
    title: "PR 7",
  });
  const ordinaryRecord = prAssignment(3);
  ordinaryRecord.assignment = {
    ...ordinaryRecord.assignment,
    assignmentId: "workflow-assignment-ordinary-3",
    target: { type: "role", id: "developer" },
  };
  const firstPrItem = createAssignmentWorkItem(
    firstPr,
    "2026-08-02T02:00:00.000Z",
  );
  const secondPrItem = createAssignmentWorkItem(
    secondPr,
    "2026-08-02T02:00:00.000Z",
  );
  const ordinaryParent = createAssignmentWorkItem(
    ordinaryRecord,
    "2026-08-02T02:00:00.000Z",
  );
  for (const item of [firstPrItem, secondPrItem]) {
    Object.assign(item, {
      status: "completed",
      revision: 2,
      statusReason: "legacy_completed",
    });
  }
  const crossTreeWorker = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "cross-tree-worker",
      work: {
        title: "消费旧 PR 结果",
        description: "不得基于无法证明 Head 的旧 PR 结果继续执行。",
      },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [secondPrItem.itemId, firstPrItem.itemId].sort(),
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  Object.assign(crossTreeWorker, {
    status: "working",
    revision: 2,
    ownerId: "legacy-cross-tree-worker",
    leaseId: "legacy-cross-tree-lease",
    leaseUntil: "2026-08-03T02:00:00.000Z",
    attempt: 1,
  });
  const directConsumer = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "direct-consumer",
      work: { title: "直接消费者", description: "消费旧 PR 交付。" },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [secondPrItem.itemId],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  Object.assign(directConsumer, {
    status: "completed",
    revision: 2,
    statusReason: "legacy_completed",
  });
  const twoHopConsumer = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "two-hop-consumer",
      work: { title: "两跳消费者", description: "传递消费旧 PR 交付。" },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [directConsumer.itemId],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  const items = [
    secondPrItem,
    firstPrItem,
    ordinaryParent,
    crossTreeWorker,
    directConsumer,
    twoHopConsumer,
  ];
  for (const item of items) {
    delete item.source;
    delete item.sourceQuarantine;
    if (item.kind === "graph_task") {
      delete item.assignment.graphTask.sourceBinding;
    }
  }
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 2,
    intakeCursor: 3,
    sourceHighWatermark: 3,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      2,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({
    records: [firstPr, secondPr, ordinaryRecord],
    store,
    limits,
  });
  let migrated = (await fixture.service.listItems({ limit: 20 })).items;
  const roots = migrated
    .filter(({ kind }) => kind === "source_root")
    .sort((left, right) =>
      left.source.workKey === right.source.workKey
        ? left.itemId.localeCompare(right.itemId)
        : left.source.workKey.localeCompare(right.source.workKey)
    );
  const secondRoot = roots.find(
    ({ source }) => source.identity.repository === "acme/other-repo",
  );
  let migratedWorker = migrated.find(
    ({ itemId }) => itemId === crossTreeWorker.itemId,
  );
  let migratedDirect = migrated.find(
    ({ itemId }) => itemId === directConsumer.itemId,
  );
  let migratedTwoHop = migrated.find(
    ({ itemId }) => itemId === twoHopConsumer.itemId,
  );

  assert.equal(roots.length, 2);
  assert.equal(
    migratedWorker.sourceQuarantine.rootItemId,
    roots[0].itemId,
  );
  assert.equal(migratedDirect.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedTwoHop.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedWorker.status, "working");
  assert.equal(migratedTwoHop.status, "blocked");
  await assert.rejects(
    fixture.service.claim({
      itemId: migratedTwoHop.itemId,
      expectedRevision: migratedTwoHop.revision,
      workerId: "legacy-two-hop-worker",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: migratedWorker.itemId,
      expectedRevision: migratedWorker.revision,
      leaseId: migratedWorker.leaseId,
      actorId: migratedWorker.ownerId,
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );

  fixture.source.records.push(assignment(4));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits,
  });
  await recovered.recover();
  migrated = (await recovered.listItems({ limit: 20 })).items;
  migratedWorker = migrated.find(({ itemId }) => itemId === crossTreeWorker.itemId);
  migratedDirect = migrated.find(({ itemId }) => itemId === directConsumer.itemId);
  migratedTwoHop = migrated.find(({ itemId }) => itemId === twoHopConsumer.itemId);
  assert.equal(migratedWorker.sourceQuarantine.rootItemId, roots[0].itemId);
  assert.equal(migratedDirect.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedTwoHop.sourceQuarantine.rootItemId, secondRoot.itemId);
  await assert.rejects(
    recovered.claim({
      itemId: migratedTwoHop.itemId,
      expectedRevision: migratedTwoHop.revision,
      workerId: "legacy-two-hop-worker",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    recovered.stageIntent({
      itemId: migratedWorker.itemId,
      expectedRevision: migratedWorker.revision,
      leaseId: migratedWorker.leaseId,
      actorId: migratedWorker.ownerId,
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

for (const [legacyState, prepareOutbox] of [
  ["pending", () => {}],
  [
    "unsealed dispatching",
    (outbox) => {
      Object.assign(outbox, {
        status: "dispatching",
        revision: 2,
        attempt: 1,
        dispatcherId: "legacy-dispatcher",
        dispatchLeaseId: "legacy-dispatch-lease",
        dispatchLeaseUntil: "2026-08-02T03:00:00.000Z",
        dispatchBinding: null,
      });
    },
  ],
]) {
  test(`schema v8 ${legacyState} intent is failed while entering PR-source quarantine`, async () => {
    const record = prAssignment(1);
    const item = createAssignmentWorkItem(record, "2026-08-02T02:00:00.000Z");
    const outbox = createWorkIntentRecord(
      item,
      reviewIntent(),
      { roleId: "pr-engineer", workerId: "employee-pr-engineer" },
      "2026-08-02T02:00:00.000Z",
    );
    Object.assign(item, {
      status: "dispatch_pending",
      revision: 3,
      activeIntentId: outbox.intentId,
    });
    delete item.source;
    delete item.sourceQuarantine;
    prepareOutbox(outbox);
    delete outbox.sourceBinding;
    const limits = normalizeWorkLedgerLimits();
    const legacy = {
      ...emptyWorkLedgerState(),
      schemaVersion: 8,
      revision: 3,
      intakeCursor: 1,
      sourceHighWatermark: 1,
      items: [item],
      outbox: [outbox],
      graphMemoryProjection: migrateWorkGraphMemoryProjection(
        [item],
        3,
        limits,
      ),
    };
    const fixture = await createFixture({
      records: [record],
      store: new MemoryStore({ [STATE_KEY]: legacy }),
    });

    let migratedItem = (await fixture.service.listItems()).items.find(
      ({ assignmentId }) => assignmentId === item.assignmentId,
    );
    let migratedOutbox = (await fixture.service.listOutbox()).items[0];
    assert.equal(migratedItem.status, "blocked");
    assert.equal(migratedItem.activeIntentId, null);
    assert.equal(migratedItem.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
    assert.equal(
      migratedItem.sourceQuarantine.reason,
      LEGACY_PR_SOURCE_CUTOVER_REASON,
    );
    assert.equal(migratedOutbox.status, "failed");
    assert.equal(migratedOutbox.dispatcherId, null);
    assert.equal(migratedOutbox.dispatchLeaseId, null);
    assert.equal(migratedOutbox.dispatchLeaseUntil, null);
    assert.deepEqual(migratedOutbox.outcome, {
      status: "failed",
      details: { reason: "pr_source_legacy_cutover_before_dispatch" },
    });

    fixture.source.records.push(assignment(2));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    assert.equal(
      fixture.store.stored().schemaVersion,
      WORK_LEDGER_STATE_SCHEMA_VERSION,
    );
    const recovered = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await recovered.recover();
    migratedItem = (await recovered.listItems()).items.find(
      ({ assignmentId }) => assignmentId === item.assignmentId,
    );
    migratedOutbox = (await recovered.listOutbox()).items.find(
      ({ intentId }) => intentId === outbox.intentId,
    );
    assert.equal(migratedItem.status, "blocked");
    assert.equal(migratedItem.activeIntentId, null);
    assert.equal(
      migratedItem.sourceQuarantine.reason,
      LEGACY_PR_SOURCE_CUTOVER_REASON,
    );
    assert.equal(migratedOutbox.status, "failed");
    assert.equal(
      migratedOutbox.outcome.details.reason,
      "pr_source_legacy_cutover_before_dispatch",
    );
  });
}

test("schema v8 sealed intent settlement cannot release its PR source quarantine", async () => {
  const record = prAssignment(1);
  const item = createAssignmentWorkItem(record, "2026-08-02T02:00:00.000Z");
  const outbox = createWorkIntentRecord(
    item,
    reviewIntent(),
    { roleId: "pr-engineer", workerId: "employee-pr-engineer" },
    "2026-08-02T02:00:00.000Z",
  );
  const dispatchBinding = createWorkIntentDispatchBinding(
    boundReviewIntent(item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  );
  Object.assign(item, {
    status: "dispatch_pending",
    revision: 3,
    activeIntentId: outbox.intentId,
  });
  delete item.source;
  delete item.sourceQuarantine;
  Object.assign(outbox, {
    status: "dispatching",
    revision: 3,
    attempt: 1,
    dispatcherId: "legacy-dispatcher",
    dispatchLeaseId: "legacy-dispatch-lease",
    dispatchLeaseUntil: "2026-08-02T02:00:00.000Z",
    dispatchBinding,
  });
  delete outbox.sourceBinding;
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 3,
    intakeCursor: 1,
    sourceHighWatermark: 1,
    items: [item],
    outbox: [outbox],
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      [item],
      3,
      limits,
    ),
  };
  const fixture = await createFixture({
    records: [record],
    store: new MemoryStore({ [STATE_KEY]: legacy }),
  });
  let quarantined = (await fixture.service.listItems()).items.find(
    ({ assignmentId }) => assignmentId === item.assignmentId,
  );
  assert.equal(quarantined.sourceQuarantine.reason, LEGACY_PR_SOURCE_CUTOVER_REASON);

  const reclaimed = await fixture.service.claimIntent({
    intentId: outbox.intentId,
    expectedRevision: outbox.revision,
    dispatcherId: "legacy-settlement-dispatcher",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(reclaimed.dispatchBinding, dispatchBinding);
  await fixture.service.ackIntent({
    intentId: outbox.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: quarantined.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T04:00:00.000Z",
    details: { code: "legacy_downstream_timeout" },
  });
  quarantined = (await fixture.service.listItems()).items.find(
    ({ assignmentId }) => assignmentId === item.assignmentId,
  );
  assert.equal(quarantined.status, "blocked");
  assert.equal(quarantined.activeIntentId, null);
  assert.equal(quarantined.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(quarantined.sourceQuarantine.reason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  await assert.rejects(
    fixture.service.claim({
      itemId: quarantined.itemId,
      expectedRevision: quarantined.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

test("schema v8 PR history uses independent source-root byte budgets", async () => {
  const migrationCapacity = normalizeWorkLedgerLimits({
    sourceRootByteBudget: 16 * 1024 * 1024,
    sourceStateByteBudget: 96 * 1024 * 1024,
  });
  assert.equal(migrationCapacity.sourceRootByteBudget, 16 * 1024 * 1024);
  assert.equal(migrationCapacity.sourceStateByteBudget, 96 * 1024 * 1024);
  const records = Array.from({ length: 12 }, (_, index) =>
    prAssignment(index + 1, {
      eventType: index === 0
        ? "pull_request.updated"
        : "pull_request.status",
      occurredAt: `2026-08-02T01:${String(index).padStart(2, "0")}:00.000Z`,
      ciStatus: index % 2 === 0 ? "PENDING" : "FAILURE",
    })
  );
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(record, record.event.occurredAt);
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const root = createPullRequestSourceRootWorkItem(
    records[0],
    records[0].event.occurredAt,
  );
  for (const record of records.slice(1)) {
    const appended = appendPullRequestWorkSource(root.source, record);
    root.source = appended.source;
    root.inputDigest = appended.source.current.inputDigest;
    root.updatedAt = record.event.occurredAt;
  }
  const capacityBytes = (item) => {
    const view = structuredClone(item);
    delete view.graph;
    if (view.source === null) delete view.source;
    if (view.sourceQuarantine === null) delete view.sourceQuarantine;
    return Buffer.byteLength(`${JSON.stringify(view, null, 2)}\n`, "utf8");
  };
  const operationalItemByteBudget = Math.max(
    ...items.map((item) => capacityBytes({
      ...item,
      status: "cancelled",
      statusReason: "consolidated_pr_source_root",
    })),
  );
  const sourceRootByteBudget = capacityBytes(root);
  assert.ok(sourceRootByteBudget > operationalItemByteBudget);
  const limits = normalizeWorkLedgerLimits({
    itemByteBudget: operationalItemByteBudget,
    sourceRootByteBudget,
  });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: records.length,
    sourceHighWatermark: records.length,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const recovered = await createFixture({ records, store, limits });

  const migratedRoot = (await recovered.service.listItems({ limit: 20 }))
    .items.find(({ kind }) => kind === "source_root");
  assert.equal(migratedRoot.source.inputRevision, records.length);
  assert.ok(capacityBytes(migratedRoot) > limits.itemByteBudget);

  const undersizedStore = new MemoryStore({ [STATE_KEY]: legacy });
  const undersized = new WorkLedgerService({
    store: undersizedStore,
    assignmentSource: recovered.source,
    exclusiveLease: new ExclusiveLease(),
    clock: recovered.time.clock,
    idFactory: incrementingIds(),
    limits: {
      itemByteBudget: operationalItemByteBudget,
      sourceRootByteBudget: sourceRootByteBudget - 1,
    },
  });
  await assert.rejects(
    undersized.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersizedStore.stored(), legacy);
  assert.equal(undersizedStore.writes.length, 0);
});

test("recovery rejects tampering with the append-only PR source history", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const tampered = fixture.store.stored();
  tampered.items[0].source.revisions[0].headRevision = 2;
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("PR decision timeline recovery rejects a rehashed foreign execution binding", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: askUserIntent(),
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(({ type }) => type === "intent_staged");
  assert.deepEqual(timeline.details.inputBinding, prExecutionBinding(item));
  assert.equal(timeline.details.workItemRevision, item.revision + 1);
  timeline.details.inputBinding.repository = "foreign/repo";
  timeline.details.inputBinding.gitTarget.baseRepository = "foreign/repo";
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  const contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${contentDigest}`;
  timeline.contentDigest = contentDigest;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("PR timeline recovery rejects rebinding an old decision to the current Head", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: askUserIntent(),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T02:00:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      gitFacts: prGitFacts(PR_HEAD_B),
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const current = (await fixture.service.listItems()).items[0];
  const currentBinding = prExecutionBinding(current);
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(({ type }) => type === "intent_staged");
  timeline.details.inputBinding = structuredClone(currentBinding);
  timeline.details.inputDigest = currentBinding.inputDigest;
  timeline.details.workItemRevision = current.revision;
  timeline.at = current.updatedAt;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  const contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${contentDigest}`;
  timeline.contentDigest = contentDigest;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a failed intake write advances neither the durable cursor nor live items", async () => {
  const { service, source, store } = await createFixture({
    records: [assignment(1)],
  });
  store.failNextWrite();

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await service.getSummary()).intakeCursor, 0);
  assert.deepEqual((await service.listItems()).items, []);
  assert.equal(store.stored(), undefined);

  const retried = await service.intake();
  assert.equal(retried.cursor, 1);
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
  assert.equal(store.stored().items.length, 1);
});

test("invalid intake transitions retain the batch and durable diagnostic while existing work can proceed", async () => {
  const local = createLocalWorkLedgerCandidateProcessor();
  let rejectIntake = false;
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
    candidateProcessor: {
      commit: () => local.commit(),
      discard: () => local.discard(),
      async prepare(input) {
        if (rejectIntake && input.candidate.intakeCursor > input.previousState.intakeCursor) {
          const candidate = clone(input.candidate);
          const terminal = candidate.items.find(({ status }) => status === "completed");
          terminal.status = "queued";
          terminal.revision += 1;
          return local.prepare({ ...input, candidate });
        }
        return local.prepare(input);
      },
    },
  });
  await fixture.service.intake();
  let terminal = (await fixture.service.listItems()).items[0];
  terminal = await fixture.service.claim({
    itemId: terminal.itemId, expectedRevision: terminal.revision,
    workerId: "test-worker", leaseDurationMs: 30_000,
  });
  await fixture.service.complete({
    itemId: terminal.itemId, expectedRevision: terminal.revision,
    leaseId: terminal.leaseId, actorId: "test-worker", result: { outcome: "done" },
  });
  fixture.source.records.push(assignment(3));
  fixture.source.highWatermark = 3;
  rejectIntake = true;
  const result = await fixture.service.intake();
  assert.equal(result.error.code, "WORK_LEDGER_GRAPH_TRANSITION_INVALID");
  assert.equal(result.cursor, 2);
  assert.equal(result.received, 0);
  const after = fixture.store.stored();
  assert.equal(after.intakeCursor, 2);
  assert.equal(after.items.length, 2);
  assert.equal(after.items[0].status, "completed");
  const diagnostic = after.timeline.at(-1);
  assert.equal(diagnostic.type, "intake_rejected");
  assert.equal(diagnostic.details.afterSequence, 2);
  assert.equal(diagnostic.details.nextSequence, 3);
  assert.equal(diagnostic.details.batchDigest.length, 64);
  await fixture.service.intake();
  assert.equal(fixture.store.stored().revision, after.revision, "unchanged rejection does not generate noise");
  const available = (await fixture.service.listItems()).items[1];
  const claimed = await fixture.service.claim({
    itemId: available.itemId, expectedRevision: available.revision,
    workerId: "test-worker", leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");
  rejectIntake = false;
  assert.equal((await fixture.service.intake()).cursor, 3);
  assert.equal(fixture.store.stored().items.length, 3);
});

test("candidate processing commits only after durable write and discards failed writes", async () => {
  const events = [];
  const local = createLocalWorkLedgerCandidateProcessor();
  const candidateProcessor = {
    async prepare(request) {
      events.push("prepare");
      return local.prepare(request);
    },
    async commit() {
      events.push("commit");
      return local.commit();
    },
    async discard() {
      events.push("discard");
      return local.discard();
    },
  };
  const store = new MemoryStore();
  const durableWrite = store.write.bind(store);
  store.write = async (...arguments_) => {
    events.push("write");
    return durableWrite(...arguments_);
  };
  const { service } = await createFixture({
    records: [assignment(1)],
    store,
    candidateProcessor,
  });
  store.failNextWrite();

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  await service.intake();

  assert.deepEqual(events, [
    "prepare",
    "write",
    "discard",
    "prepare",
    "write",
    "commit",
  ]);
});

test("malformed worker success cannot reach the durable store", async (t) => {
  class MalformedCandidateWorker extends EventEmitter {
    constructor() {
      super();
      this.terminationCount = 0;
    }

    postMessage(message) {
      queueMicrotask(() => {
        this.emit("message", { requestId: message.requestId, ok: true });
      });
    }

    ref() {}

    unref() {}

    async terminate() {
      this.terminationCount += 1;
      return 1;
    }
  }

  const worker = new MalformedCandidateWorker();
  const candidateProcessor = createWorkerWorkLedgerCandidateProcessor({
    workerFactory: () => worker,
  });
  t.after(() => candidateProcessor.close());
  const store = new MemoryStore();
  const { service } = await createFixture({
    records: [assignment(1)],
    store,
    candidateProcessor,
  });

  await assert.rejects(
    service.intake(),
    (error) =>
      error.code === "WORK_LEDGER_STATE_CORRUPTED" &&
      error.statusCode === 503,
  );

  assert.equal(worker.terminationCount, 1);
  assert.equal(store.writes.length, 0);
  assert.equal(store.stored(), undefined);
});

test("a source retention gap creates a durable blocked system alert without skipping", async () => {
  const source = new FakeAssignmentSource([assignment(5), assignment(6)]);
  source.oldestAvailableSequence = 5;
  const { service } = await createFixture({ source });

  const first = await service.intake();
  const repeated = await service.intake();
  const items = (await service.listItems({ limit: 10 })).items;
  const timeline = (await service.listTimeline({ limit: 20 })).items;

  assert.deepEqual(first.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 6,
    reason: "source_retention",
  });
  assert.equal(first.cursor, 0);
  assert.equal(repeated.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
  assert.equal(items[0].currentTarget.type, "node");
  assert.equal(items[0].currentTarget.id, "work-ledger-system");
  assert.equal(
    timeline.filter(({ type }) => type === "intake_gap").length,
    2,
  );
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
});

test("an internal source sequence gap is blocked as a system alert before partial intake", async () => {
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [assignment(1), assignment(3)],
    nextSequence: 3,
    highWatermark: 3,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  const result = await service.intake();
  const items = (await service.listItems()).items;

  assert.deepEqual(result.gap, {
    expectedSequence: 2,
    actualSequence: 3,
    highWatermark: 3,
    reason: "source_sequence",
  });
  assert.equal(result.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
});

test("configuration-first admission neither intakes nor claims work", async (t) => {
  await t.test("intake", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.intake(),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fixture.source.calls.length, 0);
    assert.equal(fixture.store.writes.length, 0);
    assert.deepEqual((await fixture.service.listItems()).items, []);
  });

  await t.test("claim", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await fixture.service.intake();
    const queued = (await fixture.service.listItems()).items[0];
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.claim({
        itemId: queued.itemId,
        expectedRevision: queued.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    const unchanged = (await fixture.service.listItems()).items[0];
    assert.equal(unchanged.status, "queued");
    assert.equal(unchanged.revision, queued.revision);
    assert.equal(fixture.store.writes.length, 1);
  });
});

test("intake-first admission releases cutover before its source settles", async () => {
  const gate = readyActionAdmissionGate();
  const sourceEntered = deferred();
  const releaseSource = deferred();
  const source = new FakeAssignmentSource([assignment(1)]);
  source.override = async ({ afterSequence, limit }) => {
    sourceEntered.resolve();
    await releaseSource.promise;
    return {
      items: source.records
        .filter(({ sequence }) => sequence > afterSequence)
        .slice(0, limit),
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    };
  };
  const fixture = await createFixture({
    source,
    actionAdmissionGate: gate,
  });

  const intake = fixture.service.intake();
  await sourceEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseSource.resolve();
  assert.equal((await intake).received, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("claim-first admission releases cutover before its durable write settles", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const writeEntered = deferred();
  const releaseWrite = deferred();
  const write = fixture.store.write.bind(fixture.store);
  let deferNextWrite = true;
  fixture.store.write = async (...args) => {
    if (deferNextWrite) {
      deferNextWrite = false;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return write(...args);
  };

  const claim = fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await writeEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseWrite.resolve();
  const claimed = await claim;
  assert.equal(claimed.status, "working");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("trusted reconciliation rereads one durable item without new intake", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const concurrent = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await concurrent.recover();
  const claimed = await concurrent.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await activateNextConfiguration(gate);
  const sourceCalls = fixture.source.calls.length;

  const reconciled = await fixture.service.readItemForReconciliation({
    itemId: queued.itemId,
  });

  assert.equal(reconciled.status, "working");
  assert.equal(reconciled.revision, claimed.revision);
  assert.equal(reconciled.leaseId, claimed.leaseId);
  assert.equal(fixture.source.calls.length, sourceCalls);
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(
    fixture.service.readItemForReconciliation({ itemId: queued.itemId, extra: true }),
    (error) => error?.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("claim records a bounded lease, revision, and immutable input digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];

  const claimed = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "working");
  assert.equal(claimed.revision, queued.revision + 1);
  assert.equal(claimed.leaseId, "lease-0001");
  assert.equal(claimed.leaseUntil, "2026-08-02T02:00:30.000Z");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(claimed.inputDigest, queued.inputDigest);
  assert.equal(claimed.attempt, 1);

  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: queued.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: claimed.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_ACTIVE",
  );
});

test("graph dependencies and child ownership block work before a lease is issued", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [consumer, prerequisite] = durable.items;
  consumer.graph.dependsOnItemIds = [prerequisite.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.claim({
      itemId: consumer.itemId,
      expectedRevision: consumer.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let gate = await recovered.claim({
    itemId: prerequisite.itemId,
    expectedRevision: prerequisite.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  gate = await recovered.complete({
    itemId: gate.itemId,
    expectedRevision: gate.revision,
    leaseId: gate.leaseId,
    actorId: "employee-pr-reviewer",
    result: { outcome: "prerequisite-complete" },
  });
  assert.equal(gate.status, "completed");
  const readyConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const claimed = await recovered.claim({
    itemId: readyConsumer.itemId,
    expectedRevision: readyConsumer.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");

  const parentFixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await parentFixture.service.intake();
  const parentState = parentFixture.store.stored();
  const [parent, child] = parentState.items;
  child.graph.parentItemId = parent.itemId;
  parentFixture.store.replaceStored(parentState);
  const parentService = new WorkLedgerService({
    store: parentFixture.store,
    assignmentSource: parentFixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: parentFixture.time.clock,
    idFactory: incrementingIds(),
  });
  await parentService.recover();
  await assert.rejects(
    parentService.claim({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("a cancelled child settles parent claiming and completion", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, cancelledChild] = durable.items;
  cancelledChild.graph.parentItemId = parent.itemId;
  cancelledChild.status = "cancelled";
  cancelledChild.statusReason = "replaced-by-corrected-work";
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  const claimed = await recovered.claim({
    itemId: parent.itemId,
    expectedRevision: parent.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const completed = await recovered.complete({
    itemId: claimed.itemId,
    expectedRevision: claimed.revision,
    leaseId: claimed.leaseId,
    actorId: "employee-orchestrator",
    result: { outcome: "cancelled-child-settled" },
  });

  assert.equal(completed.status, "completed");
});

test("a cancelled dependency remains unsatisfied for real ledger claims", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [consumer, cancelledDependency] = durable.items;
  consumer.graph.dependsOnItemIds = [cancelledDependency.itemId];
  cancelledDependency.status = "cancelled";
  cancelledDependency.statusReason = "dependency-was-cancelled";
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.claim({
      itemId: consumer.itemId,
      expectedRevision: consumer.revision,
      workerId: "employee-orchestrator",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("completion reports an ordinary graph conflict before corrupt-state handling", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-orchestrator",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.complete({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      leaseId: parent.leaseId,
      actorId: "employee-orchestrator",
      result: { outcome: "premature" },
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation atomically closes a safe subtree and blocks its dependents", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child, dependent] = durable.items;
  child.graph.parentItemId = root.itemId;
  dependent.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "owner-cancelled-scope",
  };

  const result = await recovered.cancelGraphTask(request);

  assert.equal(result.root.status, "cancelled");
  assert.deepEqual(result.cancelledItemIds, [child.itemId, root.itemId].sort());
  const byId = new Map(
    (await recovered.listItems({ limit: 10 })).items.map((item) => [
      item.itemId,
      item,
    ]),
  );
  assert.equal(byId.get(root.itemId).status, "cancelled");
  assert.equal(byId.get(child.itemId).status, "cancelled");
  assert.equal(byId.get(dependent.itemId).status, "queued");
  const writesAfterCancellation = fixture.store.writes.length;
  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  const cancelledRoot = byId.get(root.itemId);
  const replay = await recovered.cancelGraphTask({
    ...request,
    expectedGraphRevision: fixture.store.stored().revision,
    expectedRevision: cancelledRoot.revision,
  });
  assert.equal(replay.root.status, "cancelled");
  assert.deepEqual(replay.cancelledItemIds, []);
  assert.equal(fixture.store.writes.length, writesAfterCancellation);
  await assert.rejects(
    recovered.claim({
      itemId: dependent.itemId,
      expectedRevision: dependent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
  const cancelledEvents = (await recovered.listTimeline({ limit: 20 })).items
    .filter(({ type }) => type === "cancelled");
  assert.equal(cancelledEvents.length, 2);

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
  assert.equal(
    (await restarted.listItems({ status: "cancelled" })).items.length,
    2,
  );
});

test("graph cancellation refuses an active descendant and invokes no DTO accessors", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child] = durable.items;
  child.graph.parentItemId = root.itemId;
  Object.assign(child, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "child-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "cancel-tree",
  };

  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) =>
      error.code === "WORK_LEDGER_CANCELLATION_UNSAFE" &&
      error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let invoked = false;
  const hostile = { ...request };
  Object.defineProperty(hostile, "reason", {
    enumerable: true,
    get() {
      invoked = true;
      return "hidden";
    },
  });
  await assert.rejects(
    recovered.cancelGraphTask(hostile),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_INVALID",
  );
  assert.equal(invoked, false);
});

test("graph cancellation refuses an already active reverse dependency consumer", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [dependency, consumer] = durable.items;
  consumer.graph.dependsOnItemIds = [dependency.itemId];
  Object.assign(consumer, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "consumer-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: dependency.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: dependency.revision,
      actorId: "employee-orchestrator",
      reason: "dependency-invalidated",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation refuses an active ancestor", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-planner",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: child.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: child.revision,
      actorId: "employee-orchestrator",
      reason: "child-no-longer-needed",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("completed descendants do not create false active-dependent cancellation conflicts", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  let durable = fixture.store.stored();
  const [root, child, consumer] = durable.items;
  child.graph.parentItemId = root.itemId;
  consumer.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  let completedChild = await recovered.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  completedChild = await recovered.complete({
    itemId: child.itemId,
    expectedRevision: completedChild.revision,
    leaseId: completedChild.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  const currentConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const workingConsumer = await recovered.claim({
    itemId: consumer.itemId,
    expectedRevision: currentConsumer.revision,
    workerId: "employee-consumer",
    leaseDurationMs: 30_000,
  });
  assert.equal(workingConsumer.status, "working");

  durable = fixture.store.stored();
  const currentRoot = durable.items.find(({ itemId }) => itemId === root.itemId);
  const result = await recovered.cancelGraphTask({
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: currentRoot.revision,
    actorId: "employee-orchestrator",
    reason: "remaining-root-work-cancelled",
  });

  assert.deepEqual(result.cancelledItemIds, [root.itemId]);
  assert.equal(result.root.status, "cancelled");
  assert.equal(
    (await recovered.listItems()).items.find(
      ({ itemId }) => itemId === child.itemId,
    ).status,
    "completed",
  );
});

test("an expired working lease is recoverable and every claim is auditable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const first = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-first",
    leaseDurationMs: 1_000,
  });
  fixture.time.advance(1_000);

  const recovered = await fixture.service.claim({
    itemId: first.itemId,
    expectedRevision: first.revision,
    workerId: "employee-recovery",
    leaseDurationMs: 2_000,
  });
  const types = (await fixture.service.listTimeline({ limit: 20 })).items.map(
    ({ type }) => type,
  );

  assert.equal(recovered.leaseId, "lease-0002");
  assert.equal(recovered.ownerId, "employee-recovery");
  assert.equal(recovered.attempt, 2);
  assert.deepEqual(
    types.filter((type) => ["lease_expired", "claimed"].includes(type)),
    ["claimed", "lease_expired", "claimed"],
  );
});

test("every working command rejects the old worker exactly at lease expiry without writing", async (t) => {
  const cases = [
    {
      name: "transition",
      invoke: (service, item) => service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-old",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
    },
    {
      name: "scheduleRetry",
      invoke: (service, item) => service.scheduleRetry({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        availableAt: "2026-08-02T02:02:00.000Z",
        reason: "temporary-failure",
      }),
    },
    {
      name: "handoff",
      invoke: (service, item) => service.handoff({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        target: { type: "role", id: "tester" },
        reason: "ready-for-testing",
      }),
    },
    {
      name: "complete",
      invoke: (service, item) => service.complete({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        result: { outcome: "done" },
      }),
    },
    {
      name: "stageIntent",
      invoke: (service, item) => service.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        roleId: "pr-reviewer",
        intent: reviewIntent(),
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      await fixture.service.intake();
      let item = (await fixture.service.listItems()).items[0];
      item = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-old",
        leaseDurationMs: 1_000,
      });
      fixture.time.advance(1_000);
      const writesBefore = fixture.store.writes.length;

      await assert.rejects(
        entry.invoke(fixture.service, item),
        (error) =>
          error.code === "WORK_LEDGER_LEASE_EXPIRED" &&
          error.statusCode === 409,
      );

      assert.equal(fixture.store.writes.length, writesBefore);
      assert.equal((await fixture.service.listItems()).items[0].status, "working");
      const recovered = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-recovery",
        leaseDurationMs: 1_000,
      });
      assert.equal(recovered.ownerId, "employee-recovery");
      assert.equal(recovered.attempt, 2);
    });
  }
});

test("assignment input rejects accessors without invoking them", async () => {
  let invoked = false;
  const unsafeAssignment = assignment(1);
  Object.defineProperty(unsafeAssignment.event.payload, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("must not run");
    },
  });
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [unsafeAssignment],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_SOURCE_INVALID",
  );
  assert.equal(invoked, false);
  assert.equal((await service.getSummary()).intakeCursor, 0);
});

test("transition requires the exact item revision and active work lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: "wrong-lease",
      toStatus: "waiting_user",
      actorId: "employee-pr-reviewer",
      reason: "need-product-choice",
      details: { questionRef: "question-1" },
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_CONFLICT",
  );

  const waiting = await fixture.service.transition({
    itemId: working.itemId,
    expectedRevision: working.revision,
    leaseId: working.leaseId,
    toStatus: "waiting_user",
    actorId: "employee-pr-reviewer",
    reason: "need-product-choice",
    details: { questionRef: "question-1" },
  });

  assert.equal(waiting.status, "waiting_user");
  assert.equal(waiting.ownerId, null);
  assert.equal(waiting.leaseId, null);
  assert.equal(waiting.leaseUntil, null);
  assert.equal(waiting.statusReason, "need-product-choice");
  assert.equal(waiting.revision, working.revision + 1);

  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: working.revision,
      toStatus: "queued",
      actorId: "owner",
      reason: "answered",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      toStatus: "dispatch_pending",
      actorId: "owner",
      reason: "bypass-outbox",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_TRANSITION_INVALID",
  );
});

test("contention retry restores only an owned active claim attempt", async (t) => {
  for (const variant of ["refund", "default", "invalidBoolean", "wrongOwner", "wrongLease", "wrongRevision"]) {
    await t.test(variant, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      await fixture.service.intake();
      let item = (await fixture.service.listItems()).items[0];
      item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision, workerId: "employee-pr-reviewer", leaseDurationMs: 30_000 });
      const input = {
        itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
        actorId: "employee-pr-reviewer", availableAt: "2026-08-02T02:01:00.000Z",
        reason: "context_changed", consumeAttempt: false,
      };
      if (variant === "default") delete input.consumeAttempt;
      if (variant === "invalidBoolean") input.consumeAttempt = "false";
      if (variant === "wrongOwner") input.actorId = "other-worker";
      if (variant === "wrongLease") input.leaseId = "wrong-lease";
      if (variant === "wrongRevision") input.expectedRevision -= 1;
      if (!["refund", "default"].includes(variant)) {
        await assert.rejects(fixture.service.scheduleRetry(input));
        assert.equal((await fixture.service.listItems()).items[0].attempt, 1);
        return;
      }
      const retried = await fixture.service.scheduleRetry(input);
      assert.equal(retried.status, "retry_wait");
      assert.equal(retried.attempt, variant === "refund" ? 0 : 1);
      assert.equal(retried.leaseId, null);
    });
  }
});

test("retry, handoff, and completion are explicit durable timeline events", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.scheduleRetry({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    availableAt: "2026-08-02T02:01:00.000Z",
    reason: "ci-still-running",
    details: { code: "ROLE_CONTEXT_TIMEOUT" },
  });

  assert.equal(item.status, "retry_wait");
  assert.equal(item.availableAt, "2026-08-02T02:01:00.000Z");
  const retryEvent = (await fixture.service.listTimeline()).items.find(
    ({ type }) => type === "retry_scheduled",
  );
  assert.equal(retryEvent.details.code, "ROLE_CONTEXT_TIMEOUT");
  await assert.rejects(
    fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_NOT_AVAILABLE",
  );

  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.handoff({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    target: { type: "role", id: "requirements-analyst" },
    reason: "requirement-unclear",
  });

  assert.equal(item.status, "queued");
  assert.deepEqual(item.currentTarget, {
    type: "role",
    id: "requirements-analyst",
  });
  assert.equal(item.assignment.target.id, "pr-reviewer");

  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-requirements",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.complete({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-requirements",
    result: { outcome: "clarified", evidenceRefs: ["note-1"] },
  });

  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(item.status, "completed");
  assert.equal(item.leaseId, null);
  assert.equal(types.includes("retry_scheduled"), true);
  assert.equal(types.includes("handed_off"), true);
  assert.equal(types.includes("completed"), true);
});

function reviewIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_github_review",
    summary: "建议批准 PR",
    reason: "检查通过",
    verdict: "approve",
    body: "本地审查未发现阻塞问题。",
    evidence: ["tests:passed"],
    ...overrides,
  };
}

function externalPullRequestActionIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_github_pull_request_action",
    summary: "请求更新 PR 分支",
    reason: "当前 Head 已落后 base",
    action: { type: "update_branch" },
    evidence: ["merge-state:behind"],
    ...overrides,
  };
}

function boundReviewIntent(item, overrides = {}) {
  const content = {
    policyVersion: 4,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    },
    binding: {
      repository: "acme/repo",
      pullRequestNumber: 41,
    },
    payload: {
      verdict: "approve",
      body: "本地审查未发现阻塞问题。",
      evidence: ["tests:passed"],
    },
    ...overrides,
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

async function prepareClaimedReviewIntent(fixture, leaseDurationMs = 30_000) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { item, staged, claimed };
}

async function prepareClaimedPullRequestReviewIntent(
  fixture,
  leaseDurationMs = 30_000,
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { staged, claimed };
}

async function prepareClaimedPullRequestExternalActionIntent(
  fixture,
  leaseDurationMs = 30_000,
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: externalPullRequestActionIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { staged, claimed };
}

function pullRequestReviewProposalBinding(item) {
  const event = currentWorkItemEvent(item);
  return {
    eventId: event.eventId,
    subject: event.subject,
    repository: event.subject.repository,
    pullRequestNumber: event.subject.number,
    headRefOid: event.payload.headRefOid,
    inputBinding: prExecutionBinding(item),
  };
}

function boundPullRequestReviewIntent(item, binding) {
  const event = currentWorkItemEvent(item);
  return boundReviewIntent(item, {
    requestedBy: {
      roleId: "pr-engineer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: event.eventId,
    },
    binding,
    payload: {
      verdict: "approve",
      body: "本地审查未发现阻塞问题。",
      evidence: ["tests:passed"],
      summary: "建议批准 PR",
      reason: "检查通过",
    },
  });
}

function boundPullRequestExternalActionIntent(item, binding) {
  const event = currentWorkItemEvent(item);
  const content = {
    policyVersion: 4,
    kind: "github_pull_request_action_proposal",
    requestedBy: {
      roleId: "pr-engineer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: event.eventId,
    },
    binding,
    payload: {
      action: { type: "update_branch" },
      evidence: ["merge-state:behind"],
      summary: "请求更新 PR 分支",
      reason: "当前 Head 已落后 base",
    },
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

function codeActionIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_code_action",
    summary: "修改受控代码",
    reason: "需要验证修复",
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["回归测试通过"],
    evidence: ["revision 未校验"],
    ...overrides,
  };
}

function handoffIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "handoff",
    summary: "需要测试岗位继续处理",
    reason: "开发检查已经完成",
    capability: "testing",
    brief: "执行跨平台回归",
    evidence: ["unit-tests:passed"],
    ...overrides,
  };
}

function askUserIntent() {
  return {
    schemaVersion: 1,
    type: "ask_user",
    summary: "需要用户确认验收口径",
    reason: "当前事实不足以替用户决定",
    question: "是否继续按当前验收口径推进？",
    choices: [
      { id: "yes", label: "继续", description: "保持当前口径" },
      { id: "no", label: "停止", description: "退回重新梳理" },
    ],
  };
}

function waitIntent(condition) {
  return {
    schemaVersion: 1,
    type: "wait_condition",
    summary: "等待外部事实",
    reason: "事实满足后再重新判断",
    condition,
    checkAfterSeconds: 60,
  };
}

test("stageIntent persists a complete policy-safe intent before dispatch is claimable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBeforeStage = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        ...reviewIntent(),
        dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
      },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBeforeStage);

  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(fixture.store.writes.length, writesBeforeStage + 1);
  assert.equal(staged.item.status, "dispatch_pending");
  assert.equal(staged.item.leaseId, null);
  assert.equal(staged.outbox.status, "pending");
  assert.match(staged.outbox.intentId, /^work-intent-[a-f0-9]{64}$/);
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "pr-reviewer",
    workerId: "employee-pr-reviewer",
  });
  assert.deepEqual(staged.outbox.intent, {
    ...reviewIntent(),
    dispatchIntentId: staged.outbox.intent.dispatchIntentId,
  });
  assert.match(
    staged.outbox.intent.dispatchIntentId,
    /^work-dispatch-intent-[a-f0-9]{64}$/,
  );
  assert.equal(staged.deliverySemantics, "at-least-once-idempotent");
  assert.equal(fixture.store.stored().outbox.length, 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 20 })).items.at(-1).type,
    "intent_staged",
  );

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: staged.item.itemId,
      expectedRevision: staged.item.revision,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        schemaVersion: 1,
        type: "propose_code_action",
        summary: "unsafe",
        reason: "unsafe",
        operation: "modify",
        objective: "unsafe",
        acceptanceCriteria: ["unsafe"],
        evidence: [],
        command: "rm -rf /",
      },
    }),
    (error) => error.code === "WORK_INTENT_INVALID",
  );
});

test("stageIntent binds the active lease owner and target role with one orchestrator exception", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-impostor",
      roleId: "pr-reviewer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  assert.equal(fixture.store.writes.length, writesBefore);

  const takeoverFixture = await createFixture({
    records: [assignment(1, { type: "person", id: "missing-owner" })],
  });
  await takeoverFixture.service.intake();
  let takeover = (await takeoverFixture.service.listItems()).items[0];
  takeover = await takeoverFixture.service.claim({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const askUser = {
    schemaVersion: 1,
    type: "ask_user",
    summary: "目标岗位缺失",
    reason: "需要用户决定安全路由",
    question: "由哪个岗位接手？",
    choices: [],
  };
  await assert.rejects(
    takeoverFixture.service.stageIntent({
      itemId: takeover.itemId,
      expectedRevision: takeover.revision,
      leaseId: takeover.leaseId,
      actorId: "employee-orchestrator",
      roleId: "orchestrator",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  const staged = await takeoverFixture.service.stageIntent({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    leaseId: takeover.leaseId,
    actorId: "employee-orchestrator",
    roleId: "orchestrator",
    intent: askUser,
  });
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "orchestrator",
    workerId: "employee-orchestrator",
  });
});

test("newest ledger query order paginates inside the selected order", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();

  const first = await fixture.service.listItems({ order: "newest", limit: 2 });
  const second = await fixture.service.listItems({
    order: "newest",
    limit: 2,
    cursor: first.nextCursor,
  });
  const timeline = await fixture.service.listTimeline({
    order: "newest",
    limit: 2,
  });

  assert.deepEqual(first.items.map(({ sourceSequence }) => sourceSequence), [3, 2]);
  assert.deepEqual(second.items.map(({ sourceSequence }) => sourceSequence), [1]);
  assert.equal(timeline.items[0].type, "intake_completed");
  await assert.rejects(
    fixture.service.listItems({ order: "sideways" }),
    (error) => error.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("recovery rejects requestedBy tampering because identity is part of the intent digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].requestedBy.workerId = "employee-impostor";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("outbox dispatch uses expiring leases and acknowledgement fences stale workers", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  const first = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 1_000,
  });
  assert.equal(first.status, "dispatching");
  assert.equal(first.dispatchLeaseId, "lease-0002");
  assert.equal(first.attempt, 1);
  assert.equal(first.deliverySemantics, "at-least-once-idempotent");

  await assert.rejects(
    fixture.service.claimIntent({
      intentId: first.intentId,
      expectedRevision: first.revision,
      dispatcherId: "another-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_ACTIVE",
  );
  fixture.time.advance(1_000);
  const recovered = await fixture.service.claimIntent({
    intentId: first.intentId,
    expectedRevision: first.revision,
    dispatcherId: "recovery-dispatcher",
    leaseDurationMs: 2_000,
  });
  assert.equal(recovered.dispatchLeaseId, "lease-0003");
  assert.equal(recovered.attempt, 2);

  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: first.revision,
      dispatchLeaseId: recovered.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: recovered.revision,
      dispatchLeaseId: first.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_CONFLICT",
  );

  const acknowledged = await fixture.service.ackIntent({
    intentId: recovered.intentId,
    expectedRevision: recovered.revision,
    dispatchLeaseId: recovered.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "recovery-dispatcher",
    details: { downstreamRef: "confirmation-1" },
  });

  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.outbox.dispatchLeaseId, null);
  assert.equal(acknowledged.item.status, "waiting_external");
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_acknowledged",
  );
});

test("intent policy binding is durable, idempotent, and fenced by its live lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture, 1_000);
  const boundIntent = boundReviewIntent(staged.item);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent,
  };
  const writesBeforeBinding = fixture.store.writes.length;

  const sealed = await fixture.service.bindIntent(input);

  assert.equal(sealed.revision, claimed.revision + 1);
  assert.deepEqual(sealed.dispatchBinding.boundIntent, boundIntent);
  assert.match(sealed.dispatchBinding.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_bound",
  );

  const replay = await fixture.service.bindIntent(input);
  assert.deepEqual(replay.dispatchBinding, sealed.dispatchBinding);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);

  fixture.time.advance(1_000);
  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_EXPIRED",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    sealed.dispatchBinding,
  );
});

test("a failed binding write leaves the claimed intent exactly retryable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  };
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);

  const retried = await fixture.service.bindIntent(input);
  assert.deepEqual(retried.dispatchBinding.boundIntent, input.boundIntent);
});

test("intent binding rejects stale items and semantically changed plans without writing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const base = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
  };
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.bindIntent({
      ...base,
      itemExpectedRevision: staged.item.revision + 1,
      boundIntent: boundReviewIntent(staged.item),
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  const changedSource = boundReviewIntent(staged.item, {
    source: {
      assignmentId: "workflow-assignment-forged",
      eventId: staged.item.event.eventId,
    },
  });
  await assert.rejects(
    fixture.service.bindIntent({ ...base, boundIntent: changedSource }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
});

test("recovery rejects a tampered durable intent binding", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].dispatchBinding.boundIntent.payload.body = "篡改后的动作";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema v7 quarantines an in-flight intent whose old policy binding is unknowable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await prepareClaimedReviewIntent(fixture, 1_000);
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 7;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
  }
  for (const entry of legacy.outbox) {
    delete entry.dispatchBinding;
    delete entry.sourceBinding;
  }
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    { status: "legacy_unknown" },
  );
  const quarantined = (await recovered.listOutbox()).items[0];
  const writesBeforeClaim = fixture.store.writes.length;
  await assert.rejects(
    recovered.claimIntent({
      intentId: quarantined.intentId,
      expectedRevision: quarantined.revision,
      dispatcherId: "recovery-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
  );
  assert.equal(fixture.store.writes.length, writesBeforeClaim);
  assert.equal(fixture.store.stored().schemaVersion, 7);
});

test("schema v9 quarantines a sealed PR proposal without an input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } = await prepareClaimedPullRequestReviewIntent(
    fixture,
    1_000,
  );
  const legacyBinding = pullRequestReviewProposalBinding(staged.item);
  delete legacyBinding.inputBinding;
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestReviewIntent(staged.item, legacyBinding),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const quarantined = (await recovered.listOutbox()).items[0];
  assert.deepEqual(quarantined.dispatchBinding, { status: "legacy_unknown" });
  const writesBeforeClaims = fixture.store.writes.length;
  for (const dispatcherId of ["recovery-dispatcher-1", "recovery-dispatcher-2"]) {
    await assert.rejects(
      recovered.claimIntent({
        intentId: quarantined.intentId,
        expectedRevision: quarantined.revision,
        dispatcherId,
        leaseDurationMs: 1_000,
      }),
      (error) => error.code === "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
    );
  }
  assert.equal(fixture.store.writes.length, writesBeforeClaims);
});

test("schema v9 also quarantines a sealed PR external action without input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } =
    await prepareClaimedPullRequestExternalActionIntent(fixture, 1_000);
  const legacyBinding = pullRequestReviewProposalBinding(staged.item);
  delete legacyBinding.inputBinding;
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestExternalActionIntent(
      staged.item,
      legacyBinding,
    ),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const quarantined = (await recovered.listOutbox()).items[0];
  assert.deepEqual(quarantined.dispatchBinding, { status: "legacy_unknown" });
});

test("schema v9 preserves a sealed PR proposal with an input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } = await prepareClaimedPullRequestReviewIntent(
    fixture,
  );
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestReviewIntent(
      staged.item,
      pullRequestReviewProposalBinding(staged.item),
    ),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const migrated = (await recovered.listOutbox()).items[0];
  assert.deepEqual(migrated.dispatchBinding, sealed.dispatchBinding);
  assert.deepEqual(
    migrated.dispatchBinding.boundIntent.binding.inputBinding,
    prExecutionBinding(staged.item),
  );
});

test("a delivered handoff atomically acknowledges the outbox and queues the trusted role", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const writesBeforeAck = fixture.store.writes.length;

  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    target: { type: "role", id: "tester" },
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  });

  assert.equal(fixture.store.writes.length, writesBeforeAck + 1);
  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.item.status, "queued");
  assert.deepEqual(acknowledged.item.currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal(acknowledged.item.assignment.target.id, "pr-reviewer");
  assert.deepEqual(
    (await fixture.service.listTimeline({ limit: 50 })).items
      .slice(-2)
      .map(({ type }) => type),
    ["intent_acknowledged", "handed_off"],
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listItems()).items[0].currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal((await recovered.listOutbox()).items[0].status, "delivered");
});

test("handoff acknowledgement is exact, role-only, and retryable after a failed atomic write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  };

  await assert.rejects(
    fixture.service.ackIntent(base),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "person", id: "someone" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  fixture.store.failNextWrite();
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].status, "dispatching");
  assert.equal((await fixture.service.listItems()).items[0].status, "dispatch_pending");

  const retried = await fixture.service.ackIntent({
    ...base,
    target: { type: "role", id: "tester" },
  });
  assert.equal(retried.outbox.status, "delivered");
  assert.equal(retried.item.status, "queued");
});

test("non-handoff intents cannot use queued acknowledgement or inject a target", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: "bound-review" },
  };

  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "queued",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "waiting_external",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
});

test("the real assignment-feed gap error becomes a blocked alert", async () => {
  const source = new FakeAssignmentSource();
  let oldestAvailableSequence = 5;
  let highWatermark = 8;
  source.override = ({ afterSequence }) => {
    throw Object.assign(new Error("retention gap"), {
      code: "WORKFLOW_ASSIGNMENT_GAP",
      statusCode: 409,
      details: Object.freeze({
        afterSequence,
        expectedSequence: afterSequence + 1,
        oldestAvailableSequence,
        highWatermark,
      }),
    });
  };
  const { service } = await createFixture({ source });

  const result = await service.intake();

  assert.deepEqual(result.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 8,
    reason: "source_retention",
  });
  assert.equal(result.cursor, 0);
  assert.equal((await service.getSummary()).sourceHighWatermark, 8);
  assert.equal((await service.listItems()).items[0].status, "blocked");

  oldestAvailableSequence = 6;
  highWatermark = 9;
  await service.intake();
  assert.equal((await service.listItems()).items.length, 1);
  assert.equal((await service.getSummary()).sourceHighWatermark, 9);
});

test("a reused assignmentId with different input blocks cursor advancement", async () => {
  const source = new FakeAssignmentSource([assignment(1)]);
  const { service } = await createFixture({ source });
  await service.intake({ limit: 1 });
  const conflicting = assignment(2);
  conflicting.assignment.assignmentId = "workflow-assignment-1";
  source.records.push(conflicting);
  source.highWatermark = 2;

  await assert.rejects(
    service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_ASSIGNMENT_CONFLICT",
  );

  assert.equal((await service.getSummary()).intakeCursor, 1);
  assert.equal((await service.listItems()).items.length, 1);
});

test("recovery restores work, timeline, and outbox and rejects input tampering", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const before = {
    summary: await fixture.service.getSummary(),
    items: await fixture.service.listItems(),
    timeline: await fixture.service.listTimeline(),
    outbox: await fixture.service.listOutbox(),
  };
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  assert.deepEqual(await recovered.getSummary(), before.summary);
  assert.deepEqual(await recovered.listItems(), before.items);
  assert.deepEqual(await recovered.listTimeline(), before.timeline);
  assert.deepEqual(await recovered.listOutbox(), before.outbox);

  const tampered = fixture.store.stored();
  tampered.items[0].event.payload.title = "tampered";
  fixture.store.replaceStored(tampered);
  const rejected = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await assert.rejects(
    rejected.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery revalidates the complete work-intent DTO", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].intent.command = "git push --force";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery rejects dispatch-pending work without exactly one active outbox", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox = [];
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a failed intent can be restaged with the same idempotency key", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  let staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatchIntentId = staged.outbox.intent.dispatchIntentId;
  let dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 30_000,
  });
  dispatch = await fixture.service.bindIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "confirmation-bridge",
    dispatchLeaseId: dispatch.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const failed = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "confirmation-bridge",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: failed.item.itemId,
    expectedRevision: failed.item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(staged.outbox.intentId, dispatch.intentId);
  assert.equal(staged.outbox.intent.dispatchIntentId, dispatchIntentId);
  assert.equal(staged.outbox.status, "pending");
  assert.equal(staged.outbox.dispatchBinding, null);
  assert.equal(staged.outbox.attempt, 1);
  assert.equal((await fixture.service.listOutbox()).items.length, 1);
  assert.equal(
    (await fixture.service.listOutbox({ status: "pending" })).items.length,
    1,
  );
  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(types.includes("retry_scheduled"), true);
});

test("capacity rejection leaves the next assignment and cursor retryable", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
    limits: { itemLimit: 1 },
  });
  await fixture.service.intake({ limit: 1 });

  await assert.rejects(
    fixture.service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_CAPACITY_EXCEEDED",
  );

  assert.equal((await fixture.service.getSummary()).intakeCursor, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(fixture.store.stored().intakeCursor, 1);
  assert.deepEqual(
    fixture.source.calls.map(({ afterSequence }) => afterSequence),
    [0, 1],
  );
});

test("timeline retention remains contiguous and recoverable", async () => {
  const fixture = await createFixture({
    records: [assignment(1)],
    limits: { timelineLimit: 3 },
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  const summary = await fixture.service.getSummary();
  const timeline = (await fixture.service.listTimeline()).items;
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.map(({ sequence }) => sequence), [2, 3, 4]);
  assert.equal(summary.timelineStartSequence, 2);
  assert.equal(summary.nextTimelineSequence, 5);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { timelineLimit: 3 },
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listTimeline()).items, timeline);
});

test("services sharing an exclusive lease re-read durable state before writes", async () => {
  const store = new MemoryStore();
  const source = new FakeAssignmentSource([assignment(1)]);
  const lease = new ExclusiveLease();
  const time = controlledClock();
  const first = await createFixture({ store, source, lease, time });
  const second = await createFixture({ store, source, lease, time });
  await first.service.intake();
  const queued = (await first.service.listItems()).items[0];

  const claimed = await second.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-second-process",
    leaseDurationMs: 30_000,
  });
  const waiting = await first.service.transition({
    itemId: claimed.itemId,
    expectedRevision: claimed.revision,
    leaseId: claimed.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-second-process",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  assert.equal(waiting.status, "waiting_condition");
  assert.equal(store.stored().items.length, 1);
  assert.equal(store.stored().items[0].revision, waiting.revision);
});

test("durable revision rollback and same-revision forks fail closed", async (t) => {
  await t.test("rollback", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const rolledBack = fixture.store.stored();
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    fixture.store.replaceStored(rolledBack);

    await assert.rejects(
      fixture.service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-pr-reviewer",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("fork", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const item = (await fixture.service.listItems()).items[0];
    const fork = fixture.store.stored();
    fork.items[0].statusReason = "valid-but-forked";
    fixture.store.replaceStored(fork);

    await assert.rejects(
      fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });
});

test("a failed transition write preserves the active lease for exact retry", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.transition({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "await-ci",
      details: { conditionRef: "ci:pr-1" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await fixture.service.listItems()).items[0].status, "working");
  const retried = await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });
  assert.equal(retried.status, "waiting_condition");
});

test("transition details reject untrusted command-like fields", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: working.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "unsafe",
      details: { command: "git push" },
    }),
    (error) => error.code === "WORK_LEDGER_DETAILS_INVALID",
  );
});

async function prepareAttentionResult(
  fixture,
  answer,
  {
    workerId = "employee-pr-reviewer",
    roleId = "pr-reviewer",
  } = {},
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
  const intent = askUserIntent();
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: workerId,
    roleId,
    intent,
  });
  const request = normalizeAttentionRequest({
    requestKey: staged.outbox.intentId,
    type: "ask_user",
    producer: {
      roleId,
      workItemId: item.itemId,
    },
    question: intent.question,
    context: [],
    choices: intent.choices,
  });
  const attentionItem = createAttentionItem(
    request,
    1,
    "2026-08-02T01:59:00.000Z",
  );
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_user",
    actorId: "work-intent-dispatcher",
    details: {
      questionRef: attentionItem.requestId,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  return resolveAttentionItem(
    attentionItem,
    answer,
    2,
    "2026-08-02T02:00:00.000Z",
    1,
  ).outbox;
}

for (const lifecycle of [
  { eventType: "issue.left_scope", reason: "issue_source_left_scope" },
  { eventType: "issue.completed", reason: "issue_source_completed" },
]) {
  test(`${lifecycle.eventType} cancels its historical user question and revokes attention authority`, async () => {
    const initial = issueAssignment(1);
    const fixture = await createFixture({ records: [initial] });
    await prepareAttentionResult(
      fixture,
      { type: "text", text: "already completed" },
      {
        workerId: "configured-requirements-analyst",
        roleId: "requirements-analyst",
      },
    );
    const waiting = (await fixture.service.listItems()).items[0];
    assert.equal(waiting.status, "waiting_user");
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: waiting.activeIntentId,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      true,
    );
    for (const producer of [
      { roleId: "developer", workItemId: waiting.itemId },
      { roleId: "requirements-analyst", workItemId: `${waiting.itemId}-wrong` },
    ]) {
      assert.equal(
        await fixture.service.isAttentionRequestCurrent({
          requestKey: waiting.activeIntentId,
          producer,
        }),
        false,
      );
    }
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: `${waiting.activeIntentId}-wrong`,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      false,
    );

    fixture.source.records.push(
      issueAssignment(2, {
        eventType: lifecycle.eventType,
        occurredAt: "2026-08-02T02:05:00.000Z",
        state: "closed",
      }),
    );
    fixture.source.highWatermark = 2;
    await fixture.service.intake();

    const items = (await fixture.service.listItems({ limit: 10 })).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].itemId, waiting.itemId);
    assert.equal(items[0].status, "cancelled");
    assert.equal(items[0].statusReason, lifecycle.reason);
    assert.equal(items[0].activeIntentId, null);
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: waiting.activeIntentId,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      false,
    );
  });
}

test("new Issue evidence revokes an older question for the same role", async () => {
  const initial = issueAssignment(1);
  const fixture = await createFixture({ records: [initial] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "old answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = {
    requestKey: waiting.activeIntentId,
    producer: {
      roleId: "requirements-analyst",
      workItemId: waiting.itemId,
    },
  };
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);

  fixture.source.records.push(issueAssignment(2, {
    eventType: "issue.updated",
    occurredAt: "2026-08-02T02:05:00.000Z",
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), false);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.length, 2);
  const retired = items.find(({ itemId }) => itemId === waiting.itemId);
  assert.equal(retired.status, "cancelled");
  assert.equal(retired.statusReason, "issue_assignment_superseded");
  assert.equal(retired.activeIntentId, null);
  assert.equal(items.find(({ itemId }) => itemId !== waiting.itemId).status, "queued");
});

test("one intake batch keeps only the newest Issue assignment for one role", async () => {
  const fixture = await createFixture({
    records: [
      issueAssignment(1),
      issueAssignment(2, {
        eventType: "issue.updated",
        occurredAt: "2026-08-02T02:05:00.000Z",
      }),
    ],
  });

  const result = await fixture.service.intake({ limit: 10 });

  assert.equal(result.received, 2);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceSequence, 2);
  assert.equal(items[0].status, "queued");
});

test("inactive Issue maintenance retires work outside the configured active window", async () => {
  const fixture = await createFixture({
    records: [
      issueAssignment(1, {
        occurredAt: "2026-07-01T00:00:00.000Z",
        issueNumber: 41,
      }),
      issueAssignment(2, {
        occurredAt: "2026-08-20T00:00:00.000Z",
        issueNumber: 42,
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });

  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(result.retired, 1);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const oldIssue = items.find(({ sourceSequence }) => sourceSequence === 1);
  const recentIssue = items.find(({ sourceSequence }) => sourceSequence === 2);
  assert.equal(oldIssue.status, "cancelled");
  assert.equal(oldIssue.statusReason, "issue_outside_active_window");
  assert.equal(recentIssue.status, "queued");
});

test("targeted Issue maintenance retires newly received stale work", async () => {
  const fixture = await createFixture({
    records: [issueAssignment(1, {
      occurredAt: "2026-07-01T00:00:00.000Z",
      issueNumber: 41,
    })],
  });

  const intake = await fixture.service.intake({ limit: 10 });
  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: intake.itemIds,
  });

  assert.equal(result.retired, 1);
  const item = (await fixture.service.listItems({ limit: 10 })).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.statusReason, "issue_outside_active_window");
});

test("targeted Issue maintenance retires every selected role for one Issue", async () => {
  const requirements = issueAssignment(1, {
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  const developer = issueAssignment(2, {
    eventType: "issue.updated",
    occurredAt: "2026-07-01T00:05:00.000Z",
  });
  developer.assignment.target = { type: "role", id: "developer" };
  const fixture = await createFixture({ records: [requirements, developer] });
  const intake = await fixture.service.intake({ limit: 10 });

  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: intake.itemIds,
  });

  assert.equal(result.retired, 2);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.every(({ status }) => status === "cancelled"), true);
});

test("recovery retires a legacy Issue assignment superseded by newer evidence", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "legacy answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const newer = persistLegacyIssueLifecycleAssignment(
    fixture,
    issueAssignment(2, {
      eventType: "issue.updated",
      occurredAt: "2026-08-02T02:05:00.000Z",
    }),
  );

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  const items = (await restarted.service.listItems({ limit: 10 })).items;
  const retired = items.find(({ itemId }) => itemId === waiting.itemId);
  assert.equal(retired.status, "cancelled");
  assert.equal(retired.statusReason, "issue_assignment_superseded");
  assert.equal(items.find(({ itemId }) => itemId === newer.itemId).status, "queued");
});

test("content-version caching reuses validated graph state and still fails closed", async (t) => {
  await t.test("unchanged durable content reuses the validated graph projection", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();

    const first = await fixture.service.getGraphSnapshot();
    const readsAfterFirstProjection = store.versionedValueReads;
    const second = await fixture.service.getGraphSnapshot();

    assert.equal(second, first);
    assert.equal(store.versionedValueReads, readsAfterFirstProjection);
  });

  await t.test("a durable rollback invalidates the cache", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    const rolledBack = store.stored();
    const item = (await fixture.service.listItems()).items[0];
    await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    await fixture.service.getGraphSnapshot();

    store.replaceStored(rolledBack);
    await assert.rejects(
      fixture.service.getGraphSnapshot(),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("a same-revision fork invalidates the cache", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    await fixture.service.getGraphSnapshot();
    const fork = store.stored();
    fork.items[0].statusReason = "valid-but-forked";
    store.replaceStored(fork);

    await assert.rejects(
      fixture.service.getGraphSnapshot(),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("a lost write acknowledgement is visible on the next graph read", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    const waiting = await prepareWaitingCondition(fixture, {
      kind: "workflow_fact",
      fact: "ci-status",
      oneOf: ["success"],
    });
    const before = await fixture.service.getGraphSnapshot();
    const durableWrite = store.write.bind(store);
    let loseAcknowledgement = true;
    store.write = async (...arguments_) => {
      const version = await durableWrite(...arguments_);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("durable acknowledgement lost");
      }
      return version;
    };

    await assert.rejects(
      fixture.service.wakeCondition({
        itemId: waiting.item.itemId,
        expectedRevision: waiting.item.revision,
        intentId: waiting.intentId,
        actorId: "work-condition-waker",
        observation: {
          kind: "workflow_fact",
          fact: "ci-status",
          value: "success",
          observedAt: "2026-08-02T02:00:00.000Z",
        },
      }),
      (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
    );

    const browserSnapshot = await fixture.service.getLastCommittedGraphSnapshot();
    assert.equal(browserSnapshot, before);
    const recovered = await fixture.service.getGraphSnapshot();
    assert.equal(recovered.graph.revision, before.graph.revision + 1);
    assert.equal(recovered.graph.tasks[0].revision, waiting.item.revision + 1);
  });
});

test("browser graph reads bypass an in-flight write without weakening authoritative reads", async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({
    records: [assignment(1)],
    store,
    postCommitYield: async () => {},
  });
  await fixture.service.intake();
  const before = await fixture.service.getLastCommittedGraphSnapshot();
  const item = (await fixture.service.listItems()).items[0];
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const durableWrite = store.write.bind(store);
  store.write = async (...arguments_) => {
    writeStarted.resolve();
    await releaseWrite.promise;
    return durableWrite(...arguments_);
  };

  const claim = fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await writeStarted.promise;
  const browserSnapshot = await fixture.service.getLastCommittedGraphSnapshot();
  const authoritativeSnapshot = fixture.service.getGraphSnapshot();
  let authoritativeSettled = false;
  authoritativeSnapshot.finally(() => {
    authoritativeSettled = true;
  });
  await Promise.resolve();

  assert.equal(browserSnapshot, before);
  assert.equal(authoritativeSettled, false);

  releaseWrite.resolve();
  await claim;
  const after = await authoritativeSnapshot;
  assert.equal(after.graph.revision, before.graph.revision + 1);
});

test("a committed ledger write yields after publishing its browser snapshot", async () => {
  const yieldStarted = deferred();
  const releaseYield = deferred();
  const fixture = await createFixture({
    records: [assignment(1)],
    postCommitYield: async () => {
      yieldStarted.resolve();
      await releaseYield.promise;
    },
  });

  const intake = fixture.service.intake();
  await yieldStarted.promise;
  const duringYield = await fixture.service.getLastCommittedGraphSnapshot();
  let intakeSettled = false;
  intake.finally(() => {
    intakeSettled = true;
  });
  await Promise.resolve();

  assert.equal(duringYield.graph.revision, 1);
  assert.equal(intakeSettled, false);

  releaseYield.resolve();
  await intake;
});

test("recovery preserves distinct manual Issues assigned to the same role", async () => {
  const fixture = await createFixture({
    records: [
      ownerRequestedIssueAssignment(1, 101),
      ownerRequestedIssueAssignment(2, 102),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  assert.deepEqual(
    (await fixture.service.listItems({ limit: 10 })).items.map(({ status }) => status),
    ["queued", "queued"],
  );

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });
  const recovered = (await restarted.service.listItems({ limit: 10 })).items;

  assert.deepEqual(recovered.map(({ status }) => status), ["queued", "queued"]);
  assert.deepEqual(
    recovered.map(({ event }) => event.subject.number).sort((left, right) => left - right),
    [101, 102],
  );
});

test("recovery does not treat a newer Issue graph child as a root assignment", async () => {
  const olderDeveloperRecord = issueAssignment(1);
  olderDeveloperRecord.assignment.target = { type: "role", id: "developer" };
  const fixture = await createFixture({ records: [olderDeveloperRecord] });
  await fixture.service.intake();
  const olderDeveloper = (await fixture.service.listItems()).items[0];
  const newerRoot = persistLegacyIssueLifecycleAssignment(
    fixture,
    issueAssignment(2, {
      eventType: "issue.updated",
      occurredAt: "2026-08-02T02:05:00.000Z",
    }),
  );
  const newerChildRecord = issueAssignment(3, {
    eventType: "issue.updated",
    occurredAt: "2026-08-02T02:06:00.000Z",
  });
  newerChildRecord.assignment.target = { type: "role", id: "developer" };
  const newerChild = persistLegacyIssueLifecycleAssignment(
    fixture,
    newerChildRecord,
  );
  const durable = fixture.store.stored();
  const child = durable.items.find(({ itemId }) => itemId === newerChild.itemId);
  child.graph.parentItemId = newerRoot.itemId;
  fixture.store.replaceStored(durable);

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  const items = (await restarted.service.listItems({ limit: 10 })).items;
  assert.equal(
    items.find(({ itemId }) => itemId === olderDeveloper.itemId).status,
    "queued",
  );
  assert.equal(
    items.find(({ itemId }) => itemId === newerChild.itemId).status,
    "queued",
  );
});

test("recovery retires a persisted Issue lifecycle task but preserves a later reopen", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "already completed" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const completed = issueAssignment(2, {
    eventType: "issue.completed",
    occurredAt: "2026-08-02T02:05:00.000Z",
    state: "closed",
  });
  const legacyLifecycle = persistLegacyIssueLifecycleAssignment(
    fixture,
    completed,
  );
  const writesBeforeRecovery = fixture.store.writes.length;
  const reopened = issueAssignment(3, {
    occurredAt: "2026-08-02T02:10:00.000Z",
    state: "open",
  });
  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([reopened]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  assert.equal(fixture.store.writes.length, writesBeforeRecovery + 1);
  const recovered = (await restarted.service.listItems({ limit: 10 })).items;
  assert.equal(recovered.length, 2);
  assert.equal(
    recovered.find(({ itemId }) => itemId === legacyLifecycle.itemId).status,
    "cancelled",
  );
  assert.equal(
    recovered.every(({ statusReason }) => statusReason === "issue_source_completed"),
    true,
  );

  await restarted.service.intake();
  const afterReopen = (await restarted.service.listItems({ limit: 10 })).items;
  const reopenedItem = afterReopen.find(
    (item) => currentWorkItemEvent(item).eventId === reopened.event.eventId,
  );
  assert.equal(reopenedItem.status, "queued");
  assert.equal(reopenedItem.statusReason, null);
});

test("a late answer for lifecycle-cancelled Issue work is discarded without blocking the cursor", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  const result = await prepareAttentionResult(
    fixture,
    { type: "text", text: "late answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  fixture.source.records.push(
    issueAssignment(2, {
      eventType: "issue.left_scope",
      occurredAt: "2026-08-02T02:05:00.000Z",
      state: "closed",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const applied = await fixture.service.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });

  assert.equal(applied.cursor, 1);
  assert.equal(applied.applied, 1);
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.decisionContext, null);
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  const discarded = timeline.items.find(
    ({ type }) => type === "stale_result_discarded",
  );
  assert.equal(discarded.details.reason, "issue_source_left_scope");
});

test("late answers for superseded or inactive Issue work are safely discarded", async (context) => {
  for (const scenario of [
    {
      name: "superseded",
      reason: "issue_assignment_superseded",
      settle: async (fixture) => {
        fixture.source.records.push(issueAssignment(2, {
          eventType: "issue.updated",
          occurredAt: "2026-08-02T02:05:00.000Z",
        }));
        fixture.source.highWatermark = 2;
        await fixture.service.intake();
      },
    },
    {
      name: "inactive",
      reason: "issue_outside_active_window",
      settle: (fixture) => fixture.service.retireInactiveIssues({
        updatedBefore: "2026-08-15T00:00:00.000Z",
      }),
    },
  ]) {
    await context.test(scenario.name, async () => {
      const initial = scenario.name === "inactive"
        ? issueAssignment(1, { occurredAt: "2026-07-01T00:00:00.000Z" })
        : issueAssignment(1);
      const fixture = await createFixture({ records: [initial] });
      const result = await prepareAttentionResult(
        fixture,
        { type: "text", text: "late answer" },
        {
          workerId: "configured-requirements-analyst",
          roleId: "requirements-analyst",
        },
      );
      await scenario.settle(fixture);

      const applied = await fixture.service.applyAttentionBatch({
        items: [result],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });

      assert.equal(applied.cursor, 1);
      assert.equal(applied.applied, 1);
      const item = (await fixture.service.listItems()).items.find(
        ({ itemId }) => itemId === result.producer.workItemId,
      );
      assert.equal(item.status, "cancelled");
      assert.equal(item.statusReason, scenario.reason);
      assert.equal(item.decisionContext, null);
      const timeline = await fixture.service.listTimeline({ limit: 100 });
      const discarded = timeline.items.filter(
        ({ type }) => type === "stale_result_discarded",
      );
      assert.equal(discarded.length, 1);
      assert.equal(discarded[0].details.reason, scenario.reason);
    });
  }
});

function boundAttentionIntent(item, outbox) {
  const content = {
    policyVersion: 1,
    kind: "attention_request",
    requestedBy: {
      roleId: outbox.requestedBy.roleId,
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    },
    binding: { requestKey: outbox.intentId },
    payload: {
      question: outbox.intent.question,
      choices: outbox.intent.choices,
    },
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

test("Issue lifecycle settlement revokes a persisted dispatch binding", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "configured-requirements-analyst",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "configured-requirements-analyst",
    roleId: "requirements-analyst",
    intent: askUserIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const bound = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundAttentionIntent(staged.item, staged.outbox),
  });
  const authority = {
    intentId: bound.intentId,
    expectedRevision: bound.revision,
    dispatchLeaseId: bound.dispatchLeaseId,
    bindingDigest: bound.dispatchBinding.bindingDigest,
    itemId: staged.item.itemId,
    itemExpectedRevision: staged.item.revision,
  };
  assert.equal(await fixture.service.isIntentDispatchCurrent(authority), true);

  fixture.source.records.push(
    issueAssignment(2, {
      eventType: "issue.left_scope",
      occurredAt: "2026-08-02T02:05:00.000Z",
      state: "closed",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  assert.equal(await fixture.service.isIntentDispatchCurrent(authority), false);
});

function quarantineStoredItem(
  durable,
  item,
  { preserveWorkState = false } = {},
) {
  const sequence = Math.max(
    durable.intakeCursor,
    durable.sourceHighWatermark,
  ) + 1;
  const record = prAssignment(sequence, {
    repository: "legacy/quarantine",
    pullRequestNumber: 1_000 + sequence,
    title: "Legacy quarantined PR source",
  });
  const root = createPullRequestSourceRootWorkItem(
    record,
    item.updatedAt,
  );
  const quarantine = {
    kind: LEGACY_PR_SOURCE_QUARANTINE_KIND,
    rootItemId: root.itemId,
    workKey: root.source.workKey,
    reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
  };
  Object.assign(root, {
    status: "blocked",
    statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
    sourceQuarantine: quarantine,
  });
  Object.assign(
    item,
    preserveWorkState
      ? {
          statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          sourceQuarantine: quarantine,
        }
      : {
          status: "blocked",
          activeIntentId: null,
          statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          sourceQuarantine: quarantine,
        },
  );
  durable.items.push(root);
  durable.intakeCursor = sequence;
  durable.sourceHighWatermark = sequence;
  durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
    durable.items,
    durable.revision,
    normalizeWorkLedgerLimits(),
  );
  return quarantine;
}

test("an answered attention result atomically advances its cursor and requeues durable context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  const batch = {
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const waiting = (await fixture.service.listItems()).items[0];
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      actorId: "unbound-system",
      toStatus: "blocked",
      reason: "bypass",
    }),
    (error) => error.code === "WORK_LEDGER_ACTIVE_INTENT_CONFLICT",
  );

  const applied = await fixture.service.applyAttentionBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "queued");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.decisionContext.source, "attention");
  assert.equal(item.decisionContext.outcome, "answered");
  assert.deepEqual(item.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
  assert.equal(summary.attentionCursor, 1);
  assert.equal(summary.attentionHighWatermark, 1);
  const stored = fixture.store.stored();
  const resultTimeline = stored.timeline.find(
    ({ type }) => type === "attention_answer_applied",
  );
  const resultAttestation = stored.outbox[0].outcome.details.resultAttestation;
  assert.match(resultAttestation.attestationDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    resultTimeline.details.resultAttestationDigest,
    resultAttestation.attestationDigest,
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyAttentionBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(await recovered.getSummary(), summary);
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    item.decisionContext,
  );
});

test("recovery rejects a rehashed attention conclusion that disagrees with its receipt", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "attention_answer_applied",
  );
  timeline.details.answer = { type: "choice", choiceId: "forged" };
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a rejected attention result blocks work while a gap advances nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "reject",
    reason: "需求需要重新梳理",
  });
  const writesBeforeGap = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.applyAttentionBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_ATTENTION_GAP",
  );
  assert.equal((await fixture.service.getSummary()).attentionCursor, 0);
  assert.equal(fixture.store.writes.length, writesBeforeGap);

  await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.decisionContext.outcome, "rejected");
});

test("PR ask_user answers and rejections retain the exact immutable execution binding", async (t) => {
  for (const [name, answer] of [
    ["answered", { type: "choice", choiceId: "yes" }],
    ["rejected", { type: "reject", reason: "owner stopped this Head" }],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
      });
      const outbox = await prepareAttentionResult(fixture, answer, {
        workerId: "employee-pr-engineer",
        roleId: "pr-engineer",
      });
      const waiting = (await fixture.service.listItems()).items[0];
      const expectedBinding = prExecutionBinding(waiting);
      await fixture.service.applyAttentionBatch({
        items: [outbox],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
      const timeline = (await fixture.service.listTimeline({ limit: 20 })).items;
      const staged = timeline.find(({ type }) => type === "intent_staged");
      const settled = timeline.find(({ type }) =>
        ["attention_answer_applied", "attention_rejection_applied"].includes(
          type,
        )
      );
      assert.deepEqual(staged.details.inputBinding, expectedBinding);
      assert.deepEqual(settled.details.inputBinding, expectedBinding);
      assert.equal(Number.isSafeInteger(staged.details.workItemRevision), true);
      assert.equal(staged.details.workItemRevision > 0, true);
      assert.equal(Number.isSafeInteger(settled.details.workItemRevision), true);
      assert.equal(
        settled.details.workItemRevision > staged.details.workItemRevision,
        true,
      );
    });
  }
});

test("a sealed attention result advances its cursor without reviving legacy PR-source work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  const durable = fixture.store.stored();
  durable.outbox[0].dispatchBinding = createWorkIntentDispatchBinding(
    boundAttentionIntent(durable.items[0], durable.outbox[0]),
  );
  quarantineStoredItem(durable, durable.items[0]);
  fixture.store.replaceStored(durable);
  fixture.service = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await fixture.service.recover();

  const applied = await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(summary.attentionCursor, 1);
  assert.equal(summary.attentionHighWatermark, 1);
  assert.equal(item.status, "blocked");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(item.decisionContext.source, "attention");
  assert.equal(item.decisionContext.outcome, "answered");
  assert.deepEqual(item.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
});

test("legacy attention settlement discards unsealed quarantine and rejects reason-only fallback", async (t) => {
  for (const seal of [false, true]) {
    await t.test(
      seal ? "status reason alone is not quarantine" : "unsealed quarantine",
      async () => {
        const fixture = await createFixture({ records: [assignment(1)] });
        const outbox = await prepareAttentionResult(fixture, {
          type: "choice",
          choiceId: "yes",
        });
        const durable = fixture.store.stored();
        const item = durable.items[0];
        if (seal) {
          durable.outbox[0].dispatchBinding = createWorkIntentDispatchBinding(
            boundAttentionIntent(item, durable.outbox[0]),
          );
          Object.assign(item, {
            status: "blocked",
            activeIntentId: null,
            statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          });
        } else {
          quarantineStoredItem(durable, item, { preserveWorkState: true });
        }
        fixture.store.replaceStored(durable);
        fixture.service = new WorkLedgerService({
          store: fixture.store,
          assignmentSource: fixture.source,
          exclusiveLease: fixture.lease,
          clock: fixture.time.clock,
          idFactory: incrementingIds(),
        });
        await fixture.service.recover();
        if (!seal) {
          const waiting = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(waiting.status, "waiting_user");
          assert.notEqual(waiting.activeIntentId, null);
          assert.equal(
            waiting.sourceQuarantine.kind,
            LEGACY_PR_SOURCE_QUARANTINE_KIND,
          );
        }

        const batch = {
          items: [outbox],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        };
        if (!seal) {
          const applied = await fixture.service.applyAttentionBatch(batch);
          const settled = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(applied.applied, 1);
          assert.equal((await fixture.service.getSummary()).attentionCursor, 1);
          assert.equal(settled.status, "blocked");
          assert.equal(settled.activeIntentId, null);
          assert.equal(settled.decisionContext, null);
          const audit = (await fixture.service.listTimeline({
            order: "newest",
          })).items[0];
          assert.equal(audit.type, "legacy_result_discarded");
          assert.equal(audit.details.source, "attention");
          return;
        }
        await assert.rejects(
          fixture.service.applyAttentionBatch(batch),
          (error) => error.code === "WORK_LEDGER_ATTENTION_BINDING_CONFLICT",
        );
        assert.equal((await fixture.service.getSummary()).attentionCursor, 0);
      },
    );
  }
});

async function prepareProposalResult(
  fixture,
  {
    outcome = "succeeded",
    sequence = 1,
    kind = "github_review_proposal",
    downstreamRef,
    proposalDigest,
    authoritativeEvidence = false,
    intentOverrides = {},
    roleId: configuredRoleId,
    workerId: configuredWorkerId,
  } = {},
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  const codeProposal = kind === "code_action_proposal";
  const externalActionProposal =
    kind === "github_pull_request_action_proposal";
  const roleId = configuredRoleId ??
    (codeProposal ? "developer" : "pr-reviewer");
  const workerId = configuredWorkerId ?? `employee-${roleId}`;
  let evidenceTarget;
  if (authoritativeEvidence) {
    const acceptanceContract = {
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [
        {
          deliverableId: codeProposal ? "change-package" : "review-report",
          kind: codeProposal ? "change-package" : "review-report",
          description: codeProposal
            ? "可追溯的代码变更包"
            : "可追溯的 PR 审查报告",
          required: true,
        },
      ],
    };
    const durable = fixture.store.stored();
    const durableItem = durable.items.find(
      ({ itemId }) => itemId === item.itemId,
    );
    durableItem.graph.acceptanceContracts = [
      {
        ...acceptanceContract,
        recordedAt: durableItem.graph.acceptanceContracts[0].recordedAt,
      },
    ];
    durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
      durable.items,
      durable.revision,
      normalizeWorkLedgerLimits(),
    );
    fixture.store.replaceStored(durable);
    fixture.service = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: fixture.lease,
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await fixture.service.recover();
    item = (await fixture.service.listItems()).items[0];
    evidenceTarget = createDeliveryEvidenceTarget({
      taskId: item.itemId,
      roleId,
      acceptanceContract,
    });
  }
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: workerId,
    roleId,
    intent: codeProposal
      ? codeActionIntent(intentOverrides)
      : externalActionProposal
        ? externalPullRequestActionIntent(intentOverrides)
        : reviewIntent(intentOverrides),
  });
  const proposalContent = {
    policyVersion: 1,
    kind,
    requestedBy: {
      roleId,
      workItemId: staged.item.itemId,
    },
    source: {
      assignmentId: staged.item.assignmentId,
      eventId: staged.item.event.eventId,
    },
    binding: codeProposal
      ? {
          repository: "acme/repo",
          workspaceId: "dashboard",
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        }
      : {
          repository: "acme/repo",
          pullRequestNumber: 1,
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        },
    payload: codeProposal
      ? {
          operation: "modify",
          objective: "修复并发覆盖",
          acceptanceCriteria: ["回归测试通过"],
        }
      : externalActionProposal
        ? { action: { type: "update_branch" } }
        : { verdict: "approve", body: "本地审查通过。" },
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId: authoritativeEvidence
      ? `work-intent-${workProposalDigest(proposalContent)}`
      : `work-intent-${
          codeProposal
            ? "c".repeat(64)
            : externalActionProposal
              ? "d".repeat(64)
              : "b".repeat(64)
        }`,
    ...proposalContent,
  });
  let claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  if (evidenceTarget !== undefined) {
    claimed = await fixture.service.bindIntent({
      intentId: claimed.intentId,
      expectedRevision: claimed.revision,
      itemExpectedRevision: staged.item.revision,
      dispatcherId: "work-intent-dispatcher",
      dispatchLeaseId: claimed.dispatchLeaseId,
      boundIntent: {
        intentId: proposal.proposalId,
        ...proposalContent,
      },
    });
  }
  await fixture.service.ackIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    dispatchLeaseId: claimed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "work-intent-dispatcher",
    details: {
      downstreamRef: downstreamRef ?? proposal.proposalId,
      proposalDigest: proposalDigest ?? proposal.contentDigest,
    },
  });
  return createWorkProposalResult({
    proposal,
    sequence,
    transition: {
      status: outcome,
      summary: `提案结果：${outcome}`,
      evidence: ["proposal-audit-1"],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });
}

test("a late proposal result for retired Issue work is discarded and advances", async () => {
  const record = issueAssignment(1, {
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  record.assignment.target = { type: "role", id: "pr-reviewer" };
  const fixture = await createFixture({ records: [record] });
  const result = await prepareProposalResult(fixture);
  const waiting = (await fixture.service.listItems()).items[0];
  await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: [waiting.itemId],
  });

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });

  assert.equal(applied.applied, 1);
  assert.equal(applied.cursor, 1);
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.statusReason, "issue_outside_active_window");
  assert.equal(item.decisionContext, null);
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  const discarded = timeline.items.find(
    ({ type }) => type === "stale_result_discarded",
  );
  assert.equal(discarded.details.source, "proposal");
  assert.equal(discarded.details.reason, "issue_outside_active_window");
});

test("a bound GitHub proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);
  const batch = {
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const applied = await fixture.service.applyProposalBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, "proposal_succeeded");
  assert.equal(item.decisionContext.source, "proposal");
  assert.equal(item.decisionContext.outcome, "succeeded");
  assert.equal(item.decisionContext.value.resultId, result.resultId);
  assert.equal(summary.proposalCursor, 1);
  assert.equal(summary.proposalHighWatermark, 1);
  const decisionTimeline =
    (await fixture.service.listTimeline({ order: "newest" })).items[0];
  assert.equal(decisionTimeline.type, "proposal_result_applied");
  assert.equal(
    decisionTimeline.details.intentId,
    fixture.store.stored().outbox[0].intentId,
  );
  assert.equal(decisionTimeline.details.workItemRevision, item.revision);
  assert.deepEqual(decisionTimeline.details.decision, item.decisionContext);
  assert.equal(
    decisionTimeline.details.decision.value.resultId,
    result.resultId,
  );
  assert.deepEqual(
    decisionTimeline.details.decision.value.evidence,
    result.evidence,
  );

  const restarted = await createFixture({
    records: [assignment(1)],
    store: fixture.store,
  });
  const recoveredTimeline =
    (await restarted.service.listTimeline({ order: "newest" })).items[0];
  assert.equal(recoveredTimeline.entryId, decisionTimeline.entryId);
  assert.equal(
    recoveredTimeline.details.intentId,
    fixture.store.stored().outbox[0].intentId,
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyProposalBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);
});

test("a sealed proposal result settles after its PR leaves scope", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const result = await prepareProposalResult(fixture, {
    roleId: "pr-engineer",
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const pending = (await fixture.service.listItems()).items[0];
  assert.equal(pending.status, "waiting_external");
  assert.equal(
    pending.statusReason,
    "pr_source_left_scope_pending_settlement",
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const settled = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(settled.status, "completed");
  assert.equal(settled.activeIntentId, null);
  assert.equal(settled.statusReason, "proposal_succeeded");
});

test("recovery rejects a rehashed proposal conclusion not sealed by its result attestation", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  timeline.details.decision.value.summary = "forged successful conclusion";
  timeline.details.decision.value.evidence = ["forged-evidence"];
  timeline.details.evidenceRefs = ["forged-evidence"];
  timeline.details.decision.contentDigest = ledgerDigest({
    source: timeline.details.decision.source,
    referenceId: timeline.details.decision.referenceId,
    outcome: timeline.details.decision.outcome,
    value: timeline.details.decision.value,
    observedAt: timeline.details.decision.observedAt,
  });
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("current state rejects removing both copies of a proposal result receipt", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  delete timeline.details.resultAttestationDigest;
  delete stored.outbox[0].outcome.details.resultAttestation;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema 10 migration quarantines an unattested proposal conclusion", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  stored.schemaVersion = 10;
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  delete timeline.details.resultAttestationDigest;
  delete stored.outbox[0].outcome.details.resultAttestation;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();
  const recoveredTimeline = await recovered.listTimeline({ limit: 20 });
  assert.equal(
    recoveredTimeline.items.some(
      ({ type }) => type === "proposal_result_applied",
    ),
    false,
  );
  const discarded = recoveredTimeline.items.find(
    ({ type }) => type === "legacy_result_discarded",
  );
  assert.equal(discarded.details.originalType, "proposal_result_applied");
  assert.equal(
    discarded.details.reason,
    "unsealed_result_attestation_migration",
  );
});

test("a sealed proposal result advances its cursor without completing legacy PR-source work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
  });
  const durable = fixture.store.stored();
  quarantineStoredItem(durable, durable.items[0]);
  fixture.store.replaceStored(durable);
  fixture.service = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await fixture.service.recover();

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(summary.proposalCursor, 1);
  assert.equal(summary.proposalHighWatermark, 1);
  assert.equal(item.status, "blocked");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(item.decisionContext.source, "proposal");
  assert.equal(item.decisionContext.outcome, "succeeded");
  assert.equal(item.decisionContext.value.resultId, result.resultId);
});

test("legacy proposal settlement discards unsealed quarantine and rejects reason-only fallback", async (t) => {
  for (const seal of [false, true]) {
    await t.test(
      seal ? "status reason alone is not quarantine" : "unsealed quarantine",
      async () => {
        const fixture = await createFixture({ records: [assignment(1)] });
        const result = await prepareProposalResult(fixture, {
          authoritativeEvidence: seal,
        });
        const durable = fixture.store.stored();
        const item = durable.items[0];
        if (seal) {
          Object.assign(item, {
            status: "blocked",
            activeIntentId: null,
            statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          });
        } else {
          quarantineStoredItem(durable, item, { preserveWorkState: true });
        }
        fixture.store.replaceStored(durable);
        fixture.service = new WorkLedgerService({
          store: fixture.store,
          assignmentSource: fixture.source,
          exclusiveLease: fixture.lease,
          clock: fixture.time.clock,
          idFactory: incrementingIds(),
        });
        await fixture.service.recover();
        if (!seal) {
          const waiting = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(waiting.status, "waiting_external");
          assert.notEqual(waiting.activeIntentId, null);
          assert.equal(
            waiting.sourceQuarantine.kind,
            LEGACY_PR_SOURCE_QUARANTINE_KIND,
          );
        }

        const batch = {
          items: [result],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        };
        if (!seal) {
          const applied = await fixture.service.applyProposalBatch(batch);
          const settled = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(applied.applied, 1);
          assert.equal((await fixture.service.getSummary()).proposalCursor, 1);
          assert.equal(settled.status, "blocked");
          assert.equal(settled.activeIntentId, null);
          assert.equal(settled.decisionContext, null);
          const audit = (await fixture.service.listTimeline({
            order: "newest",
          })).items[0];
          assert.equal(audit.type, "legacy_result_discarded");
          assert.equal(audit.details.source, "proposal");
          return;
        }
        await assert.rejects(
          fixture.service.applyProposalBatch(batch),
          (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        );
        assert.equal((await fixture.service.getSummary()).proposalCursor, 0);
      },
    );
  }
});

test("authoritative proposal evidence requeues graph work with trusted result context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
  });
  const firstOutbox = fixture.store.stored().outbox[0];
  const waiting = (await fixture.service.listItems()).items[0];
  const boundTarget = fixture.store.stored().outbox[0].dispatchBinding
    .boundIntent.binding.evidenceTarget;
  assert.deepEqual(
    boundTarget,
    createDeliveryEvidenceTarget({
      taskId: waiting.itemId,
      roleId: "pr-reviewer",
      acceptanceContract: waiting.graph.acceptanceContracts.at(-1),
    }),
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const queued = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(queued.status, "queued");
  assert.equal(queued.statusReason, "proposal_evidence_ready");
  assert.equal(queued.activeIntentId, null);
  assert.deepEqual(
    {
      source: queued.decisionContext.source,
      referenceId: queued.decisionContext.referenceId,
      outcome: queued.decisionContext.outcome,
      value: queued.decisionContext.value,
      observedAt: queued.decisionContext.observedAt,
    },
    {
      source: "proposal",
      referenceId: result.proposalId,
      outcome: "succeeded",
      value: {
        kind: result.kind,
        resultId: result.resultId,
        resultDigest: result.contentDigest,
        summary: result.summary,
        downstreamRef: result.downstreamRef,
        evidence: result.evidence,
      },
      observedAt: result.at,
    },
  );
  assert.match(queued.decisionContext.contentDigest, /^[a-f0-9]{64}$/);

  const nextTurn = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(nextTurn.decisionContext, queued.decisionContext);
  const continued = await fixture.service.stageIntent({
    itemId: nextTurn.itemId,
    expectedRevision: nextTurn.revision,
    leaseId: nextTurn.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  assert.notEqual(continued.outbox.intentId, firstOutbox.intentId);
  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    firstOutbox.intent.dispatchIntentId,
  );
});

test("a successful intervening proposal starts a new retry identity", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const failedDispatchIntentId = staged.outbox.intent.dispatchIntentId;
  const bound = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  await fixture.service.ackIntent({
    intentId: bound.intentId,
    expectedRevision: bound.revision,
    dispatchLeaseId: bound.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "work-intent-dispatcher",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);

  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
    intentOverrides: {
      summary: "先提交另一份审查",
      body: "另一份独立审查。",
    },
  });
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const continued = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    failedDispatchIntentId,
  );
  const historicalFailure = (await fixture.service.listOutbox()).items.find(
    ({ intent }) => intent.dispatchIntentId === failedDispatchIntentId,
  );
  assert.equal(historicalFailure.status, "failed");
});

test("a bound code proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({
    records: [assignment(1, { type: "role", id: "developer" })],
  });
  const result = await prepareProposalResult(fixture, {
    kind: "code_action_proposal",
  });

  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.statusReason, "proposal_succeeded");
});

test("a PR external action result settles only its trusted external-action intent", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    kind: "github_pull_request_action_proposal",
  });
  const stored = fixture.store.stored().outbox[0];
  assert.equal(
    stored.intent.type,
    "propose_github_pull_request_action",
  );
  assert.match(
    stored.intent.dispatchIntentId,
    /^work-dispatch-intent-[a-f0-9]{64}$/,
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.statusReason, "proposal_succeeded");
});

test("proposal results reject forged downstream and digest bindings", async (t) => {
  for (const field of ["downstreamRef", "proposalDigest"]) {
    await t.test(field, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      const result = await prepareProposalResult(fixture, {
        ...(field === "downstreamRef"
          ? { downstreamRef: `work-intent-${"d".repeat(64)}` }
          : { proposalDigest: "d".repeat(64) }),
      });

      await assert.rejects(
        fixture.service.applyProposalBatch({
          items: [result],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        }),
        (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
      );
      assert.equal((await fixture.service.listItems()).items[0].status, "waiting_external");
    });
  }
});

test("proposal results fail closed when two outbox records claim one downstream", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const items = (await fixture.service.listItems()).items;
  const proposal = normalizeBoundWorkProposal({
    proposalId: `work-intent-${"e".repeat(64)}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: items[0].itemId,
    },
    source: {
      assignmentId: items[0].assignmentId,
      eventId: items[0].event.eventId,
    },
    binding: { repository: "acme/repo", pullRequestNumber: 1 },
    payload: { verdict: "approve", body: "本地审查通过。" },
  });

  for (const [index, item] of items.entries()) {
    const claimedItem = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    const staged = await fixture.service.stageIntent({
      itemId: claimedItem.itemId,
      expectedRevision: claimedItem.revision,
      leaseId: claimedItem.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: reviewIntent({ body: `本地审查通过 ${index + 1}。` }),
    });
    const claimedIntent = await fixture.service.claimIntent({
      intentId: staged.outbox.intentId,
      expectedRevision: staged.outbox.revision,
      dispatcherId: "work-intent-dispatcher",
      leaseDurationMs: 30_000,
    });
    await fixture.service.ackIntent({
      intentId: claimedIntent.intentId,
      expectedRevision: claimedIntent.revision,
      dispatchLeaseId: claimedIntent.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "work-intent-dispatcher",
      details: {
        downstreamRef: proposal.proposalId,
        proposalDigest: proposal.contentDigest,
      },
    });
  }
  const result = createWorkProposalResult({
    proposal,
    sequence: 1,
    transition: {
      status: "succeeded",
      summary: "提案已成功",
      evidence: [],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [result],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
  );
  assert.deepEqual(
    (await fixture.service.listItems()).items.map(({ status }) => status),
    ["waiting_external", "waiting_external"],
  );
});

test("a failed proposal blocks work while gaps and binding changes fail closed", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, { outcome: "unknown" });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_GAP",
  );
  assert.equal((await fixture.service.getSummary()).proposalCursor, 0);

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [{ ...result, proposalContentDigest: "0".repeat(64) }],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BATCH_INVALID",
  );

  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "proposal_unknown");
});

test("work ledger recovers schema v1 state with an empty proposal checkpoint", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 1;
  delete legacy.graphMemoryProjection;
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  const summary = await recovered.recover();

  assert.equal(summary.proposalCursor, 0);
  assert.equal(summary.proposalHighWatermark, 0);
  assert.equal(summary.intakeCursor, 1);
});

test("schema v2 migration is lazy and preserves an active outbox through its next write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const entry of legacy.items) {
    delete entry.graph;
    delete entry.source;
    delete entry.sourceQuarantine;
  }
  for (const entry of legacy.outbox) {
    delete entry.dispatchBinding;
    delete entry.sourceBinding;
  }
  fixture.store.replaceStored(legacy);
  const writesBeforeRecovery = fixture.store.writes.length;
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  assert.equal(fixture.store.writes.length, writesBeforeRecovery);
  assert.equal(fixture.store.stored().schemaVersion, 2);
  const recoveredItem = (await recovered.listItems()).items[0];
  const recoveredOutbox = (await recovered.listOutbox()).items[0];
  assert.equal(recoveredItem.itemId, staged.item.itemId);
  assert.equal(recoveredItem.revision, staged.item.revision);
  assert.equal(recoveredItem.activeIntentId, staged.outbox.intentId);
  assert.deepEqual(recoveredItem.graph, {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: recoveredItem.createdAt,
      },
    ],
    deliveries: [],
  });
  assert.equal(recoveredOutbox.intentId, staged.outbox.intentId);

  const claimed = await recovered.claimIntent({
    intentId: recoveredOutbox.intentId,
    expectedRevision: recoveredOutbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "dispatching");
  assert.equal(
    fixture.store.stored().schemaVersion,
    WORK_LEDGER_STATE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    fixture.store.stored().items[0].graph,
    recoveredItem.graph,
  );
});

test("schema v2 keeps its original byte budget while graph metadata stays separately bounded", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  const legacyBytes = Buffer.byteLength(
    `${JSON.stringify(legacy, null, 2)}\n`,
    "utf8",
  );
  const exactStore = new MemoryStore({ [STATE_KEY]: legacy });
  const recovered = new WorkLedgerService({
    store: exactStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes },
  });

  await recovered.recover();
  assert.equal((await recovered.listItems()).items.length, 1);
  assert.equal(exactStore.stored().schemaVersion, 2);
  assert.equal(exactStore.writes.length, 0);

  const undersizedStore = new MemoryStore({ [STATE_KEY]: legacy });
  const undersized = new WorkLedgerService({
    store: undersizedStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes - 1 },
  });
  await assert.rejects(
    undersized.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersizedStore.stored(), legacy);
  assert.equal(undersizedStore.writes.length, 0);
});

test("schema v2 keeps the original per-item byte budget during migration", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  const legacyItemBytes = Buffer.byteLength(
    `${JSON.stringify(legacy.items[0], null, 2)}\n`,
    "utf8",
  );
  const createRecovered = (itemByteBudget) => {
    const store = new MemoryStore({ [STATE_KEY]: legacy });
    const service = new WorkLedgerService({
      store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
      limits: { itemByteBudget },
    });
    return { service, store };
  };
  const exact = createRecovered(legacyItemBytes);

  await exact.service.recover();

  assert.equal((await exact.service.listItems()).items.length, 1);
  assert.equal(exact.store.writes.length, 0);

  const undersized = createRecovered(legacyItemBytes - 1);
  await assert.rejects(
    undersized.service.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersized.store.stored(), legacy);
  assert.equal(undersized.store.writes.length, 0);
});

async function prepareWaitingCondition(fixture, condition) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: waitIntent(condition),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_condition",
    actorId: "work-intent-dispatcher",
    details: {
      conditionRef: `bound-${dispatch.intentId}`,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  return { item: acknowledged.item, intentId: staged.outbox.intentId };
}

test("condition wake is atomically bound, durable, and idempotent", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const input = {
    itemId: waiting.item.itemId,
    expectedRevision: waiting.item.revision,
    intentId: waiting.intentId,
    actorId: "work-condition-waker",
    observation: {
      kind: "workflow_fact",
      fact: "ci-status",
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
  };

  const woken = await fixture.service.wakeCondition(input);
  assert.equal(woken.status, "queued");
  assert.equal(woken.activeIntentId, null);
  assert.equal(woken.decisionContext.source, "condition");
  assert.deepEqual(woken.decisionContext.value, {
    fact: "ci-status",
    kind: "workflow_fact",
    value: "success",
  });

  const writesBeforeReplay = fixture.store.writes.length;
  const replay = await fixture.service.wakeCondition(input);
  assert.equal(replay.itemId, woken.itemId);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    woken.decisionContext,
  );
});

test("graph recovery reads a condition wake that lost its durable acknowledgement", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const before = await fixture.service.getGraphSnapshot();
  const durableWrite = fixture.store.write.bind(fixture.store);
  let loseAcknowledgement = true;
  fixture.store.write = async (...args) => {
    await durableWrite(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("durable acknowledgement lost");
    }
  };

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "success",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  const recovered = await fixture.service.getGraphSnapshot();
  assert.equal(recovered.graph.revision, before.graph.revision + 1);
  assert.equal(recovered.graph.tasks[0].revision, waiting.item.revision + 1);
});

test("an unmatched condition observation writes nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "failure",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_CONDITION_OBSERVATION_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listItems()).items[0].status, "waiting_condition");
});
