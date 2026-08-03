import assert from "node:assert/strict";
import test from "node:test";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledClock() {
  let milliseconds = Date.parse("2026-08-02T08:00:00.000Z");
  return {
    clock: () => new Date(milliseconds).toISOString(),
    advance(value) {
      milliseconds += value;
    },
  };
}

function workItem(number, target = { type: "role", id: "pr-reviewer" }) {
  const timestamp = new Date(
    Date.parse("2026-08-02T07:00:00.000Z") + number * 1_000,
  ).toISOString();
  return {
    itemId: `work-item-${number}`,
    kind: "assignment",
    assignmentId: `workflow-assignment-${number}`,
    sourceSequence: number,
    inputDigest: `digest-${number}`,
    assignment: {
      assignmentId: `workflow-assignment-${number}`,
      target: clone(target),
    },
    event: {
      eventId: `workflow-event-${number}`,
      eventType: "pull_request.created",
      subject: { id: `github:pr:acme/repo#${number}` },
      payload: { number },
    },
    currentTarget: clone(target),
    activeIntentId: null,
    decisionContext: null,
    status: "queued",
    revision: 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 0,
    availableAt: null,
    statusReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function completeDecision(summary = "无需进一步操作") {
  return {
    schemaVersion: 1,
    confidence: 90,
    summary,
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary,
      reason: "已完成岗位判断",
      outcome: "no-action",
      evidence: [],
    },
  };
}

class FakeLedger {
  constructor({ source = [], time = controlledClock() } = {}) {
    this.source = source.map(clone);
    this.items = [];
    this.outbox = [];
    this.time = time;
    this.calls = {
      intake: [],
      listItems: [],
      claim: [],
      stageIntent: [],
      scheduleRetry: [],
      transition: [],
    };
    this.stageFailure = null;
    this.claimFailure = null;
    this.nextLease = 1;
  }

  async intake(input) {
    this.calls.intake.push(clone(input));
    const known = new Set(this.items.map(({ itemId }) => itemId));
    const created = this.source
      .filter(({ itemId }) => !known.has(itemId))
      .slice(0, input.limit);
    this.items.push(...created.map(clone));
    return {
      received: created.length,
      deduplicated: 0,
      cursor: this.items.length,
      highWatermark: this.source.length,
      gap: null,
      itemIds: created.map(({ itemId }) => itemId),
      alertItemId: null,
    };
  }

  async listItems(options = {}) {
    this.calls.listItems.push(clone(options));
    const start = options.cursor
      ? this.items.findIndex(({ itemId }) => itemId === options.cursor) + 1
      : 0;
    const limit = options.limit || 50;
    const items = this.items.slice(start, start + limit).map(clone);
    return {
      items,
      nextCursor:
        start + items.length < this.items.length && items.length
          ? items.at(-1).itemId
          : null,
    };
  }

  async claim(input) {
    this.calls.claim.push(clone(input));
    if (this.claimFailure === "before_write") {
      this.claimFailure = null;
      throw new Error("claim write unavailable");
    }
    const item = this.#item(input.itemId);
    assert.equal(input.expectedRevision, item.revision);
    assert.equal(
      item.status === "queued" ||
        (item.status === "retry_wait" &&
          Date.parse(item.availableAt) <= Date.parse(this.time.clock())) ||
        (item.status === "working" &&
          Date.parse(item.leaseUntil) <= Date.parse(this.time.clock())),
      true,
    );
    item.status = "working";
    item.revision += 1;
    item.ownerId = input.workerId;
    item.leaseId = `lease-${this.nextLease++}`;
    item.leaseUntil = new Date(
      Date.parse(this.time.clock()) + input.leaseDurationMs,
    ).toISOString();
    item.attempt += 1;
    item.availableAt = null;
    item.statusReason = null;
    item.updatedAt = this.time.clock();
    if (this.claimFailure === "after_write") {
      this.claimFailure = null;
      throw new Error("claim acknowledgement lost");
    }
    return clone(item);
  }

  async stageIntent(input) {
    this.calls.stageIntent.push(clone(input));
    if (this.stageFailure === "before_write") {
      this.stageFailure = null;
      throw Object.assign(new Error("write failed"), {
        code: "WORK_LEDGER_STATE_WRITE_FAILED",
      });
    }
    const item = this.#leasedItem(input);
    item.status = "dispatch_pending";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.statusReason = "intent_staged";
    item.updatedAt = this.time.clock();
    this.outbox.push({
      intentId: `intent-${item.itemId}`,
      itemId: item.itemId,
      intent: clone(input.intent),
      status: "pending",
    });
    const result = {
      item: clone(item),
      outbox: clone(this.outbox.at(-1)),
    };
    if (this.stageFailure === "after_write") {
      this.stageFailure = null;
      throw Object.assign(new Error("acknowledgement lost"), {
        code: "WORK_LEDGER_STATE_WRITE_FAILED",
      });
    }
    return result;
  }

  async scheduleRetry(input) {
    this.calls.scheduleRetry.push(clone(input));
    const item = this.#leasedItem(input);
    item.status = "retry_wait";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.availableAt = input.availableAt;
    item.statusReason = input.reason;
    item.updatedAt = this.time.clock();
    return clone(item);
  }

  async transition(input) {
    this.calls.transition.push(clone(input));
    const item = this.#leasedItem(input);
    assert.equal(input.toStatus, "blocked");
    item.status = "blocked";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.statusReason = input.reason;
    item.updatedAt = this.time.clock();
    return clone(item);
  }

  #item(itemId) {
    const item = this.items.find((candidate) => candidate.itemId === itemId);
    assert.ok(item, `missing fake item ${itemId}`);
    return item;
  }

  #leasedItem(input) {
    const item = this.#item(input.itemId);
    assert.equal(input.expectedRevision, item.revision);
    assert.equal(input.leaseId, item.leaseId);
    assert.equal(item.status, "working");
    return item;
  }
}

