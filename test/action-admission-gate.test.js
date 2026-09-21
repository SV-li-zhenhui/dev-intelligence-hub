import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

test("action admission and configuration activation have one total order", async (t) => {
  await t.test("an admitted action finishes its cutover before activation", async () => {
    const gate = readyGate();
    const actionEntered = deferred();
    const releaseAction = deferred();
    const events = [];
    const action = gate.run(async () => {
      events.push("action-enter");
      actionEntered.resolve();
      await releaseAction.promise;
      events.push("action-admitted");
    });
    await actionEntered.promise;
    const activation = gate.cutover(({ abort }) => {
      events.push("configuration-activated");
      abort();
    });

    await Promise.resolve();
    assert.deepEqual(events, ["action-enter"]);
    releaseAction.resolve();
    await Promise.all([action, activation]);
    assert.deepEqual(events, [
      "action-enter",
      "action-admitted",
      "configuration-activated",
    ]);
  });

  await t.test("activation completes before a later action verifies authority", async () => {
    const gate = readyGate();
    const activationEntered = deferred();
    const releaseActivation = deferred();
    const events = [];
    const activation = gate.cutover(async ({ abort }) => {
      events.push("configuration-enter");
      activationEntered.resolve();
      await releaseActivation.promise;
      events.push("configuration-activated");
      abort();
    });
    await activationEntered.promise;
    const action = gate.run(() => {
      events.push("action-verified");
    });

    await Promise.resolve();
    assert.deepEqual(events, ["configuration-enter"]);
    releaseActivation.resolve();
    await Promise.all([activation, action]);
    assert.deepEqual(events, [
      "configuration-enter",
      "configuration-activated",
      "action-verified",
    ]);
  });
});

test("a failed participant does not poison later admission", async () => {
  const gate = readyGate();
  await assert.rejects(
    gate.run(() => {
      throw new Error("activation failed");
    }),
    /activation failed/,
  );
  assert.equal(await gate.run(() => "admitted"), "admitted");
  assert.throws(() => gate.run(null), /operation must be a function/);
});

test("an unbound gate fails closed before runtime recovery", async () => {
  const gate = new ActionAdmissionGate();
  let calls = 0;

  for (const operation of [
    () => gate.run(() => {
      calls += 1;
    }),
    () => gate.cutover(() => {
      calls += 1;
    }),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error?.code === "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
    );
  }
  assert.equal(calls, 0);
  assert.equal(gate.readStatus().mode, "unbound");
});

test("a committed configuration cutover fences every later action until restart", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  const cutoverEntered = deferred();
  const releaseCutover = deferred();
  let laterActionCalls = 0;

  const cutover = gate.cutover(async ({ commit }) => {
    cutoverEntered.resolve();
    await releaseCutover.promise;
    commit({ version: 2, configurationDigest: "2".repeat(64) });
    return "stored-v2";
  });
  await cutoverEntered.promise;
  const laterAction = gate.run(() => {
    laterActionCalls += 1;
  });
  releaseCutover.resolve();

  assert.equal(await cutover, "stored-v2");
  await assert.rejects(
    laterAction,
    (error) =>
      error?.code === "RUNTIME_RESTART_REQUIRED" &&
      error?.statusCode === 409,
  );
  assert.equal(laterActionCalls, 0);
  assert.deepEqual(gate.readStatus(), {
    mode: "restart_required",
    storedActive: {
      version: 2,
      configurationDigest: "2".repeat(64),
    },
    runtimeEffective: {
      version: 1,
      configurationDigest: "1".repeat(64),
    },
  });
});

test("safe bootstrap admits only a configuration cutover", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(null);
  let actionCalls = 0;

  await assert.rejects(
    gate.run(() => {
      actionCalls += 1;
    }),
    (error) => error?.code === "RUNTIME_CONFIGURATION_NOT_READY",
  );
  assert.equal(actionCalls, 0);
  assert.equal(
    await gate.cutover(({ commit }) => {
      commit({ version: 1, configurationDigest: "a".repeat(64) });
      return "initialized";
    }),
    "initialized",
  );
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("a proven absent cutover restores admission while uncertainty stays closed", async () => {
  const gate = new ActionAdmissionGate();
  const effective = {
    version: 4,
    configurationDigest: "4".repeat(64),
  };
  gate.bindEffective(effective);

  await assert.rejects(
    gate.cutover(({ abort }) => {
      abort();
      throw Object.assign(new Error("stale"), { code: "STALE" });
    }),
    (error) => error?.code === "STALE",
  );
  assert.equal(await gate.run(() => "still-ready"), "still-ready");
  assert.deepEqual(gate.readStatus(), {
    mode: "ready",
    storedActive: effective,
    runtimeEffective: effective,
  });

  const uncertainResult = await gate.cutover(({ markUnknown }) => {
    markUnknown();
    return { status: "error", trust: "unknown" };
  });
  assert.deepEqual(uncertainResult, { status: "error", trust: "unknown" });
  assert.equal(gate.readStatus().mode, "unknown");
  await assert.rejects(
    gate.run(() => "must-not-run"),
    (error) => error?.code === "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
  );
});

test("reconciling the runtime-effective version leaves the gate ready", async () => {
  const gate = new ActionAdmissionGate();
  const effective = {
    version: 3,
    configurationDigest: "3".repeat(64),
  };
  gate.bindEffective(effective);

  await gate.cutover(({ commit }) => {
    commit(effective);
  });

  assert.equal(gate.readStatus().mode, "ready");
  assert.equal(await gate.run(() => "admitted"), "admitted");
});

test("reconciliation remains available while actions wait for restart", async () => {
  const gate = readyGate();
  const stored = {
    version: 2,
    configurationDigest: "2".repeat(64),
  };
  await gate.cutover(({ commit }) => commit(stored));
  assert.equal(gate.readStatus().mode, "restart_required");

  assert.equal(
    await gate.reconcileCutover(({ commit }) => {
      commit(stored);
      return "already";
    }),
    "already",
  );
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(
    gate.run(() => "must-not-run"),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );
});

test("trusted reconciliation can resolve an uncertain absent cutover", async () => {
  const gate = readyGate();
  await gate.cutover(({ markUnknown }) => markUnknown());
  assert.equal(gate.readStatus().mode, "unknown");

  await gate.reconcileCutover(({ abort }) => abort());
  assert.equal(gate.readStatus().mode, "ready");
  assert.equal(await gate.run(() => "admitted"), "admitted");
});

test("an unsettled or unexpectedly failed cutover fails closed", async () => {
  for (const operation of [
    () => "missing settlement",
    () => {
      throw new Error("unexpected failure");
    },
  ]) {
    const gate = new ActionAdmissionGate();
    gate.bindEffective({
      version: 1,
      configurationDigest: "b".repeat(64),
    });
    await assert.rejects(gate.cutover(operation));
    assert.equal(gate.readStatus().mode, "unknown");
  }
});
