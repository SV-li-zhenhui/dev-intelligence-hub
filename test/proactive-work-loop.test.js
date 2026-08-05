import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";

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
  });
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
    graph: {
      parentItemId: null,
      dependsOnItemIds: [],
      acceptanceContracts: [],
      deliveries: [],
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

test("configuration-first claim rejection stops the cycle with its gate error", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claim = async (input) => {
    ledger.calls.claim.push(clone(input));
    throw Object.assign(new Error("configuration changed"), {
      code: "RUNTIME_RESTART_REQUIRED",
    });
  };
  let decisionCalls = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        decisionCalls += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  await assert.rejects(
    loop.runCycle(),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("an admitted lost claim ACK reconciles after cutover without reaching the brain", async () => {
  const time = controlledClock();
  const gate = readyActionAdmissionGate();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claimFailure = "after_write";
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    const admitted = await gate.run(() => ({ operation: claim(input) }));
    try {
      return await admitted.operation;
    } catch (error) {
      await activateNextConfiguration(gate);
      throw error;
    }
  };
  let reconciliationReads = 0;
  ledger.readItemForReconciliation = async ({ itemId }) => {
    reconciliationReads += 1;
    return clone(
      ledger.items.find((candidate) => candidate.itemId === itemId) ?? null,
    );
  };
  let providerCalls = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: (input) => gate.run(() => {
        providerCalls += 1;
        return completeDecision(input.item.itemId);
      }),
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimed, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
  assert.equal(reconciliationReads, 1);
  assert.equal(providerCalls, 0);
  assert.equal(ledger.calls.intake.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(gate.readStatus().mode, "restart_required");
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

test("a bounded context timeout aborts a hanging graph read before retrying", async () => {
  const time = controlledClock();
  const sourceItem = workItem(69, { type: "role", id: "developer" });
  sourceItem.inputDigest = "a".repeat(64);
  const ledger = new FakeLedger({
    source: [sourceItem],
    time,
  });
  let graphSignal;
  const directory = new FakeRoleDirectory({
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    leaseDurationMs: 13_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    roleContextAssembler: new RoleContextAssembler({
      graphReader: {
        async getSnapshot({ signal } = {}) {
          graphSignal = signal;
          return new Promise((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      },
    }),
    orchestratorService: { async execute() {} },
  });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.equal(result.retried, 1);
  assert.equal(graphSignal instanceof AbortSignal, true);
  assert.equal(graphSignal.aborted, true);
  assert.equal(graphSignal.reason.code, "ROLE_CONTEXT_TIMEOUT");
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

function contextPacket(item, roleId) {
  return {
    schemaVersion: 1,
    binding: { taskId: item.itemId, roleId },
    context: { requirements: { taskId: item.itemId } },
    acceptedInputs: [],
    contextDigest: "a".repeat(64),
  };
}

function deliveryDecision(item) {
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "交付当前岗位成果",
    intent: {
      schemaVersion: 1,
      type: "submit_delivery",
      taskId: item.itemId,
      expectedTaskRevision: item.revision,
      expectedGraphRevision: 7,
      contractRevision: 1,
      deliverableId: "implementation",
      summary: "实现和验证均已完成",
      reason: "满足当前交付契约",
      evidence: [],
      artifact: null,
    },
  };
}

function orchestrationDecision(item, actionType = "pause") {
  const reason = "根据共享任务图推进";
  return {
    schemaVersion: 1,
    confidence: 92,
    summary: "协调直属任务",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "协调直属任务",
      reason,
      action: {
        schemaVersion: 1,
        type: actionType,
        sourceTaskId: item.itemId,
        sourceTaskRevision: item.revision,
        expectedGraphRevision: 7,
        reason,
      },
    },
  };
}

test("trusted specialist claims, assembles, decides, and submits without staging", async () => {
  const time = controlledClock();
  const source = workItem(31, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const order = [];
  const originalClaim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    order.push("claim");
    return originalClaim(input);
  };
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item, context }) => {
        order.push("decide");
        assert.deepEqual(context, { requirements: { taskId: item.itemId } });
        return deliveryDecision(item);
      },
    }),
  });
  const assembler = {
    async assemble({ roleId, item }) {
      order.push("assemble");
      return contextPacket(item, roleId);
    },
  };
  const executions = [];
  const service = {
    async execute(input) {
      order.push("execute");
      executions.push(clone(input));
      return { applied: true, deliveryRevision: 1 };
    },
  };
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: assembler,
    orchestratorService: service,
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.deepEqual(order, ["claim", "assemble", "decide", "execute"]);
  assert.equal(cycle.submittedDeliveries, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(executions[0].item.ownerId, "employee-developer");
  assert.equal(executions[0].contextPacket.binding.roleId, "developer");
  assert.equal(executions[0].intent.type, "submit_delivery");
});

test("runtime cutover is never recorded as a specialist failure", async (t) => {
  for (const failurePoint of ["brain", "final-mutation"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const source = workItem(
        failurePoint === "brain" ? 61 : 62,
        { type: "role", id: "developer" },
      );
      const ledger = new FakeLedger({ source: [source], time });
      const admissionError = Object.assign(new Error("configuration changed"), {
        code: "RUNTIME_RESTART_REQUIRED",
      });
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async ({ item }) => {
            if (failurePoint === "brain") throw admissionError;
            return deliveryDecision(item);
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            throw admissionError;
          },
        },
      });

      await assert.rejects(
        loop.runCycle({ roleId: "developer" }),
        (error) => error === admissionError,
      );

      assert.equal(ledger.items[0].status, "working");
      assert.equal(ledger.items[0].ownerId, "employee-developer");
      assert.equal(ledger.items[0].leaseId, "lease-1");
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(serviceCalls, failurePoint === "brain" ? 0 : 1);
    });
  }
});

