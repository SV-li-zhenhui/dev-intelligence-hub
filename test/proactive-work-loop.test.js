import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { OrchestratorServiceError } from "../src/services/orchestrator-service.js";
import { assertExpectedWorkGraphRevision } from "../src/services/work-ledger-graph-command-support.js";

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

function issueWorkItem(number, updatedAt, labels = []) {
  const item = workItem(number);
  item.event = {
    eventId: `workflow-event-${number}`,
    eventType: "issue.observed",
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: `github:issue:acme/repo#${number}`,
      repository: "acme/repo",
      number,
    },
    payload: { updatedAt, labels },
  };
  return item;
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
      retireInactiveIssues: [],
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

  async retireInactiveIssues(input) {
    this.calls.retireInactiveIssues.push(clone(input));
    let retired = 0;
    const selected = input.itemIds === undefined
      ? null
      : new Set(input.itemIds);
    for (const item of this.items) {
      const updatedAt = Date.parse(item.event?.payload?.updatedAt);
      if (
        (selected === null || selected.has(item.itemId)) &&
        item.status === "queued" &&
        item.event?.eventType?.startsWith("issue.") &&
        Number.isFinite(updatedAt) &&
        updatedAt < Date.parse(input.updatedBefore)
      ) {
        item.status = "cancelled";
        item.statusReason = "issue_outside_active_window";
        retired += 1;
      }
    }
    return { retired, itemIds: [] };
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
    if (input.consumeAttempt === false) item.attempt -= 1;
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
  checkAvailability,
  decide = async () => completeDecision(),
} = {}) {
  return {
    roleId,
    workerId,
    paused,
    enabled,
    ...(checkAvailability ? { checkAvailability } : {}),
    decide,
  };
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

test("a deferred intake is observable without preventing existing tasks from running", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  await ledger.intake({ limit: 100 });
  ledger.intake = async () => ({
    received: 0, deduplicated: 0, cursor: 1, highWatermark: 2,
    gap: null, itemIds: [], alertItemId: null,
    error: { code: "WORK_LEDGER_GRAPH_TRANSITION_INVALID", afterSequence: 1, nextSequence: 2 },
  });
  const loop = createLoop({
    ledger, time, directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
  });
  const result = await loop.runCycle();
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.ok(result.outcomes.some(({ status, code }) =>
    status === "intake_deferred" && code === "WORK_LEDGER_GRAPH_TRANSITION_INVALID"));
});

test("unsafe intake storage errors still stop the role cycle", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  await ledger.intake({ limit: 100 });
  ledger.intake = async () => {
    throw Object.assign(new Error("write failed"), { code: "WORK_LEDGER_STATE_WRITE_FAILED" });
  };
  const loop = createLoop({
    ledger, time, directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
  });
  await assert.rejects(loop.runCycle(), { code: "WORK_LEDGER_STATE_WRITE_FAILED" });
  assert.equal(ledger.calls.claim.length, 0);
});

test("a role cycle scans only current claim candidates instead of durable history", async () => {
  const time = controlledClock();
  const current = workItem(1);
  const history = Array.from({ length: 60 }, (_, index) => {
    const item = workItem(index + 2);
    item.status = "completed";
    return item;
  });
  const ledger = new FakeLedger({ source: [current, ...history], time });
  const candidateCalls = [];
  ledger.listClaimCandidates = async (options) => {
    candidateCalls.push(clone(options));
    return {
      items: [clone(current)],
      nextCursor: null,
      facts: [{
        itemId: current.itemId,
        graphBlocked: false,
        submittedChildren: 0,
        satisfiedChildren: 0,
      }],
      activeQuestionTargets: [],
    };
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const result = await loop.runCycle({
    trigger: "scheduled",
    roleId: "pr-reviewer",
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(candidateCalls, [{
    at: time.clock(),
    limit: 100,
    roleId: "pr-reviewer",
  }]);
  assert.equal(ledger.calls.listItems.length, 0);
});

test("candidate scanning refreshes its fixed time after intake", async () => {
  const time = controlledClock();
  const candidate = workItem(1);
  candidate.status = "retry_wait";
  candidate.availableAt = "2026-08-02T08:00:01.000Z";
  const ledger = new FakeLedger({ source: [candidate], time });
  const intake = ledger.intake.bind(ledger);
  ledger.intake = async (input) => {
    const result = await intake(input);
    time.advance(1_000);
    return result;
  };
  const candidateCalls = [];
  ledger.listClaimCandidates = async (options) => {
    candidateCalls.push(clone(options));
    const items = ledger.items.filter((item) =>
      item.status === "retry_wait" &&
      Date.parse(item.availableAt) <= Date.parse(options.at)
    ).map(clone);
    return {
      items,
      nextCursor: null,
      facts: items.map(({ itemId }) => ({
        itemId,
        graphBlocked: false,
        submittedChildren: 0,
        satisfiedChildren: 0,
      })),
      activeQuestionTargets: [],
    };
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const result = await loop.runCycle({
    trigger: "scheduled",
    roleId: "pr-reviewer",
  });

  assert.equal(result.claimed, 1);
  assert.equal(candidateCalls.length, 1);
  assert.equal(candidateCalls[0].at, "2026-08-02T08:00:01.000Z");
});

test("automatic work skips issues outside the configurable active window", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      issueWorkItem(1, "2026-06-01T08:00:00.000Z", ["p0"]),
      issueWorkItem(2, "2026-08-01T08:00:00.000Z"),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    issueActiveWindowDays: 14,
  });

  const result = await loop.runCycle({ trigger: "scheduled" });

  assert.equal(result.claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), ["work-item-2"]);
  assert.deepEqual(ledger.calls.retireInactiveIssues, [{
    updatedBefore: "2026-07-19T08:00:00.000Z",
  }]);
  assert.equal(ledger.items[0].status, "cancelled");
});

