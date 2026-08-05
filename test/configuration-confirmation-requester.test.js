import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationConfirmationRequester,
} from "../src/services/configuration-confirmation-requester.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

function prepared(kind = "configuration.initialize") {
  const common = {
    kind,
    expectedStateRevision: 1,
    expectedActiveVersion: kind === "configuration.initialize" ? null : 2,
    activeDigest: kind === "configuration.initialize" ? null : A,
    documentDigest: kind === "configuration.rollback" ? E : B,
    validationDigest: C,
    impactDigest: D,
    impact: {
      changed: true,
      beforeDigest: A,
      afterDigest: B,
      security_tightening: [],
      authority_expansion: ["trackedRepositories"],
      benign_claim_change: [],
      restart_required: [],
    },
  };
  if (kind === "configuration.rollback") {
    return {
      ...common,
      targetVersion: 1,
      targetDigest: E,
    };
  }
  return {
    ...common,
    ...(kind === "configuration.initialize" ? { baselineDigest: A } : {}),
    draftId: "draft-1",
    draftRevision: 1,
    draftRevisionId: `configuration-draft-revision-${E}`,
  };
}

test("requester prepares and enqueues but never receives activation authority", async () => {
  const calls = [];
  const requester = new ConfigurationConfirmationRequester({
    simulator: {
      async prepareInitialization(value) {
        calls.push({ method: "prepareInitialization", value });
        return prepared();
      },
      async prepareDraftActivation(value) {
        calls.push({ method: "prepareDraftActivation", value });
        return prepared("configuration.activate");
      },
      async prepareRollback(value) {
        calls.push({ method: "prepareRollback", value });
        return prepared("configuration.rollback");
      },
    },
    confirmationProducer: {
      async enqueue(plan) {
        calls.push({ method: "enqueue", plan });
        return { id: plan.id, status: "pending" };
      },
    },
  });

  const result = await requester.requestInitialization({
    draftId: "draft-1",
    draftRevision: 1,
    expectedStateRevision: 1,
  });
  assert.equal(result.status, "pending");
  assert.deepEqual(calls[0], {
    method: "prepareInitialization",
    value: {
      draftId: "draft-1",
      draftRevision: 1,
      expectedStateRevision: 1,
    },
  });
  assert.equal(calls[1].plan.action.type, "initialize_from_draft");
  assert.equal("activateInitialization" in requester, false);
  assert.equal(Object.isFrozen(requester), true);
});

test("requester routes draft activation and rollback through the same queue", async () => {
  const calls = [];
  const requester = new ConfigurationConfirmationRequester({
    simulator: {
      async prepareInitialization() {
        throw new Error("unexpected initialization");
      },
      async prepareDraftActivation(value) {
        calls.push({ method: "prepareDraftActivation", value });
        return prepared("configuration.activate");
      },
      async prepareRollback(value) {
        calls.push({ method: "prepareRollback", value });
        return prepared("configuration.rollback");
      },
    },
    confirmationProducer: {
      async enqueue(plan) {
        calls.push({ method: "enqueue", actionType: plan.action.type });
        return { id: plan.id, status: "pending" };
      },
    },
  });

  await requester.requestDraftActivation({
    draftId: "draft-1",
    draftRevision: 1,
    expectedStateRevision: 1,
    expectedActiveVersion: 2,
  });
  await requester.requestRollback({
    targetVersion: 1,
    expectedStateRevision: 1,
    expectedActiveVersion: 2,
  });

  assert.deepEqual(calls.map(({ method }) => method), [
    "prepareDraftActivation",
    "enqueue",
    "prepareRollback",
    "enqueue",
  ]);
  assert.deepEqual(
    calls
      .filter(({ method }) => method === "enqueue")
      .map(({ actionType }) => actionType),
    ["activate_draft", "activate_rollback"],
  );
});

test("request DTOs reject extra fields and accessors before simulator use", async () => {
  let simulatorCalls = 0;
  const requester = new ConfigurationConfirmationRequester({
    simulator: {
      prepareInitialization() {
        simulatorCalls += 1;
      },
      prepareDraftActivation() {
        simulatorCalls += 1;
      },
      prepareRollback() {
        simulatorCalls += 1;
      },
    },
    confirmationProducer: { enqueue() {} },
  });
  await assert.rejects(
    requester.requestInitialization({
      draftId: "draft-1",
      draftRevision: 1,
      expectedStateRevision: 1,
      activatedBy: "employee:developer",
    }),
    TypeError,
  );
  const hostile = {
    draftId: "draft-1",
    draftRevision: 1,
    expectedStateRevision: 1,
  };
  let reads = 0;
  Object.defineProperty(hostile, "draftId", {
    enumerable: true,
    get() {
      reads += 1;
      return "draft-1";
    },
  });
  await assert.rejects(requester.requestInitialization(hostile), TypeError);
  assert.equal(reads, 0);
  assert.equal(simulatorCalls, 0);
});