test("trusted specialist retries assembler and delivery-service failures", async (t) => {
  for (const failurePoint of ["assembler", "service"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const source = workItem(
        failurePoint === "assembler" ? 70 : 71,
        { type: "role", id: "developer" },
      );
      const ledger = new FakeLedger({ source: [source], time });
      let assembleCalls = 0;
      let decisionCalls = 0;
      let serviceCalls = 0;
      let successfulSubmissions = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async ({ item }) => {
            decisionCalls += 1;
            return deliveryDecision(item);
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assembleCalls += 1;
            if (failurePoint === "assembler" && assembleCalls === 1) {
              throw new Error("context temporarily unavailable");
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            if (failurePoint === "service" && serviceCalls === 1) {
              throw new Error("delivery service temporarily unavailable");
            }
            successfulSubmissions += 1;
            return { applied: true, deliveryRevision: 1 };
          },
        },
      });

      const first = await loop.runCycle({ roleId: "developer" });

      assert.equal(first.retried, 1);
      assert.equal(first.submittedDeliveries, 0);
      assert.equal(ledger.items[0].status, "retry_wait");
      assert.equal(ledger.calls.scheduleRetry.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 0);

      time.advance(1_000);
      const second = await loop.runCycle({ roleId: "developer" });

      assert.equal(second.submittedDeliveries, 1);
      assert.equal(successfulSubmissions, 1);
      assert.equal(ledger.calls.claim.length, 2);
      assert.equal(ledger.calls.scheduleRetry.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(assembleCalls, 2);
      assert.equal(
        decisionCalls,
        failurePoint === "assembler" ? 1 : 2,
      );
      assert.equal(serviceCalls, failurePoint === "assembler" ? 1 : 2);
    });
  }
});

test("trusted specialist generic decisions retain the durable stage path", async () => {
  const time = controlledClock();
  const source = workItem(32, { type: "role", id: "tester" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    tester: worker({ roleId: "tester", decide: async () => completeDecision() }),
  });
  let serviceCalls = 0;
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        serviceCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "tester" });

  assert.equal(cycle.staged, 1);
  assert.equal(serviceCalls, 0);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a child-blocked configured root orchestrates without obtaining a lease", async () => {
  const time = controlledClock();
  const root = workItem(40, { type: "role", id: "orchestrator" });
  const child = workItem(41, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async ({ item }) => orchestrationDecision(item),
    }),
    developer: worker({ roleId: "developer" }),
  });
  const executions = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute(input) {
        executions.push(clone(input));
        return { applied: true };
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.orchestrated, 1);
  assert.equal(cycle.claimed, 0);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(executions[0].item.status, "queued");
});

test("an expired configured root orchestrates without reclaiming its lease", async () => {
  const time = controlledClock();
  const root = workItem(70, { type: "role", id: "orchestrator" });
  root.status = "working";
  root.ownerId = "previous-orchestrator";
  root.leaseId = "expired-root-lease";
  root.leaseUntil = new Date(
    Date.parse(time.clock()) - 1_000,
  ).toISOString();
  root.attempt = 1;
  const ledger = new FakeLedger({ source: [root], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async ({ item }) => orchestrationDecision(item),
    }),
  });
  const executions = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute(input) {
        executions.push(clone(input));
        return { applied: true };
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.orchestrated, 1);
  assert.equal(cycle.claimed, 0);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].item.status, "working");
  assert.equal(executions[0].item.leaseId, "expired-root-lease");
});