test("same-day Issue intake retires new stale work with a targeted sweep", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
    issueActiveWindowDays: 14,
  });

  await loop.runCycle({ trigger: "scheduled" });
  ledger.source.push(issueWorkItem(1, "2026-06-01T08:00:00.000Z"));
  await loop.runCycle({ trigger: "scheduled" });

  assert.equal(ledger.calls.retireInactiveIssues.length, 2);
  assert.deepEqual(ledger.calls.retireInactiveIssues[1], {
    updatedBefore: "2026-07-19T08:00:00.000Z",
    itemIds: ["work-item-1"],
  });
  assert.equal(ledger.items[0].status, "cancelled");
});

test("concurrent role cycles share one daily inactive-Issue sweep", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [], time });
  const sweepStarted = deferred();
  const releaseSweep = deferred();
  const retireInactiveIssues = ledger.retireInactiveIssues.bind(ledger);
  ledger.retireInactiveIssues = async (input) => {
    sweepStarted.resolve();
    await releaseSweep.promise;
    return retireInactiveIssues(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({ roleId: "developer" }),
      tester: worker({ roleId: "tester" }),
    }),
    time,
  });

  const developer = loop.runCycle({ roleId: "developer" });
  await sweepStarted.promise;
  const tester = loop.runCycle({ roleId: "tester" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseSweep.resolve();
  await Promise.all([developer, tester]);

  assert.deepEqual(ledger.calls.retireInactiveIssues, [{
    updatedBefore: "2026-07-19T08:00:00.000Z",
  }]);
});

test("automatic work chooses a high-priority recent issue before an ordinary one", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      issueWorkItem(1, "2026-08-01T08:00:00.000Z"),
      issueWorkItem(2, "2026-08-01T07:00:00.000Z", ["priority: high"]),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    issueActiveWindowDays: 14,
  });

  await loop.runCycle({ trigger: "scheduled", workLimit: 1 });

  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), ["work-item-2"]);
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

