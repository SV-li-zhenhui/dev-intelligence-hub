import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationExecutorRouter } from "../src/services/confirmation-executor-router.js";

function executor(name, calls) {
  return {
    execute(...args) {
      calls.push({ method: "execute", name, receiver: this, args });
      return { name, method: "execute" };
    },
    reconcile(...args) {
      calls.push({ method: "reconcile", name, receiver: this, args });
      return { name, method: "reconcile" };
    },
  };
}

test("routes execute and reconcile by the exact confirmation kind", () => {
  const calls = [];
  const github = executor("github", calls);
  const localCode = executor("local-code", calls);
  const router = new ConfirmationExecutorRouter({
    executors: {
      "github.work-proposal-review": github,
      "local.code-work-proposal": localCode,
    },
  });
  const request = { requestId: "request-1" };
  const githubPlan = { kind: "github.work-proposal-review" };
  const codePlan = { kind: "local.code-work-proposal" };

  assert.deepEqual(router.execute(codePlan, request), {
    name: "local-code",
    method: "execute",
  });
  assert.deepEqual(router.reconcile(githubPlan), {
    name: "github",
    method: "reconcile",
  });
  assert.deepEqual(calls, [
    {
      method: "execute",
      name: "local-code",
      receiver: localCode,
      args: [codePlan, request],
    },
    {
      method: "reconcile",
      name: "github",
      receiver: github,
      args: [githubPlan],
    },
  ]);
});

test("preserves the queue's one-envelope call without appending undefined", () => {
  const envelope = { kind: "local.code-work-proposal" };
  let received;
  const result = { status: "applied", receipt: { id: "job-1" } };
  const actionExecutor = {
    execute(...args) {
      received = args;
      return result;
    },
    reconcile() {
      throw new Error("not used");
    },
  };
  const router = new ConfirmationExecutorRouter({
    executors: { "local.code-work-proposal": actionExecutor },
  });

  assert.equal(router.execute(envelope), result);
  assert.deepEqual(received, [envelope]);
});

test("unknown, missing, and inherited kinds fail closed without a fallback", () => {
  let configuredCalls = 0;
  const router = new ConfirmationExecutorRouter({
    executors: {
      "configured.kind": {
        execute() {
          configuredCalls += 1;
        },
        reconcile() {
          configuredCalls += 1;
        },
      },
    },
  });
  const inherited = Object.create({ kind: "configured.kind" });
  const expected = {
    status: "error",
    error: {
      code: "CONFIRMATION_EXECUTOR_NOT_CONFIGURED",
      trust: "unknown",
    },
  };

  assert.deepEqual(router.execute({ kind: "unconfigured.kind" }), expected);
  assert.deepEqual(router.reconcile({}), expected);
  assert.deepEqual(router.execute(inherited), expected);
  assert.deepEqual(router.reconcile(null), expected);
  assert.equal(configuredCalls, 0);
});

test("requires executors to be a plain data record", () => {
  const validExecutor = { execute() {}, reconcile() {} };
  const invalidRecords = [
    undefined,
    null,
    [],
    new Map(),
    Object.create({ inherited: validExecutor }),
  ];

  for (const executors of invalidRecords) {
    assert.throws(
      () => new ConfirmationExecutorRouter({ executors }),
      /executors must be a plain data record/,
    );
  }

  const accessorRecord = {};
  Object.defineProperty(accessorRecord, "local.code-work-proposal", {
    enumerable: true,
    get() {
      throw new Error("must not invoke executor accessors");
    },
  });
  assert.throws(
    () => new ConfirmationExecutorRouter({ executors: accessorRecord }),
    /executors must be a plain data record/,
  );

  const symbolRecord = { "local.code-work-proposal": validExecutor };
  symbolRecord[Symbol("hidden")] = validExecutor;
  assert.throws(
    () => new ConfirmationExecutorRouter({ executors: symbolRecord }),
    /executors must be a plain data record/,
  );

  assert.throws(
    () =>
      new ConfirmationExecutorRouter({
        executors: { "*": validExecutor },
      }),
    /confirmation executor kind is invalid/,
  );

  const nullPrototypeRecord = Object.create(null);
  nullPrototypeRecord["local.code-work-proposal"] = validExecutor;
  assert.doesNotThrow(
    () => new ConfirmationExecutorRouter({ executors: nullPrototypeRecord }),
  );
});

test("requires every configured executor to implement execute and reconcile", () => {
  const invalidExecutors = [
    null,
    {},
    { execute() {} },
    { reconcile() {} },
    { execute: true, reconcile() {} },
    { execute() {}, reconcile: true },
  ];

  for (const actionExecutor of invalidExecutors) {
    assert.throws(
      () =>
        new ConfirmationExecutorRouter({
          executors: { "local.code-work-proposal": actionExecutor },
        }),
      /executor for local\.code-work-proposal must provide execute and reconcile/,
    );
  }

  class ClassExecutor {
    execute() {}
    reconcile() {}
  }
  assert.doesNotThrow(
    () =>
      new ConfirmationExecutorRouter({
        executors: { "local.code-work-proposal": new ClassExecutor() },
      }),
  );
});

test("keeps the configured executor registry private", () => {
  const router = new ConfirmationExecutorRouter({
    executors: {
      "local.code-work-proposal": { execute() {}, reconcile() {} },
    },
  });

  assert.equal(Object.isFrozen(router), true);
  assert.deepEqual(Reflect.ownKeys(router), []);
  assert.equal("executors" in router, false);
  assert.equal("defaultExecutor" in router, false);
});
