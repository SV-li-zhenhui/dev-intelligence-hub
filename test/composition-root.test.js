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
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
} from "../src/domain/work-proposal-contract.js";

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
      codeJobMemoryLimit: 18,
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
    memory: { enabled: true },
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
    async reconcileCancellation() {},
    ...overrides,
  };
}

function codeJobControlPort() {
  return { async pause() {}, async resume() {}, async cancel() {} };
}

function codeJobWorkerPort() {
  return { async runCycle() {} };
}

function codeJobProjectionSourcePort() {
  return {
    async readBatch() {
      return { cursor: 0, highWatermark: 0, items: [] };
    },
    async ack() {},
  };
}

function graphMemoryProjectionSourcePort() {
  return {
    async readBatch() {
      return { cursor: 0, highWatermark: 0, items: [] };
    },
    async ack() {},
    async ackBatch() {},
  };
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
    graphReader: { async getSnapshot() { return { graphRevision: 0 }; } },
    graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
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
  const memory = {
    producer: { async append() {}, async appendBatch() {} },
    search: { async search() {}, async getHealth() {} },
    contextReader: { async readRecords() {} },
    receiptVerifier: {
      async verify(value) { return { ...value, persisted: true }; },
    },
    maintenance: { async rebuildIndex() {} },
    async close() {
      closeCalls.push("memory");
    },
  };
  return {
    workflowRoutingRuntimeFactory: async (_config, options) => {
      calls.workflowRuntime = options;
      return workflow;
    },
    workLedgerRuntimeFactory: async (options) => {
      calls.ledgerRuntime = options;
      return ledger;
    },
    attentionInboxRuntimeFactory: async () => attention,
    workProposalRuntimeFactory: async (options) => {
      calls.proposalRuntime = options;
      return proposals;
    },
    memoryRuntimeFactory: async (options) => {
      calls.memoryRuntime = options;
      return memory;
    },
    configuredWorkforceFactory: (options) => {
      calls.workforce = options;
      return { employees: [], workers: [] };
    },
    workIntentPolicyFactory: () => ({ async bind() {} }),
    roleWorkerDirectoryFactory: () => ({ async resolve() {} }),
    workflowFactSourceFactory: () => ({ async read() {} }),
    roleContextAssemblerFactory: () => ({ async assemble() {} }),
    orchestratorServiceFactory: (options) => {
      calls.orchestratorService = options;
      return { async execute() {} };
    },
    attentionResultReconcilerFactory: () => ({ async runCycle() {} }),
    workProposalResultReconcilerFactory: (options) => {
      calls.proposalResultReconciler = options;
      return { async runCycle() {} };
    },
    workConditionWakerFactory: (options) => {
      calls.waker = options;
      return { async runCycle() {} };
    },
    proactiveWorkLoopFactory: (options) => {
      calls.loop = options;
      return { async runCycle() {} };
    },
    workIntentDispatcherFactory: (options) => {
      calls.dispatcher = options;
      return { async dispatchPending() {} };
    },
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
  assert.equal("actionAdmissionGate" in calls[0].dependencies, false);
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
    graphReader: {
      async getSnapshot() {
        return { graphRevision: 7, tasks: [] };
      },
      async createChild() {
        throw new Error("graph writes must remain private");
      },
    },
    graphPlanner: {
      async createChild() {
        throw new Error("graph planner must remain private");
      },
    },
    graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
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
  const roleContextAssembler = { async assemble() {} };
  const orchestratorService = { async execute() {} };
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
    roleContextAssemblerFactory: (options) => {
      serviceOrder.push("context-assembler");
      calls.contextAssembler = options;
      return roleContextAssembler;
    },
    orchestratorServiceFactory: (options) => {
      serviceOrder.push("orchestrator-service");
      calls.orchestratorService = options;
      return orchestratorService;
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
    "context-assembler",
    "orchestrator-service",
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
  assert.equal("actionAdmissionGate" in calls.ledger, false);
  assert.equal("actionAdmissionGate" in calls.proposals, false);
  assert.equal("actionAdmissionGate" in calls.dispatcher, false);
  assert.equal("actionAdmissionGate" in calls.orchestratorService, false);
  assert.equal("actionAdmissionGate" in calls.waker, false);
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
  assert.strictEqual(calls.contextAssembler.graphReader, ledgerRuntime.graphReader);
  assert.strictEqual(calls.contextAssembler.factSource, factSource);
  assert.strictEqual(
    calls.orchestratorService.contextAssembler,
    roleContextAssembler,
  );
  assert.strictEqual(
    calls.orchestratorService.graphReader,
    ledgerRuntime.graphReader,
  );
  assert.deepEqual(calls.orchestratorService.capabilityRoles, {
    testing: "tester",
  });
  assert.strictEqual(calls.reconciler.attentionConsumer, attentionConsumer);
  assert.strictEqual(calls.reconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.proposalReconciler.proposalConsumer, proposalConsumer);
  assert.strictEqual(calls.proposalReconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.waker.factSource, factSource);
  assert.strictEqual(calls.waker.ledger, ledgerRuntime);
  assert.strictEqual(calls.loop.roleDirectory, roleDirectory);
  assert.strictEqual(calls.loop.roleContextAssembler, roleContextAssembler);
  assert.strictEqual(calls.loop.orchestratorService, orchestratorService);
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
  assert.deepEqual(Object.keys(application.workGraphView), ["getSnapshot"]);
  assert.notStrictEqual(application.workGraphView, ledgerRuntime.graphReader);
  assert.equal("createChild" in application.workGraphView, false);
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
    application.workGraphView,
    application.attentionBrowser,
    application.attentionCoordinator,
    application.workCoordination,
  ]) {
    assert.equal(Object.isFrozen(port), true);
  }
  for (const privateName of [
    "workLedger",
    "workLedgerRuntime",
    "graphReader",
    "graphPlanner",
    "workGraphPlanner",
    "workGraphStore",
    "createGraphChild",
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
  assert.deepEqual(await application.workGraphView.getSnapshot(), {
    graphRevision: 7,
    tasks: [],
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

test("work coordination normalizes omitted timing before composing the loop and orchestrator", async () => {
  const cases = [
    {
      omitted: [
        "leaseDurationMs",
        "resolveTimeoutMs",
        "decisionTimeoutMs",
      ],
      expected: {
        leaseDurationMs: 120_000,
        resolveTimeoutMs: 10_000,
        decideTimeoutMs: 60_000,
        evidenceVerificationTimeoutMs: 49_000,
      },
    },
    {
      omitted: ["decisionTimeoutMs"],
      expected: {
        leaseDurationMs: 16_000,
        resolveTimeoutMs: 2_000,
        decideTimeoutMs: 3_000,
        evidenceVerificationTimeoutMs: 10_000,
      },
    },
  ];

  for (const { omitted, expected } of cases) {
    const config = structuredClone(
      workCoordinationConfig({ externalActions: false }),
    );
    for (const field of omitted) delete config.workCoordination[field];
    const calls = {};
    const closeCalls = [];
    const application = await createApplication({
      config,
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    });

    assert.equal(calls.loop.leaseDurationMs, expected.leaseDurationMs);
    assert.equal(calls.loop.resolveTimeoutMs, expected.resolveTimeoutMs);
    assert.equal(calls.loop.decideTimeoutMs, expected.decideTimeoutMs);
    assert.equal(
      calls.orchestratorService.evidenceVerificationTimeoutMs,
      expected.evidenceVerificationTimeoutMs,
    );
    assert.equal(
      calls.orchestratorService.evidenceMutationMarginMs,
      1_000,
    );
    assert.equal(
      calls.loop.resolveTimeoutMs +
        calls.loop.decideTimeoutMs +
        calls.orchestratorService.evidenceMutationMarginMs +
        calls.orchestratorService.evidenceVerificationTimeoutMs,
      calls.loop.leaseDurationMs,
    );

    await application.close();
  }
});

test("work coordination rejects optional timing below the role-context budget", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  config.workCoordination.leaseDurationMs = 12_999;
  delete config.workCoordination.resolveTimeoutMs;
  delete config.workCoordination.decisionTimeoutMs;
  const calls = {};
  const closeCalls = [];

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    }),
    /must preserve at least 1000ms.*10000ms for evidence verification/,
  );
  assert.equal(calls.loop, undefined);
  assert.deepEqual(closeCalls, ["workflow"]);
});

test("default delivery evidence service is shared, least-authority, and verifies trusted results", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  const calls = {};
  const closeCalls = [];
  const taskId = "task-review";
  const roleId = "pr-reviewer";
  const proposalId = "proposal-review-1";
  const contractDigest = "b".repeat(64);
  const evidenceTarget = {
    schemaVersion: 1,
    taskId,
    roleId,
    contractRevision: 4,
    contractDigest,
    deliverables: [
      { deliverableId: "review", kind: "review-report" },
    ],
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId, workItemId: taskId },
    source: { assignmentId: "assignment-review", eventId: "event-review" },
    binding: { evidenceTarget },
    payload: { verdict: "comment", body: "Review completed" },
  });
  const result = createWorkProposalResult({
    proposal,
    sequence: 1,
    transition: {
      status: "succeeded",
      summary: "Review published",
      evidence: ["github-review:published"],
    },
    downstreamRef: "github-review-1",
    at: "2026-08-06T01:00:00.000Z",
  });
  const resultId = result.resultId;
  const resultDigest = result.contentDigest;
  const authoritativeEvidence = {
    kind: "review-report",
    referenceId: resultId,
    contentDigest: resultDigest,
  };
  const evidenceReaderCalls = [];
  const proposalRuntime = workProposalRuntimePort({
    runners: {},
    evidenceReader: {
      async getResult({ resultId: requestedResultId }) {
        evidenceReaderCalls.push(["getResult", requestedResultId]);
        return requestedResultId === resultId ? structuredClone(result) : null;
      },
      async getResultForProposal() {
        throw new Error("review verification uses its exact result id");
      },
      async getProposalForEvidence({ proposalId: requestedProposalId }) {
        evidenceReaderCalls.push([
          "getProposalForEvidence",
          requestedProposalId,
        ]);
        return requestedProposalId === proposalId
          ? structuredClone(proposal)
          : null;
      },
      async listEvidenceCandidates() {
        throw new Error("verification must use exact result authority");
      },
    },
  });
  const compositionStubs = localCoordinationStubs({
    calls,
    closeCalls,
    runners: {},
  });

  const application = await createApplication({
    config,
    store: memoryStore(),
    ...compositionStubs,
    workProposalRuntimeFactory: async (options) => {
      calls.proposalRuntime = options;
      return proposalRuntime;
    },
    roleContextAssemblerFactory: (options) => {
      calls.contextAssembler = options;
      return { async assemble() {} };
    },
  });

  assert.strictEqual(
    calls.contextAssembler.evidenceCatalog,
    application.deliveryEvidence,
  );
  assert.strictEqual(
    calls.orchestratorService.evidenceVerifier,
    application.deliveryEvidence,
  );
  assert.deepEqual(Object.keys(application.deliveryEvidence), [
    "listForTask",
    "verify",
  ]);
  assert.equal(Object.isFrozen(application.deliveryEvidence), true);
  assert.equal("getResult" in application.deliveryEvidence, false);
  assert.equal("getProposalForEvidence" in application.deliveryEvidence, false);

  const coordination = config.workCoordination;
  const evidenceBudget =
    coordination.leaseDurationMs -
    coordination.resolveTimeoutMs -
    coordination.decisionTimeoutMs -
    1_000;
  assert.equal(
    calls.orchestratorService.evidenceVerificationTimeoutMs,
    evidenceBudget,
  );
  assert.equal(
    calls.orchestratorService.evidenceVerificationTimeoutMs +
      calls.orchestratorService.evidenceMutationMarginMs +
      coordination.resolveTimeoutMs +
      coordination.decisionTimeoutMs <=
      coordination.leaseDurationMs,
    true,
  );

  assert.deepEqual(
    await application.deliveryEvidence.verify({
      taskId,
      roleId,
      contractRevision: evidenceTarget.contractRevision,
      contractDigest,
      deliverableId: "review",
      evidence: authoritativeEvidence,
    }),
    authoritativeEvidence,
  );
  assert.deepEqual(evidenceReaderCalls, [
    ["getResult", resultId],
    ["getProposalForEvidence", proposalId],
  ]);

  await application.close();
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
  assert.equal(application.workGraphView, null);
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
    receiptVerifier: {
      async verify(value) { return { ...value, persisted: true }; },
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
      graphReader: { async getSnapshot() { return { graphRevision: 0 }; } },
      scopedGraphPlannerFactory: { forRoot() {} },
      graphDelivererFactory: { forClaim() {} },
      graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
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
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: null,
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: null,
        projectionSource: codeJobProjectionSourcePort(),
        async close() {},
      };
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
  assert.equal(Object.isFrozen(calls.projector.graphProjectionSource), true);
  assert.deepEqual(
    Object.keys(calls.projector.graphProjectionSource).sort(),
    ["ackBatch", "readBatch"],
  );
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

