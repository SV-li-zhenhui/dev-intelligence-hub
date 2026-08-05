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

test("action admission and configuration activation have one total order", async (t) => {
  await t.test("an admitted action finishes its cutover before activation", async () => {
    const gate = new ActionAdmissionGate();
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
    const activation = gate.run(() => {
      events.push("configuration-activated");
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
    const gate = new ActionAdmissionGate();
    const activationEntered = deferred();
    const releaseActivation = deferred();
    const events = [];
    const activation = gate.run(async () => {
      events.push("configuration-enter");
      activationEntered.resolve();
      await releaseActivation.promise;
      events.push("configuration-activated");
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
  const gate = new ActionAdmissionGate();
  await assert.rejects(
    gate.run(() => {
      throw new Error("activation failed");
    }),
    /activation failed/,
  );
  assert.equal(await gate.run(() => "admitted"), "admitted");
  assert.throws(() => gate.run(null), /operation must be a function/);
});