test("provider credential degradation leaves the selected task unclaimed without fallback", async () => {
  const time = controlledClock();
  const source = workItem(4, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const availabilityItems = [];
  let fallbackCalls = 0;
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability({ item, signal }) {
        availabilityItems.push(item);
        assert.equal(signal instanceof AbortSignal, true);
        throw Object.assign(new Error("private credential detail"), {
          code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
        });
      },
      async decide() {
        fallbackCalls += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.equal(result.claimed, 0);
  assert.equal(result.claimAttempts, 0);
  assert.deepEqual(result.outcomes, [{
    itemId: source.itemId,
    status: "degraded",
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  }]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(fallbackCalls, 0);
  assert.equal(availabilityItems.length, 1);
  assert.equal(availabilityItems[0].event.eventType, "pull_request.created");
  assert.equal(Object.hasOwn(availabilityItems[0], "ownerId"), false);
});

test("availability remains item-specific while target resolution is cached", async () => {
  const time = controlledClock();
  const first = workItem(5, { type: "role", id: "developer" });
  const second = workItem(6, { type: "role", id: "developer" });
  first.event.eventType = "issue.updated";
  const ledger = new FakeLedger({ source: [first, second], time });
  const checkedEventTypes = [];
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability({ item }) {
        checkedEventTypes.push(item.event.eventType);
        throw Object.assign(new Error("provider unavailable"), {
          code: "STRUCTURED_PROVIDER_UNAVAILABLE",
        });
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer", workLimit: 2 });

  assert.equal(directory.calls.length, 1);
  assert.deepEqual(checkedEventTypes, ["issue.updated", "pull_request.created"]);
  assert.deepEqual(
    result.outcomes.map(({ status, code }) => ({ status, code })),
    [
      { status: "degraded", code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
      { status: "degraded", code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
    ],
  );
  assert.equal(ledger.calls.claim.length, 0);
});

test("one unavailable task cannot consume the work budget and starve a ready task", async () => {
  const time = controlledClock();
  const unavailable = workItem(106, { type: "role", id: "orchestrator" });
  const ready = workItem(107, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [unavailable, ready], time });
  const checked = [];
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      async checkAvailability({ item }) {
        checked.push(item.itemId);
        if (item.itemId === unavailable.itemId) {
          throw Object.assign(new Error("task brain missing"), {
            code: "ROLE_TASK_BRAIN_NOT_CONFIGURED",
          });
        }
      },
      async decide() {
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
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });

  assert.deepEqual(checked, [unavailable.itemId, ready.itemId]);
  assert.equal(result.availabilityChecks, 2);
  assert.equal(result.workAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(result.outcomes.map(({ status }) => status), [
    "degraded",
    "staged",
  ]);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[1].status, "dispatch_pending");
});

test("unexpected availability errors remain resolution failures before claim", async () => {
  const time = controlledClock();
  const source = workItem(7, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability() {
        throw new TypeError("programming error");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.deepEqual(result.outcomes, [{
    itemId: source.itemId,
    status: "resolution_failed",
  }]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.items[0].status, "queued");
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
  assert.deepEqual(ledger.calls.scheduleRetry[0].details, {
    code: "ROLE_DECISION_FAILED",
  });
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

test("explicit local owner requests take priority without reordering peers", async () => {
  const time = controlledClock();
  const oldest = workItem(1);
  const high = workItem(2);
  const urgent = workItem(3);
  const laterHigh = workItem(4);
  for (const [item, priority] of [
    [high, "high"],
    [urgent, "urgent"],
    [laterHigh, "high"],
  ]) {
    item.event.eventType = "pull_request.owner_requested";
    item.event.source = {
      provider: "local-owner",
      scopeId: `owner-request:${item.itemId}`,
    };
    item.event.payload.priority = priority;
  }
  const ledger = new FakeLedger({
    source: [oldest, high, urgent, laterHigh],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  await loop.runCycle({ workLimit: 3 });

  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    [urgent.itemId, high.itemId, laterHigh.itemId],
  );
  assert.equal(ledger.items[0].status, "queued");
});

test("configured roots with more settled child work close before peer roots", async () => {
  const time = controlledClock();
  const firstRoot = workItem(31, { type: "role", id: "orchestrator" });
  const laterRoot = workItem(32, { type: "role", id: "orchestrator" });
  const children = [
    [workItem(33, { type: "role", id: "developer" }), firstRoot],
    [workItem(34, { type: "role", id: "developer" }), laterRoot],
    [workItem(35, { type: "role", id: "tester" }), laterRoot],
  ];
  for (const [child, parent] of children) {
    child.graph = { parentItemId: parent.itemId, dependsOnItemIds: [], deliveries: [] };
    child.status = "completed";
  }
  const ledger = new FakeLedger({
    source: [firstRoot, children[0][0], laterRoot, children[1][0], children[2][0]],
    time,
  });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision("完成根任务"),
    }),
    developer: worker({ roleId: "developer" }),
    tester: worker({ roleId: "tester" }),
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
    orchestratorService: { async execute() {} },
  });

  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });

  assert.equal(ledger.calls.claim[0].itemId, laterRoot.itemId);
  assert.equal(ledger.calls.stageIntent[0].itemId, laterRoot.itemId);
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

test("a fenced PR claim does not starve the next claimable task", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 5 }, (_, index) => workItem(index + 1));
  const ready = workItem(6);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.workAttempts, 1);
  assert.equal(result.availabilityChecks, 6);
  assert.equal(result.claimAttempts, 6);
  assert.equal(result.claimed, 1);
  assert.deepEqual(
    result.outcomes.map(({ status, code }) => ({ status, code })),
    [
      ...fenced.map(() => ({
      status: "claim_not_acquired",
      code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      })),
      { status: "staged", code: undefined },
    ],
  );
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    ...fenced.map(() => "queued"),
    "dispatch_pending",
  ]);
});

test("fenced PR claim scanning stops at its independent safety cap", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  ledger.claim = async (input) => {
    ledger.calls.claim.push(clone(input));
    throw Object.assign(new Error("PR source authority is fenced"), {
      code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
    });
  };
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.workAttempts, 0);
  assert.equal(result.availabilityChecks, 32);
  assert.equal(result.claimAttempts, 32);
  assert.equal(result.claimed, 0);
  assert.equal(ledger.calls.claim.length, 32);
  assert.equal(ledger.items.at(-1).itemId, ready.itemId);
  assert.equal(ledger.items.at(-1).status, "queued");
});

test("later work is claimed on the next cycle after fenced claim safety cap", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const first = await loop.runCycle({ workLimit: 1 });
  const second = await loop.runCycle({ workLimit: 1 });

  assert.equal(first.claimAttempts, 32);
  assert.equal(first.claimed, 0);
  assert.equal(second.claimAttempts, 1);
  assert.equal(second.claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), [
    ...fenced.map(({ itemId }) => itemId),
    ready.itemId,
  ]);
  assert.equal(ledger.items.at(-1).status, "dispatch_pending");
});

test("fenced deferrals never bypass a newly arrived urgent owner request", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });
  await loop.runCycle({ workLimit: 1 });

  const urgent = workItem(34);
  urgent.event.eventType = "pull_request.owner_requested";
  urgent.event.source = {
    provider: "local-owner",
    scopeId: `owner-request:${urgent.itemId}`,
  };
  urgent.event.payload.priority = "urgent";
  ledger.items.push(urgent);
  const second = await loop.runCycle({ workLimit: 1 });

  assert.equal(second.claimed, 1);
  assert.equal(ledger.calls.claim.at(-1).itemId, urgent.itemId);
  assert.equal(
    ledger.items.find(({ itemId }) => itemId === ready.itemId).status,
    "queued",
  );
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
    "pr-reviewer": worker({
      decide: async ({ signal }) => new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    }),
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