test("cited memory answering wires only trusted retrieval and configured brain ports", async () => {
  const configuredBrain = {
    provider: "ollama",
    model: "configured-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const localBrain = {
    provider: "ollama",
    model: "local-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const config = {
    ...applicationConfig(),
    memory: {
      enabled: true,
      answering: {
        enabled: true,
        maximumRecords: 7,
        maximumContextBytes: 110_000,
        maximumConcurrent: 2,
        brain: configuredBrain,
        localBrain,
      },
    },
    brainProviders: { ollama: { kind: "ollama" } },
  };
  const calls = {};
  const memoryRuntime = {
    producer: { async append() {}, async appendBatch() {} },
    search: {
      async search() { return { items: [], nextCursor: null }; },
      async getHealth() { return { ready: true }; },
    },
    contextReader: { async readRecords() {} },
    receiptVerifier: { async verify() {} },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const router = { async generate() {}, describe() {} };
  const retriever = { async retrieve() {} };
  const answerService = {
    async answer(value) { return { value }; },
    async hiddenWrite() {},
  };

  const application = await createApplication({
    config,
    store: memoryStore(),
    memoryRuntimeFactory: async () => memoryRuntime,
    memoryBrainRouterFactory: (options) => {
      calls.router = options;
      return router;
    },
    memoryContextRetrieverFactory: (options) => {
      calls.retriever = options;
      return retriever;
    },
    memoryAnswerServiceFactory: (options) => {
      calls.answer = options;
      return answerService;
    },
    memoryAnswerDependencies: {
      brainDependencies: { fetch: "injected-fetch" },
      beforeGenerate: async () => {},
    },
  });

  assert.deepEqual(calls.router, {
    brainProviders: config.brainProviders,
    dependencies: { fetch: "injected-fetch" },
  });
  assert.equal(Object.isFrozen(calls.retriever.memorySearch), true);
  assert.deepEqual(Object.keys(calls.retriever.memorySearch), ["search"]);
  assert.equal(Object.isFrozen(calls.retriever.contextReader), true);
  assert.deepEqual(Object.keys(calls.retriever.contextReader), ["readRecords"]);
  assert.equal(calls.retriever.maximumRecords, 7);
  assert.equal(calls.retriever.maximumContextBytes, 110_000);
  assert.strictEqual(calls.answer.contextRetriever, retriever);
  assert.strictEqual(calls.answer.brainRouter, router);
  assert.deepEqual(calls.answer.configuredBrain, configuredBrain);
  assert.deepEqual(calls.answer.localBrain, localBrain);
  assert.equal(calls.answer.maximumConcurrent, 2);
  assert.equal(typeof calls.answer.beforeGenerate, "function");
  assert.equal(Object.isFrozen(application.memoryAnswer), true);
  assert.deepEqual(Object.keys(application.memoryAnswer), ["answer"]);
  assert.equal("contextReader" in application, false);
  assert.equal("hiddenWrite" in application.memoryAnswer, false);
  assert.deepEqual(await application.memoryAnswer.answer({ safe: true }), {
    value: { safe: true },
  });
  await application.close();
});

test("memory imports are explicit opt-in ports with append-only authority", async () => {
  const config = {
    ...applicationConfig(),
    memory: {
      enabled: true,
      imports: { localSessions: true, git: true },
    },
  };
  const calls = {};
  const producer = {
    async append() {},
    async appendBatch(value) { return value; },
    async hiddenErase() {},
  };
  const memoryRuntime = {
    producer,
    search: { async search() {}, async getHealth() {} },
    contextReader: { async readRecords() {} },
    receiptVerifier: { async verify() {} },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const sessionImporter = {
    async importSession(value) { return { kind: "session", value }; },
    async hiddenImport() {},
  };
  const gitImporter = {
    async importCommits(value) { return { kind: "git", value }; },
    async hiddenImport() {},
  };

  const application = await createApplication({
    config,
    store: memoryStore(),
    memoryRuntimeFactory: async () => memoryRuntime,
    localSessionImporterFactory: (options) => {
      calls.session = options;
      return sessionImporter;
    },
    gitActivityImporterFactory: (options) => {
      calls.git = options;
      return gitImporter;
    },
  });

  for (const options of [calls.session, calls.git]) {
    assert.equal(Object.isFrozen(options.memoryProducer), true);
    assert.deepEqual(Object.keys(options.memoryProducer), ["appendBatch"]);
    assert.equal("hiddenErase" in options.memoryProducer, false);
  }
  assert.equal(Object.isFrozen(application.memoryImports), true);
  assert.deepEqual(Object.keys(application.memoryImports), ["session", "git"]);
  assert.deepEqual(Object.keys(application.memoryImports.session), ["importSession"]);
  assert.deepEqual(Object.keys(application.memoryImports.git), ["importCommits"]);
  assert.equal("hiddenImport" in application.memoryImports.session, false);
  assert.deepEqual(
    await application.memoryImports.session.importSession({ id: "s1" }),
    { kind: "session", value: { id: "s1" } },
  );
  assert.deepEqual(
    await application.memoryImports.git.importCommits({ id: "g1" }),
    { kind: "git", value: { id: "g1" } },
  );
  await application.close();
});

test("disabling unified memory also disables answering and import children", async () => {
  const calls = { runtime: 0, answer: 0, sessionImport: 0, gitImport: 0 };
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      memory: {
        enabled: false,
        answering: { enabled: true },
        imports: { localSessions: true, git: true },
      },
    },
    store: memoryStore(),
    memoryRuntimeFactory: async () => {
      calls.runtime += 1;
      return null;
    },
    memoryAnswerServiceFactory: () => {
      calls.answer += 1;
      return { async answer() {} };
    },
    localSessionImporterFactory: () => {
      calls.sessionImport += 1;
      return { async importSession() {} };
    },
    gitActivityImporterFactory: () => {
      calls.gitImport += 1;
      return { async importCommits() {} };
    },
  });

  assert.equal(application.memorySearch, null);
  assert.equal(application.memoryAnswer, null);
  assert.equal(application.memoryImports, null);
  assert.deepEqual(calls, {
    runtime: 0,
    answer: 0,
    sessionImport: 0,
    gitImport: 0,
  });
  await application.close();
});

