import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";

function clone(value) {
  return structuredClone(value);
}

function controlledClock(initial = "2026-08-02T04:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now).toISOString(),
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function workflowEvent(index = 1) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T03:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: `github:pr:acme/repo#${40 + index}`,
      repository: "acme/repo",
      number: 40 + index,
    },
    payload: {
      title: `Fix race ${index}`,
      headRefOid: `head-${index}`,
      state: "open",
      changedFields: ["headRefOid"],
    },
  });
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成可信事实核对",
    reason: "需要推进下一步",
  };
}

function askUserIntent(overrides = {}) {
  return {
    ...common("ask_user"),
    question: "是否接受新的验收口径？",
    choices: [
      { id: "accept", label: "接受", description: "继续推进" },
      { id: "revise", label: "修改", description: "先补充需求" },
    ],
    ...overrides,
  };
}

function waitIntent() {
  return {
    ...common("wait_condition"),
    condition: {
      kind: "workflow_fact",
      fact: "ci-status",
      oneOf: ["success", "failure"],
    },
    checkAfterSeconds: 60,
  };
}

function reviewIntent() {
  return {
    ...common("propose_github_review"),
    verdict: "comment",
    body: "建议补一条并发回归测试。",
    evidence: ["状态更新可能丢失"],
  };
}

function codeIntent() {
  return {
    ...common("propose_code_action"),
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["回归测试通过"],
    evidence: ["revision 未校验"],
  };
}

function handoffIntent() {
  return {
    ...common("handoff"),
    capability: "testing",
    brief: "执行跨平台回归",
    evidence: ["unit-tests:passed"],
  };
}

function completeIntent() {
  return {
    ...common("complete"),
    outcome: "done",
    evidence: ["验收条件全部满足"],
  };
}

function workPair(index, intent, {
  target = { type: "role", id: "pr-reviewer" },
  status = "pending",
  leaseUntil = null,
} = {}) {
  const inputDigest = String((index % 9) + 1).repeat(64);
  const itemId = `work-item-${String.fromCharCode(96 + index).repeat(64)}`;
  const intentId = `work-intent-${"abcdef0123456789"[index % 16].repeat(64)}`;
  const item = {
    itemId,
    kind: "assignment",
    assignmentId: `workflow-assignment-${index}`,
    sourceSequence: index,
    inputDigest,
    assignment: {
      assignmentId: `workflow-assignment-${index}`,
      target: clone(target),
    },
    event: workflowEvent(index),
    currentTarget: clone(target),
    activeIntentId: intentId,
    decisionContext: null,
    status: "dispatch_pending",
    revision: 3,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 1,
    availableAt: null,
    statusReason: "intent_staged",
    createdAt: "2026-08-02T03:00:00.000Z",
    updatedAt: "2026-08-02T03:01:00.000Z",
  };
  const outbox = {
    intentId,
    intentDigest: intentId.slice("work-intent-".length),
    itemId,
    inputDigest,
    requestedBy: {
      roleId: target.type === "role" ? target.id : "orchestrator",
      workerId: target.type === "role"
        ? `employee-${target.id}`
        : "employee-orchestrator",
    },
    intent: clone(intent),
    status,
    revision: status === "dispatching" ? 2 : 1,
    attempt: status === "dispatching" ? 1 : 0,
    dispatcherId: status === "dispatching" ? "other-dispatcher" : null,
    dispatchLeaseId: status === "dispatching" ? `dispatch-lease-${index}` : null,
    dispatchLeaseUntil: status === "dispatching" ? leaseUntil : null,
    outcome: null,
    createdAt: new Date(Date.parse("2026-08-02T03:10:00.000Z") + index).toISOString(),
    updatedAt: "2026-08-02T03:10:00.000Z",
  };
  return { item, outbox };
}

class FakeLedger {
  constructor(pairs, clock) {
    this.items = pairs.map(({ item }) => clone(item));
    this.outbox = pairs.map(({ outbox }) => clone(outbox));
    this.clock = clock;
    this.claimCalls = [];
    this.ackCalls = [];
    this.nextLease = 1;
    this.failAckBeforeOnce = false;
    this.failAckAfterOnce = false;
  }

