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
    config: applicationConfig(),
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