test("enabled memory children fail closed when the runtime factory is unavailable", async () => {
  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        memory: {
          enabled: true,
          answering: { enabled: true },
          imports: { localSessions: true, git: true },
        },
      },
      store: memoryStore(),
      memoryRuntimeFactory: async () => null,
    }),
    /记忆问答需要启用统一记忆运行时/,
  );
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

test("change package composition derives trusted targets and shares the confirmation queue", async () => {
  const calls = {};
  const closeCalls = [];
  const trustedTargets = Object.freeze([
    Object.freeze({
      workspaceId: "dashboard",
      sourceRoot: "D:\\trusted\\dashboard",
      targetAuthorityDigest: "a".repeat(64),
      writablePaths: Object.freeze(["src"]),
      excludePaths: Object.freeze(["node_modules"]),
    }),
  ]);
  const applicationExecutor = { async execute() {}, async reconcile() {} };
  const preparedPlan = { id: "confirmation-change-package-1" };
  const runtime = {
    packageReader: {
      async get(id) { return { packageId: id }; },
      async readFile() { throw new Error("must remain private"); },
    },
    applicationProducer: {
      async prepareConfirmation(value) {
        calls.prepared = value;
        return preparedPlan;
      },
    },
    applicationExecutor,
    applicationReader: {
      async getResult(id) { return { confirmationId: id }; },
    },
    applicationProjectionReader: {
      async getForJob(id) { return { status: "not_requested", jobId: id }; },
      async getForPackage() {},
      async getSummary() {},
    },
    applicationProjectionWriter: {
      async getCheckpoint() {},
      async applySnapshot() {},
    },
    async close() { closeCalls.push("change-package"); },
  };
  const confirmationProducer = confirmationProducerPort({
    async enqueue(plan) {
      calls.enqueued = plan;
      return { status: "applied", id: plan.id };
    },
  });
  const config = {
    ...applicationConfig({ enabled: true }),
    changePackages: {
      enabled: true,
      gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    },
  };
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      changePackageTargets: trustedTargets,
      async close() { closeCalls.push("code-executor"); },
    }),
    changePackageRuntimeFactory: async (runtimeConfig, dependencies) => {
      calls.runtimeConfig = runtimeConfig;
      calls.runtimeDependencies = dependencies;
      return runtime;
    },
    confirmationRuntimeFactory: async (_runtimeConfig, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducer,
        async close() { closeCalls.push("confirmation"); },
      };
    },
  });

  assert.strictEqual(calls.runtimeConfig, config.changePackages);
  assert.strictEqual(calls.runtimeDependencies.trustedTargets, trustedTargets);
  assert.strictEqual(calls.runtimeDependencies.store, application.store);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors), [
    "local.change-package-apply",
  ]);
  assert.equal(Object.isFrozen(calls.confirmation.localExecutors), true);
  assert.equal(
    Object.isFrozen(
      calls.confirmation.localExecutors["local.change-package-apply"],
    ),
    true,
  );
  assert.deepEqual(Object.keys(application.changePackageReader), ["get"]);
  assert.deepEqual(
    await application.changePackageReader.get("change-package-1"),
    { packageId: "change-package-1" },
  );
  assert.deepEqual(
    await application.changePackageApplicationReader.getResult(
      "confirmation-change-package-1",
    ),
    { confirmationId: "confirmation-change-package-1" },
  );
  assert.deepEqual(
    await application.changePackageApplicationStatusReader.getForJob(
      "code-job-1",
    ),
    { status: "not_requested", jobId: "code-job-1" },
  );
  assert.deepEqual(
    Object.keys(application.changePackageApplicationStatusReader),
    ["getForJob"],
  );
  const request = {
    packageId: "change-package-1",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
  };
  assert.deepEqual(
    await application.changePackageApplicationRequester.request(request),
    { status: "applied", id: preparedPlan.id },
  );
  assert.strictEqual(calls.prepared, request);
  assert.strictEqual(calls.enqueued, preparedPlan);
  for (const privateName of [
    "changePackageRuntime",
    "changePackageProducer",
    "changePackageApplicationExecutor",
    "changePackageApplicationProducer",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "change-package",
    "code-executor",
  ]);
});