  async listOutbox(options) {
    return this.#page(
      this.outbox.filter(({ status }) => status === options.status),
      "intentId",
      options,
    );
  }

  async listItems(options) {
    return this.#page(this.items, "itemId", options);
  }

  async claimIntent(input) {
    this.claimCalls.push(clone(input));
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    if (!entry || entry.revision !== input.expectedRevision) {
      throw Object.assign(new Error("revision changed"), {
        code: "WORK_LEDGER_INTENT_REVISION_CONFLICT",
      });
    }
    const expired =
      entry.status === "dispatching" &&
      Date.parse(entry.dispatchLeaseUntil) <= this.clock.now();
    if (entry.status === "dispatching" && !expired) {
      throw Object.assign(new Error("active"), {
        code: "WORK_LEDGER_INTENT_LEASE_ACTIVE",
      });
    }
    if (!new Set(["pending", "dispatching"]).has(entry.status)) {
      throw Object.assign(new Error("terminal"), {
        code: "WORK_LEDGER_INTENT_STATUS_CONFLICT",
      });
    }
    entry.status = "dispatching";
    entry.revision += 1;
    entry.attempt += 1;
    entry.dispatcherId = input.dispatcherId;
    entry.dispatchLeaseId = `dispatcher-lease-${this.nextLease++}`;
    entry.dispatchLeaseUntil = new Date(
      this.clock.now() + input.leaseDurationMs,
    ).toISOString();
    entry.updatedAt = this.clock.clock();
    return clone(entry);
  }

  async ackIntent(input) {
    this.ackCalls.push(clone(input));
    if (this.failAckBeforeOnce) {
      this.failAckBeforeOnce = false;
      throw new Error("ack write unavailable");
    }
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    const item = this.items.find(({ itemId }) => itemId === entry.itemId);
    if (
      entry.status !== "dispatching" ||
      entry.revision !== input.expectedRevision ||
      entry.dispatchLeaseId !== input.dispatchLeaseId ||
      item.revision !== input.itemExpectedRevision
    ) {
      throw Object.assign(new Error("ack fenced"), {
        code: "WORK_LEDGER_INTENT_LEASE_CONFLICT",
      });
    }
    entry.status = input.outcome;
    entry.revision += 1;
    entry.dispatcherId = null;
    entry.dispatchLeaseId = null;
    entry.dispatchLeaseUntil = null;
    entry.outcome = { status: input.outcome, details: clone(input.details) };
    item.status = input.nextStatus;
    item.revision += 1;
    item.currentTarget = input.target ? clone(input.target) : item.currentTarget;
    item.availableAt = input.availableAt ?? null;
    item.updatedAt = this.clock.clock();
    if (this.failAckAfterOnce) {
      this.failAckAfterOnce = false;
      throw new Error("ack response lost");
    }
    return { item: clone(item), outbox: clone(entry) };
  }

  #page(records, idName, options) {
    const start = options.cursor
      ? records.findIndex((record) => record[idName] === options.cursor) + 1
      : 0;
    const items = records.slice(start, start + options.limit).map(clone);
    return {
      items,
      nextCursor:
        start + items.length < records.length && items.length
          ? items.at(-1)[idName]
          : null,
    };
  }
}

class FakeAttentionProducer {
  constructor() {
    this.calls = [];
    this.records = new Map();
    this.error = null;
    this.failAfterCreateOnce = false;
  }

  async create(request) {
    this.calls.push(clone(request));
    if (this.error) throw this.error;
    const key = JSON.stringify({
      requestKey: request.requestKey,
      producer: request.producer,
    });
    const content = JSON.stringify(request);
    const existing = this.records.get(key);
    if (existing && existing.content !== content) {
      throw Object.assign(new Error("different content"), {
        code: "ATTENTION_REQUEST_CONFLICT",
      });
    }
    const receipt = existing?.receipt ?? {
      requestId: `attention-${createHash("sha256").update(content).digest("hex")}`,
      status: "pending",
    };
    this.records.set(key, { content, receipt });
    if (this.failAfterCreateOnce) {
      this.failAfterCreateOnce = false;
      throw new Error("attention response lost");
    }
    return clone(receipt);
  }
}

class FakeProposalProducer {
  constructor() {
    this.calls = [];
    this.records = new Map();
    this.error = null;
    this.failAfterCreateOnce = false;
  }

  async create(value) {
    const proposal = normalizeBoundWorkProposal(value);
    this.calls.push(clone(proposal));
    if (this.error) throw this.error;
    const existing = this.records.get(proposal.proposalId);
    if (existing && existing.contentDigest !== proposal.contentDigest) {
      throw Object.assign(new Error("different proposal"), {
        code: "WORK_PROPOSAL_ID_CONFLICT",
      });
    }
    const receipt = existing ?? {
      proposalId: proposal.proposalId,
      contentDigest: proposal.contentDigest,
      kind: proposal.kind,
      status: "pending_delivery",
      revision: 1,
      createdAt: "2026-08-02T04:00:00.000Z",
    };
    this.records.set(proposal.proposalId, receipt);
    if (this.failAfterCreateOnce) {
      this.failAfterCreateOnce = false;
      throw new Error("proposal response lost");
    }
    return clone(receipt);
  }
}

