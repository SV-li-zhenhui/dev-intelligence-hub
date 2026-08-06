import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredBrainRouter,
  createConfiguredWorkforce,
} from "../src/services/configured-workforce.js";

const SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
});
const MESSAGES = Object.freeze([
  Object.freeze({ role: "system", content: "Return JSON." }),
  Object.freeze({ role: "user", content: "{}" }),
]);

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
  };
}

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

test("workforce forwards one run-only admission gate to every role brain", async () => {
  const blocked = Object.assign(new Error("runtime cutover"), {
    code: "RUNTIME_RESTART_REQUIRED",
  });
  let admissions = 0;
  let fetchCalls = 0;
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    roles: {
      orchestrator: role("qwen3.5:9b"),
      developer: role("code-model"),
    },
    store: new MemoryStore(),
    actionAdmissionGate: {
      run() {
        admissions += 1;
        throw blocked;
      },
    },
    dependencies: {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("blocked requests must not reach the provider");
      },
    },
  });

  for (const worker of workforce.workers) {
    await assert.rejects(
      worker.decide({ item: { event: { eventType: "issue.updated" } } }),
      (error) => error === blocked,
    );
  }

  assert.equal(admissions, 2);
  assert.equal(fetchCalls, 0);
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

test("provider options are isolated by adapter kind", () => {
  assert.doesNotThrow(() =>
    createConfiguredWorkforce({
      brainProviders: {
        local: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          apiKeyEnv: "UNUSED_LOCAL_TOKEN",
        },
        remote: {
          kind: "openai-compatible",
          baseUrl: "https://models.example/v1",
          apiKeyEnv: "MODEL_TOKEN",
          contextTokens: 16_384,
        },
      },
      roles: {},
      store: new MemoryStore(),
      dependencies: {
        environment: { MODEL_TOKEN: "token" },
        fetch: async () => {
          throw new Error("provider construction must not call fetch");
        },
      },
    }),
  );
});

test("a loopback gateway declared remote enforces memory authorization before fetch", async () => {
  const calls = [];
  const router = createConfiguredBrainRouter({
    brainProviders: {
      gateway: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        remote: true,
      },
    },
    dependencies: {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return textResponse({ message: { content: '{"ok":true}' } });
      },
    },
  });
  const deniedBrain = {
    provider: "gateway",
    model: "local-gateway-model",
    remoteData: { requirements: false, code: false, memory: false },
  };

  await assert.rejects(
    router.generate({
      brain: deniedBrain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(router.describe(deniedBrain), {
    provider: "gateway",
    model: "local-gateway-model",
    remote: true,
    remoteData: { requirements: false, code: false, memory: false },
  });

  assert.equal(
    await router.generate({
      brain: {
        ...deniedBrain,
        remoteData: { requirements: false, code: false, memory: true },
      },
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    '{"ok":true}',
  );
  assert.equal(calls.length, 1);
});

test("a non-loopback provider cannot be downgraded by remote false", async () => {
  let fetchCalls = 0;
  const router = createConfiguredBrainRouter({
    brainProviders: {
      hosted: {
        kind: "ollama",
        baseUrl: "https://models.example/v1",
        remote: false,
      },
    },
    dependencies: {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("denied data must not reach fetch");
      },
    },
  });
  const brain = {
    provider: "hosted",
    model: "hosted-model",
    remoteData: { requirements: false, code: false, memory: false },
  };

  assert.equal(router.describe(brain).remote, true);
  await assert.rejects(
    router.generate({
      brain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(fetchCalls, 0);
});

test("a dotted Responses provider is remote and denied data never starts fetch", async () => {
  let fetchCalls = 0;
  const router = createConfiguredBrainRouter({
    brainProviders: {
      "company.codex_api": {
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        protocol: "responses",
        remote: false,
      },
    },
    dependencies: {
      fetch: async (url, options) => {
        fetchCalls += 1;
        assert.equal(url, "https://api.openai.com/v1/responses");
        const body = JSON.parse(options.body);
        assert.deepEqual(body.tools, []);
        assert.equal(body.tool_choice, "none");
        return textResponse({
          object: "response",
          status: "completed",
          error: null,
          incomplete_details: null,
          output: [{
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          }],
        });
      },
      environment: {
        OPENAI_API_KEY: "fixture-key",
      },
    },
  });
  const brain = {
    provider: "company.codex_api",
    model: "gpt-5.2-codex",
    remoteData: { requirements: true, code: false, memory: false },
  };

  assert.equal(router.describe(brain).remote, true);
  await assert.rejects(
    router.generate({
      brain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["requirements", "code"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(
    await router.generate({
      brain: {
        ...brain,
        remoteData: { requirements: true, code: true, memory: false },
      },
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["requirements", "code"],
    }),
    '{"ok":true}',
  );
  assert.equal(fetchCalls, 1);
});

test("provider remote declarations are optional booleans only", () => {
  assert.equal(
    createConfiguredBrainRouter({
      brainProviders: {
        local: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        },
      },
    }).describe({
      provider: "local",
      model: "local-model",
      remoteData: { requirements: false, code: false, memory: false },
    }).remote,
    false,
  );
  assert.throws(
    () =>
      createConfiguredBrainRouter({
        brainProviders: {
          invalid: { kind: "ollama", remote: "yes" },
        },
      }),
    /brainProviders\.invalid\.remote is invalid/,
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
