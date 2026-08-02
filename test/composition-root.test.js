import assert from "node:assert/strict";
import test from "node:test";
import { OllamaBrain } from "../src/adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "../src/adapters/ollama-pr-employee-reviewer.js";
import {
  createBrain,
  createApplication,
  createEmployeeRegistry,
  createPrEmployeeReviewer,
} from "../src/composition-root.js";

function applicationConfig(codeExecutor = { enabled: false }) {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    employees: { prReviewer: { enabled: false } },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor,
  };
}

function externalActionConfig(codeExecutor = { enabled: false }) {
  return {
    ...applicationConfig(codeExecutor),
    githubActions: {
      enabled: true,
      actorAccountId: "review-account",
    },
  };
}

function workCoordinationConfig({ externalActions = true } = {}) {
  return {
    ...applicationConfig(),
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [],
    },
    githubActions: externalActions
      ? { enabled: true, actorAccountId: "review-account" }
      : { enabled: false },
    workCoordination: {
      enabled: true,
      intakeLimit: 11,
      workLimit: 12,
      dispatchLimit: 13,
      attentionLimit: 14,
      conditionLimit: 15,
      leaseDurationMs: 16_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 3_000,
      maxAttempts: 4,
      retryBaseMs: 5_000,
      retryMaxMs: 6_000,
      factMaximumAgeMs: 7_000,
      policy: {
        version: 2,
        capabilityRoles: { testing: "tester" },
        githubReviewRoles: ["pr-reviewer"],
        codeActionRoles: ["developer"],
        workspaceByRepository: { "acme/repo": "acme-workspace" },
      },
    },
  };
}

function confirmationQueuePort() {
  return Object.freeze({
    async next() {
      return { queueRevision: 0, pendingCount: 0, item: null };
    },
    async get() {},
    async approve() {},
    async retry() {},
    async reject() {},
  });
}

function confirmationProducerPort(overrides = {}) {
  return Object.freeze({
    async enqueue() {},
    async get() {},
    async invalidate() {},
    ...overrides,
  });
}

function memoryStore() {
  return {
    async read(_key, fallback = null) {
      return fallback;
    },
    async write() {},
  };
}

function invalidationPendingEmployeeState() {
  const workItemId = "pr-work-startup-invalidation";
  const approvalBindingDigest = "b".repeat(64);
  const confirmationInvalidationIntent = {
    requestedBy: { roleId: "pr-reviewer", workItemId },
    approvalBindingDigest,
    reason: "work_item_superseded",
  };
  return {
    revision: 7,
    paused: false,
    jobs: [
      {
        id: workItemId,
        fingerprint: "startup-invalidation-fingerprint",
        policyVersion: 1,
        subjectId: "github:pr:acme/repo#42",
        repo: "acme/repo",
        number: 42,
        title: "Protect checkout",
        url: "https://github.com/acme/repo/pull/42",
        relation: "review_requested",
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
        nextAction: "review",
        status: "confirmation_invalidation_pending",
        confirmationId: `confirmation-${workItemId}`,
        confirmationBindingDigest: approvalBindingDigest,
        confirmationStatus: "pending",
        confirmationIntent: null,
        confirmationInvalidationIntent,
        summary: "旧 Review 已被新事实替代",
        evidence: ["nextAction changed"],
        reviewVerdict: "comment",
        reviewBody: "旧 Review 不应再发布。",
        createdAt: "2026-08-02T01:00:00.000Z",
        updatedAt: "2026-08-02T01:01:00.000Z",
      },
    ],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "等待恢复外部动作失效",
  };
}

function storedValues(entries) {
  const values = new Map(
    Object.entries(entries).map(([name, value]) => [
      name,
      structuredClone(value),
    ]),
  );
  return {
    async read(name, fallback = null) {
      return structuredClone(values.has(name) ? values.get(name) : fallback);
    },
    async write(name, value) {
      values.set(name, structuredClone(value));
    },
  };
}