test("maintenance mode does not acquire change package write authority", async () => {
  let changePackageCalls = 0;
  let confirmationCalls = 0;
  const application = await createApplication({
    config: {
      ...applicationConfig({ enabled: true }),
      changePackages: {
        enabled: true,
        gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
      },
    },
    store: memoryStore(),
    externalActions: false,
    codeExecutorRuntimeFactory: async () => ({
      changePackageTargets: [{}],
    }),
    changePackageRuntimeFactory: async () => {
      changePackageCalls += 1;
    },
    confirmationRuntimeFactory: async () => {
      confirmationCalls += 1;
    },
  });

  assert.equal(changePackageCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(application.changePackageReader, null);
  assert.equal(application.changePackageApplicationReader, null);
  assert.equal(application.changePackageApplicationStatusReader, null);
  assert.equal(application.changePackageApplicationRequester, null);
  await application.close();
});

test("local code and change package composition injects only frozen delivery ports", async () => {
  const calls = {};
  const applicationRequestOrder = [];
  const closeCalls = [];
  const config = {
    ...localCodeCoordinationConfig({ githubActions: false }),
    changePackages: {
      enabled: true,
      gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    },
  };
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      executor: controlledCodeExecutorPort(),
      changePackageTargets: [{ workspaceId: "dashboard" }],
      completedChangeExporter: { async export() {} },
      auditArtifactReader: {
        async read(value) { return Buffer.from(JSON.stringify(value)); },
      },
      async close() {},
    }),
    changePackageRuntimeFactory: async () => ({
      packageProducer: { async create() {} },
      packageReader: { async get() {}, async readFile() {} },
      applicationProducer: {
        async prepareConfirmation(value) {
          applicationRequestOrder.push("prepare");
          calls.applicationRequest = value;
          return { id: "confirmation-change-package-1" };
        },
      },
      applicationExecutor: { async execute() {}, async reconcile() {} },
      applicationReader: { async getResult() {} },
      applicationProjectionReader: {
        async getForJob() {}, async getForPackage() {}, async getSummary() {},
      },
      applicationProjectionWriter: {
        async getCheckpoint() {
          return { sourceRevision: 0, sourceSnapshotDigest: "0".repeat(64) };
        },
        async applySnapshot() {},
      },
      async close() {},
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        changePackageDelivery: { async runCycle() {} },
        async close() {},
      };
    },
    codeJobEvidenceReaderFactory: (options) => {
      calls.codeJobEvidenceReader = options;
      return {
        async read(value) {
          return { request: value };
        },
      };
    },
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort({
        async enqueue(value) {
          applicationRequestOrder.push("enqueue");
          calls.applicationPlan = value;
          return { id: value.id, status: "pending", queueRevision: 9 };
        },
      }),
      applicationResultSource: { async readSnapshot() {} },
      async close() {},
    }),
    changePackageApplicationResultReconcilerFactory: () => ({
      async runCycle() {
        return { status: "applied" };
      },
      async runThrough(sourceRevision) {
        applicationRequestOrder.push("reconcile");
        calls.applicationSourceRevision = sourceRevision;
        return { status: "applied", sourceRevision };
      },
    }),
    codeJobGrantFactory: () => ({
      async create() {},
      verify(value) { return value; },
    }),
    codeJobBrainDirectoryFactory: () => ({ async decide() {} }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: (runners) => runners[0],
  });

  for (const [name, methods] of [
    ["completedChangeExporter", ["export"]],
    ["changePackageProducer", ["create"]],
    ["changePackageReader", ["get"]],
  ]) {
    assert.equal(Object.isFrozen(calls.codeJobRuntime[name]), true);
    assert.deepEqual(Object.keys(calls.codeJobRuntime[name]), methods);
  }
  assert.equal(
    Object.isFrozen(calls.coordination.codeJobChangePackageDispatcher),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.coordination.codeJobChangePackageDispatcher),
    ["runCycle"],
  );
  assert.equal(
    Object.isFrozen(
      calls.coordination.changePackageApplicationResultReconciler,
    ),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.coordination.changePackageApplicationResultReconciler),
    ["runCycle"],
  );
  const applicationRequest = {
    packageId: "change-package-1",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
  };
  assert.deepEqual(
    await application.changePackageApplicationRequester.request(
      applicationRequest,
    ),
    {
      id: "confirmation-change-package-1",
      status: "pending",
      queueRevision: 9,
    },
  );
  assert.strictEqual(calls.applicationRequest, applicationRequest);
  assert.deepEqual(calls.applicationPlan, {
    id: "confirmation-change-package-1",
  });
  assert.deepEqual(applicationRequestOrder, [
    "prepare",
    "enqueue",
    "reconcile",
  ]);
  assert.equal(calls.applicationSourceRevision, 9);
  for (const [name, methods] of [
    ["codeJobReader", ["get", "getDetail", "list", "listNewest"]],
    ["changePackageReader", ["get"]],
    ["auditArtifactReader", ["read"]],
  ]) {
    assert.equal(Object.isFrozen(calls.codeJobEvidenceReader[name]), true);
    assert.deepEqual(
      Object.keys(calls.codeJobEvidenceReader[name]).sort(),
      methods.sort(),
    );
  }
  assert.equal(Object.isFrozen(application.codeJobEvidenceReader), true);
  assert.deepEqual(Object.keys(application.codeJobEvidenceReader), ["read"]);
  assert.deepEqual(
    await application.codeJobEvidenceReader.read({ evidence: "request" }),
    { request: { evidence: "request" } },
  );
  for (const privateName of [
    "completedChangeExporter",
    "changePackageProducer",
    "changePackageDelivery",
    "codeJobChangePackageDispatcher",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
});