function policy(overrides = {}) {
  return createWorkIntentPolicy({
    version: 4,
    capabilityRoles: {
      coordination: "orchestrator",
      requirements: "requirements-analyst",
      "pr-review": "pr-reviewer",
      development: "developer",
      testing: "trusted-tester",
    },
    githubReviewRoles: ["pr-reviewer"],
    codeActionRoles: ["developer"],
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    ...overrides,
  });
}

function fixture(pairs, options = {}) {
  const time = options.time ?? controlledClock();
  const ledger = options.ledger ?? new FakeLedger(pairs, time);
  const attention = options.attention ?? new FakeAttentionProducer();
  const proposals = options.proposals ?? new FakeProposalProducer();
  const dispatcher = new WorkIntentDispatcher({
    ledger,
    policy: options.policy ?? policy(),
    attentionProducer: attention,
    proposalProducer: proposals,
    clock: time.clock,
    leaseDurationMs: options.leaseDurationMs ?? 1_000,
    retryDelayMs: options.retryDelayMs ?? 60_000,
  });
  return { dispatcher, ledger, attention, proposals, time };
}

test("ask_user is content-addressed in the internal inbox before waiting_user acknowledgement", async () => {
  const pair = workPair(1, askUserIntent({ reason: "依据".repeat(600) }));
  const { dispatcher, ledger, attention } = fixture([pair]);

  const result = await dispatcher.dispatchPending({ limit: 10 });

  assert.deepEqual(
    {
      scanned: result.scanned,
      claimed: result.claimed,
      delivered: result.delivered,
      blocked: result.blocked,
      retryWait: result.retryWait,
      uncertain: result.uncertain,
      skipped: result.skipped,
    },
    {
      scanned: 1,
      claimed: 1,
      delivered: 1,
      blocked: 0,
      retryWait: 0,
      uncertain: 0,
      skipped: 0,
    },
  );
  assert.equal(attention.calls.length, 1);
  const request = attention.calls[0];
  assert.equal(request.requestKey, pair.outbox.intentId);
  assert.deepEqual(request.producer, {
    roleId: "pr-reviewer",
    workItemId: pair.item.itemId,
  });
  assert.equal(request.context.every(({ value }) => typeof value === "string"), true);
  assert.equal(
    request.context.every(({ value }) => Buffer.byteLength(value, "utf8") <= 2_048),
    true,
  );
  assert.equal(ledger.ackCalls[0].nextStatus, "waiting_user");
  assert.match(ledger.ackCalls[0].details.questionRef, /^attention-[a-f0-9]{64}$/);
  assert.match(ledger.ackCalls[0].details.downstreamRef, WORK_INTENT_REF);
});

const WORK_INTENT_REF = /^work-intent-[a-f0-9]{64}$/;

test("internal outcomes and durable proposals map to explicit ledger states", async (t) => {
  const cases = [
    { name: "wait", intent: waitIntent(), role: "pr-reviewer", next: "waiting_condition" },
    { name: "complete", intent: completeIntent(), role: "pr-reviewer", next: "completed" },
    { name: "github", intent: reviewIntent(), role: "pr-reviewer", next: "waiting_external" },
    { name: "code", intent: codeIntent(), role: "developer", next: "waiting_external" },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const pair = workPair(index + 2, entry.intent, {
        target: { type: "role", id: entry.role },
      });
      const { dispatcher, ledger, attention, proposals } = fixture([pair]);
      const result = await dispatcher.dispatchPending();

      assert.equal(result.delivered, 1);
      assert.equal(ledger.items[0].status, entry.next);
      assert.match(ledger.ackCalls[0].details.downstreamRef ?? ledger.ackCalls[0].details.resultRef, WORK_INTENT_REF);
      assert.equal(attention.calls.length, 0);
      if (["github", "code"].includes(entry.name)) {
        assert.equal(proposals.calls.length, 1);
        assert.equal(
          ledger.ackCalls[0].details.proposalDigest,
          proposals.calls[0].contentDigest,
        );
      } else {
        assert.equal(proposals.calls.length, 0);
      }
      assert.equal(Object.hasOwn(ledger.ackCalls[0], "command"), false);
      assert.equal(Object.hasOwn(ledger.ackCalls[0], "accountId"), false);
    });
  }
});

