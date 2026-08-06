import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfigurationActivationConfirmationPlan,
} from "../src/domain/configuration-activation-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
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

function activeRecord(version, configurationDigest) {
  return { version, configurationDigest };
}

function reconciliationProjection(state, version) {
  const projectActive = (value) =>
    value === null || value === undefined
      ? null
      : {
          version: value.version,
          configurationDigest: value.configurationDigest,
        };
  const projectObserved = (value) =>
    value === null || value === undefined
      ? null
      : {
          version: value.version,
          configurationDigest: value.configurationDigest,
          source: value.source,
          previousVersion: value.previousVersion,
          draftRevisionId: value.draftRevisionId,
          rollbackOf: value.rollbackOf,
          activatedBy: value.activatedBy,
          activatedAt: value.activatedAt,
          impactDigest: value.impactDigest,
        };
  return {
    revision: state.revision,
    activeVersion: state.activeVersion,
    active: projectActive(
      state.activeVersion === null
        ? null
        : state.versions[state.activeVersion - 1],
    ),
    observedVersion: projectObserved(state.versions[version - 1]),
  };
}

function fixture({
  snapshot,
  activation,
  allowedActionTypes,
  runtimeEffective = null,
} = {}) {
  const calls = [];
  const actionAdmissionGate = new ActionAdmissionGate();
  actionAdmissionGate.bindEffective(runtimeEffective);
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
    async readActivationReconciliationSnapshot(value) {
      calls.push({
        method: "readActivationReconciliationSnapshot",
        value,
      });
      const state = snapshot?.() ?? {
        revision: 4,
        activeVersion: null,
        versions: [],
      };
      return reconciliationProjection(state, value.version);
    },
  };
  return {
    calls,
    executor: new ConfigurationActivationExecutor({
      activationExecutor,
      configurationReader: reader,
      actionAdmissionGate,
      ...(allowedActionTypes === undefined ? {} : { allowedActionTypes }),
    }),
    actionAdmissionGate,
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
      runtimeEffective: { version: 3, configurationDigest: A },
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
    runtimeEffective: { version: 3, configurationDigest: A },
    allowedActionTypes: ["initialize_from_draft"],
    activation: () => {
      throw new Error("must not activate a normal draft in this process");
    },
    snapshot: () => ({
      revision: 4,
      activeVersion: 3,
      versions: [{}, {}, activeRecord(3, A)],
    }),
  });
  const envelope = privateEnvelope("configuration.activate");

  assert.equal(
    (await context.executor.execute(envelope)).status,
    "stale",
  );
  assert.deepEqual(context.calls, []);
  assert.equal((await context.executor.reconcile(envelope)).status, "absent");
  assert.deepEqual(context.calls.map(({ method }) => method), [
    "readActivationReconciliationSnapshot",
  ]);
});