test("local code execution fails closed when unified memory is disabled", async () => {
  const config = localCodeCoordinationConfig({ githubActions: false });
  config.memory.enabled = false;
  const calls = {};
  const closeCalls = [];
  let codeJobCalls = 0;

  await assert.rejects(
    createApplication({
      config,
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
      codeJobRuntimeFactory: async () => {
        codeJobCalls += 1;
      },
    }),
    /需要启用统一记忆运行时/,
  );

  assert.equal(codeJobCalls, 0);
  assert.deepEqual(closeCalls, [
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local code composition binds authority, both proposal runners, and one safe reader", async () => {
  const calls = {};
  const closeCalls = [];
  const githubRunnerPort = { async claim() {}, async advance() {} };
  const codeRunnerPort = { async claim() {}, async advance() {} };
  const githubRunner = { id: "github-runner", async runCycle() {} };
  const codeRunner = { id: "code-runner", async runCycle() {} };
  const runnerGroup = { async runCycle() {} };
  const codeJobMemoryProjector = { async runCycle() {} };
  const localExecutor = { async execute() {}, async reconcile() {} };
  const codeJobReader = {
    async get(id) { return { id }; },
    async getDetail(value) { return { detail: value }; },
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
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    codeJobMemoryProjectorFactory: (options) => {
      calls.codeJobMemoryProjector = options;
      return codeJobMemoryProjector;
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
    "reconcileCancellation",
    "resume",
    "start",
    "view",
  ]);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.brainDirectory), true);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.memoryReceiptVerifier), true);
  assert.deepEqual(
    Object.keys(calls.codeJobRuntime.memoryReceiptVerifier),
    ["verify"],
  );
  assert.deepEqual(calls.codeJobRuntime.workerLimits, {
    maxTurns: 64,
    observationLimit: 20,
  });
  assert.equal(Object.isFrozen(calls.confirmation.localExecutors), true);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors), [
    "local.code-job-create",
  ]);
  assert.equal(
    Object.isFrozen(
      calls.confirmation.localExecutors["local.code-job-create"],
    ),
    true,
  );
  assert.deepEqual(Object.keys(
    calls.confirmation.localExecutors["local.code-job-create"],
  ).sort(), [
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
    "getDetail",
    "list",
    "listNewest",
  ]);
  assert.strictEqual(
    calls.proposalResultReconciler.codeJobReader,
    calls.codeRunner.codeJobReader,
  );
  assert.equal(typeof calls.codeRunner.grantFactory.create, "function");
  assert.deepEqual(calls.runnerGroup, [githubRunner, codeRunner]);
  assert.strictEqual(calls.coordination.proposalRunner, runnerGroup);
  assert.equal(Object.isFrozen(calls.coordination.codeJobRunner), true);
  assert.equal(typeof calls.coordination.codeJobRunner.runCycle, "function");
  assert.equal(calls.coordination.codeJobLimit, 9);
  assert.equal(Object.isFrozen(calls.codeJobMemoryProjector.projectionSource), true);
  assert.deepEqual(
    Object.keys(calls.codeJobMemoryProjector.projectionSource).sort(),
    ["ack", "readBatch"],
  );
  assert.equal(Object.isFrozen(calls.codeJobMemoryProjector.memoryProducer), true);
  assert.deepEqual(
    Object.keys(calls.codeJobMemoryProjector.memoryProducer),
    ["appendBatch"],
  );
  assert.equal(Object.isFrozen(calls.coordination.codeJobMemoryProjector), true);
  assert.equal(
    typeof calls.coordination.codeJobMemoryProjector.runCycle,
    "function",
  );
  assert.equal(calls.coordination.codeJobMemoryLimit, 18);
  assert.equal("completedChangeExporter" in calls.codeJobRuntime, false);
  assert.equal("changePackageProducer" in calls.codeJobRuntime, false);
  assert.equal("changePackageReader" in calls.codeJobRuntime, false);
  assert.equal(calls.coordination.codeJobChangePackageDispatcher, null);

  assert.equal(Object.isFrozen(application.codeJobReader), true);
  assert.equal(Object.isFrozen(application.codeJobControl), true);
  assert.deepEqual(Object.keys(application.codeJobControl).sort(), [
    "cancel",
    "pause",
    "resume",
  ]);
  assert.deepEqual(Object.keys(application.codeJobReader).sort(), [
    "get",
    "getDetail",
    "list",
    "listNewest",
  ]);
  assert.deepEqual(await application.codeJobReader.get("job-1"), { id: "job-1" });
  assert.deepEqual(
    await application.codeJobReader.getDetail({ jobId: "job-1" }),
    { detail: { jobId: "job-1" } },
  );
  for (const privateName of [
    "codeJobRuntime",
    "codeJobStore",
    "codeJobExecutor",
    "codeJobWorker",
    "codeJobMemoryProjector",
    "projectionSource",
    "confirmationExecutor",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "code-job",
    "memory",
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local-only code actions create confirmation while maintenance keeps projection recovery", async () => {
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
    codeJobRuntimeFactory: async (options) => {
      codeJobCalls += 1;
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
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
  assert.equal(codeJobCalls, 1);
  assert.equal(confirmationCalls, 0);
  assert.equal(Object.isFrozen(maintenance.codeJobReader), true);
  assert.equal(Object.isFrozen(maintenance.codeJobControl), true);
  assert.deepEqual(calls.proposalRuntime.runnerScopes, []);
  assert.equal(calls.coordination.codeJobRunner, null);
  assert.equal(
    typeof calls.coordination.codeJobMemoryProjector.runCycle,
    "function",
  );
  assert.equal("executor" in calls.codeJobRuntime, false);
  assert.equal("brainDirectory" in calls.codeJobRuntime, false);
  assert.equal("grantVerifier" in calls.codeJobRuntime, false);
  assert.equal("completedChangeExporter" in calls.codeJobRuntime, false);
  assert.equal("changePackageProducer" in calls.codeJobRuntime, false);
  assert.equal("changePackageReader" in calls.codeJobRuntime, false);
  assert.equal(calls.coordination.codeJobChangePackageDispatcher, null);
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
      reader: {
        async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
      },
      control: codeJobControlPort(),
      worker: codeJobWorkerPort(),
      projectionSource: codeJobProjectionSourcePort(),
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
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
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
    "memory",
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

test("versioned composition builds every subsystem from the stored active snapshot", async () => {
  const bootstrap = applicationConfig();
  const active = { ...applicationConfig(), refreshMinutes: 23 };
  const calls = [];
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  const configurationRuntime = {
    startupConfiguration: active,
    status: Object.freeze({
      safeMode: false,
      activeVersion: 4,
      stateRevision: 9,
      migrationError: null,
    }),
    reader: port([
      "readSnapshot",
      "readActivationReconciliationSnapshot",
      "readActive",
      "readVersion",
      "readDraft",
      "readProjectionBatch",
    ]),
    draftManager: port([
      "createDraft",
      "createInitializationDraft",
      "reviseDraft",
    ]),
    simulator: port([
      "prepareInitialization",
      "prepareDraftActivation",
      "prepareRollback",
    ]),
    activationExecutor: port([
      "activateInitialization",
      "activateDraft",
      "activateRollback",
    ]),
    proposalPort: port([
      "createDraft",
      "createInitializationDraft",
      "reviseDraft",
    ]),
    async close() {
      calls.push("configuration-close");
    },
  };
  let activationOptions;
  let confirmationDependencies;
  let requesterOptions;

  const application = await createApplication({
    config: bootstrap,
    store: memoryStore(),
    versionedConfiguration: true,
    actionAdmissionGateFactory: () => new ActionAdmissionGate(),
    configurationRuntimeFactory: async (candidate, dependencies) => {
      calls.push({ candidate, dependencies });
      dependencies.actionAdmissionGate.bindEffective({
        version: 4,
        configurationDigest: "4".repeat(64),
      });
      return configurationRuntime;
    },
    configurationActivationExecutorFactory: (options) => {
      activationOptions = options;
      return { async execute() {}, async reconcile() {} };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      confirmationDependencies = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          calls.push("confirmation-close");
        },
      };
    },
    configurationConfirmationRequesterFactory: (options) => {
      requesterOptions = options;
      return {
        async requestInitialization() {},
        async requestDraftActivation() {},
        async requestRollback() {},
      };
    },
  });

  assert.deepEqual(calls[0].candidate, bootstrap);
  assert.equal(calls[0].dependencies.store instanceof Object, true);
  assert.deepEqual(
    Object.keys(calls[0].dependencies.actionAdmissionGate).sort(),
    ["bindEffective", "cutover", "readStatus", "reconcileCutover", "run"],
  );
  assert.equal(
    Object.isFrozen(calls[0].dependencies.actionAdmissionGate),
    true,
  );
  assert.strictEqual(application.config, active);
  assert.equal(application.configuration.status.activeVersion, 4);
  assert.strictEqual(application.configuration.reader, configurationRuntime.reader);
  assert.strictEqual(
    application.configuration.proposalPort,
    configurationRuntime.proposalPort,
  );
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestDraftActivation", "requestRollback"],
  );
  assert.deepEqual(Object.keys(application.configuration.runtimeStatus), [
    "readStatus",
  ]);
  assert.deepEqual(activationOptions.allowedActionTypes, [
    "activate_draft",
    "activate_rollback",
  ]);
  assert.equal(Object.isFrozen(activationOptions.allowedActionTypes), true);
  assert.deepEqual(Object.keys(requesterOptions.simulator), [
    "prepareInitialization",
    "prepareDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(requesterOptions.confirmationProducer), [
    "enqueue",
  ]);
  assert.deepEqual(Object.keys(confirmationDependencies.localExecutors), [
    "local.configuration-activate",
  ]);
  assert.notEqual(application.confirmationQueue, null);
  assert.equal("activationExecutor" in application.configuration, false);

  await application.close();
  assert.equal(calls.at(-1), "configuration-close");
});

