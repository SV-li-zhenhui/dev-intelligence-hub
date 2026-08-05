import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfigurationActivationConfirmationPlan,
} from "../src/domain/configuration-activation-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import {
  ConfigurationActivationExecutor,
} from "../src/services/configuration-activation-executor.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const DRAFT_REVISION_ID = `configuration-draft-revision-${E}`;
const ACTIVATED_AT = "2026-08-05T01:03:04.000Z";

function prepared(kind = "configuration.initialize") {
  const common = {
    kind,
    expectedStateRevision: 4,
    expectedActiveVersion: null,
    activeDigest: null,
    documentDigest: B,
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
  if (kind === "configuration.initialize") {
    return {
      ...common,
      baselineDigest: A,
      draftId: "draft-1",
      draftRevision: 2,
      draftRevisionId: DRAFT_REVISION_ID,
    };
  }
  if (kind === "configuration.activate") {
    return {
      ...common,
      expectedActiveVersion: 3,
      activeDigest: A,
      draftId: "draft-1",
      draftRevision: 2,
      draftRevisionId: DRAFT_REVISION_ID,
    };
  }
  return {
    ...common,
    expectedActiveVersion: 3,
    activeDigest: A,
    targetVersion: 1,
    targetDigest: E,
    documentDigest: E,
  };
}

function privateEnvelope(kind = "configuration.initialize") {
  const plan = normalizeConfirmationPlan(
    createConfigurationActivationConfirmationPlan(prepared(kind)),
  );
  return {
    schemaVersion: 1,
    id: plan.id,
    idempotencyKey: `confirmation-${plan.approvalBindingDigest}`,
    kind: plan.kind,
    requestedBy: plan.requestedBy,
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
    displayedPayloadDigest: plan.displayedPayloadDigest,
    approvalBindingDigest: plan.approvalBindingDigest,
    execution: {
      requestId: "configuration-request-1",
      attempt: 1,
      startedAt: "2026-08-05T01:02:03.000Z",
    },
  };
}

function versionFor(envelope) {
  const action = envelope.action;
  return {
    version: action.expectedActiveVersion === null
      ? 1
      : action.expectedActiveVersion + 1,
    configurationDigest: action.documentDigest,
    configuration: {},
    source: {
      initialize_from_draft: "initialization",
      activate_draft: "draft",
      activate_rollback: "rollback",
    }[action.type],
    previousVersion: action.expectedActiveVersion,
    draftRevisionId:
      action.type === "activate_rollback" ? null : action.draftRevisionId,
    rollbackOf:
      action.type === "activate_rollback" ? action.targetVersion : null,
    activatedBy: "owner:local",
    activatedAt: ACTIVATED_AT,
    impactDigest: action.impactDigest,
  };
}

function fixture({ snapshot, activation, allowedActionTypes } = {}) {
  const calls = [];
  const activationExecutor = {
    async activateInitialization(value) {
      calls.push({ method: "activateInitialization", value });
      return activation?.(value) ?? {
        applied: true,
        active: versionFor(privateEnvelope()),
      };
    },
    async activateDraft(value) {
      calls.push({ method: "activateDraft", value });
      return activation(value);
    },
    async activateRollback(value) {
      calls.push({ method: "activateRollback", value });
      return activation(value);
    },
  };
  const reader = {
    async readSnapshot() {
      calls.push({ method: "readSnapshot" });
      return snapshot?.() ?? {
        revision: 4,
        activeVersion: null,
        versions: [],
      };
    },
  };
  return {
    calls,
    executor: new ConfigurationActivationExecutor({
      activationExecutor,
      configurationReader: reader,
      ...(allowedActionTypes === undefined ? {} : { allowedActionTypes }),
    }),
  };
}

test("execute injects the trusted owner and returns a bound receipt", async () => {
  const envelope = privateEnvelope();
  const expectedVersion = versionFor(envelope);
  const context = fixture({
    activation: () => ({ applied: true, active: expectedVersion }),
  });
  const result = await context.executor.execute(envelope);

  assert.equal(result.status, "applied");
  assert.match(result.receipt.id, /^configuration-activation-[a-f0-9]{64}$/);
  assert.equal(result.receipt.createdAt, ACTIVATED_AT);
  assert.deepEqual(context.calls[0], {
    method: "activateInitialization",
    value: {
      kind: "configuration.initialize",
      expectedStateRevision: 4,
      expectedActiveVersion: null,
      activeDigest: null,
      baselineDigest: A,
      draftId: "draft-1",
      draftRevision: 2,
      draftRevisionId: DRAFT_REVISION_ID,
      documentDigest: B,
      validationDigest: C,
      impactDigest: D,
      activatedBy: "owner:local",
    },
  });
});

test("execute dispatches draft activation and rollback through their private ports", async () => {
  for (const [kind, method] of [
    ["configuration.activate", "activateDraft"],
    ["configuration.rollback", "activateRollback"],
  ]) {
    const envelope = privateEnvelope(kind);
    const context = fixture({
      activation: () => ({ applied: true, active: versionFor(envelope) }),
    });

    assert.equal((await context.executor.execute(envelope)).status, "applied");
    assert.equal(context.calls[0].method, method);
    assert.equal(context.calls[0].value.activatedBy, "owner:local");
    assert.equal(context.calls[0].value.kind, kind);
    if (kind === "configuration.activate") {
      assert.equal(context.calls[0].value.draftRevisionId, DRAFT_REVISION_ID);
      assert.equal("targetVersion" in context.calls[0].value, false);
    } else {
      assert.equal(context.calls[0].value.targetVersion, 1);
      assert.equal("draftRevisionId" in context.calls[0].value, false);
    }
  }
});

test("runtime policy can fence actions whose live configuration is stale", async () => {
  const context = fixture({
    allowedActionTypes: ["initialize_from_draft"],
    activation: () => {
      throw new Error("must not activate a normal draft in this process");
    },
    snapshot: () => ({
      revision: 4,
      activeVersion: 3,
      versions: [{}, {}, {}],
    }),
  });
  const envelope = privateEnvelope("configuration.activate");

  assert.equal(
    (await context.executor.execute(envelope)).status,
    "stale",
  );
  assert.deepEqual(context.calls, []);
  assert.equal((await context.executor.reconcile(envelope)).status, "absent");
  assert.deepEqual(context.calls.map(({ method }) => method), ["readSnapshot"]);
});

test("reconcile is read-only and distinguishes already, absent, stale, and unknown", async (t) => {
  const envelope = privateEnvelope("configuration.activate");
  await t.test("already", async () => {
    const context = fixture({
      snapshot: () => ({
        revision: 5,
        activeVersion: 4,
        versions: [{}, {}, {}, versionFor(envelope)],
      }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "already");
    assert.deepEqual(context.calls.map(({ method }) => method), ["readSnapshot"]);
  });
  await t.test("absent", async () => {
    const context = fixture({
      snapshot: () => ({ revision: 4, activeVersion: 3, versions: [{}, {}, {}] }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "absent");
  });
  await t.test("stale", async () => {
    const context = fixture({
      snapshot: () => ({ revision: 5, activeVersion: 3, versions: [{}, {}, {}] }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "stale");
  });
  await t.test("unknown", async () => {
    const context = fixture({
      snapshot: () => {
        throw new Error("reader unavailable");
      },
    });
    assert.equal(
      (await context.executor.reconcile(envelope)).error.trust,
      "unknown",
    );
  });
});

test("an acknowledgement loss reconciles instead of activating twice", async () => {
  const envelope = privateEnvelope();
  const matching = versionFor(envelope);
  const context = fixture({
    activation: () => {
      throw Object.assign(new Error("ack lost"), {
        code: "CONFIGURATION_STATE_WRITE_FAILED",
      });
    },
    snapshot: () => ({ revision: 5, activeVersion: 1, versions: [matching] }),
  });
  assert.equal((await context.executor.execute(envelope)).status, "already");
  assert.deepEqual(context.calls.map(({ method }) => method), [
    "activateInitialization",
    "readSnapshot",
  ]);
});

test("forged envelopes fail closed before activation or reads", async () => {
  const context = fixture();
  const forged = privateEnvelope();
  forged.action.documentDigest = E;
  const result = await context.executor.execute(forged);
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "INVALID_CONFIGURATION_ACTIVATION_APPROVAL");
  assert.equal(context.calls.length, 0);
});