test("runtime cutover leaves configured root orchestration queued", async () => {
  const time = controlledClock();
  const root = workItem(63, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const admissionError = Object.assign(new Error("configuration changed"), {
    code: "RUNTIME_RESTART_REQUIRED",
  });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async ({ item }) => orchestrationDecision(item),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw admissionError;
      },
    },
  });

  await assert.rejects(
    loop.runCycle({ roleId: "orchestrator" }),
    (error) => error === admissionError,
  );

  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("a child-blocked root generic decision stays unclaimed", async () => {
  const time = controlledClock();
  const root = workItem(42, { type: "role", id: "orchestrator" });
  const child = workItem(43, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
  });
  let serviceCalls = 0;
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        serviceCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.outcomes[0].status, "graph_blocked");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(serviceCalls, 0);
});

test("a ready root decides before claiming and staging a generic intent", async () => {
  const time = controlledClock();
  const root = workItem(44, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const order = [];
  const originalClaim = ledger.claim.bind(ledger);
  const originalStage = ledger.stageIntent.bind(ledger);
  ledger.claim = async (input) => {
    order.push("claim");
    return originalClaim(input);
  };
  ledger.stageIntent = async (input) => {
    order.push("stage");
    return originalStage(input);
  };
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => {
        order.push("decide");
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        order.push("assemble");
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.deepEqual(order, ["assemble", "decide", "claim", "stage"]);
  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
});

test("missing-target fallback never exposes work to trusted role ports", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(45, { type: "role", id: "missing-role" })],
    time,
  });
  let trustedCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory(),
    time,
    roleContextAssembler: {
      async assemble() {
        trustedCalls += 1;
      },
    },
    orchestratorService: {
      async execute() {
        trustedCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle();

  assert.equal(cycle.staged, 1);
  assert.equal(trustedCalls, 0);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
});

test("concurrent scopes create only one question for the same missing target", async () => {
  const time = controlledClock();
  const target = { type: "role", id: "missing-specialist" };
  const ledger = new FakeLedger({
    source: [workItem(46, target), workItem(47, target)],
    time,
  });
  const firstStageStarted = deferred();
  const releaseFirstStage = deferred();
  const secondResolveStarted = deferred();
  const releaseSecondResolve = deferred();
  const directory = new FakeRoleDirectory();
  let resolveCalls = 0;
  directory.resolve = async (requestedTarget) => {
    directory.calls.push(clone(requestedTarget));
    resolveCalls += 1;
    if (resolveCalls === 2) {
      secondResolveStarted.resolve();
      await releaseSecondResolve.promise;
    }
    return null;
  };
  const originalStage = ledger.stageIntent.bind(ledger);
  ledger.stageIntent = async (input) => {
    firstStageStarted.resolve();
    await releaseFirstStage.promise;
    return originalStage(input);
  };
  const loop = createLoop({ ledger, directory, time });

  const wildcardCycle = loop.runCycle({ workLimit: 1 });
  await firstStageStarted.promise;
  const orchestratorCycle = loop.runCycle({
    roleId: "orchestrator",
    workLimit: 2,
  });
  await secondResolveStarted.promise;
  releaseFirstStage.resolve();
  await wildcardCycle;
  releaseSecondResolve.resolve();
  const concurrent = await orchestratorCycle;

  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
  assert.equal(
    concurrent.outcomes.every(
      ({ status }) => status === "missing_target_waiting",
    ),
    true,
  );
});

test("different role cycles overlap while one item is decided only once", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(50, { type: "role", id: "requirements-analyst" }),
      workItem(51, { type: "role", id: "developer" }),
    ],
    time,
  });
  const requirementsStarted = deferred();
  const developerStarted = deferred();
  const release = deferred();
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({
      roleId: "requirements-analyst",
      decide: async () => {
        requirementsStarted.resolve();
        await release.promise;
        return completeDecision();
      },
    }),
    developer: worker({
      roleId: "developer",
      decide: async () => {
        developerStarted.resolve();
        await release.promise;
        return completeDecision();
      },
    }),
  });
  const trusted = {
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  };
  const loop = createLoop({ ledger, directory, time, ...trusted });

  const requirements = loop.runCycle({ roleId: "requirements-analyst" });
  await requirementsStarted.promise;
  const developer = loop.runCycle({ roleId: "developer" });
  await Promise.race([
    developerStarted.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("different role cycle was serialized")),
      100,
    )),
  ]);
  release.resolve();
  await Promise.all([requirements, developer]);

  const wildcard = loop.runCycle();
  const developerAgain = loop.runCycle({ roleId: "developer" });
  await Promise.all([wildcard, developerAgain]);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId).sort(),
    ["work-item-50", "work-item-51"],
  );
});