test("active dispatcher leases are skipped while an exactly expired lease is reclaimed", async () => {
  const time = controlledClock();
  const active = workPair(6, waitIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now() + 1).toISOString(),
  });
  const expired = workPair(7, waitIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now()).toISOString(),
  });
  const { dispatcher, ledger } = fixture([active, expired], { time });

  const result = await dispatcher.dispatchPending({ limit: 10 });

  assert.equal(result.scanned, 1);
  assert.equal(result.delivered, 1);
  assert.deepEqual(
    ledger.claimCalls.map(({ intentId }) => intentId),
    [expired.outbox.intentId],
  );
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(ledger.outbox[1].status, "delivered");
});

test("an idempotent attention create survives a lost ack and replays after lease expiry", async () => {
  const pair = workPair(8, askUserIntent());
  const { dispatcher, ledger, attention, time } = fixture([pair]);
  ledger.failAckBeforeOnce = true;

  const first = await dispatcher.dispatchPending();
  assert.equal(first.uncertain, 1);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(attention.records.size, 1);

  const active = await dispatcher.dispatchPending();
  assert.equal(active.scanned, 0);
  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();

  assert.equal(recovered.delivered, 1);
  assert.equal(attention.calls.length, 2);
  assert.equal(attention.records.size, 1);
  assert.deepEqual(attention.calls[1], attention.calls[0]);
  assert.equal(ledger.outbox[0].status, "delivered");
  assert.equal(ledger.items[0].status, "waiting_user");
});

test("unknown attention side effects stay dispatching until idempotent lease recovery", async () => {
  const pair = workPair(9, askUserIntent());
  const { dispatcher, ledger, attention, time } = fixture([pair]);
  attention.failAfterCreateOnce = true;

  const uncertain = await dispatcher.dispatchPending();

  assert.equal(uncertain.uncertain, 1);
  assert.equal(ledger.ackCalls.length, 0);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(attention.records.size, 1);

  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(attention.records.size, 1);
  assert.equal(ledger.ackCalls.length, 1);
});

test("an idempotent proposal survives a lost response and is acknowledged after lease recovery", async () => {
  const pair = workPair(10, codeIntent(), {
    target: { type: "role", id: "developer" },
  });
  const proposals = new FakeProposalProducer();
  proposals.failAfterCreateOnce = true;
  const { dispatcher, ledger, time } = fixture([pair], { proposals });

  const uncertain = await dispatcher.dispatchPending();
  assert.equal(uncertain.uncertain, 1);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(proposals.records.size, 1);

  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(proposals.calls.length, 2);
  assert.equal(proposals.records.size, 1);
  assert.equal(ledger.items[0].status, "waiting_external");
  assert.match(ledger.ackCalls[0].details.proposalDigest, /^[a-f0-9]{64}$/);
});

test("policy rejection blocks safely and attention conflicts split blocked from retry_wait", async (t) => {
  await t.test("policy", async () => {
    const pair = workPair(1, reviewIntent(), {
      target: { type: "role", id: "developer" },
    });
    const { dispatcher, ledger } = fixture([pair]);
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.outbox[0].status, "failed");
    assert.equal(ledger.items[0].status, "blocked");
    assert.equal(ledger.ackCalls[0].details.code, "policy-denied");
  });

  await t.test("attention conflict", async () => {
    const pair = workPair(2, askUserIntent());
    const attention = new FakeAttentionProducer();
    attention.error = Object.assign(new Error("conflict"), {
      code: "ATTENTION_REQUEST_CONFLICT",
    });
    const { dispatcher, ledger } = fixture([pair], { attention });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.items[0].status, "blocked");
  });

  await t.test("attention capacity", async () => {
    const pair = workPair(3, askUserIntent());
    const attention = new FakeAttentionProducer();
    attention.error = Object.assign(new Error("full"), {
      code: "ATTENTION_CAPACITY_EXCEEDED",
    });
    const { dispatcher, ledger } = fixture([pair], { attention });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.retryWait, 1);
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.ackCalls[0].outcome, "failed");
    assert.ok(Date.parse(ledger.ackCalls[0].availableAt) > Date.parse(ledger.ackCalls[0].details.at ?? "2026-08-02T04:00:00.000Z"));
  });
});

