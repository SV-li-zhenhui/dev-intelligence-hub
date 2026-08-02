import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ConfirmationRuntimeError,
  createConfirmationRuntime,
} from "../src/confirmation-runtime.js";

const TOKEN_ENV = "MYDASHBOARD_GITHUB_TOKEN";
const TOKEN = "github-token-from-environment";

function enabledConfig(overrides = {}) {
  return {
    githubActions: {
      enabled: true,
      actorAccountId: "review-account",
      tokenEnv: TOKEN_ENV,
      ghCommand: process.execPath,
      networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
      ...overrides,
    },
  };
}

function queuePort(events = []) {
  return {
    async recover() {
      events.push("recover");
    },
    enqueue(...args) {
      assert.equal(this, this);
      return ["enqueue", ...args];
    },
    next() {
      return "next";
    },
    get(id) {
      return ["get", id];
    },
    approve(id, input) {
      return ["approve", id, input];
    },
    retry(id, input) {
      return ["retry", id, input];
    },
    reject(id, input) {
      return ["reject", id, input];
    },
    invalidate(id, input) {
      return ["invalidate", id, input];
    },
  };
}

function runtimeDependencies(overrides = {}) {
  const environment = {
    [TOKEN_ENV]: TOKEN,
    HTTPS_PROXY: "http://ambient-proxy.example",
    UNRELATED_SECRET: "must-not-become-network-config",
  };
  return {
    env: environment,
    dataDirectory: path.join(path.dirname(process.execPath), "confirmation-test-data"),
    createStore: () => ({ read() {}, write() {} }),
    createOperationQueue: () => ({ enqueue(operation) { return operation(); } }),
    createExecutor: () => ({ execute() {}, reconcile() {} }),
    createGuard: () => ({
      acquire() {},
      run(operation) { return operation(); },
      close() {},
    }),
    createQueue: () => queuePort(),
    ...overrides,
  };
}

test("disabled GitHub actions construct no confirmation runtime components", async () => {
  let creations = 0;
  const failIfCalled = () => {
    creations += 1;
    throw new Error("must not construct");
  };

  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    Object.defineProperty(
      {
        createStore: failIfCalled,
        createOperationQueue: failIfCalled,
        createExecutor: failIfCalled,
        createExecutorRouter: failIfCalled,
        createGuard: failIfCalled,
        createQueue: failIfCalled,
      },
      "env",
      { get: failIfCalled },
    ),
  );

  assert.equal(runtime, null);
  assert.equal(creations, 0);
});