test("safe mode grants only initialization through the shared confirmation queue", async () => {
  const config = applicationConfig();
  const calls = {};
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: true,
    configurationRuntimeFactory: async () => ({
      startupConfiguration: config,
      status: {
        safeMode: true,
        activeVersion: null,
        stateRevision: 1,
        migrationError: null,
      },
      reader: port([
        "readSnapshot",
        "readActivationReconciliationSnapshot",
        "readActive",
        "readVersion",
        "readDraft",
        "readProjectionBatch",
      ]),
      draftManager: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      simulator: port([
        "prepareInitialization",
        "prepareDraftActivation",
        "prepareRollback",
      ]),
      activationExecutor: port([
        "activateInitialization",
        "activateDraft",
        "activateRollback",
      ]),
      proposalPort: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      async close() {},
    }),
    configurationActivationExecutorFactory: (options) => {
      calls.activationOptions = options;
      return { async execute() {}, async reconcile() {} };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmationDependencies = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {},
      };
    },
    configurationConfirmationRequesterFactory: (options) => {
      calls.requesterOptions = options;
      return {
        async requestInitialization() {},
        async requestDraftActivation() {},
        async requestRollback() {},
      };
    },
  });

  assert.deepEqual(calls.activationOptions.allowedActionTypes, [
    "initialize_from_draft",
  ]);
  assert.equal(Object.isFrozen(calls.activationOptions.allowedActionTypes), true);
  assert.deepEqual(Object.keys(calls.activationOptions.activationExecutor), [
    "activateInitialization",
    "activateDraft",
    "activateRollback",
  ]);
  assert.deepEqual(Object.keys(calls.activationOptions.configurationReader), [
    "readActivationReconciliationSnapshot",
  ]);
  assert.deepEqual(Object.keys(calls.activationOptions.actionAdmissionGate), [
    "cutover",
    "readStatus",
    "reconcileCutover",
  ]);
  assert.deepEqual(
    Object.keys(calls.confirmationDependencies.localExecutors),
    ["local.configuration-activate"],
  );
  assert.equal(
    Object.isFrozen(calls.confirmationDependencies.localExecutors),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.confirmationDependencies.actionAdmissionGate),
    ["run"],
  );
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestInitialization"],
  );
  assert.deepEqual(Object.keys(calls.requesterOptions.simulator), [
    "prepareInitialization",
    "prepareDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(calls.requesterOptions.confirmationProducer), [
    "enqueue",
  ]);
  assert.equal("activationExecutor" in application.configuration, false);
  await application.close();
});

