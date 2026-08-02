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
      proposalLimit: 16,
      conditionLimit: 15,
      codeJobLimit: 9,
      codeJobMaximumTurns: 64,
      codeJobObservationLimit: 20,
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

function localCodeCoordinationConfig({ githubActions = true } = {}) {
  const base = workCoordinationConfig({ externalActions: githubActions });
  return {
    ...base,
    codeExecutor: { enabled: true },
    githubActions: githubActions
      ? { enabled: true, actorAccountId: "review-account" }
      : { enabled: false },
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    employees: {
      ...base.employees,
      roles: {
        developer: {
          brain: {
            provider: "ollama",
            model: "developer-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
        tester: {
          brain: {
            provider: "ollama",
            model: "tester-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
        "policy-only-role": {
          brain: {
            provider: "ollama",
            model: "policy-only-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
      },
    },
    workCoordination: {
      ...base.workCoordination,
      policy: {
        ...base.workCoordination.policy,
        codeActionRoles: ["developer", "tester", "role-without-policy"],
        codeOperationsByRole: {
          developer: ["inspect", "modify", "verify"],
          tester: ["inspect", "verify"],
          "policy-only-role": ["inspect"],
        },
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

function controlledCodeExecutorPort(overrides = {}) {
  return {
    async start() {},
    async view() {},
    async resume() {},
    async perform() {},
    async getActionResult() {},
    async reconcileAction() {},
    ...overrides,
  };
}

function codeJobControlPort() {
  return { async pause() {}, async resume() {} };
}

function codeJobWorkerPort() {
  return { async runCycle() {} };
}

function workProposalRuntimePort(overrides = {}) {
  const runner = { async claim() {}, async advance() {} };
  return {
    producer: { async create() {} },
    runners: { "github-review-runner": runner },
    consumer: { async readResultBatch() {} },
    async close() {},
    ...overrides,
  };
}

function localCoordinationStubs({ calls, closeCalls, runners }) {
  const workflow = {
    async readAssignmentBatch() {},
    async close() {
      closeCalls.push("workflow");
    },
  };
  const ledger = {
    async getSummary() {},
    async listItems() { return { items: [], nextCursor: null }; },
    async listTimeline() { return { items: [], nextCursor: null }; },
    async close() {
      closeCalls.push("ledger");
    },
  };
  const attention = {
    producer: { async create() {} },
    consumer: { async readOutbox() {} },
    browser: {
      async next() {},
      async answer() {},
      async reject() {},
      async later() {},
    },
    async close() {
      closeCalls.push("attention");
    },
  };
  const proposals = workProposalRuntimePort({
    runners,
    async close() {
      closeCalls.push("proposals");
    },
  });
  return {
    workflowRoutingRuntimeFactory: async () => workflow,
    workLedgerRuntimeFactory: async () => ledger,
    attentionInboxRuntimeFactory: async () => attention,
    workProposalRuntimeFactory: async (options) => {
      calls.proposalRuntime = options;
      return proposals;
    },
    configuredWorkforceFactory: () => ({ employees: [], workers: [] }),
    workIntentPolicyFactory: () => ({ async bind() {} }),
    roleWorkerDirectoryFactory: () => ({ async resolve() {} }),
    workflowFactSourceFactory: () => ({ async read() {} }),
    attentionResultReconcilerFactory: () => ({ async runCycle() {} }),
    workProposalResultReconcilerFactory: () => ({ async runCycle() {} }),
    workConditionWakerFactory: () => ({ async runCycle() {} }),
    proactiveWorkLoopFactory: () => ({ async runCycle() {} }),
    workIntentDispatcherFactory: () => ({ async dispatchPending() {} }),
    workCoordinationFactory: (options) => {
      calls.coordination = options;
      return { async intake() {}, async runCycle() {} };
    },
    attentionCoordinatorFactory: () => ({ async next() {} }),
  };
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

  assert.equal(Object.hasOwn(application, "codeExecutorRuntime"), false);
  assert.equal(Object.hasOwn(application, "codeExecutor"), false);
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
  const configuredWorker = { roleId: "requirements-analyst" };
  const configuredEmployee = {
    id: "requirements-analyst",
    scheduleMinutes: 3,
    async view() { return { role: await this.roleView() }; },
    async roleView() {
      return {
        id: this.id,
        name: "需求分析师",
        mission: "梳理需求",
        enabled: true,
        state: "paused",
        revision: 0,
        paused: true,
      };
    },
    async run() {},
    async control() {},
  };
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
  const proposalProducer = { async create() {} };
  const proposalConsumer = { async readResultBatch() {} };
  const confirmationQueue = confirmationQueuePort();
  const policy = { async bind() {} };
  const roleDirectory = { async resolve() {} };
  const factSource = { async read() {} };
  const reconciler = { async runCycle() {} };
  const proposalReconciler = { async runCycle() {} };
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
      return null;
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
    workProposalRuntimeFactory: async (options) => {
      runtimeOrder.push("proposals");
      calls.proposals = options;
      return workProposalRuntimePort({
        producer: proposalProducer,
        consumer: proposalConsumer,
        async close() {
          closeCalls.push("proposals");
        },
      });
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
    configuredWorkforceFactory: (options) => {
      calls.workforce = options;
      return {
        employees: [configuredEmployee],
        workers: [configuredWorker],
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
    workProposalResultReconcilerFactory: (options) => {
      serviceOrder.push("proposal-reconciler");
      calls.proposalReconciler = options;
      return proposalReconciler;
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
    "proposals",
    "confirmation",
  ]);
  assert.deepEqual(serviceOrder, [
    "policy",
    "directory",
    "facts",
    "reconciler",
    "proposal-reconciler",
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
  assert.notStrictEqual(
    calls.attention.operationQueue,
    calls.proposals.operationQueue,
  );
  assert.deepEqual(calls.proposals.runnerScopes, [
    {
      runnerId: "github-review-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
  ]);
  assert.strictEqual(
    calls.directory.legacyEmployeeRegistry,
    application.employeeRegistry,
  );
  assert.deepEqual(calls.directory.legacyOwnedRoleIds, ["pr-reviewer"]);
  assert.deepEqual(calls.directory.workers, [configuredWorker, ...workers]);
  assert.strictEqual(
    application.employeeRegistry.get("requirements-analyst"),
    configuredEmployee,
  );
  assert.deepEqual(calls.workforce.brainProviders, {});
  assert.deepEqual(calls.workforce.roles, {});
  assert.strictEqual(calls.workforce.store, store);
  assert.equal(typeof calls.workforce.onRun, "function");
  assert.deepEqual(
    await calls.workforce.onRun({ roleId: "requirements-analyst" }),
    {
      trigger: "employee:requirements-analyst",
      includeWork: true,
      roleId: "requirements-analyst",
    },
  );
  assert.deepEqual(calls.policy, workCoordinationConfig().workCoordination.policy);
  assert.equal(calls.facts.maximumAgeMs, 7_000);
  assert.strictEqual(calls.reconciler.attentionConsumer, attentionConsumer);
  assert.strictEqual(calls.reconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.proposalReconciler.proposalConsumer, proposalConsumer);
  assert.strictEqual(calls.proposalReconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.waker.factSource, factSource);
  assert.strictEqual(calls.waker.ledger, ledgerRuntime);
  assert.strictEqual(calls.loop.roleDirectory, roleDirectory);
  assert.equal(calls.loop.decideTimeoutMs, 3_000);
  assert.strictEqual(calls.dispatcher.policy, policy);
  assert.strictEqual(calls.dispatcher.attentionProducer, attentionProducer);
  assert.strictEqual(calls.dispatcher.proposalProducer, proposalProducer);
  assert.strictEqual(calls.coordination.workLoop, workLoop);
  assert.equal(typeof calls.coordination.proposalRunner.runCycle, "function");
  assert.strictEqual(calls.coordination.dispatcher, dispatcher);
  assert.equal(calls.coordination.attentionLimit, 14);
  assert.equal(calls.coordination.proposalLimit, 16);
  assert.strictEqual(
    calls.coordination.proposalResultReconciler,
    proposalReconciler,
  );
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
    "workProposalRuntime",
    "proposalProducer",
    "proposalConsumer",
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
    "proposals",
    "attention",
    "ledger",
    "workflow",
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
    workProposalRuntimeFactory: unexpectedFactory,
    workIntentPolicyFactory: unexpectedFactory,
    workCoordinationFactory: unexpectedFactory,
    workProposalResultReconcilerFactory: unexpectedFactory,
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
    workProposalRuntimeFactory: async () => workProposalRuntimePort(),
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
    workProposalResultReconcilerFactory: () => ({ async runCycle() {} }),
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
      externalActions: false,
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
  assert.equal(Object.hasOwn(application, "codeExecutor"), false);

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

test("local code composition binds authority, both proposal runners, and one safe reader", async () => {
  const calls = {};
  const closeCalls = [];
  const githubRunnerPort = { async claim() {}, async advance() {} };
  const codeRunnerPort = { async claim() {}, async advance() {} };
  const githubRunner = { id: "github-runner", async runCycle() {} };
  const codeRunner = { id: "code-runner", async runCycle() {} };
  const runnerGroup = { async runCycle() {} };
  const localExecutor = { async execute() {}, async reconcile() {} };
  const codeJobReader = {
    async get(id) { return { id }; },
    async list(value) { return { value }; },
    async listNewest(value) { return { newest: value }; },
  };
  const executorAuthority = Object.freeze({
    workspaces: Object.freeze([
      Object.freeze({
        id: "acme-workspace",
        writablePaths: Object.freeze(["src"]),
        requiredProfiles: Object.freeze([
          Object.freeze({ id: "node-tests", configDigest: "a".repeat(64) }),
        ]),
        authorityDigest: "b".repeat(64),
      }),
    ]),
  });
  const application = await createApplication({
    config: localCodeCoordinationConfig(),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: executorAuthority,
      executor: controlledCodeExecutorPort(),
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "github-review-runner": githubRunnerPort,
        "code-action-runner": codeRunnerPort,
      },
    }),
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: localExecutor,
        reader: codeJobReader,
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    codeJobGrantFactory: (options) => {
      calls.grantFactory = options;
      return { async create() {}, verify(value) { return value; } };
    },
    githubReviewProposalRunnerFactory: (options) => {
      calls.githubRunner = options;
      return githubRunner;
    },
    codeActionProposalRunnerFactory: (options) => {
      calls.codeRunner = options;
      return codeRunner;
    },
    workProposalRunnerGroupFactory: (runners) => {
      calls.runnerGroup = runners;
      return runnerGroup;
    },
  });

  assert.deepEqual(calls.proposalRuntime.runnerScopes, [
    {
      runnerId: "github-review-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
    {
      runnerId: "code-action-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer", "tester"],
    },
  ]);
  assert.strictEqual(calls.codeJobRuntime.store, application.store);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.executor), true);
  assert.deepEqual(Object.keys(calls.codeJobRuntime.executor).sort(), [
    "getActionResult",
    "perform",
    "reconcileAction",
    "resume",
    "start",
    "view",
  ]);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.brainDirectory), true);
  assert.deepEqual(calls.codeJobRuntime.workerLimits, {
    maxTurns: 64,
    observationLimit: 20,
  });
  assert.equal(Object.isFrozen(calls.confirmation.localExecutor), true);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutor).sort(), [
    "execute",
    "reconcile",
  ]);
  assert.strictEqual(calls.grantFactory.executorAuthority, executorAuthority);
  assert.equal(calls.grantFactory.policyVersion, 2);
  assert.deepEqual(calls.grantFactory.workspaceByRepository, {
    "acme/repo": "acme-workspace",
  });
  assert.deepEqual(calls.grantFactory.codeActionRoles, [
    "developer",
    "tester",
    "role-without-policy",
  ]);
  assert.deepEqual(calls.grantFactory.codeOperationsByRole, {
    developer: ["inspect", "modify", "verify"],
    tester: ["inspect", "verify"],
    "policy-only-role": ["inspect"],
  });
  assert.deepEqual(calls.grantFactory.brainByRole, {
    developer: localCodeCoordinationConfig().employees.roles.developer.brain,
    tester: localCodeCoordinationConfig().employees.roles.tester.brain,
    "policy-only-role":
      localCodeCoordinationConfig().employees.roles["policy-only-role"].brain,
  });
  assert.deepEqual(
    calls.grantFactory.brainProviders,
    localCodeCoordinationConfig().brainProviders,
  );
  assert.strictEqual(calls.githubRunner.runner, githubRunnerPort);
  assert.strictEqual(calls.codeRunner.runner, codeRunnerPort);
  assert.strictEqual(
    calls.codeRunner.confirmationProducer,
    calls.githubRunner.confirmationProducer,
  );
  assert.equal(Object.isFrozen(calls.codeRunner.codeJobReader), true);
  assert.deepEqual(Object.keys(calls.codeRunner.codeJobReader).sort(), [
    "get",
    "list",
    "listNewest",
  ]);
  assert.equal(typeof calls.codeRunner.grantFactory.create, "function");
  assert.deepEqual(calls.runnerGroup, [githubRunner, codeRunner]);
  assert.strictEqual(calls.coordination.proposalRunner, runnerGroup);
  assert.equal(Object.isFrozen(calls.coordination.codeJobRunner), true);
  assert.equal(typeof calls.coordination.codeJobRunner.runCycle, "function");
  assert.equal(calls.coordination.codeJobLimit, 9);

  assert.equal(Object.isFrozen(application.codeJobReader), true);
  assert.equal(Object.isFrozen(application.codeJobControl), true);
  assert.deepEqual(Object.keys(application.codeJobControl).sort(), [
    "pause",
    "resume",
  ]);
  assert.deepEqual(Object.keys(application.codeJobReader).sort(), [
    "get",
    "list",
    "listNewest",
  ]);
  assert.deepEqual(await application.codeJobReader.get("job-1"), { id: "job-1" });
  for (const privateName of [
    "codeJobRuntime",
    "codeJobStore",
    "codeJobExecutor",
    "codeJobWorker",
    "confirmationExecutor",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "code-job",
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local-only code actions still create confirmation while maintenance acquires neither guard", async () => {
  const calls = {};
  const closeCalls = [];
  const codeRunnerPort = { async claim() {}, async advance() {} };
  let codeJobCalls = 0;
  let confirmationCalls = 0;
  const baseOptions = {
    config: localCodeCoordinationConfig({ githubActions: false }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      executor: controlledCodeExecutorPort(),
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: { "code-action-runner": codeRunnerPort },
    }),
    codeJobRuntimeFactory: async () => {
      codeJobCalls += 1;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    confirmationRuntimeFactory: async () => {
      confirmationCalls += 1;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    codeJobGrantFactory: () => ({
      async create() {},
      verify(value) { return value; },
    }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: (runners) => runners[0] || null,
  };

  const application = await createApplication(baseOptions);
  assert.equal(codeJobCalls, 1);
  assert.equal(confirmationCalls, 1);
  assert.deepEqual(calls.proposalRuntime.runnerScopes, [
    {
      runnerId: "code-action-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer", "tester"],
    },
  ]);
  await application.close();

  codeJobCalls = 0;
  confirmationCalls = 0;
  const maintenance = await createApplication({
    ...baseOptions,
    externalActions: false,
  });
  assert.equal(codeJobCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(maintenance.codeJobReader, null);
  assert.equal(maintenance.codeJobControl, null);
  assert.deepEqual(calls.proposalRuntime.runnerScopes, []);
  await maintenance.close();
});

test("local composition constructs the real grant, handler, and runner group chain", async () => {
  const calls = {};
  const closeCalls = [];
  const authority = {
    workspaces: [
      {
        id: "acme-workspace",
        writablePaths: ["src"],
        requiredProfiles: [
          { id: "node-tests", configDigest: "a".repeat(64) },
        ],
        authorityDigest: "b".repeat(64),
      },
    ],
  };
  const application = await createApplication({
    config: localCodeCoordinationConfig({ githubActions: false }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority,
      executor: controlledCodeExecutorPort(),
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    codeJobRuntimeFactory: async () => ({
      confirmationExecutor: { async execute() {}, async reconcile() {} },
      reader: { async get() {}, async list() {}, async listNewest() {} },
      control: codeJobControlPort(),
      worker: codeJobWorkerPort(),
      async close() {},
    }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort(),
      async close() {},
    }),
  });

  assert.equal(typeof calls.coordination.proposalRunner.runCycle, "function");
  assert.equal(Object.isFrozen(application.codeJobReader), true);
  await application.close();
});

test("confirmation startup failure closes the already acquired local code runtime in reverse order", async () => {
  const calls = {};
  const closeCalls = [];
  const startupFailure = new Error("confirmation startup failed");

  await assert.rejects(
    createApplication({
      config: localCodeCoordinationConfig({ githubActions: false }),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        authority: { workspaces: [] },
        executor: controlledCodeExecutorPort(),
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "code-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      codeJobRuntimeFactory: async () => ({
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: { async get() {}, async list() {}, async listNewest() {} },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        async close() {
          closeCalls.push("code-job");
        },
      }),
      codeJobGrantFactory: () => ({
        async create() {},
        verify(value) { return value; },
      }),
      confirmationRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, [
    "code-job",
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local code startup rejects an empty role-policy intersection before acquiring later guards", async () => {
  const config = localCodeCoordinationConfig({ githubActions: false });
  config.workCoordination.policy.codeActionRoles = ["role-without-policy"];
  const closeCalls = [];
  let codeJobCalls = 0;
  let confirmationCalls = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        authority: { workspaces: [] },
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("workflow");
        },
      }),
      codeJobRuntimeFactory: async () => {
        codeJobCalls += 1;
      },
      confirmationRuntimeFactory: async () => {
        confirmationCalls += 1;
      },
    }),
    /没有同时满足岗位和操作策略的执行角色/,
  );
  assert.equal(codeJobCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(closeCalls, ["workflow", "code-executor"]);
});
