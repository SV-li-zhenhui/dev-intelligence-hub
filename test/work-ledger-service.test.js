import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAttentionRequest } from "../src/domain/attention-contract.js";
import {
  createAttentionItem,
  resolveAttentionItem,
} from "../src/services/attention-inbox-state.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
} from "../src/domain/work-proposal-contract.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";

const STATE_KEY = "work-ledger-state";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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
} = {}) {
  const service = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: time.clock,
    idFactory: incrementingIds(),
    ...(limits ? { limits } : {}),
  });
  await service.recover();
  return { service, source, store, lease, time };
}

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
  });

  assert.equal(item.status, "retry_wait");
  assert.equal(item.availableAt, "2026-08-02T02:01:00.000Z");
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
  assert.deepEqual(staged.outbox.intent, reviewIntent());
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
  let dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 30_000,
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
  assert.equal(staged.outbox.status, "pending");
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

async function prepareAttentionResult(fixture, answer) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const intent = askUserIntent();
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent,
  });
  const request = normalizeAttentionRequest({
    requestKey: staged.outbox.intentId,
    type: "ask_user",
    producer: {
      roleId: "pr-reviewer",
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

async function prepareProposalResult(
  fixture,
  { outcome = "succeeded", sequence = 1 } = {},
) {
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
  const proposal = normalizeBoundWorkProposal({
    proposalId: staged.outbox.intentId,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: staged.item.itemId,
    },
    source: {
      assignmentId: staged.item.assignmentId,
      eventId: staged.item.event.eventId,
    },
    binding: { repository: "acme/repo", pullRequestNumber: 1 },
    payload: { verdict: "approve", body: "本地审查通过。" },
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  await fixture.service.ackIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    dispatchLeaseId: claimed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "work-intent-dispatcher",
    details: {
      downstreamRef: proposal.proposalId,
      proposalDigest: proposal.contentDigest,
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

test("a succeeded proposal result atomically completes its bound work and cursor", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
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
  assert.equal(
    (await fixture.service.listTimeline({ order: "newest" })).items[0].type,
    "proposal_result_applied",
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyProposalBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);
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
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
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
