import assert from "node:assert/strict";
import test from "node:test";
import { OwnerWorkRetryService } from "../src/services/owner-work-retry-service.js";

const ITEM_ID = "work-item-owner-retry";
const INPUT_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

function eligibleItem(overrides = {}) {
  const item = {
    itemId: ITEM_ID,
    kind: "source_root",
    inputDigest: INPUT_DIGEST,
    status: "blocked",
    statusReason: "decision_attempts_exhausted",
    revision: 7,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    activeIntentId: null,
    decisionContext: null,
    sourceQuarantine: null,
    attempt: 3,
    source: {
      kind: "pull_request",
      inputRevision: 4,
      activeRevision: 4,
      pendingRevision: null,
      pending: null,
      current: {
        eventId: "event-4",
        inputDigest: INPUT_DIGEST,
        event: { eventId: "event-4" },
      },
      bindings: [{ eventId: "event-4", inputRevision: 4 }],
    },
  };
  return structuredClone(Object.assign(item, overrides));
}

function queuedResult(item = eligibleItem(), overrides = {}) {
  return structuredClone(Object.assign(item, {
    status: "queued",
    statusReason: "owner_retry_decision_exhaustion",
    revision: item.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    activeIntentId: null,
    decisionContext: null,
  }, overrides));
}

function request(overrides = {}) {
  return {
    itemId: ITEM_ID,
    expectedRevision: 7,
    expectedInputDigest: INPUT_DIGEST,
    ...overrides,
  };
}

function fixture({ item = eligibleItem(), result } = {}) {
  const calls = { read: [], transition: [] };
  const ledger = {
    async readItemForReconciliation(input) {
      calls.read.push(structuredClone(input));
      return item === null ? null : structuredClone(item);
    },
    async transition(command) {
      calls.transition.push(structuredClone(command));
      return result === undefined
        ? queuedResult(item)
        : structuredClone(result);
    },
  };
  return {
    calls,
    service: new OwnerWorkRetryService({ ledger }),
  };
}

async function assertRejectedWithoutTransition(item, code = "OWNER_WORK_RETRY_INELIGIBLE") {
  const { calls, service } = fixture({ item });
  await assert.rejects(
    service.retryDecisionExhaustion(request()),
    (error) => error.code === code && error.statusCode >= 400,
  );
  assert.deepEqual(calls.read, [{ itemId: ITEM_ID }]);
  assert.equal(calls.transition.length, 0);
}

test("retries only the exact decision exhaustion and preserves attempts", async () => {
  const { calls, service } = fixture();

  const result = await service.retryDecisionExhaustion(request());

  assert.deepEqual(calls.read, [{ itemId: ITEM_ID }]);
  assert.deepEqual(calls.transition, [{
    itemId: ITEM_ID,
    expectedRevision: 7,
    leaseId: null,
    toStatus: "queued",
    actorId: "owner:local",
    reason: "owner_retry_decision_exhaustion",
    details: { code: "decision_attempts_exhausted" },
  }]);
  assert.equal(result.itemId, ITEM_ID);
  assert.equal(result.status, "queued");
  assert.equal(result.revision, 8);
  assert.equal(result.inputDigest, INPUT_DIGEST);
  assert.equal(result.attempt, 3);
});

test("requires exactly the two-method ledger dependency", () => {
  const readItemForReconciliation = async () => null;
  const transition = async () => null;
  assert.throws(() => new OwnerWorkRetryService(), TypeError);
  assert.throws(
    () => new OwnerWorkRetryService({ ledger: { readItemForReconciliation } }),
    TypeError,
  );
  assert.throws(
    () => new OwnerWorkRetryService({ ledger: { transition } }),
    TypeError,
  );
  assert.doesNotThrow(
    () => new OwnerWorkRetryService({ ledger: {
      readItemForReconciliation,
      transition,
      genericMutation: () => assert.fail("broader authority was used"),
    } }),
  );
});