test("brain provider factory keeps the role independent from its model", () => {
  const brain = createBrain({
    enabled: true,
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://localhost:11434/",
    contextTokens: 4096,
  });

  assert.ok(brain instanceof OllamaBrain);
  assert.equal(brain.provider, "ollama");
  assert.equal(brain.model, "qwen3.5:9b");
  assert.equal(brain.baseUrl, "http://localhost:11434");
  assert.equal(createBrain({ enabled: false }), null);
});

test("unknown brain providers fail explicitly", () => {
  assert.throws(
    () => createBrain({ enabled: true, provider: "future-provider" }),
    /Unsupported brain provider: future-provider/,
  );
});

test("the PR employee can use its own model without changing its role", () => {
  const reviewer = createPrEmployeeReviewer(
    {
      enabled: true,
      provider: "ollama",
      model: "qwen3.5:9b",
      contextTokens: 8192,
    },
    { model: "special-review-model", contextTokens: 4096 },
  );

  assert.ok(reviewer instanceof OllamaPrEmployeeReviewer);
  assert.equal(reviewer.provider, "ollama");
  assert.equal(reviewer.model, "special-review-model");
  assert.equal(reviewer.contextTokens, 4096);
});

test("employee registry keeps role instances discoverable by id", () => {
  const employee = (id) => ({
    id,
    async view() {},
    async roleView() {},
    async run() {},
    async control() {},
  });
  const prEmployee = employee("pr-reviewer");
  const analyst = employee("requirements-analyst");

  const registry = createEmployeeRegistry([prEmployee, analyst]);

  assert.strictEqual(registry.get("pr-reviewer"), prEmployee);
  assert.strictEqual(registry.get("requirements-analyst"), analyst);
});

test("application composition keeps the disabled executor absent", async () => {
  const store = memoryStore();
  const calls = [];
  const application = await createApplication({
    config: applicationConfig(),
    store,
    codeExecutorRuntimeFactory: async (config, dependencies) => {
      calls.push({ config, dependencies });
      return null;
    },
  });

  assert.equal(application.codeExecutorRuntime, null);
  assert.equal(application.codeExecutor, null);
  assert.deepEqual(calls[0].config, { enabled: false });
  assert.strictEqual(calls[0].dependencies.store, store);
});

test("application composes the recovered local workflow router", async () => {
  const store = memoryStore();
  const workflowRouting = { id: "workflow-routing" };
  const calls = [];
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      workflowRouting: {
        schemaVersion: 1,
        enabled: false,
        maxHops: 8,
        rules: [],
      },
    },
    store,
    workflowRoutingRuntimeFactory: async (config, dependencies) => {
      calls.push({ config, dependencies });
      return workflowRouting;
    },
  });

  assert.strictEqual(application.workflowRouting, workflowRouting);
  assert.strictEqual(calls[0].dependencies.store, store);
  assert.equal(calls[0].config.workflowRouting.enabled, false);
  await application.close();
});