test("shutdown abort reaches an active role decision and stages no later intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(70)], time });
  const started = deferred();
  let providerSignal = null;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async ({ signal }) => {
        providerSignal = signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });
  const controller = new AbortController();
  const running = loop.runCycle({
    trigger: "scheduled",
    signal: controller.signal,
  });
  await Promise.race([
    started.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("role provider did not start")),
      100,
    )),
  ]);
  const reason = Object.assign(new Error("shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.equal(providerSignal instanceof AbortSignal, true);
  assert.equal(providerSignal.aborted, true);
  assert.strictEqual(providerSignal.reason, reason);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
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

function memoryQueryDecision() {
  return {
    schemaVersion: 1,
    confidence: 88,
    summary: "需要查询可引用的历史证据",
    intent: {
      schemaVersion: 1,
      type: "query_memory",
      summary: "查询旧回归证据",
      reason: "当前判断缺少可复现的历史记录",
      question: "上次同类回归是如何修复的？",
      searchQuery: "同类 回归 修复",
      mode: "local",
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

test("a specialist can query cited memory once and re-enter the same work decision", async () => {
  const time = controlledClock();
  const source = workItem(32, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  const contexts = [];
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ context }) => {
        contexts.push(clone(context));
        return context.memory ? completeDecision("已结合引用继续判断") : memoryQueryDecision();
      },
    }),
  });
  let assembleCalls = 0;
  const assembler = {
    async assemble({ roleId, item }) {
      assembleCalls += 1;
      const packet = contextPacket(item, roleId);
      if (memoryReady) {
        packet.context.memory = {
          agentQuery: {
            queryId: `agent-memory-query-${"a".repeat(64)}`,
            claims: [{
              statement: "旧回归通过恢复空值分支保护修复。",
              citationIds: [`memory-${"b".repeat(64)}`],
            }],
          },
        };
      }
      return packet;
    },
  };
  const queryCalls = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: assembler,
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute(input) {
        queryCalls.push(clone({ ...input, signal: undefined }));
        assert.equal(input.signal instanceof AbortSignal, true);
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context, signal }) {
        assert.equal(signal instanceof AbortSignal, true);
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.staged, 1);
  assert.equal(assembleCalls, 2);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].memory, undefined);
  assert.match(contexts[1].memory.agentQuery.claims[0].statement, /空值分支/);
  assert.equal(queryCalls.length, 1);
  assert.equal(queryCalls[0].roleId, "developer");
  assert.equal(queryCalls[0].workerId, "employee-developer");
  assert.equal(queryCalls[0].intent.type, "query_memory");
  assert.equal(ledger.outbox[0].intent.type, "complete");
});

test("a second memory query in one work iteration is rejected without another primitive call", async () => {
  const time = controlledClock();
  const source = workItem(33, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let queryCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => memoryQueryDecision(),
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute() {
        queryCalls += 1;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context }) {
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(queryCalls, 1);
  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED");
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("the complete memory-assisted decision phase shares one lease-safe deadline", async () => {
  const time = controlledClock();
  const source = workItem(34, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let decisions = 0;
  let queryAborted = false;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          decisions += 1;
          return memoryQueryDecision();
        },
      }),
    }),
    time,
    leaseDurationMs: 13_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute({ signal }) {
        await new Promise((_resolve, reject) => {
          const onAbort = () => {
            queryAborted = true;
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      async verifyContext({ context }) {
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(queryAborted, true);
  assert.equal(decisions, 1);
  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "ROLE_DECISION_TIMEOUT");
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("healthy memory decision stages use separate deadlines inside one hard total budget", async () => {
  const time = controlledClock();
  const source = workItem(35, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  let decisions = 0;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 600));
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async ({ context, signal }) => {
          assert.equal(signal instanceof AbortSignal, true);
          await delay();
          signal.throwIfAborted();
          decisions += 1;
          return context.memory
            ? completeDecision("记忆阶段完成后继续")
            : memoryQueryDecision();
        },
      }),
    }),
    time,
    leaseDurationMs: 15_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    roleContextAssembler: {
      async assemble({ roleId, item, signal }) {
        signal?.throwIfAborted();
        const packet = contextPacket(item, roleId);
        if (memoryReady) {
          packet.context.memory = {
            agentQuery: {
              queryId: `agent-memory-query-${"a".repeat(64)}`,
              claims: [{
                statement: "引用仍然有效。",
                citationIds: [`memory-${"b".repeat(64)}`],
              }],
            },
          };
        }
        return packet;
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute({ signal }) {
        await delay();
        signal.throwIfAborted();
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context, signal }) {
        signal.throwIfAborted();
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.staged, 1);
  assert.equal(decisions, 2);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.outbox[0].intent.type, "complete");
});