test("rejects malformed, accessor, proxy, and custom-prototype input before ledger I/O", async () => {
  const accessor = request();
  Object.defineProperty(accessor, "itemId", {
    enumerable: true,
    get() {
      assert.fail("input accessor must not run");
    },
  });
  const customPrototype = Object.assign(Object.create({ inherited: true }), request());
  const proxy = new Proxy(request(), {});
  const invalidInputs = [
    null,
    {},
    { ...request(), extra: true },
    { ...request(), itemId: "" },
    { ...request(), itemId: "x".repeat(193) },
    { ...request(), expectedRevision: 0 },
    { ...request(), expectedRevision: 1.5 },
    { ...request(), expectedInputDigest: INPUT_DIGEST.toUpperCase() },
    { ...request(), expectedInputDigest: "a".repeat(63) },
    accessor,
    customPrototype,
    proxy,
  ];

  for (const input of invalidInputs) {
    const { calls, service } = fixture();
    await assert.rejects(
      service.retryDecisionExhaustion(input),
      (error) => error.code === "OWNER_WORK_RETRY_INVALID" && error.statusCode === 400,
    );
    assert.equal(calls.read.length, 0);
    assert.equal(calls.transition.length, 0);
  }
});

test("rejects not-found and stale item bindings without transition", async () => {
  await assertRejectedWithoutTransition(null, "OWNER_WORK_RETRY_NOT_FOUND");
  await assertRejectedWithoutTransition(
    eligibleItem({ revision: 8 }),
    "OWNER_WORK_RETRY_STALE",
  );
  await assertRejectedWithoutTransition(
    eligibleItem({ inputDigest: OTHER_DIGEST }),
    "OWNER_WORK_RETRY_STALE",
  );
});

test("rejects every unsafe state and failure reason without transition", async () => {
  const unsafe = [
    { status: "queued" },
    { status: "working" },
    { status: "retry_wait" },
    { statusReason: null },
    { statusReason: "decision_failed" },
    { statusReason: "delivery_failed" },
    { statusReason: "delivery_attempts_exhausted" },
    { statusReason: "intent_failed" },
    { statusReason: "proposal_failed" },
    { statusReason: "external_action_failed" },
    { ownerId: "employee-pr-engineer" },
    { leaseId: "lease-1" },
    { leaseUntil: "2026-08-02T02:00:00.000Z" },
    { activeIntentId: "intent-1" },
    { decisionContext: { source: "proposal", outcome: "failed" } },
    { sourceQuarantine: { reason: "legacy_pr_source_cutover_required" } },
  ];

  for (const overrides of unsafe) {
    await assertRejectedWithoutTransition(eligibleItem(overrides));
  }
});

test("rejects every unsafe source invariant without transition", async () => {
  const sourceCases = [
    { kind: "assignment" },
    { source: null },
    { source: { ...eligibleItem().source, kind: "issue" } },
    { source: { ...eligibleItem().source, pendingRevision: 5 } },
    { source: { ...eligibleItem().source, pending: { eventId: "event-5" } } },
    { source: { ...eligibleItem().source, activeRevision: 3 } },
    {
      source: {
        ...eligibleItem().source,
        current: { ...eligibleItem().source.current, inputDigest: OTHER_DIGEST },
      },
    },
    { source: { ...eligibleItem().source, current: null } },
    {
      source: {
        ...eligibleItem().source,
        current: { ...eligibleItem().source.current, event: null },
      },
    },
    { source: { ...eligibleItem().source, bindings: [] } },
    {
      source: {
        ...eligibleItem().source,
        bindings: [{ eventId: "foreign-event", inputRevision: 4 }],
      },
    },
  ];

  for (const overrides of sourceCases) {
    await assertRejectedWithoutTransition(eligibleItem(overrides));
  }
});

test("fails closed when transition returns an unbound or mutated result", async () => {
  const invalidResults = [
    null,
    queuedResult(eligibleItem(), { itemId: "work-item-other" }),
    queuedResult(eligibleItem(), { inputDigest: OTHER_DIGEST }),
    queuedResult(eligibleItem(), { status: "blocked" }),
    queuedResult(eligibleItem(), { revision: 7 }),
    queuedResult(eligibleItem(), { revision: 9 }),
    queuedResult(eligibleItem(), { ownerId: "employee-pr-engineer" }),
    queuedResult(eligibleItem(), { leaseId: "lease-1" }),
    queuedResult(eligibleItem(), { leaseUntil: "2026-08-02T02:00:00.000Z" }),
    queuedResult(eligibleItem(), { activeIntentId: "intent-1" }),
    queuedResult(eligibleItem(), { decisionContext: {} }),
    queuedResult(eligibleItem(), { attempt: 4 }),
  ];

  for (const result of invalidResults) {
    const { calls, service } = fixture({ result });
    await assert.rejects(
      service.retryDecisionExhaustion(request()),
      (error) =>
        error.code === "OWNER_WORK_RETRY_RESULT_INVALID" &&
        error.statusCode === 500,
    );
    assert.equal(calls.transition.length, 1);
  }
});