class FakeRoleDirectory {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.calls = [];
  }

  async resolve(target) {
    this.calls.push(clone(target));
    return this.entries.get(target.id) ?? null;
  }
}

function worker({
  roleId = "pr-reviewer",
  workerId = `employee-${roleId}`,
  paused = false,
  enabled = true,
  decide = async () => completeDecision(),
} = {}) {
  return { roleId, workerId, paused, enabled, decide };
}

function createLoop({ ledger, directory, time, ...options }) {
  return new ProactiveWorkLoop({
    ledger,
    roleDirectory: directory,
    clock: time.clock,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    ...options,
  });
}

test("a cycle reliably intakes, claims, decides, and only stages an intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let decisionInput;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async (input) => {
        decisionInput = input;
        return completeDecision("PR 当前无需动作");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ trigger: "manual" });

  assert.equal(result.intake.received, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.equal(ledger.items[0].status, "dispatch_pending");
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "complete");
  assert.equal(decisionInput.trigger, "manual");
  assert.equal(decisionInput.item.status, "working");
  assert.equal(Object.hasOwn(decisionInput.item, "ownerId"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "leaseId"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "leaseUntil"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "decisionContext"), true);
  assert.deepEqual(ledger.calls.claim[0], {
    itemId: "work-item-1",
    expectedRevision: 1,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 120_000,
  });
  assert.equal(ledger.calls.stageIntent[0].expectedRevision, 2);
  assert.equal(ledger.calls.stageIntent[0].leaseId, "lease-1");
  assert.equal(ledger.calls.stageIntent[0].roleId, "pr-reviewer");
});

test("a paused PR role leaves every PR queued without asking or deciding", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2), workItem(3)],
    time,
  });
  let decisions = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      paused: true,
      decide: async () => {
        decisions += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimed, 0);
  assert.equal(decisions, 0);
  assert.equal(directory.calls.length, 1);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    "queued",
    "queued",
    "queued",
  ]);
});