test("enabled work coordination composes private runtimes into frozen application ports", async () => {
  const store = memoryStore();
  const runtimeOrder = [];
  const serviceOrder = [];
  const closeCalls = [];
  const calls = {};
  const workers = [{ roleId: "developer" }];
  const workflowRouting = {
    async readAssignmentBatch() {},
    async close() {
      closeCalls.push("workflow");
    },
  };
  const ledgerRuntime = {
    async getSummary() {
      return { source: "ledger" };
    },
    async listItems(options) {
      return { items: [options], nextCursor: null };
    },
    async listTimeline(options) {
      return { items: [options], nextCursor: null };
    },
    async close() {
      closeCalls.push("ledger");
    },
  };
  const attentionProducer = { async create() {} };
  const attentionConsumer = { async readOutbox() {} };
  const attentionBrowser = {
    async next() {
      return { id: "attention-1" };
    },
    async answer(value) {
      return value;
    },
    async reject(value) {
      return value;
    },
    async later(value) {
      return value;
    },
  };
  const confirmationQueue = confirmationQueuePort();
  const policy = { async bind() {} };
  const roleDirectory = { async resolve() {} };
  const factSource = { async read() {} };
  const reconciler = { async runCycle() {} };
  const conditionWaker = { async runCycle() {} };
  const workLoop = { async runCycle() {} };
  const dispatcher = { async dispatchPending() {} };
  const coordinationService = {
    async intake() {
      return "intake-result";
    },
    async runCycle(value) {
      return value;
    },
  };
  const coordinator = {
    async next() {
      return "coordinated-attention";
    },
  };

  const application = await createApplication({
    config: workCoordinationConfig(),
    store,
    workCoordinationDependencies: { workers },
    codeExecutorRuntimeFactory: async () => {
      runtimeOrder.push("code-executor");
      return {
        async close() {
          closeCalls.push("code-executor");
        },
      };
    },
    workflowRoutingRuntimeFactory: async () => {
      runtimeOrder.push("workflow");
      return workflowRouting;
    },
    workLedgerRuntimeFactory: async (options) => {
      runtimeOrder.push("ledger");
      calls.ledger = options;
      return ledgerRuntime;
    },
    attentionInboxRuntimeFactory: async (options) => {
      runtimeOrder.push("attention");
      calls.attention = options;
      return {
        producer: attentionProducer,
        browser: attentionBrowser,
        consumer: attentionConsumer,
        async close() {
          closeCalls.push("attention");
        },
      };
    },
    confirmationRuntimeFactory: async () => {
      runtimeOrder.push("confirmation");
      return {
        queue: confirmationQueue,
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    workIntentPolicyFactory: (options) => {
      serviceOrder.push("policy");
      calls.policy = options;
      return policy;
    },
    roleWorkerDirectoryFactory: (options) => {
      serviceOrder.push("directory");
      calls.directory = options;
      return roleDirectory;
    },
    workflowFactSourceFactory: (options) => {
      serviceOrder.push("facts");
      calls.facts = options;
      return factSource;
    },
    attentionResultReconcilerFactory: (options) => {
      serviceOrder.push("reconciler");
      calls.reconciler = options;
      return reconciler;
    },
    workConditionWakerFactory: (options) => {
      serviceOrder.push("waker");
      calls.waker = options;
      return conditionWaker;
    },
    proactiveWorkLoopFactory: (options) => {
      serviceOrder.push("loop");
      calls.loop = options;
      return workLoop;
    },
    workIntentDispatcherFactory: (options) => {
      serviceOrder.push("dispatcher");
      calls.dispatcher = options;
      return dispatcher;
    },
    workCoordinationFactory: (options) => {
      serviceOrder.push("coordination");
      calls.coordination = options;
      return coordinationService;
    },
    attentionCoordinatorFactory: (options) => {
      serviceOrder.push("attention-coordinator");
      calls.coordinator = options;
      return coordinator;
    },
  });

  assert.deepEqual(runtimeOrder, [
    "code-executor",
    "workflow",
    "ledger",
    "attention",
    "confirmation",
  ]);
  assert.deepEqual(serviceOrder, [
    "policy",
    "directory",
    "facts",
    "reconciler",
    "waker",
    "loop",
    "dispatcher",
    "coordination",
    "attention-coordinator",
  ]);
  assert.strictEqual(calls.ledger.store, store);
  assert.strictEqual(calls.ledger.assignmentSource, workflowRouting);
  assert.strictEqual(calls.attention.store, store);
  assert.notStrictEqual(
    calls.ledger.operationQueue,
    calls.attention.operationQueue,
  );
  assert.strictEqual(
    calls.directory.legacyEmployeeRegistry,
    application.employeeRegistry,
  );
  assert.deepEqual(calls.directory.legacyOwnedRoleIds, ["pr-reviewer"]);
  assert.strictEqual(calls.directory.workers, workers);
  assert.deepEqual(calls.policy, workCoordinationConfig().workCoordination.policy);
  assert.equal(calls.facts.maximumAgeMs, 7_000);
  assert.strictEqual(calls.reconciler.attentionConsumer, attentionConsumer);
  assert.strictEqual(calls.reconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.waker.factSource, factSource);
  assert.strictEqual(calls.waker.ledger, ledgerRuntime);
  assert.strictEqual(calls.loop.roleDirectory, roleDirectory);
  assert.equal(calls.loop.decideTimeoutMs, 3_000);
  assert.strictEqual(calls.dispatcher.policy, policy);
  assert.strictEqual(calls.dispatcher.attentionProducer, attentionProducer);
  assert.strictEqual(calls.coordination.workLoop, workLoop);
  assert.strictEqual(calls.coordination.dispatcher, dispatcher);
  assert.equal(calls.coordination.attentionLimit, 14);
  assert.strictEqual(calls.coordinator.externalQueue, confirmationQueue);
  assert.strictEqual(calls.coordinator.internalInbox, attentionBrowser);

  assert.deepEqual(Object.keys(application.workLedgerView).sort(), [
    "getSummary",
    "listItems",
    "listTimeline",
  ]);
  assert.deepEqual(Object.keys(application.attentionBrowser).sort(), [
    "answer",
    "later",
    "next",
    "reject",
  ]);
  assert.deepEqual(Object.keys(application.attentionCoordinator), ["next"]);
  assert.deepEqual(Object.keys(application.workCoordination).sort(), [
    "intake",
    "runCycle",
  ]);
  for (const port of [
    application.workLedgerView,
    application.attentionBrowser,
    application.attentionCoordinator,
    application.workCoordination,
  ]) {
    assert.equal(Object.isFrozen(port), true);
  }
  for (const privateName of [
    "workLedger",
    "workLedgerRuntime",
    "attentionInbox",
    "attentionInboxRuntime",
    "attentionProducer",
    "attentionConsumer",
  ]) {
    assert.equal(privateName in application, false);
  }
  assert.deepEqual(await application.workLedgerView.getSummary(), {
    source: "ledger",
  });
  assert.equal(await application.workCoordination.intake(), "intake-result");
  assert.equal(
    await application.attentionCoordinator.next(),
    "coordinated-attention",
  );

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("disabled work coordination does not acquire private runtimes or services", async () => {
  let workFactoryCalls = 0;
  const unexpectedFactory = () => {
    workFactoryCalls += 1;
    throw new Error("work coordination must stay disabled");
  };
  const application = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    workLedgerRuntimeFactory: unexpectedFactory,
    attentionInboxRuntimeFactory: unexpectedFactory,
    workIntentPolicyFactory: unexpectedFactory,
    workCoordinationFactory: unexpectedFactory,
  });

  assert.equal(workFactoryCalls, 0);
  assert.equal(application.workLedgerView, null);
  assert.equal(application.attentionBrowser, null);
  assert.equal(application.attentionCoordinator, null);
  assert.equal(application.workCoordination, null);
  await application.close();
});

test("enabled unified memory exposes search only and projects the existing work ledger", async () => {
  const config = {
    ...workCoordinationConfig({ externalActions: false }),
    memory: {
      enabled: true,
      maximumRecords: 1234,
      maximumStateBytes: 5_000_000,
    },
  };
  const calls = {};
  const memoryRuntime = {
    producer: { async appendBatch() {} },
    search: {
      async search(value) { return { items: [value], nextCursor: null }; },
      async getHealth() { return { ready: true }; },
    },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const projector = { async runCycle() { return { added: 0 }; } };
  const application = await createApplication({
    config,
    store: memoryStore(),
    workflowRoutingRuntimeFactory: async () => ({
      async readAssignmentBatch() {},
      async close() {},
    }),
    workLedgerRuntimeFactory: async () => ({
      async getSummary() {},
      async listItems() { return { items: [], nextCursor: null }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
      async close() {},
    }),
    attentionInboxRuntimeFactory: async () => ({
      producer: { async create() {} },
      consumer: { async readOutbox() {} },
      browser: {
        async next() {}, async answer() {}, async reject() {}, async later() {},
      },
      async close() {},
    }),
    memoryRuntimeFactory: async (options) => {
      calls.memory = options;
      return memoryRuntime;
    },
    memoryProjectorFactory: (options) => {
      calls.projector = options;
      return projector;
    },
    workIntentPolicyFactory: () => ({ async bind() {} }),
    roleWorkerDirectoryFactory: () => ({ async resolve() {} }),
    workflowFactSourceFactory: () => ({ async read() {} }),
    attentionResultReconcilerFactory: () => ({ async runCycle() {} }),
    workConditionWakerFactory: () => ({ async runCycle() {} }),
    proactiveWorkLoopFactory: () => ({ async runCycle() {} }),
    workIntentDispatcherFactory: () => ({ async dispatchPending() {} }),
    workCoordinationFactory: () => ({ async intake() {}, async runCycle() {} }),
    attentionCoordinatorFactory: () => ({ async next() {} }),
  });

  assert.equal(calls.memory.maximumRecords, 1234);
  assert.equal(calls.memory.maximumStateBytes, 5_000_000);
  assert.strictEqual(calls.projector.memoryProducer, memoryRuntime.producer);
  assert.equal(Object.isFrozen(application.memorySearch), true);
  assert.deepEqual(Object.keys(application.memorySearch).sort(), [
    "getHealth",
    "search",
  ]);
  assert.deepEqual(Object.keys(application.memoryProjector), ["runCycle"]);
  assert.equal("memoryRuntime" in application, false);
  assert.equal("memoryProducer" in application, false);
  assert.deepEqual(await application.memorySearch.search({ q: "test" }), {
    items: [{ q: "test" }],
    nextCursor: null,
  });
  await application.close();
});

test("application close is idempotent and attempts every runtime in reverse order", async () => {
  const closeCalls = [];
  const closeFailure = new Error("confirmation close failed");
  const application = await createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    workflowRoutingRuntimeFactory: async () => ({
      async close() {
        closeCalls.push("workflow");
      },
    }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort(),
      async close() {
        closeCalls.push("confirmation");
        throw closeFailure;
      },
    }),
  });

  const firstClose = application.close();
  const secondClose = application.close();
  assert.strictEqual(secondClose, firstClose);
  await assert.rejects(firstClose, (error) => error === closeFailure);
  await assert.rejects(secondClose, (error) => error === closeFailure);
  assert.deepEqual(closeCalls, ["confirmation", "workflow", "code-executor"]);
});

test("a later startup failure releases the acquired workflow runtime", async () => {
  const closeCalls = [];
  const startupFailure = new Error("confirmation startup failed");

  await assert.rejects(
    createApplication({
      config: externalActionConfig(),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("workflow");
        },
      }),
      confirmationRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, ["workflow", "code-executor"]);
});