test("citation invalidation after the provider returns stages no decision", async () => {
  const time = controlledClock();
  const source = workItem(36, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  let citationCurrent = true;
  let verificationCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async ({ context }) => {
          if (!context.memory) return memoryQueryDecision();
          citationCurrent = false;
          return completeDecision("不得采用已过期引用");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        const packet = contextPacket(item, roleId);
        if (memoryReady) {
          packet.context.memory = {
            agentQuery: {
              queryId: `agent-memory-query-${"a".repeat(64)}`,
              claims: [{
                statement: "即将失效的结论。",
                citationIds: [`memory-${"b".repeat(64)}`],
              }],
            },
          };
        }
        return packet;
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute() {
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context }) {
        verificationCalls += 1;
        if (!citationCurrent) {
          throw Object.assign(new Error("citation is obsolete"), {
            code: "AGENT_MEMORY_QUERY_CITATION_STALE",
          });
        }
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "AGENT_MEMORY_QUERY_CITATION_STALE");
  assert.equal(verificationCalls, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
});

test("authoritative task changes after the provider returns stage no decision", async () => {
  const time = controlledClock();
  const source = workItem(37, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          const authoritative = ledger.items[0];
          authoritative.revision += 1;
          authoritative.inputDigest = "superseding-input-digest";
          return completeDecision("不得采用旧任务输入的判断");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.outcomes[0].status, "failure_state_unchanged");
  assert.equal(cycle.outcomes[0].code, "ROLE_DECISION_INPUT_STALE");
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
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

test("specialist delivery exhaustion remains distinct from decision exhaustion", async () => {
  const time = controlledClock();
  const source = workItem(72, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item }) => deliveryDecision(item),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw new Error("delivery outcome remains unproven");
      },
    },
  });

  const first = await loop.runCycle({ roleId: "developer" });
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_failed");
  time.advance(1_000);

  const second = await loop.runCycle({ roleId: "developer" });
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_attempts_exhausted");
  assert.equal(ledger.calls.scheduleRetry[0].reason, "delivery_failed");
  assert.equal(
    ledger.calls.transition[0].reason,
    "delivery_attempts_exhausted",
  );
});

test("delivery attention staging exhaustion remains delivery-classified", async () => {
  const time = controlledClock();
  const source = workItem(73, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item }) => deliveryDecision(item),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw Object.assign(new Error("delivery cleanup state is unknown"), {
          code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
        });
      },
    },
  });

  ledger.stageFailure = "before_write";
  const first = await loop.runCycle({ roleId: "developer" });
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_failed");
  time.advance(1_000);

  ledger.stageFailure = "before_write";
  const second = await loop.runCycle({ roleId: "developer" });
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_attempts_exhausted");
  assert.equal(ledger.calls.stageIntent.length, 2);
  assert.equal(ledger.calls.scheduleRetry[0].reason, "delivery_failed");
  assert.equal(
    ledger.calls.transition[0].reason,
    "delivery_attempts_exhausted",
  );
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

test("task-brain owner decisions enter one durable attention request without fallback", async (t) => {
  for (const code of [
    "ROLE_TASK_BRAIN_NOT_CONFIGURED",
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    "REMOTE_DATA_NOT_AUTHORIZED",
  ]) {
    await t.test(code, async () => {
      const time = controlledClock();
      const source = workItem(80, { type: "role", id: "developer" });
      const ledger = new FakeLedger({ source: [source], time });
      let decisions = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async () => {
            decisions += 1;
            throw Object.assign(new Error(code), { code });
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
        orchestratorService: { async execute() {} },
      });

      const cycle = await loop.runCycle({ roleId: "developer" });

      assert.equal(cycle.staged, 1);
      assert.equal(decisions, 1);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.outbox.length, 1);
      assert.equal(ledger.outbox[0].intent.type, "ask_user");
      assert.match(ledger.outbox[0].intent.reason, new RegExp(code));
      assert.equal(ledger.outbox[0].intent.choices[0].id, "configured-retry");
    });
  }
});

const STRUCTURED_BRAIN_ATTENTION_CASES = Object.freeze([
  Object.freeze({
    code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    failurePoint: "brain",
    remediation: /保留.*会话历史.*不要删除/,
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
    failurePoint: "context",
    remediation: /安装|配置|可执行/,
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    failurePoint: "brain",
    remediation: /登录|认证|凭据/,
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    failurePoint: "context",
    remediation: /进程|清理|运行环境/,
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_REAP_FAILED",
    failurePoint: "brain",
    remediation: /进程|清理|运行环境/,
  }),
]);

function structuredBrainFailure(code) {
  return Object.assign(
    new Error(`raw stderr sk-owner-secret from C:\\private\\codex.exe (${code})`),
    {
      code,
      stderr: "provider stderr sk-owner-secret",
      executablePath: "C:\\private\\codex.exe",
      credential: "sk-owner-secret",
    },
  );
}