test("enabled runtime composes private ports, acquires, then recovers", async () => {
  const events = [];
  const environment = {
    [TOKEN_ENV]: TOKEN,
    HTTPS_PROXY: "http://ambient-proxy.example",
    UNRELATED_SECRET: "do-not-forward",
  };
  const store = { read() {}, write() {} };
  const operationQueue = { enqueue(operation) { return operation(); } };
  const executor = { execute() {}, reconcile() {} };
  const router = { execute() {}, reconcile() {} };
  const guard = {
    acquire() { events.push("acquire"); },
    run(operation) { return operation(); },
    close() { events.push("close"); },
  };
  const rawQueue = queuePort(events);
  let executorOptions;
  let routerOptions;
  let queueOptions;

  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      env: environment,
      createStore(dataDirectory) {
        events.push("store");
        assert.equal(path.isAbsolute(dataDirectory), true);
        return store;
      },
      createOperationQueue() {
        events.push("operationQueue");
        return operationQueue;
      },
      createExecutor(options) {
        events.push("executor");
        executorOptions = options;
        return executor;
      },
      createExecutorRouter(options) {
        events.push("router");
        routerOptions = options;
        return router;
      },
      createGuard(options) {
        events.push("guard");
        assert.deepEqual(options, { name: "mydashboard-confirmation-queue-v1" });
        return guard;
      },
      createQueue(options) {
        events.push("queue");
        queueOptions = options;
        return rawQueue;
      },
    }),
  );

  assert.deepEqual(events, [
    "store",
    "operationQueue",
    "executor",
    "router",
    "guard",
    "queue",
    "acquire",
    "recover",
  ]);
  assert.deepEqual(Object.keys(executorOptions).sort(), [
    "env",
    "ghCommand",
    "networkEnv",
    "token",
  ]);
  assert.equal(executorOptions.token, TOKEN);
  assert.equal(executorOptions.env, environment);
  assert.deepEqual(executorOptions.networkEnv, {
    HTTPS_PROXY: "http://127.0.0.1:8080",
  });
  assert.equal("actorAccountId" in executorOptions, false);
  assert.equal("tokenEnv" in executorOptions, false);
  assert.deepEqual(queueOptions, {
    store,
    executor: router,
    operationQueue,
    exclusiveLease: guard,
  });
  assert.deepEqual(Object.keys(routerOptions.executors).sort(), [
    "github.pull-request-review",
    "github.work-proposal-review",
  ]);
  assert.strictEqual(
    routerOptions.executors["github.pull-request-review"],
    executor,
  );
  assert.strictEqual(
    routerOptions.executors["github.work-proposal-review"],
    executor,
  );

  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime), ["queue", "producerQueue", "close"]);
  assert.equal(Object.isFrozen(runtime.queue), true);
  assert.equal(Object.isFrozen(runtime.producerQueue), true);
  assert.notEqual(runtime.queue, rawQueue);
  assert.notEqual(runtime.producerQueue, rawQueue);
  assert.equal("recover" in runtime.queue, false);
  assert.equal("enqueue" in runtime.queue, false);
  assert.equal("invalidate" in runtime.queue, false);
  assert.equal("executor" in runtime.queue, false);
  assert.equal("exclusiveLease" in runtime.queue, false);
  assert.equal(runtime.queue.next(), "next");
  const detachedNext = runtime.queue.next;
  assert.equal(detachedNext(), "next");
  assert.deepEqual(runtime.queue.get("item-1"), ["get", "item-1"]);
  assert.equal("approve" in runtime.producerQueue, false);
  assert.deepEqual(runtime.producerQueue.enqueue("plan"), ["enqueue", "plan"]);
  assert.deepEqual(runtime.producerQueue.invalidate("item-1", "reason"), [
    "invalidate",
    "item-1",
    "reason",
  ]);

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(events.slice(-1), ["close"]);
});

test("a local-only runtime starts without reading GitHub credentials", async () => {
  const localExecutor = { execute() {}, reconcile() {} };
  let routed;
  let githubExecutors = 0;
  const dependencies = runtimeDependencies({
    localExecutor,
    createExecutor() {
      githubExecutors += 1;
      throw new Error("must not create GitHub executor");
    },
    createExecutorRouter({ executors }) {
      routed = executors;
      return localExecutor;
    },
  });
  Object.defineProperty(dependencies, "env", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("must not read GitHub environment");
    },
  });

  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    dependencies,
  );

  assert.equal(githubExecutors, 0);
  assert.deepEqual(Object.keys(routed), ["local.code-job-create"]);
  assert.strictEqual(routed["local.code-job-create"], localExecutor);
  assert.ok(runtime);
  await runtime.close();
});

test("multiple local confirmation kinds share one routed queue", async () => {
  const codeJobExecutor = { execute() {}, reconcile() {} };
  const applicationExecutor = { execute() {}, reconcile() {} };
  let routed;
  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    runtimeDependencies({
      localExecutors: {
        "local.code-job-create": codeJobExecutor,
        "local.change-package-apply": applicationExecutor,
      },
      createExecutorRouter({ executors }) {
        routed = executors;
        return codeJobExecutor;
      },
    }),
  );

  assert.deepEqual(Object.keys(routed).sort(), [
    "local.change-package-apply",
    "local.code-job-create",
  ]);
  assert.strictEqual(routed["local.code-job-create"], codeJobExecutor);
  assert.strictEqual(
    routed["local.change-package-apply"],
    applicationExecutor,
  );
  await runtime.close();
});

