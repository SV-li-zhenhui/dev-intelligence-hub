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
    codeExecutor,
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
