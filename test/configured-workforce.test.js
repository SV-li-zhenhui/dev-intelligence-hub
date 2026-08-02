import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredWorkforce } from "../src/services/configured-workforce.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function role(model, initialPaused = false) {
  return {
    name: "岗位",
    mission: "主动判断并推动工作",
    enabled: true,
    scheduleMinutes: 5,
    initialPaused,
    permissions: { allowedIntents: ["ask_user", "complete"] },
    brain: {
      provider: "ollama",
      model,
      remoteData: { requirements: false, code: false, memory: false },
    },
  };
}

test("workforce builds independently controlled roles over one local provider", async () => {
  const calls = [];
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    roles: {
      orchestrator: role("qwen3.5:9b"),
      developer: role("code-model", true),
    },
    store: new MemoryStore(),
    onRun: async (input) => calls.push(input),
  });

  assert.deepEqual(workforce.employees.map(({ id }) => id), [
    "orchestrator",
    "developer",
  ]);
  assert.deepEqual(workforce.workers.map(({ roleId }) => roleId), [
    "orchestrator",
    "developer",
  ]);
  await workforce.employees[0].run({ trigger: "manual" });
  assert.equal(calls[0].roleId, "orchestrator");
  assert.equal((await workforce.employees[1].roleView()).paused, true);
  assert.equal(Object.isFrozen(workforce.employees), true);
  assert.equal(Object.isFrozen(workforce.workers), true);
});

test("workforce rejects unknown provider fields and the legacy PR role", () => {
  assert.throws(
    () =>
      createConfiguredWorkforce({
        brainProviders: { ollama: { kind: "ollama", token: "secret" } },
        roles: {},
        store: new MemoryStore(),
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      createConfiguredWorkforce({
        brainProviders: {},
        roles: { "pr-reviewer": role("qwen") },
        store: new MemoryStore(),
      }),
    /role id/,
  );
});

test("remote providers read credentials only from the injected environment", async () => {
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      remote: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
      },
    },
    roles: {
      developer: {
        ...role("smart-model"),
        brain: {
          provider: "remote",
          model: "smart-model",
          remoteData: { requirements: true, code: false, memory: false },
        },
      },
    },
    store: new MemoryStore(),
    dependencies: {
      environment: { MODEL_TOKEN: "secret-token" },
      fetch: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  confidence: 90,
                  summary: "完成",
                  intent: {
                    schemaVersion: 1,
                    type: "complete",
                    summary: "完成",
                    reason: "证据充分",
                    outcome: "done",
                    evidence: [],
                  },
                }),
              },
            }],
          });
        },
      }),
    },
  });

  await assert.rejects(
    workforce.workers[0].decide({
      item: { event: { eventType: "pull_request.updated" } },
      trigger: "assigned",
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
});