test("root context contention defers one item and continues the cycle", async (t) => {
  for (const failurePoint of ["assemble", "execute"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const ledger = new FakeLedger({
        source: [
          workItem(401, { type: "role", id: "orchestrator" }),
          workItem(402, { type: "role", id: "orchestrator" }),
        ],
        time,
      });
      let assemblies = 0;
      let executions = 0;
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async ({ item }) => orchestrationDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assemblies += 1;
            if (failurePoint === "assemble" && assemblies === 1) {
              throw Object.assign(new Error("context changed"), { code: "ROLE_CONTEXT_STALE" });
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            executions += 1;
            if (failurePoint === "execute" && executions === 1) {
              throw new OrchestratorServiceError("ORCHESTRATOR_CONTEXT_STALE", "changed", 409);
            }
            return { applied: true };
          },
        },
      });
      const cycle = await loop.runCycle({ roleId: "orchestrator" });
      assert.equal(executions, failurePoint === "execute" ? 2 : 1);
      assert.deepEqual(cycle.outcomes.map(({ status }) => status), ["decision_deferred", "orchestrated"]);
      assert.equal(ledger.calls.claim.length, 0);
    });
  }
});

test("specialist context contention never exhausts the business attempt budget", async (t) => {
  for (const priorFailures of [0, 2]) {
    await t.test(`prior failures: ${priorFailures}`, async () => {
      const time = controlledClock();
      const source = workItem(403, { type: "role", id: "developer" });
      source.attempt = priorFailures;
      const ledger = new FakeLedger({ source: [source], time });
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          developer: worker({
            roleId: "developer",
            decide: async ({ item }) => deliveryDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) { return contextPacket(item, roleId); },
        },
        orchestratorService: {
          async execute() {
            if (priorFailures === 2) assertExpectedWorkGraphRevision(1, { revision: 2 });
            throw new OrchestratorServiceError("ORCHESTRATOR_CONTEXT_STALE", "changed", 409);
          },
        },
      });
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const result = await loop.runCycle({ roleId: "developer" });
        assert.equal(result.retried, 1);
        assert.equal(ledger.items[0].attempt, priorFailures);
        assert.equal(ledger.items[0].status, "retry_wait");
        time.advance(1_000);
      }
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.scheduleRetry.every(({ consumeAttempt }) => consumeAttempt === false), true);
    });
  }
});

test("only authentic pre-write graph conflicts defer root decisions", async (t) => {
  for (const authentic of [true, false]) {
    await t.test(`authentic: ${authentic}`, async () => {
      const time = controlledClock();
      const ledger = new FakeLedger({
        source: [workItem(404, { type: "role", id: "orchestrator" })],
        time,
      });
      let conflict = Object.assign(new Error("durable state fork or untrusted error"), {
        code: "WORK_LEDGER_STATE_REVISION_CONFLICT", contextContention: true,
      });
      if (authentic) {
        try {
          assertExpectedWorkGraphRevision(1, { revision: 2 });
        } catch (error) {
          conflict = error;
        }
      }
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator", workerId: "employee-orchestrator",
            decide: async ({ item }) => orchestrationDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) { return contextPacket(item, roleId); },
        },
        orchestratorService: { async execute() { throw conflict; } },
      });
      if (authentic) {
        assert.equal((await loop.runCycle({ roleId: "orchestrator" })).outcomes[0].status, "decision_deferred");
      } else {
        await assert.rejects(loop.runCycle({ roleId: "orchestrator" }), (error) => error === conflict);
      }
      assert.equal(ledger.calls.scheduleRetry.length, 0);
    });
  }
});

function terminalPullRequestFailure(state = "MERGED") {
  const terminal = Object.assign(new Error(`PR is ${state}`), {
    code: "PR_FACTS_TERMINAL",
    terminalState: state,
  });
  const refresh = Object.assign(
    new Error("Unable to refresh PR facts", { cause: terminal }),
    { code: "PR_FACT_REFRESH_FAILED" },
  );
  return Object.assign(
    new Error("Unable to assemble PR role context", { cause: refresh }),
    { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" },
  );
}

function assertSafeOwnerAttention({ ledger, roleId, code, remediation }) {
  assert.equal(ledger.outbox.length, 1);
  const intent = ledger.outbox[0].intent;
  assert.equal(intent.type, "ask_user");
  assert.match(intent.summary, new RegExp(roleId));
  assert.match(intent.reason, new RegExp(code));
  assert.match(intent.question, remediation);
  assert.equal(intent.choices[0].id, "configured-retry");
  const publicCopy = JSON.stringify(intent);
  for (const secret of [
    "raw stderr",
    "provider stderr",
    "sk-owner-secret",
    "C:\\\\private\\\\codex.exe",
  ]) {
    assert.equal(publicCopy.includes(secret), false);
  }
}

test("a configured root closes a terminal PR task instead of retrying it", async () => {
  const time = controlledClock();
  const root = workItem(801, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
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
        throw terminalPullRequestFailure("MERGED");
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.blocked, 1);
  assert.equal(cycle.outcomes[0].code, "PR_FACTS_TERMINAL");
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].statusReason, "pr_source_terminal");
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.deepEqual(ledger.calls.transition[0].details, {
    code: "PR_FACTS_TERMINAL",
    outcome: "MERGED",
  });
});

test("a specialist closes a terminal PR task without consuming retry attempts", async () => {
  const time = controlledClock();
  const source = workItem(802, { type: "role", id: "pr-engineer" });
  const ledger = new FakeLedger({ source: [source], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      "pr-engineer": worker({ roleId: "pr-engineer" }),
    }),
    time,
    roleContextAssembler: {
      async assemble() {
        throw terminalPullRequestFailure("CLOSED");
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "pr-engineer" });

  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.blocked, 1);
  assert.equal(cycle.retried, 0);
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].statusReason, "pr_source_terminal");
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.deepEqual(ledger.calls.transition[0].details, {
    code: "PR_FACTS_TERMINAL",
    outcome: "CLOSED",
  });
});