test("handoff uses only the policy-mapped role and never exposes a half-handoff crash state", async (t) => {
  await t.test("write fails before the atomic acknowledgement", async () => {
    const pair = workPair(4, handoffIntent());
    const { dispatcher, ledger, time } = fixture([pair]);
    ledger.failAckBeforeOnce = true;

    const uncertain = await dispatcher.dispatchPending();
    assert.equal(uncertain.uncertain, 1);
    assert.equal(ledger.outbox[0].status, "dispatching");
    assert.equal(ledger.items[0].status, "dispatch_pending");
    assert.equal(ledger.items[0].currentTarget.id, "pr-reviewer");
    assert.deepEqual(ledger.ackCalls[0].target, {
      type: "role",
      id: "trusted-tester",
    });

    time.advance(1_000);
    const recovered = await dispatcher.dispatchPending();
    assert.equal(recovered.delivered, 1);
    assert.equal(ledger.outbox[0].status, "delivered");
    assert.equal(ledger.items[0].status, "queued");
    assert.equal(ledger.items[0].currentTarget.id, "trusted-tester");
  });

  await t.test("response is lost after the atomic acknowledgement", async () => {
    const pair = workPair(5, handoffIntent());
    const { dispatcher, ledger, time } = fixture([pair]);
    ledger.failAckAfterOnce = true;

    const uncertain = await dispatcher.dispatchPending();
    assert.equal(uncertain.uncertain, 1);
    assert.equal(ledger.outbox[0].status, "delivered");
    assert.equal(ledger.items[0].status, "queued");
    assert.equal(ledger.items[0].currentTarget.id, "trusted-tester");

    time.advance(1_000);
    const noReplay = await dispatcher.dispatchPending();
    assert.equal(noReplay.scanned, 0);
    assert.equal(ledger.ackCalls.length, 1);
  });
});

test("constructor and dispatch options reject incomplete ports and unsafe batch sizes", async () => {
  assert.throws(
    () => new WorkIntentDispatcher({ ledger: {}, policy: {}, attentionProducer: {} }),
    /ledger must provide/,
  );
  assert.throws(
    () =>
      new WorkIntentDispatcher({
        ledger: {
          listOutbox() {},
          listItems() {},
          claimIntent() {},
          ackIntent() {},
        },
        policy: { bind() {} },
        attentionProducer: { create() {} },
      }),
    /proposalProducer/,
  );
  const pair = workPair(1, waitIntent());
  const { dispatcher } = fixture([pair]);
  await assert.rejects(dispatcher.dispatchPending({ limit: 101 }), /limit/);
  await assert.rejects(dispatcher.dispatchPending({ limit: 1, extra: true }), /options/);
});

test("dispatcher binds policy and attention producer only from durable requestedBy", async () => {
  const pair = workPair(1, askUserIntent(), {
    target: { type: "person", id: "missing-owner" },
  });
  const contexts = [];
  const trustedPolicy = policy();
  const capturingPolicy = {
    async bind(input) {
      contexts.push(clone(input.context));
      return trustedPolicy.bind(input);
    },
  };
  const { dispatcher, attention } = fixture([pair], { policy: capturingPolicy });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(contexts[0].roleId, "orchestrator");
  assert.deepEqual(attention.calls[0].producer, {
    roleId: "orchestrator",
    workItemId: pair.item.itemId,
  });
});

test("dispatcher rejects accessor and sparse ledger pages without invoking getters", async (t) => {
  const cases = [
    {
      name: "accessor item",
      page() {
        let reads = 0;
        const items = [];
        Object.defineProperty(items, "0", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("must not execute");
          },
        });
        return { value: { items, nextCursor: null }, reads: () => reads };
      },
    },
    {
      name: "sparse item",
      page() {
        return {
          value: { items: new Array(1), nextCursor: null },
          reads: () => 0,
        };
      },
    },
    {
      name: "record accessor",
      page() {
        let reads = 0;
        const record = {};
        Object.defineProperty(record, "intentId", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("must not execute");
          },
        });
        return {
          value: { items: [record], nextCursor: null },
          reads: () => reads,
        };
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const malicious = entry.page();
      const ledger = {
        listOutbox: async () => malicious.value,
        listItems: async () => ({ items: [], nextCursor: null }),
        claimIntent: async () => {
          throw new Error("must not claim");
        },
        ackIntent: async () => {
          throw new Error("must not acknowledge");
        },
      };
      const { dispatcher } = fixture([], { ledger });

      await assert.rejects(
        dispatcher.dispatchPending(),
        (error) => error.code === "WORK_INTENT_LEDGER_QUERY_INVALID",
      );
      assert.equal(malicious.reads(), 0);
    });
  }
});