test("local executor registration rejects unknown or ambiguous kinds", async () => {
  const executor = { execute() {}, reconcile() {} };
  await assert.rejects(
    createConfirmationRuntime(
      { githubActions: { enabled: false } },
      runtimeDependencies({ localExecutors: { "local.unknown": executor } }),
    ),
    /localExecutors/,
  );
  await assert.rejects(
    createConfirmationRuntime(
      { githubActions: { enabled: false } },
      runtimeDependencies({
        localExecutor: executor,
        localExecutors: { "local.code-job-create": executor },
      }),
    ),
    /localExecutor/,
  );
});

test("recover failure closes the guard before rethrowing the same error", async () => {
  const events = [];
  const failure = new Error("invalid durable state");
  const dependencies = runtimeDependencies({
    createGuard: () => ({
      acquire() { events.push("acquire"); },
      run(operation) { return operation(); },
      close() { events.push("close"); },
    }),
    createQueue: () => ({
      ...queuePort(),
      recover() {
        events.push("recover");
        throw failure;
      },
    }),
  });

  await assert.rejects(
    createConfirmationRuntime(enabledConfig(), dependencies),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["acquire", "recover", "close"]);
});

test("an injected store remains private and bypasses store construction", async () => {
  const store = { read() {}, write() {} };
  let createStoreCalls = 0;
  let receivedStore;
  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      store,
      createStore() {
        createStoreCalls += 1;
        throw new Error("must not construct a replacement store");
      },
      createQueue(options) {
        receivedStore = options.store;
        return queuePort();
      },
    }),
  );

  assert.equal(createStoreCalls, 0);
  assert.equal(receivedStore, store);
  assert.equal("store" in runtime, false);
  assert.equal("store" in runtime.queue, false);
  await runtime.close();
});

test("queue construction and acquisition failures do not leave a guard", async () => {
  for (const failurePoint of ["queue", "acquire"]) {
    const events = [];
    const failure = new Error(`${failurePoint} failed`);
    const dependencies = runtimeDependencies({
      createGuard: () => ({
        acquire() {
          events.push("acquire");
          if (failurePoint === "acquire") throw failure;
        },
        run(operation) { return operation(); },
        close() { events.push("close"); },
      }),
      createQueue: () => {
        events.push("queue");
        if (failurePoint === "queue") throw failure;
        return queuePort();
      },
    });

    await assert.rejects(
      createConfirmationRuntime(enabledConfig(), dependencies),
      (error) => error === failure,
    );
    assert.equal(events.at(-1), "close");
    assert.equal(events.filter((event) => event === "close").length, 1);
  }
});

test("invalid enabled settings fail before constructing any component", async () => {
  const invalidCases = [
    enabledConfig({ tokenEnv: "unsafe-name" }),
    enabledConfig({ actorAccountId: "bad login" }),
    enabledConfig({ token: "credential-in-json-is-forbidden" }),
    enabledConfig({ ghCommand: "relative/gh" }),
    enabledConfig({ networkEnv: { PATH: "C:\\unsafe" } }),
    enabledConfig({ timeoutMs: 999 }),
  ];

  for (const config of invalidCases) {
    let creations = 0;
    const count = () => {
      creations += 1;
      return {};
    };
    await assert.rejects(
      createConfirmationRuntime(config, {
        env: { [TOKEN_ENV]: TOKEN },
        createStore: count,
        createOperationQueue: count,
        createExecutor: count,
        createGuard: count,
        createQueue: count,
      }),
      (error) =>
        error instanceof ConfirmationRuntimeError &&
        error.code === "INVALID_CONFIRMATION_RUNTIME_CONFIG",
    );
    assert.equal(creations, 0);
  }

  let creations = 0;
  await assert.rejects(
    createConfirmationRuntime(enabledConfig(), {
      env: {},
      createStore: () => { creations += 1; },
    }),
    (error) => error.code === "INVALID_CONFIRMATION_RUNTIME_CONFIG",
  );
  assert.equal(creations, 0);
});