test("versioned maintenance mode does not construct configuration action authority", async () => {
  const config = applicationConfig();
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  let activationExecutorCalls = 0;
  let confirmationRuntimeCalls = 0;
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: true,
    externalActions: false,
    configurationRuntimeFactory: async () => ({
      startupConfiguration: config,
      status: {
        safeMode: false,
        activeVersion: 1,
        stateRevision: 1,
        migrationError: null,
      },
      reader: port([
        "readSnapshot",
        "readActivationReconciliationSnapshot",
        "readActive",
        "readVersion",
        "readDraft",
        "readProjectionBatch",
      ]),
      draftManager: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      simulator: port([
        "prepareInitialization",
        "prepareDraftActivation",
        "prepareRollback",
      ]),
      activationExecutor: port([
        "activateInitialization",
        "activateDraft",
        "activateRollback",
      ]),
      proposalPort: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      async close() {},
    }),
    configurationActivationExecutorFactory: () => {
      activationExecutorCalls += 1;
      throw new Error("must not construct configuration action authority");
    },
    confirmationRuntimeFactory: async () => {
      confirmationRuntimeCalls += 1;
      throw new Error("must not construct confirmation runtime");
    },
  });

  assert.equal(activationExecutorCalls, 0);
  assert.equal(confirmationRuntimeCalls, 0);
  assert.equal(application.configuration.confirmationRequester, null);
  assert.equal(application.confirmationQueue, null);
  assert.equal("activationExecutor" in application.configuration, false);
  await application.close();
});