test("work coordination startup preserves its error while closing every acquired runtime", async () => {
  const closeCalls = [];
  const startupFailure = new Error("attention startup failed");
  const cleanupFailure = new Error("ledger close failed");

  await assert.rejects(
    createApplication({
      config: workCoordinationConfig({ externalActions: false }),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async readAssignmentBatch() {},
        async close() {
          closeCalls.push("workflow");
        },
      }),
      workLedgerRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("ledger");
          throw cleanupFailure;
        },
      }),
      attentionInboxRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, ["ledger", "workflow", "code-executor"]);
});

test("external confirmation runtime requires both action authorization gates", async () => {
  let calls = 0;
  const createConfirmation = async () => {
    calls += 1;
    throw new Error("confirmation runtime must stay disabled");
  };
  const withoutConfiguredActions = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    confirmationRuntimeFactory: createConfirmation,
  });
  const withoutProcessAuthorization = await createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    externalActions: false,
    confirmationRuntimeFactory: createConfirmation,
  });

  assert.equal(calls, 0);
  assert.equal(withoutConfiguredActions.confirmationQueue, null);
  assert.equal(withoutProcessAuthorization.confirmationQueue, null);
  await withoutConfiguredActions.close();
  await withoutProcessAuthorization.close();
});

test("application awaits recovered executor composition and propagates failure", async () => {
  const executor = { id: "controlled-executor" };
  let release;
  const recovery = new Promise((resolve) => {
    release = resolve;
  });
  let composed = false;
  let factoryCalled = false;
  const pending = createApplication({
    config: applicationConfig({ enabled: true }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: () => {
      factoryCalled = true;
      return recovery;
    },
  }).then((application) => {
    composed = true;
    return application;
  });
  assert.equal(factoryCalled, true);
  assert.equal(composed, false);

  release({ executor, recovery: { recovered: true, cleanupPending: 0 } });
  const application = await pending;
  assert.strictEqual(application.codeExecutor, executor);

  const startupFailure = new Error("recovery failed");
  await assert.rejects(
    createApplication({
      config: applicationConfig({ enabled: true }),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
});

test("application awaits the private confirmation runtime and exposes only its queue facade", async () => {
  const queue = confirmationQueuePort();
  let release;
  const recoveredRuntime = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false;
  const pending = createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    confirmationRuntimeFactory: () => recoveredRuntime,
  }).then((application) => {
    completed = true;
    return application;
  });

  await Promise.resolve();
  assert.equal(completed, false);
  release({
    queue,
    producerQueue: confirmationProducerPort(),
    close: async () => {},
  });
  const application = await pending;

  assert.strictEqual(application.confirmationQueue, queue);
  assert.equal("confirmationRuntime" in application, false);
  assert.equal("githubActionExecutor" in application, false);
  assert.equal("executor" in application.confirmationQueue, false);
  assert.equal("recover" in application.confirmationQueue, false);
  await application.close();
});

test("employee recovery failure closes an acquired confirmation runtime", async () => {
  let closes = 0;
  const store = {
    async read(name, fallback = null) {
      if (name === "pr-employee-state") throw new Error("employee state corrupt");
      return fallback;
    },
    async write() {},
  };

  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        githubActions: {
          enabled: true,
          actorAccountId: "review-account",
        },
      },
      store,
      confirmationRuntimeFactory: async () => ({
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closes += 1;
        },
      }),
    }),
    /employee state corrupt/,
  );
  assert.equal(closes, 1);
});

