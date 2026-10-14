import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCodeExecutionSession, closeCodeExecutionContext, createCodeExecutionContext,
  isCodeExecutionContext, revokeCodeExecutionContext,
} from "../src/lib/code-execution-context.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  return createCodeExecutionContext({ performAction: async (args) => args,
    readSource: async (args) => args, getState: async () => ({ revision: 1 }), ...overrides });
}

test("execution authority is an opaque process-private capability", async () => {
  const context = fixture();
  assert.ok(isCodeExecutionContext(context));
  assert.ok(Object.isFrozen(context));
  assert.equal(JSON.stringify(context), "{}");
  assert.equal(isCodeExecutionContext(structuredClone(context)), false);
  assert.equal(isCodeExecutionContext(null), false);
  assert.throws(() => beginCodeExecutionSession({}), { code: "CODE_EXECUTION_CONTEXT_INVALID" });
  assert.throws(() => createCodeExecutionContext({}), { code: "CODE_EXECUTION_CONTEXT_INVALID" });
  await closeCodeExecutionContext(context);
});

test("each capability has one session lifetime and closes its host exactly once", async () => {
  let closes = 0;
  const receipt = { settled: true };
  const context = fixture({ close: async () => { closes += 1; return receipt; } });
  const session = beginCodeExecutionSession(context);
  assert.throws(() => beginCodeExecutionSession(context), { code: "CODE_EXECUTION_SESSION_ALREADY_STARTED" });
  assert.deepEqual(await session.invoke("get_state", {}), { revision: 1 });
  assert.deepEqual(await Promise.all([session.close(), closeCodeExecutionContext(context), session.close()]), [receipt, receipt, receipt]);
  assert.equal(closes, 1);
  assert.throws(() => beginCodeExecutionSession(context), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  await assert.rejects(session.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  const unopened = fixture({ close: async () => { closes += 1; } });
  await closeCodeExecutionContext(unopened);
  assert.equal(closes, 2);
  assert.throws(() => beginCodeExecutionSession(unopened), { code: "CODE_EXECUTION_SESSION_REVOKED" });
});

test("host callbacks serialize, including read and state calls after a failed action", async () => {
  const entered = deferred(), release = deferred(), calls = [];
  const context = fixture({ performAction: async () => {
    calls.push("action-start"); entered.resolve(); await release.promise;
    calls.push("action-end"); throw new Error("host failure");
  }, readSource: async () => { calls.push("read"); return "source"; },
  getState: async () => { calls.push("state"); return "state"; } });
  const session = beginCodeExecutionSession(context);
  const first = session.invoke("perform_action", {});
  const failure = assert.rejects(first, /host failure/);
  await entered.promise;
  const read = session.invoke("read_source", {}), state = session.invoke("get_state", {});
  assert.deepEqual(calls, ["action-start"]);
  release.resolve();
  await failure;
  assert.equal(await read, "source");
  assert.equal(await state, "state");
  assert.deepEqual(calls, ["action-start", "action-end", "read", "state"]);
  await session.close();
});

test("ordinary revoke denies queued work and close drains an active callback without aborting it", async () => {
  const entered = deferred(), release = deferred();
  let callbackSignal, closes = 0, stateCalls = 0, closed = false;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return { audited: true };
  }, getState: async () => { stateCalls += 1; }, close: async () => { closes += 1; } });
  const session = beginCodeExecutionSession(context);
  const active = session.invoke("perform_action", {});
  await entered.promise;
  const queued = assert.rejects(session.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  revokeCodeExecutionContext(context);
  assert.equal(callbackSignal.aborted, false);
  assert.throws(() => session.assertActive(), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  const closing = session.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(closes, 0);
  release.resolve();
  assert.deepEqual(await active, { audited: true });
  await Promise.all([queued, closing]);
  assert.equal(stateCalls, 0);
  assert.equal(closes, 1);
});

test("parent cancellation aborts the active callback but close still waits for settlement", async () => {
  const parent = new AbortController(), entered = deferred(), release = deferred();
  let callbackSignal, closed = false;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return "settled";
  } });
  const session = beginCodeExecutionSession(context, { signal: parent.signal });
  const active = session.invoke("perform_action", {});
  await entered.promise;
  parent.abort();
  assert.equal(callbackSignal.aborted, true);
  const closing = session.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await active, "settled");
  await closing;
});

test("explicit active cancellation and an already aborted parent close admissions", async () => {
  const entered = deferred(), release = deferred();
  let callbackSignal;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise;
  } });
  const session = beginCodeExecutionSession(context);
  const active = session.invoke("perform_action", {});
  await entered.promise;
  session.revoke({ abortActive: true });
  assert.ok(callbackSignal.aborted);
  release.resolve(); await active; await session.close();
  const parent = new AbortController(); parent.abort();
  const already = beginCodeExecutionSession(fixture(), { signal: parent.signal });
  await assert.rejects(already.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  await already.close();
});

test("only the three host callbacks are invokable", async () => {
  const session = beginCodeExecutionSession(fixture());
  for (const name of ["complete", "shell", "close", "constructor", "toString"]) {
    await assert.rejects(session.invoke(name, {}), { code: "CODE_EXECUTION_TOOL_NOT_ALLOWED" });
  }
  await session.close();
});

test("a failing host close remains a failing receipt without executing twice", async () => {
  let closes = 0;
  const context = fixture({ close: async () => { closes += 1; throw new Error("cannot settle host"); } });
  await assert.rejects(closeCodeExecutionContext(context), /cannot settle host/);
  await assert.rejects(closeCodeExecutionContext(context), /cannot settle host/);
  assert.equal(closes, 1);
});
