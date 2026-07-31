import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/lib/config.js";

test("local provider settings merge without erasing base defaults", () => {
  const result = mergeConfig(
    {
      dingtalk: { enabled: true, maxNotificationsPerRun: 5 },
      brain: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        contextTokens: 8192,
      },
      prResponsibility: { historicalAfterDays: 60 },
      employees: {
        prReviewer: {
          enabled: true,
          maxJobsPerTick: 2,
          brain: { timeoutMs: 45_000 },
        },
      },
    },
    {
      dingtalk: { enabled: false },
      brain: { model: "another-model" },
      prResponsibility: { historicalAfterDays: 30 },
      employees: {
        prReviewer: {
          maxJobsPerTick: 1,
          brain: { model: "employee-model" },
        },
      },
    },
  );

  assert.deepEqual(result.dingtalk, {
    enabled: false,
    maxNotificationsPerRun: 5,
  });
  assert.equal(result.brain.enabled, true);
  assert.equal(result.brain.model, "another-model");
  assert.equal(result.brain.contextTokens, 8192);
  assert.equal(result.prResponsibility.historicalAfterDays, 30);
  assert.deepEqual(result.employees.prReviewer, {
    enabled: true,
    maxJobsPerTick: 1,
    brain: { timeoutMs: 45_000, model: "employee-model" },
  });
});
