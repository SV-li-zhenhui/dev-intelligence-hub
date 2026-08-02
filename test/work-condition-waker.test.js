import assert from "node:assert/strict";
import test from "node:test";
import { WorkConditionWaker } from "../src/services/work-condition-waker.js";

function clone(value) {
  return structuredClone(value);
}

function waitingPair(condition, index = 1) {
  const itemId = `work-item-${index}`;
  const intentId = `work-intent-${index}`;
  return {
    item: {
      itemId,
      status: "waiting_condition",
      revision: 4,
      activeIntentId: intentId,
      decisionContext: null,
      ownerId: null,
      leaseId: null,
      leaseUntil: null,
    },
    outbox: {
      intentId,
      itemId,
      status: "delivered",
      intent: {
        schemaVersion: 1,
        type: "wait_condition",
        summary: "等待事实",
        reason: "满足后重试",
        condition: clone(condition),
        checkAfterSeconds: 60,
      },
    },
  };
}

class FakeLedger {
  constructor(pairs) {
    this.items = pairs.map(({ item }) => clone(item));
    this.outbox = pairs.map(({ outbox }) => clone(outbox));
    this.wakeCalls = [];
  }

  async listItems(options) {
    return {
      items: this.items.filter(({ status }) => status === options.status).map(clone),
      nextCursor: null,
    };
  }

  async listOutbox(options) {
    return {
      items: this.outbox.filter(({ status }) => status === options.status).map(clone),
      nextCursor: null,
    };
  }

  async wakeCondition(input) {
    this.wakeCalls.push(clone(input));
    const item = this.items.find(({ itemId }) => itemId === input.itemId);
    item.status = "queued";
    item.revision += 1;
    item.activeIntentId = null;
    return clone(item);
  }
}

test("time conditions wake only at the exact durable notBefore boundary", async () => {
  let now = Date.parse("2026-08-02T01:59:59.999Z");
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  const ledger = new FakeLedger([pair]);
  const waker = new WorkConditionWaker({
    ledger,
    clock: () => new Date(now).toISOString(),
  });

  const early = await waker.runCycle();
  assert.equal(early.woken, 0);
  assert.equal(ledger.wakeCalls.length, 0);

  now += 1;
  const due = await waker.runCycle();
  assert.equal(due.woken, 1);
  assert.deepEqual(ledger.wakeCalls[0].observation, {
    kind: "time",
    observedAt: "2026-08-02T02:00:00.000Z",
  });
});

test("workflow facts require healthy, fresh, and oneOf while exposing no lease token", async () => {
  const pair = waitingPair({
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const ledger = new FakeLedger([pair]);
  const responses = [
    { healthy: false, fresh: true, value: "success", observedAt: null },
    {
      healthy: true,
      fresh: false,
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
    {
      healthy: true,
      fresh: true,
      value: "failure",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
    {
      healthy: true,
      fresh: true,
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
  ];
  const factCalls = [];
  const factSource = {
    async read(input) {
      factCalls.push(input);
      return responses.shift();
    },
  };
  const waker = new WorkConditionWaker({
    ledger,
    factSource,
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 1);

  assert.equal(factCalls.every(({ fact }) => fact === "ci-status"), true);
  assert.equal(
    factCalls.every(({ item }) =>
      !Object.hasOwn(item, "ownerId") &&
      !Object.hasOwn(item, "leaseId") &&
      !Object.hasOwn(item, "leaseUntil")),
    true,
  );
  assert.deepEqual(ledger.wakeCalls[0].observation, {
    kind: "workflow_fact",
    fact: "ci-status",
    value: "success",
    observedAt: "2026-08-02T02:00:00.000Z",
  });
});

test("invalid fact observations and missing fact sources keep work waiting", async () => {
  const pair = waitingPair({
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const ledger = new FakeLedger([pair]);
  const invalid = {};
  Object.defineProperty(invalid, "healthy", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const waker = new WorkConditionWaker({
    ledger,
    factSource: { read: async () => invalid },
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  assert.equal((await waker.runCycle()).waiting, 1);
  assert.equal(ledger.wakeCalls.length, 0);

  const withoutSource = new WorkConditionWaker({
    ledger,
    clock: () => "2026-08-02T02:00:00.000Z",
  });
  assert.equal((await withoutSource.runCycle()).waiting, 1);
  assert.equal(ledger.wakeCalls.length, 0);
});
