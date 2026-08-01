import assert from "node:assert/strict";
import test from "node:test";
import { OllamaBrain } from "../src/adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "../src/adapters/ollama-pr-employee-reviewer.js";
import {
  createBrain,
  createEmployeeRegistry,
  createPrEmployeeReviewer,
} from "../src/composition-root.js";

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