test("ten assignments for one missing role create only one durable question", async () => {
  const time = controlledClock();
  const target = { type: "role", id: "missing-role" };
  const ledger = new FakeLedger({
    source: Array.from({ length: 10 }, (_, index) =>
      workItem(index + 1, target),
    ),
    time,
  });
  const directory = new FakeRoleDirectory();
  const loop = createLoop({ ledger, directory, time });

  const first = await loop.runCycle({ workLimit: 10 });
  const second = await loop.runCycle({ workLimit: 10 });

  assert.equal(first.claimed, 1);
  assert.equal(second.claimed, 0);
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(directory.calls.length, 2);
  assert.equal(
    ledger.items.filter(({ status }) => status === "dispatch_pending").length,
    1,
  );
  assert.equal(
    ledger.items.filter(({ status }) => status === "queued").length,
    9,
  );
});

test("person and node targets are preserved through separate orchestrator questions", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "person", id: "owner" }),
      workItem(2, { type: "node", id: "manual-gate" }),
    ],
    time,
  });
  const directory = new FakeRoleDirectory();
  const loop = createLoop({ ledger, directory, time });

  await loop.runCycle({ workLimit: 2 });

  assert.equal(directory.calls.length, 0);
  assert.equal(ledger.outbox.length, 2);
  assert.deepEqual(
    ledger.outbox.map(({ intent }) => intent.type),
    ["ask_user", "ask_user"],
  );
  assert.match(ledger.outbox[0].intent.question, /person:owner/);
  assert.match(ledger.outbox[1].intent.question, /node:manual-gate/);
});

test("decision failures use bounded retry and block at maxAttempts", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let decisions = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        decisions += 1;
        throw new Error("model unavailable");
      },
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
  });

  const first = await loop.runCycle();
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.items[0].availableAt, "2026-08-02T08:00:01.000Z");
  time.advance(1_000);

  const second = await loop.runCycle();
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].attempt, 2);
  assert.equal(decisions, 2);
  assert.equal(ledger.calls.scheduleRetry[0].expectedRevision, 2);
  assert.equal(ledger.calls.transition[0].expectedRevision, 4);
});

test("a lost stage acknowledgement is observed as one durable intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.stageFailure = "after_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.recoveredStages, 1);
  assert.equal(ledger.items[0].status, "dispatch_pending");
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.intake.length, 2);
});

test("a stage failure before persistence safely schedules the leased item", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.stageFailure = "before_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.retried, 1);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.outbox.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 1);
  assert.equal(ledger.calls.scheduleRetry[0].expectedRevision, 2);
  assert.equal(ledger.calls.scheduleRetry[0].leaseId, "lease-1");
});

test("concurrent runCycle calls share one in-flight decision", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let release;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const decision = new Promise((resolve) => {
    release = resolve;
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        startedResolve();
        return decision;
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const first = loop.runCycle({ trigger: "scheduled" });
  await started;
  const second = loop.runCycle({ trigger: "manual" });
  assert.strictEqual(second, first);
  release(completeDecision());
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.trigger, "scheduled");
  assert.equal(ledger.calls.intake.length, 1);
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a role-scoped cycle only decides work resolved to that role", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "role", id: "requirements-analyst" }),
      workItem(2, { type: "role", id: "developer" }),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({ roleId: "requirements-analyst" }),
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({
    trigger: "employee:requirements-analyst",
    roleId: "requirements-analyst",
  });

  assert.equal(result.roleId, "requirements-analyst");
  assert.deepEqual(directory.calls, [
    { type: "role", id: "requirements-analyst" },
  ]);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1"],
  );
  assert.deepEqual(
    ledger.items.map(({ status }) => status),
    ["dispatch_pending", "queued"],
  );
});