test("structured brain failures create one safe owner attention for a configured specialist", async (t) => {
  for (const { code, failurePoint, remediation } of STRUCTURED_BRAIN_ATTENTION_CASES) {
    await t.test(`${failurePoint}:${code}`, async () => {
      const time = controlledClock();
      const source = workItem(81, { type: "role", id: "developer" });
      const ledger = new FakeLedger({ source: [source], time });
      let decisionCalls = 0;
      let serviceCalls = 0;
      const loop = createLoop({
        ledger,
        directory: new FakeRoleDirectory({
          developer: worker({
            roleId: "developer",
            decide: async () => {
              decisionCalls += 1;
              if (failurePoint === "brain") throw structuredBrainFailure(code);
              return completeDecision();
            },
          }),
        }),
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            if (failurePoint === "context") throw structuredBrainFailure(code);
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
          },
        },
      });

      const first = await loop.runCycle({ roleId: "developer" });
      const second = await loop.runCycle({ roleId: "developer" });

      assert.equal(first.staged, 1);
      assert.equal(second.staged, 0);
      assert.equal(ledger.items[0].status, "dispatch_pending");
      assert.equal(ledger.calls.claim.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 1);
      assert.equal(ledger.calls.stageIntent[0].roleId, "developer");
      assert.equal(ledger.calls.stageIntent[0].actorId, "employee-developer");
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(decisionCalls, failurePoint === "brain" ? 1 : 0);
      assert.equal(serviceCalls, 0);
      assertSafeOwnerAttention({ ledger, roleId: "developer", code, remediation });
    });
  }
});

test("structured brain failures make a configured root claim and stage one safe owner attention", async (t) => {
  for (const { code, failurePoint, remediation } of STRUCTURED_BRAIN_ATTENTION_CASES) {
    await t.test(`${failurePoint}:${code}`, async () => {
      const time = controlledClock();
      const root = workItem(82, { type: "role", id: "orchestrator" });
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
      let decisionCalls = 0;
      let serviceCalls = 0;
      const loop = createLoop({
        ledger,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async () => {
              order.push("decide");
              decisionCalls += 1;
              if (failurePoint === "brain") throw structuredBrainFailure(code);
              return completeDecision();
            },
          }),
        }),
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            order.push("assemble");
            if (failurePoint === "context") throw structuredBrainFailure(code);
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
          },
        },
      });

      const first = await loop.runCycle({ roleId: "orchestrator" });
      const second = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(first.claimed, 1);
      assert.equal(first.staged, 1);
      assert.equal(second.claimed, 0);
      assert.equal(ledger.items[0].status, "dispatch_pending");
      assert.deepEqual(
        order,
        failurePoint === "brain"
          ? ["assemble", "decide", "claim", "stage"]
          : ["assemble", "claim", "stage"],
      );
      assert.equal(ledger.calls.claim.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 1);
      assert.equal(ledger.calls.stageIntent[0].roleId, "orchestrator");
      assert.equal(ledger.calls.stageIntent[0].actorId, "employee-orchestrator");
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(decisionCalls, failurePoint === "brain" ? 1 : 0);
      assert.equal(serviceCalls, 0);
      assertSafeOwnerAttention({ ledger, roleId: "orchestrator", code, remediation });
    });
  }
});

test("configured-root owner attention recovers lost claim and stage acknowledgements", async (t) => {
  for (const failureMode of ["claim_after_write", "stage_after_write"]) {
    await t.test(failureMode, async () => {
      const time = controlledClock();
      const root = workItem(
        failureMode === "claim_after_write" ? 83 : 84,
        { type: "role", id: "orchestrator" },
      );
      const ledger = new FakeLedger({ source: [root], time });
      if (failureMode === "claim_after_write") {
        ledger.claimFailure = "after_write";
      } else {
        ledger.stageFailure = "after_write";
      }
      const loop = createLoop({
        ledger,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async () => {
              throw structuredBrainFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
            },
          }),
        }),
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: { async execute() {} },
      });

      const cycle = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(cycle.claimed, 1);
      assert.equal(
        cycle.outcomes[0].status,
        failureMode === "stage_after_write" ? "stage_recovered" : "staged",
      );
      assert.equal(ledger.items[0].status, "dispatch_pending");
      assert.equal(ledger.outbox.length, 1);
      assert.equal(ledger.calls.claim.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 1);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
    });
  }
});