test("application does not open until a persisted invalidation intent is recovered", async () => {
  const state = invalidationPendingEmployeeState();
  const store = storedValues({ "pr-employee-state": state });
  let releaseInvalidation;
  const invalidationGate = new Promise((resolve) => {
    releaseInvalidation = resolve;
  });
  let invalidationCalls = 0;
  let applicationOpened = false;
  const pending = createApplication({
    config: {
      ...applicationConfig(),
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
      },
    },
    store,
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort({
        async invalidate(id, intent) {
          invalidationCalls += 1;
          await invalidationGate;
          return {
            id,
            status: "stale",
            requestedBy: intent.requestedBy,
            approvalBindingDigest: intent.approvalBindingDigest,
            retryable: false,
            invalidation: {
              ...intent,
              at: "2026-08-02T01:02:00.000Z",
            },
          };
        },
      }),
      async close() {},
    }),
  }).then((application) => {
    applicationOpened = true;
    return application;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidationCalls, 1);
  assert.equal(applicationOpened, false);
  releaseInvalidation();
  const application = await pending;

  assert.equal(applicationOpened, true);
  assert.equal(
    (await store.read("pr-employee-state")).jobs[0].status,
    "superseded",
  );
  await application.close();
});

test("failed persisted invalidation recovery aborts startup and closes the runtime", async () => {
  const store = storedValues({
    "pr-employee-state": invalidationPendingEmployeeState(),
  });
  let closes = 0;
  const invalidationFailure = Object.assign(
    new Error("confirmation queue unavailable"),
    { statusCode: 503 },
  );

  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        githubActions: {
          enabled: true,
          actorAccountId: "review-account",
        },
      },
      store,
      confirmationRuntimeFactory: async () => ({
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort({
          async invalidate() {
            throw invalidationFailure;
          },
        }),
        async close() {
          closes += 1;
        },
      }),
    }),
    (error) => error.statusCode === 503 && /拒绝启动服务/.test(error.message),
  );

  assert.equal(closes, 1);
  assert.match(
    (await store.read("pr-employee-state")).jobs[0].error,
    /无法安全失效/,
  );
});

test("maintenance composition never acquires the external-action runtime", async () => {
  let confirmationFactoryCalls = 0;
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
      },
    },
    store: memoryStore(),
    externalActions: false,
    confirmationRuntimeFactory: async () => {
      confirmationFactoryCalls += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(confirmationFactoryCalls, 0);
  assert.equal(application.confirmationQueue, null);
  await application.close();
});