test("reconcile is read-only and distinguishes already, absent, stale, and unknown", async (t) => {
  const envelope = privateEnvelope("configuration.activate");
  await t.test("already", async () => {
    const context = fixture({
      runtimeEffective: { version: 3, configurationDigest: A },
      snapshot: () => ({
        revision: 5,
        activeVersion: 4,
        versions: [{}, {}, {}, versionFor(envelope)],
      }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "already");
    assert.deepEqual(context.calls.map(({ method }) => method), [
      "readActivationReconciliationSnapshot",
    ]);
  });
  await t.test("absent", async () => {
    const context = fixture({
      runtimeEffective: { version: 3, configurationDigest: A },
      snapshot: () => ({
        revision: 4,
        activeVersion: 3,
        versions: [{}, {}, activeRecord(3, A)],
      }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "absent");
  });
  await t.test("stale", async () => {
    const context = fixture({
      runtimeEffective: { version: 3, configurationDigest: A },
      snapshot: () => ({
        revision: 5,
        activeVersion: 3,
        versions: [{}, {}, activeRecord(3, A)],
      }),
    });
    assert.equal((await context.executor.reconcile(envelope)).status, "stale");
  });
  await t.test("unknown", async () => {
    const context = fixture({
      runtimeEffective: { version: 3, configurationDigest: A },
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

test("acknowledgement loss reconciles every activation kind without replay", async () => {
  for (const [kind, method] of [
    ["configuration.initialize", "activateInitialization"],
    ["configuration.activate", "activateDraft"],
    ["configuration.rollback", "activateRollback"],
  ]) {
    const envelope = privateEnvelope(kind);
    const matching = versionFor(envelope);
    const context = fixture({
      runtimeEffective: kind === "configuration.initialize"
        ? null
        : { version: 3, configurationDigest: A },
      activation: () => {
        throw Object.assign(new Error("ack lost"), {
          code: "CONFIGURATION_STATE_WRITE_FAILED",
        });
      },
      snapshot: () => ({
        revision: 5,
        activeVersion: matching.version,
        versions: matching.version === 1
          ? [matching]
          : [{}, {}, activeRecord(3, A), matching],
      }),
    });

    assert.equal((await context.executor.execute(envelope)).status, "already");
    assert.deepEqual(context.calls.map(({ method: name }) => name), [
      method,
      "readActivationReconciliationSnapshot",
    ]);
    assert.equal(
      context.actionAdmissionGate.readStatus().mode,
      "restart_required",
    );
  }
});

test("a successful activation closes later admission against the old runtime", async () => {
  const envelope = privateEnvelope("configuration.activate");
  const context = fixture({
    runtimeEffective: { version: 3, configurationDigest: A },
    activation: () => ({ applied: true, active: versionFor(envelope) }),
  });
  let laterCalls = 0;

  assert.equal((await context.executor.execute(envelope)).status, "applied");
  await assert.rejects(
    context.actionAdmissionGate.run(() => {
      laterCalls += 1;
    }),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(laterCalls, 0);
  assert.deepEqual(context.actionAdmissionGate.readStatus(), {
    mode: "restart_required",
    storedActive: { version: 4, configurationDigest: B },
    runtimeEffective: { version: 3, configurationDigest: A },
  });
});

test("proven absence reopens the runtime but an unknown result keeps it fenced", async () => {
  const envelope = privateEnvelope("configuration.activate");
  const runtimeEffective = { version: 3, configurationDigest: A };
  const absentContext = fixture({
    runtimeEffective,
    activation: () => {
      throw new Error("not written");
    },
    snapshot: () => ({
      revision: 4,
      activeVersion: 3,
      versions: [{}, {}, activeRecord(3, A)],
    }),
  });

  assert.equal((await absentContext.executor.execute(envelope)).status, "absent");
  assert.equal(absentContext.actionAdmissionGate.readStatus().mode, "ready");
  assert.equal(
    await absentContext.actionAdmissionGate.run(() => "admitted"),
    "admitted",
  );

  const unknownContext = fixture({
    runtimeEffective,
    activation: () => {
      throw new Error("write acknowledgement lost");
    },
    snapshot: () => {
      throw new Error("reader unavailable");
    },
  });
  assert.equal(
    (await unknownContext.executor.execute(envelope)).error.trust,
    "unknown",
  );
  assert.equal(unknownContext.actionAdmissionGate.readStatus().mode, "unknown");
});

test("same-process reconciliation remains available after activation", async () => {
  const envelope = privateEnvelope("configuration.activate");
  const matching = versionFor(envelope);
  const context = fixture({
    runtimeEffective: { version: 3, configurationDigest: A },
    activation: () => ({ applied: true, active: matching }),
    snapshot: () => ({
      revision: 5,
      activeVersion: 4,
      versions: [{}, {}, activeRecord(3, A), matching],
    }),
  });

  assert.equal((await context.executor.execute(envelope)).status, "applied");
  assert.equal(context.actionAdmissionGate.readStatus().mode, "restart_required");
  assert.equal((await context.executor.reconcile(envelope)).status, "already");
  assert.equal(context.actionAdmissionGate.readStatus().mode, "restart_required");
});

test("corrupt active evidence never reopens admission", async () => {
  const envelope = privateEnvelope("configuration.activate");
  for (const active of [
    {},
    activeRecord(2, A),
    activeRecord(3, C),
  ]) {
    const context = fixture({
      runtimeEffective: { version: 3, configurationDigest: A },
      activation: () => {
        throw new Error("activation acknowledgement unavailable");
      },
      snapshot: () => ({
        revision: 4,
        activeVersion: 3,
        versions: [{}, {}, active],
      }),
    });

    assert.equal((await context.executor.execute(envelope)).status, "absent");
    assert.equal(context.actionAdmissionGate.readStatus().mode, "unknown");
    await assert.rejects(
      context.actionAdmissionGate.run(() => "must-not-run"),
      (error) => error?.code === "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
    );
  }
});

test("same-process reconciliation resolves an uncertain activation", async (t) => {
  const envelope = privateEnvelope("configuration.activate");
  const runtimeEffective = { version: 3, configurationDigest: A };

  await t.test("proven absent restores ready admission", async () => {
    let reads = 0;
    const context = fixture({
      runtimeEffective,
      activation: () => {
        throw new Error("activation acknowledgement unavailable");
      },
      snapshot: () => {
        reads += 1;
        if (reads === 1) throw new Error("reader unavailable");
        return {
          revision: 4,
          activeVersion: 3,
          versions: [{}, {}, activeRecord(3, A)],
        };
      },
    });

    assert.equal(
      (await context.executor.execute(envelope)).error.trust,
      "unknown",
    );
    assert.equal(context.actionAdmissionGate.readStatus().mode, "unknown");
    assert.equal((await context.executor.reconcile(envelope)).status, "absent");
    assert.equal(context.actionAdmissionGate.readStatus().mode, "ready");
  });

  await t.test("proven applied requires restart", async () => {
    let reads = 0;
    const matching = versionFor(envelope);
    const context = fixture({
      runtimeEffective,
      activation: () => {
        throw new Error("activation acknowledgement unavailable");
      },
      snapshot: () => {
        reads += 1;
        if (reads === 1) throw new Error("reader unavailable");
        return {
          revision: 5,
          activeVersion: 4,
          versions: [{}, {}, activeRecord(3, A), matching],
        };
      },
    });

    assert.equal(
      (await context.executor.execute(envelope)).error.trust,
      "unknown",
    );
    assert.equal((await context.executor.reconcile(envelope)).status, "already");
    assert.equal(context.actionAdmissionGate.readStatus().mode, "restart_required");
  });
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

test("executor rejects a full-state reader and binds only reconciliation evidence", async () => {
  const activationExecutor = {
    async activateInitialization() {},
    async activateDraft() {},
    async activateRollback() {},
  };
  const actionAdmissionGate = new ActionAdmissionGate();
  actionAdmissionGate.bindEffective(null);

  assert.throws(
    () =>
      new ConfigurationActivationExecutor({
        activationExecutor,
        configurationReader: { async readSnapshot() {} },
        actionAdmissionGate,
      }),
    /configuration reader is invalid/,
  );

  const reads = [];
  const executor = new ConfigurationActivationExecutor({
    activationExecutor,
    configurationReader: {
      async readActivationReconciliationSnapshot(value) {
        reads.push(value);
        return {
          revision: 4,
          activeVersion: null,
          active: null,
          observedVersion: null,
        };
      },
    },
    actionAdmissionGate,
  });

  assert.equal((await executor.reconcile(privateEnvelope())).status, "absent");
  assert.deepEqual(reads, [{ version: 1 }]);
});

test("executor construction requires the shared cutover fence", () => {
  const activationExecutor = {
    async activateInitialization() {},
    async activateDraft() {},
    async activateRollback() {},
  };
  assert.throws(
    () =>
      new ConfigurationActivationExecutor({
        activationExecutor,
        configurationReader: {
          async readActivationReconciliationSnapshot() {},
        },
      }),
    /action admission gate is invalid/,
  );
});