test("same role signals coalesce while different role cycles remain isolated", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "role", id: "requirements-analyst" }),
      workItem(2, { type: "role", id: "developer" }),
    ],
    time,
  });
  const requirementsStarted = deferred();
  const releaseRequirements = deferred();
  let developerStarted = false;
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({
      roleId: "requirements-analyst",
      decide: async () => {
        requirementsStarted.resolve();
        await releaseRequirements.promise;
        return completeDecision("需求已梳理");
      },
    }),
    developer: worker({
      roleId: "developer",
      decide: async () => {
        developerStarted = true;
        return completeDecision("开发已判断");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const requirements = loop.runCycle({
    trigger: "employee:requirements-analyst",
    roleId: "requirements-analyst",
  });
  await requirementsStarted.promise;
  const duplicateRequirements = loop.runCycle({
    trigger: "manual",
    roleId: "requirements-analyst",
  });
  const developer = loop.runCycle({
    trigger: "employee:developer",
    roleId: "developer",
  });

  assert.strictEqual(duplicateRequirements, requirements);
  assert.notStrictEqual(developer, requirements);
  assert.equal(developerStarted, false);

  releaseRequirements.resolve();
  const [requirementsResult, duplicateResult, developerResult] =
    await Promise.all([requirements, duplicateRequirements, developer]);

  assert.deepEqual(duplicateResult, requirementsResult);
  assert.equal(developerResult.roleId, "developer");
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1", "work-item-2"],
  );
});

test("workLimit processes the oldest available items first", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2), workItem(3)],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const first = await loop.runCycle({ workLimit: 2 });

  assert.equal(first.claimed, 2);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1", "work-item-2"],
  );
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    "dispatch_pending",
    "dispatch_pending",
    "queued",
  ]);

  await loop.runCycle({ workLimit: 2 });
  assert.equal(ledger.items[2].status, "dispatch_pending");
});

test("graph-blocked parents do not consume the claim budget before ready children", async () => {
  const time = controlledClock();
  const parent = workItem(1);
  const child = workItem(2);
  parent.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [],
    deliveries: [],
  };
  child.graph = {
    parentItemId: parent.itemId,
    dependsOnItemIds: [],
    acceptanceContracts: [],
    deliveries: [],
  };
  const ledger = new FakeLedger({ source: [parent, child], time });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    [child.itemId],
  );
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[1].status, "dispatch_pending");
});

test("workLimit bounds claim attempts even when a claim is not acquired", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2)],
    time,
  });
  ledger.claimFailure = "before_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 0);
  assert.equal(ledger.calls.claim.length, 1);
  assert.deepEqual(ledger.items.map(({ status }) => status), ["queued", "queued"]);
});

test("a lost claim acknowledgement is recovered before one decision is staged", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claimFailure = "after_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.outbox.length, 1);
});

test("one failed target resolution is cached for the whole cycle", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2)],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": { roleId: "wrong-role" },
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 2 });

  assert.equal(directory.calls.length, 1);
  assert.deepEqual(
    result.outcomes.map(({ status }) => status),
    ["resolution_failed", "resolution_failed"],
  );
  assert.equal(ledger.calls.claim.length, 0);
});

test("a bounded decision timeout schedules a safe retry before the lease expires", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({ decide: async () => new Promise(() => {}) }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    leaseDurationMs: 1_000,
    resolveTimeoutMs: 20,
    decideTimeoutMs: 10,
  });

  const result = await loop.runCycle();

  assert.equal(result.retried, 1);
  assert.equal(ledger.calls.scheduleRetry[0].reason, "decision_failed");
  assert.equal(
    ledger.calls.scheduleRetry[0].actorId,
    "employee-pr-reviewer",
  );
  assert.equal(ledger.items[0].status, "retry_wait");
});

test("role timeouts must be strictly shorter than the work lease", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      leaseDurationMs: 1_000,
      resolveTimeoutMs: 1_000,
      decideTimeoutMs: 10,
    }),
    /shorter than leaseDurationMs/,
  );
});
