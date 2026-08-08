import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  ChangePackageRuntimeError,
  createChangePackageRuntime,
} from "../src/change-package-runtime.js";

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    gitCommand: process.execPath,
    gitTimeoutMs: 12_000,
    ...overrides,
  };
}

function fakePort(methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => {}]));
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("disabled change packages construct no runtime dependency", async () => {
  let calls = 0;
  const fail = () => {
    calls += 1;
    throw new Error("must not construct");
  };
  const dependencies = {
    createApplicationProjectionStore: fail,
    createApplicationService: fail,
    createGitInspector: fail,
    createGuard: fail,
    createOperationQueue: fail,
    createPackageStore: fail,
    createStore: fail,
  };
  Object.defineProperty(dependencies, "trustedTargets", {
    enumerable: true,
    get: fail,
  });

  assert.equal(
    await createChangePackageRuntime({ enabled: false }, dependencies),
    null,
  );
  assert.equal(calls, 0);
});

test("runtime recovers packages before the application and exposes only narrow ports", async () => {
  const events = [];
  const dataDirectory = path.join(path.dirname(process.execPath), "change-package-data");
  const packageRoot = path.join(dataDirectory, "packages-test");
  const durableStore = fakePort(["read", "write"]);
  const operationQueue = { enqueue: (operation) => operation() };
  const packageProducer = fakePort(["create"]);
  const packageReader = {
    marker: "bound-package-reader",
    async get() { return this.marker; },
    async readFile() { return this.marker; },
  };
  const applicationProducer = fakePort(["prepareConfirmation"]);
  const applicationExecutor = fakePort(["execute", "reconcile"]);
  const applicationReader = fakePort(["getResult"]);
  const applicationProjectionReader = fakePort([
    "getForJob",
    "getForPackage",
    "getSummary",
  ]);
  const applicationProjectionStore = {
    async recover() { events.push("application-projection-recover"); },
    reader() { return applicationProjectionReader; },
    async getCheckpoint() {},
    async applySnapshot() {},
  };
  const controlledCommitBuilder = fakePort(["create", "find", "verify"]);
  const controlledCommitDelivery = {
    marker: "bound-controlled-delivery",
    async deliver() { return this.marker; },
  };
  const controlledCommitService = {
    async recover() { events.push("controlled-commit-recover"); },
    delivery() { return controlledCommitDelivery; },
  };
  const gitInspector = fakePort(["inspect"]);
  const guard = {
    async acquire() { events.push("acquire"); },
    async run(operation) { events.push("lease"); return operation(); },
    async close() { events.push("close"); },
  };
  const packageStore = {
    async recover() { events.push("package-recover"); },
    producer() { return packageProducer; },
    reader() { return packageReader; },
  };
  const application = {
    async recover() { events.push("application-recover"); },
    producer() { return applicationProducer; },
    executor() { return applicationExecutor; },
    reader() { return applicationReader; },
  };
  const trustedTargets = [{
    workspaceId: "workspace-1",
    sourceRoot: path.dirname(process.execPath),
    targetAuthorityDigest: "a".repeat(64),
    writablePaths: ["src"],
    excludePaths: ["node_modules"],
  }];
  let packageOptions;
  let inspectorOptions;
  let applicationOptions;
  let applicationProjectionOptions;
  let controlledCommitOptions;

  const runtime = await createChangePackageRuntime(enabledConfig(), {
    dataDirectory,
    packageRoot,
    store: durableStore,
    trustedTargets,
    controlledCommitBuilder,
    createPackageStore(options) {
      events.push("package-store");
      packageOptions = options;
      return packageStore;
    },
    createGitInspector(options) {
      events.push("git-inspector");
      inspectorOptions = options;
      return gitInspector;
    },
    createGuard(options) {
      events.push(`guard:${options.name}`);
      return guard;
    },
    createOperationQueue() {
      events.push("operation-queue");
      return operationQueue;
    },
    createApplicationProjectionStore(options) {
      events.push("application-projection-store");
      applicationProjectionOptions = options;
      return applicationProjectionStore;
    },
    createApplicationService(options) {
      events.push("application-service");
      applicationOptions = options;
      return application;
    },
    createControlledCommitService(options) {
      events.push("controlled-commit-service");
      controlledCommitOptions = options;
      return controlledCommitService;
    },
    createStore() {
      throw new Error("injected store must be reused");
    },
  });

  assert.deepEqual(events, [
    "package-store",
    "git-inspector",
    "guard:mydashboard-change-package-application-v1",
    "operation-queue",
    "application-projection-store",
    "controlled-commit-service",
    "application-service",
    "package-recover",
    "acquire",
    "controlled-commit-recover",
    "application-recover",
    "application-projection-recover",
  ]);
  assert.equal(packageOptions.root, packageRoot);
  assert.equal(typeof packageOptions.createGuard, "function");
  assert.deepEqual(inspectorOptions, {
    gitCommand: process.execPath,
    timeoutMs: 12_000,
  });
  assert.deepEqual(
    Object.keys(applicationOptions.packageReader).sort(),
    ["get", "readFile"].sort(),
  );
  assert.equal(Object.isFrozen(applicationOptions.packageReader), true);
  assert.deepEqual(Object.keys(applicationOptions.gitInspector), ["inspect"]);
  assert.equal(Object.isFrozen(applicationOptions.gitInspector), true);
  assert.deepEqual(
    Object.keys(applicationOptions.applicationAuthorityVerifier),
    ["verify"],
  );
  assert.equal(
    Object.isFrozen(applicationOptions.applicationAuthorityVerifier),
    true,
  );
  assert.throws(
    () => applicationOptions.applicationAuthorityVerifier.verify({}),
    /source authority is unavailable/,
  );
  assert.deepEqual(Object.keys(applicationOptions.store).sort(), ["read", "write"]);
  assert.deepEqual(
    Object.keys(applicationOptions.exclusiveLease),
    ["acquire", "run", "close"],
  );
  assert.deepEqual(Object.keys(applicationOptions.operationQueue), ["enqueue"]);
  assert.deepEqual(applicationOptions.trustedTargets, trustedTargets);
  assert.strictEqual(applicationProjectionOptions.store, applicationOptions.store);
  assert.strictEqual(
    applicationProjectionOptions.exclusiveLease,
    applicationOptions.exclusiveLease,
  );
  assert.deepEqual(
    Object.keys(controlledCommitOptions.packageReader).sort(),
    ["get", "readFile"].sort(),
  );
  assert.deepEqual(
    Object.keys(controlledCommitOptions.controlledCommitBuilder).sort(),
    ["create", "find", "verify"].sort(),
  );
  assert.strictEqual(controlledCommitOptions.store, applicationOptions.store);
  assert.strictEqual(
    controlledCommitOptions.exclusiveLease,
    applicationOptions.exclusiveLease,
  );
  assert.strictEqual(
    controlledCommitOptions.operationQueue,
    applicationOptions.operationQueue,
  );
  assert.strictEqual(
    applicationProjectionOptions.operationQueue,
    applicationOptions.operationQueue,
  );

  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "applicationExecutor",
    "applicationProjectionReader",
    "applicationProjectionWriter",
    "applicationProducer",
    "applicationReader",
    "close",
    "controlledCommitDelivery",
    "packageProducer",
    "packageReader",
  ].sort());
  assert.deepEqual(Object.keys(runtime.packageProducer).sort(), ["create"]);
  assert.deepEqual(Object.keys(runtime.controlledCommitDelivery), ["deliver"]);
  assert.deepEqual(
    Object.keys(runtime.packageReader).sort(),
    ["get", "readFile"].sort(),
  );
  assert.deepEqual(
    Object.keys(runtime.applicationProducer),
    ["prepareConfirmation"],
  );
  assert.deepEqual(
    Object.keys(runtime.applicationExecutor).sort(),
    ["execute", "reconcile"].sort(),
  );
  assert.deepEqual(Object.keys(runtime.applicationReader).sort(), ["getResult"]);
  assert.deepEqual(Object.keys(runtime.applicationProjectionReader).sort(), [
    "getForJob",
    "getForPackage",
    "getSummary",
  ]);
  assert.deepEqual(Object.keys(runtime.applicationProjectionWriter).sort(), [
    "applySnapshot",
    "getCheckpoint",
  ]);
  for (const port of [
    runtime.packageProducer,
    runtime.packageReader,
    runtime.controlledCommitDelivery,
    runtime.applicationProducer,
    runtime.applicationExecutor,
    runtime.applicationReader,
    runtime.applicationProjectionReader,
    runtime.applicationProjectionWriter,
  ]) {
    assert.equal(Object.isFrozen(port), true);
  }
  assert.equal(await runtime.packageReader.get("ignored"), "bound-package-reader");
  assert.equal(
    await runtime.controlledCommitDelivery.deliver({}),
    "bound-controlled-delivery",
  );
  assert.equal("guard" in runtime, false);
  assert.equal("store" in runtime, false);

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(events.at(-1), "close");
  await assert.rejects(
    runtime.packageReader.get("package-1"),
    (error) => error.code === "CHANGE_PACKAGE_RUNTIME_CLOSED",
  );
});