test("versioned local code shares one gate and reads Active authority", async () => {
  const baseConfig = localCodeCoordinationConfig({ githubActions: false });
  const answerBrain = {
    provider: "ollama",
    model: "memory-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const config = {
    ...baseConfig,
    memory: {
      ...baseConfig.memory,
      answering: {
        enabled: true,
        maximumRecords: 10,
        maximumContextBytes: 100_000,
        maximumConcurrent: 1,
        brain: answerBrain,
        localBrain: answerBrain,
      },
    },
  };
  const calls = {};
  const closeCalls = [];
  const sharedGate = new ActionAdmissionGate();
  const configurationReader = {
    async readSnapshot() {},
    async readActivationReconciliationSnapshot() {},
    async readActive() {},
    async readVersion() {},
    async readDraft() {},
    async readProjectionBatch() {},
  };
  const versionedAuthority = {
    async create() {},
    async verify(value) {
      return value;
    },
    async decide() {},
  };
  const localExecutor = { async execute() {}, async reconcile() {} };

  const application = await createApplication({
    config,
    versionedConfiguration: true,
    store: memoryStore(),
    actionAdmissionGateFactory: () => sharedGate,
    workflowRoutingDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign workflow gate"); },
      },
    },
    workLedgerDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign ledger gate"); },
      },
    },
    workProposalDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign proposal gate"); },
      },
    },
    configurationRuntimeFactory: async (_candidate, dependencies) => {
      calls.configuration = dependencies;
      return {
        startupConfiguration: config,
        status: {
          safeMode: false,
          activeVersion: 1,
          stateRevision: 1,
          migrationError: null,
        },
        reader: configurationReader,
        draftManager: {
          async createDraft() {},
          async createInitializationDraft() {},
          async reviseDraft() {},
        },
        simulator: {
          async prepareInitialization() {},
          async prepareDraftActivation() {},
          async prepareRollback() {},
        },
        activationExecutor: {
          async activateInitialization() {},
          async activateDraft() {},
          async activateRollback() {},
        },
        proposalPort: {
          async createDraft() {},
          async createInitializationDraft() {},
          async reviseDraft() {},
        },
        async close() {
          closeCalls.push("configuration");
        },
      };
    },
    codeExecutorRuntimeFactory: async () => ({
      authority: {
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
      },
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
    versionedCodeJobAuthorityFactory: (options) => {
      calls.versionedAuthority = options;
      return versionedAuthority;
    },
    codeActionProposalRunnerFactory: (options) => {
      calls.codeRunner = options;
      return { async runCycle() {} };
    },
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: localExecutor,
        reader: {
          async get() {},
          async getDetail() {},
          async list() {},
          async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    memoryAnswerServiceFactory: (options) => {
      calls.memoryAnswer = options;
      return { async answer() {} };
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
  });

  assert.notStrictEqual(
    calls.configuration.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.notStrictEqual(calls.configuration.actionAdmissionGate, sharedGate);
  assert.deepEqual(Object.keys(calls.codeJobRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.versionedAuthority.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.workflowRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.ledgerRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.proposalRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.dispatcher.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(
    Object.keys(calls.orchestratorService.actionAdmissionGate),
    ["run"],
  );
  assert.deepEqual(Object.keys(calls.waker.actionAdmissionGate), ["run"]);
  assert.strictEqual(
    calls.workflowRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.ledgerRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.proposalRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.dispatcher.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.orchestratorService.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.waker.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.codeJobRuntime.actionAdmissionGate,
    calls.versionedAuthority.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.workforce.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.memoryAnswer.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.versionedAuthority.configurationReader,
    configurationReader,
  );
  assert.equal(
    await calls.codeJobRuntime.grantVerifier.verify("sealed-grant"),
    "sealed-grant",
  );
  assert.strictEqual(calls.codeRunner.grantFactory, versionedAuthority);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors).sort(), [
    "local.code-job-create",
    "local.configuration-activate",
  ]);
  assert.deepEqual(Object.keys(calls.confirmation.actionAdmissionGate), [
    "run",
  ]);
  assert.equal("activationExecutor" in application.configuration, false);
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestDraftActivation", "requestRollback"],
  );

  await application.close();
});