test("configured-root owner attention retries a stage failure only until one durable write", async () => {
  const time = controlledClock();
  const root = workItem(85, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  ledger.stageFailure = "before_write";
  let decisions = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
        decide: async () => {
          decisions += 1;
          throw structuredBrainFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const first = await loop.runCycle({ roleId: "orchestrator" });
  time.advance(1_000);
  const second = await loop.runCycle({ roleId: "orchestrator" });
  const third = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(first.retried, 1);
  assert.equal(second.staged, 1);
  assert.equal(third.staged, 0);
  assert.equal(decisions, 2);
  assert.equal(ledger.items[0].status, "dispatch_pending");
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 2);
  assert.equal(ledger.calls.scheduleRetry.length, 1);
  assert.equal(ledger.calls.transition.length, 0);
});

test("unclassified structured failures preserve generic specialist behavior and defer invalid root output", async (t) => {
  await t.test("specialist retries a provider timeout", async () => {
    const time = controlledClock();
    const source = workItem(87, { type: "role", id: "developer" });
    const ledger = new FakeLedger({ source: [source], time });
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async () => {
            throw structuredBrainFailure("STRUCTURED_PROVIDER_TIMEOUT");
          },
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble({ roleId, item }) {
          return contextPacket(item, roleId);
        },
      },
      orchestratorService: { async execute() {} },
    });

    const cycle = await loop.runCycle({ roleId: "developer" });

    assert.equal(cycle.retried, 1);
    assert.equal(cycle.outcomes[0].code, "STRUCTURED_PROVIDER_TIMEOUT");
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.calls.stageIntent.length, 0);
    assert.equal(ledger.outbox.length, 0);
  });

  for (const code of [
    "STRUCTURED_BRAIN_RESPONSE_INVALID",
    "STRUCTURED_PROVIDER_RESPONSE_INVALID",
  ]) {
    await t.test(`root defers ${code} without failing the employee`, async () => {
      const time = controlledClock();
      const root = workItem(88, { type: "role", id: "orchestrator" });
      const ledger = new FakeLedger({ source: [root], time });
      const loop = createLoop({
        ledger,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async () => {
              throw structuredBrainFailure(code);
            },
          }),
        }),
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: { async execute() {} },
      });

      const cycle = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(cycle.outcomes[0].status, "decision_deferred");
      assert.equal(cycle.outcomes[0].code, code);
      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(ledger.outbox.length, 0);
    });
  }
});

test("cycle-signal cancellation wins over configured-root owner attention", async () => {
  const time = controlledClock();
  const root = workItem(86, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const started = deferred();
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
        decide: async ({ signal }) => {
          started.resolve();
          return new Promise((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });
  const controller = new AbortController();
  const running = loop.runCycle({
    roleId: "orchestrator",
    signal: controller.signal,
  });
  await started.promise;
  const cancellation = Object.assign(new Error("cycle stopped"), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  controller.abort(cancellation);

  await assert.rejects(running, (error) => error === cancellation);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
  assert.equal(ledger.outbox.length, 0);
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

test("runtime cutover leaves configured root orchestration queued", async (t) => {
  for (const failurePoint of ["brain", "orchestration"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const root = workItem(
        failurePoint === "brain" ? 63 : 64,
        { type: "role", id: "orchestrator" },
      );
      const ledger = new FakeLedger({ source: [root], time });
      const admissionError = Object.assign(new Error("configuration changed"), {
        code: "RUNTIME_RESTART_REQUIRED",
      });
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => {
            if (failurePoint === "brain") throw admissionError;
            return orchestrationDecision(item);
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
        loop.runCycle({ roleId: "orchestrator" }),
        (error) => error === admissionError,
      );

      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(serviceCalls, failurePoint === "orchestration" ? 1 : 0);
    });
  }
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

test("a superseded child is terminal and does not block root completion", async () => {
  const time = controlledClock();
  const root = workItem(142, { type: "role", id: "orchestrator" });
  const child = workItem(143, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  child.status = "superseded";
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
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
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a cancelled child is settled and lets the root judge replacement work", async () => {
  const time = controlledClock();
  const root = workItem(144, { type: "role", id: "orchestrator" });
  const cancelled = workItem(145, { type: "role", id: "developer" });
  const replacement = workItem(146, { type: "role", id: "developer" });
  cancelled.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  replacement.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  cancelled.status = "cancelled";
  replacement.status = "completed";
  const ledger = new FakeLedger({ source: [root, cancelled, replacement], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
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
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a cancelled dependency remains unsatisfied", async () => {
  const time = controlledClock();
  const dependency = workItem(147, { type: "role", id: "developer" });
  const dependent = workItem(148, { type: "role", id: "developer" });
  dependency.status = "cancelled";
  dependent.graph = {
    parentItemId: null,
    dependsOnItemIds: [dependency.itemId],
  };
  const ledger = new FakeLedger({ source: [dependency, dependent], time });
  let decisions = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          decisions += 1;
          return completeDecision();
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.claimed, 0);
  assert.equal(decisions, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
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

test("a pre-write root authority rejection stays local to one orchestration outcome", async () => {
  const time = controlledClock();
  const root = workItem(65, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const denied = new OrchestratorServiceError(
    "ORCHESTRATOR_AUTHORITY_DENIED",
    "invalid dependency",
    403,
  );
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
        throw denied;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.workAttempts, 1);
  assert.deepEqual(cycle.outcomes, [{
    itemId: root.itemId,
    status: "orchestration_rejected",
    workerId: "employee-orchestrator",
    code: "ORCHESTRATOR_AUTHORITY_DENIED",
  }]);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
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