test("root trusted failures use natural cycles without lease-based retry", async (t) => {
  for (const failurePoint of ["assembler", "service"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const root = workItem(
        failurePoint === "assembler" ? 60 : 61,
        { type: "role", id: "orchestrator" },
      );
      const ledger = new FakeLedger({ source: [root], time });
      let assembleCalls = 0;
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => orchestrationDecision(item),
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assembleCalls += 1;
            if (failurePoint === "assembler" && assembleCalls === 1) {
              throw new Error("trusted context failed");
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            if (failurePoint === "service" && serviceCalls === 1) {
              throw new Error("trusted mutation failed");
            }
            return { applied: true };
          },
        },
      });

      await assert.rejects(
        loop.runCycle({ roleId: "orchestrator" }),
        failurePoint === "assembler"
          ? /trusted context failed/
          : /trusted mutation failed/,
      );
      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);

      const recovered = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(recovered.orchestrated, 1);
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(assembleCalls, 2);
      assert.equal(serviceCalls, failurePoint === "assembler" ? 1 : 2);
    });
  }
});

test("non-root orchestrator tasks never use the configured-root path", async (t) => {
  await t.test("graph-blocked child stays unclaimed", async () => {
    const time = controlledClock();
    const child = workItem(62, { type: "role", id: "orchestrator" });
    child.graph = {
      parentItemId: "work-item-root",
      dependsOnItemIds: ["work-item-unfinished-dependency"],
    };
    const ledger = new FakeLedger({ source: [child], time });
    let trustedCalls = 0;
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble() {
          trustedCalls += 1;
        },
      },
      orchestratorService: {
        async execute() {
          trustedCalls += 1;
        },
      },
    });

    const cycle = await loop.runCycle({ roleId: "orchestrator" });

    assert.equal(cycle.outcomes[0].status, "graph_blocked");
    assert.equal(ledger.calls.claim.length, 0);
    assert.equal(trustedCalls, 0);
  });

  await t.test("ready child is handled as a specialist", async () => {
    const time = controlledClock();
    const child = workItem(63, { type: "role", id: "orchestrator" });
    child.graph = {
      parentItemId: "work-item-root",
      dependsOnItemIds: [],
    };
    const ledger = new FakeLedger({ source: [child], time });
    let serviceCalls = 0;
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => orchestrationDecision(item),
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble({ roleId, item }) {
          return contextPacket(item, roleId);
        },
      },
      orchestratorService: {
        async execute() {
          serviceCalls += 1;
        },
      },
    });

    const cycle = await loop.runCycle({ roleId: "orchestrator" });

    assert.equal(cycle.retried, 1);
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.calls.claim.length, 1);
    assert.equal(ledger.calls.scheduleRetry.length, 1);
    assert.equal(serviceCalls, 0);
  });
});

test("trusted loop ports are configured together and fit inside the lease", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      roleContextAssembler: { async assemble() {} },
    }),
    /configured together/,
  );
  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      leaseDurationMs: 2_000,
      resolveTimeoutMs: 1_000,
      decideTimeoutMs: 1_000,
      roleContextAssembler: { async assemble() {} },
      orchestratorService: { async execute() {} },
    }),
    /must fit within leaseDurationMs/,
  );
});

test("trusted loop constructor rejects accessor ports without invoking them", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  for (const [portName, method] of [
    ["roleContextAssembler", "assemble"],
    ["orchestratorService", "execute"],
  ]) {
    let getterCalls = 0;
    const accessorPort = {};
    Object.defineProperty(accessorPort, method, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => {};
      },
    });
    const ports = {
      roleContextAssembler: { async assemble() {} },
      orchestratorService: { async execute() {} },
      [portName]: accessorPort,
    };

    assert.throws(
      () => createLoop({ ledger, directory, time, ...ports }),
      new RegExp(`${portName} is invalid`),
    );
    assert.equal(getterCalls, 0);
  }
});