test("close drains accepted package writes before releasing authority", async () => {
  const started = deferred();
  const release = deferred();
  const events = [];
  const guard = {
    async acquire() {},
    async run(operation) { return operation(); },
    async close() { events.push("close"); },
  };
  const runtime = await createChangePackageRuntime(enabledConfig(), {
    trustedTargets: [],
    createStore: () => fakePort(["read", "write"]),
    createGuard: () => guard,
    createOperationQueue: () => ({ enqueue: (operation) => operation() }),
    createApplicationProjectionStore: () => ({
      async recover() {},
      reader: () => fakePort(["getForJob", "getForPackage", "getSummary"]),
      async getCheckpoint() {},
      async applySnapshot() {},
    }),
    createGitInspector: () => fakePort(["inspect"]),
    createPackageStore: () => ({
      async recover() {},
      producer: () => ({
        async create() {
          started.resolve();
          await release.promise;
          events.push("created");
        },
      }),
      reader: () => fakePort(["get", "readFile"]),
    }),
    createApplicationService: () => ({
      async recover() {},
      producer: () => fakePort(["prepareConfirmation"]),
      executor: () => fakePort(["execute", "reconcile"]),
      reader: () => fakePort(["getResult"]),
    }),
  });

  const writing = runtime.packageProducer.create({});
  await started.promise;
  const closing = runtime.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  release.resolve();
  await Promise.all([writing, closing]);
  assert.deepEqual(events, ["created", "close"]);
});

