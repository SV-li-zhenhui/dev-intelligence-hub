import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfigurationActivationConfirmationPlan,
} from "../src/domain/configuration-activation-confirmation.js";
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

test("proposal activation recovers one deterministic confirmation after enqueue acknowledgement loss", async () => {
  const calls = [];
  let queued = null;
  const simulator = {
    async prepareInitialization() { return prepared(); },
    async prepareDraftActivation(value) {
      calls.push({ method: "strict", value });
      return prepared("configuration.activate");
    },
    async prepareProposalDraftActivation(value) {
      calls.push({ method: "recover", value });
      return {
        prepared: prepared("configuration.activate"),
        current: true,
      };
    },
    async prepareRollback() { return prepared("configuration.rollback"); },
  };
  const confirmationProducer = {
    async get(id) {
      calls.push({ method: "get", id });
      if (queued) return queued;
      throw Object.assign(new Error("missing"), {
        code: "CONFIRMATION_NOT_FOUND",
      });
    },
    async enqueue(plan) {
      calls.push({ method: "enqueue", id: plan.id });
      queued = { id: plan.id, status: "pending" };
      return queued;
    },
    async invalidate() {
      throw new Error("must not invalidate current confirmation");
    },
  };
  const requester = new ConfigurationConfirmationRequester({
    simulator,
    confirmationProducer,
  });
  const request = {
    proposalId: "work-intent-configuration-change-1",
    proposalContentDigest: "a".repeat(64),
  };

  const first = await requester.requestProposalDraftActivation(request);
  const duplicate = await requester.requestProposalDraftActivation(request);

  assert.deepEqual(duplicate, first);
  assert.equal(calls.filter(({ method }) => method === "enqueue").length, 1);
  assert.equal(calls.filter(({ method }) => method === "strict").length, 1);
  assert.equal(calls.filter(({ method }) => method === "recover").length, 2);
});

test("proposal activation never creates a new confirmation from stale authority", async () => {
  let enqueueCalls = 0;
  const requester = new ConfigurationConfirmationRequester({
    simulator: {
      async prepareInitialization() { return prepared(); },
      async prepareDraftActivation() { throw new Error("must not run"); },
      async prepareProposalDraftActivation() {
        return {
          prepared: prepared("configuration.activate"),
          current: false,
        };
      },
      async prepareRollback() { return prepared("configuration.rollback"); },
    },
    confirmationProducer: {
      async get() {
        throw Object.assign(new Error("missing"), {
          code: "CONFIRMATION_NOT_FOUND",
        });
      },
      async enqueue() {
        enqueueCalls += 1;
      },
      async invalidate() {
        throw new Error("must not invalidate a missing confirmation");
      },
    },
  });

  await assert.rejects(
    requester.requestProposalDraftActivation({
      proposalId: "work-intent-configuration-change-1",
      proposalContentDigest: "b".repeat(64),
    }),
    (error) => error?.code === "CONFIGURATION_PROPOSAL_STALE",
  );
  assert.equal(enqueueCalls, 0);
});

test("proposal activation invalidates a pending confirmation after authority changes", async () => {
  const plan = createConfigurationActivationConfirmationPlan(
    prepared("configuration.activate"),
  );
  let invalidation = null;
  const requester = new ConfigurationConfirmationRequester({
    simulator: {
      async prepareInitialization() { return prepared(); },
      async prepareDraftActivation() { throw new Error("must not run"); },
      async prepareProposalDraftActivation() {
        return {
          prepared: prepared("configuration.activate"),
          current: false,
        };
      },
      async prepareRollback() { return prepared("configuration.rollback"); },
    },
    confirmationProducer: {
      async get() {
        return {
          id: plan.id,
          status: "pending",
          retryable: false,
          approvalBindingDigest: "c".repeat(64),
        };
      },
      async enqueue() { throw new Error("must not enqueue"); },
      async invalidate(id, request) {
        invalidation = { id, request };
        return { id, status: "stale", retryable: false };
      },
    },
  });

  const result = await requester.requestProposalDraftActivation({
    proposalId: "work-intent-configuration-change-1",
    proposalContentDigest: "d".repeat(64),
  });
  assert.equal(result.status, "stale");
  assert.deepEqual(invalidation, {
    id: plan.id,
    request: {
      requestedBy: plan.requestedBy,
      approvalBindingDigest: "c".repeat(64),
      reason: "configuration_authority_changed",
    },
  });
});