test("port method accessors are rejected without execution", async () => {
  let getterCalls = 0;
  const producer = Object.defineProperty({}, "create", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => {};
    },
  });
  await assert.rejects(
    createChangePackageRuntime(enabledConfig(), {
      createStore: () => fakePort(["read", "write"]),
      createPackageStore: () => ({
        async recover() {},
        producer: () => producer,
        reader: () => fakePort(["get", "readFile"]),
      }),
    }),
    /packageProducer does not implement/,
  );
  assert.equal(getterCalls, 0);
});

test("application recovery failure closes the acquired guard", async () => {
  const failure = new Error("corrupt application state");
  const events = [];
  const guard = {
    async acquire() { events.push("acquire"); },
    async run(operation) { return operation(); },
    async close() { events.push("close"); },
  };
  await assert.rejects(
    createChangePackageRuntime(enabledConfig(), {
      trustedTargets: [],
      createPackageStore: () => ({
        async recover() { events.push("package-recover"); },
        producer: () => fakePort(["create"]),
        reader: () => fakePort(["get", "readFile"]),
      }),
      createGitInspector: () => fakePort(["inspect"]),
      createGuard: () => guard,
      createOperationQueue: () => ({ enqueue: (operation) => operation() }),
      createStore: () => fakePort(["read", "write"]),
      createApplicationService: () => ({
        async recover() { events.push("application-recover"); throw failure; },
        producer: () => fakePort(["prepareConfirmation"]),
        executor: () => fakePort(["execute", "reconcile"]),
        reader: () => fakePort(["getResult"]),
      }),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, [
    "package-recover",
    "acquire",
    "application-recover",
    "close",
  ]);
});

test("application projection recovery failure closes the acquired guard", async () => {
  const failure = new Error("corrupt application projection state");
  const events = [];
  const guard = {
    async acquire() { events.push("acquire"); },
    async run(operation) { return operation(); },
    async close() { events.push("close"); },
  };
  await assert.rejects(
    createChangePackageRuntime(enabledConfig(), {
      trustedTargets: [],
      createPackageStore: () => ({
        async recover() { events.push("package-recover"); },
        producer: () => fakePort(["create"]),
        reader: () => fakePort(["get", "readFile"]),
      }),
      createGitInspector: () => fakePort(["inspect"]),
      createGuard: () => guard,
      createOperationQueue: () => ({ enqueue: (operation) => operation() }),
      createStore: () => fakePort(["read", "write"]),
      createApplicationService: () => ({
        async recover() { events.push("application-recover"); },
        producer: () => fakePort(["prepareConfirmation"]),
        executor: () => fakePort(["execute", "reconcile"]),
        reader: () => fakePort(["getResult"]),
      }),
      createApplicationProjectionStore: () => ({
        async recover() {
          events.push("application-projection-recover");
          throw failure;
        },
        reader: () => fakePort(["getForJob", "getForPackage", "getSummary"]),
        async getCheckpoint() {},
        async applySnapshot() {},
      }),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, [
    "package-recover",
    "acquire",
    "application-recover",
    "application-projection-recover",
    "close",
  ]);
});

test("invalid runtime configuration fails before construction", async () => {
  const invalid = [
    { enabled: true, gitCommand: "relative/git" },
    { enabled: true, gitCommand: process.execPath, gitTimeoutMs: 60_001 },
    { enabled: true, gitCommand: process.execPath, extra: true },
    { enabled: "yes", gitCommand: process.execPath },
  ];
  for (const config of invalid) {
    let constructions = 0;
    await assert.rejects(
      createChangePackageRuntime(config, {
        createPackageStore() { constructions += 1; },
      }),
      (error) =>
        error instanceof ChangePackageRuntimeError &&
        error.code === "INVALID_CHANGE_PACKAGE_RUNTIME_CONFIG",
    );
    assert.equal(constructions, 0);
  }
});
