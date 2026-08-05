import assert from "node:assert/strict";
import test from "node:test";
import { OllamaStructuredProvider } from "../src/adapters/ollama-structured-provider.js";
import {
  OpenAICompatibleProvider,
  OpenAiCompatibleProvider,
} from "../src/adapters/openai-compatible-provider.js";
import { BrainRouter } from "../src/services/brain-router.js";

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

function textResponse(value, { ok = true, status = 200 } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

function remoteData(overrides = {}) {
  return { requirements: false, code: false, memory: false, ...overrides };
}

test("Ollama defaults to loopback and sends a bounded schema request without redirects", async () => {
  const calls = [];
  const provider = new OllamaStructuredProvider({
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return textResponse({ message: { content: '{"ok":true}' } });
    },
  });

  const output = await provider.generate({
    model: "qwen3.5:9b",
    messages: MESSAGES,
    schema: SCHEMA,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(provider.id, "ollama");
  assert.equal(provider.remote, false);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].body.format, SCHEMA);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.keep_alive, "30m");
});

test("Ollama removes only an exact JSON transport fence", async () => {
  const fenced = new OllamaStructuredProvider({
    fetch: async () =>
      textResponse({ message: { content: "```json\n{\"ok\":true}\n```" } }),
  });
  const prose = new OllamaStructuredProvider({
    fetch: async () =>
      textResponse({
        message: { content: "Result:\n```json\n{\"ok\":true}\n```" },
      }),
  });

  assert.equal(
    await fenced.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    '{"ok":true}',
  );
  assert.equal(
    await prose.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    "Result:\n```json\n{\"ok\":true}\n```",
  );
});

test("remote endpoints require HTTPS and every endpoint rejects userinfo", () => {
  assert.throws(
    () => new OllamaStructuredProvider({ baseUrl: "http://models.example" }),
    /remote endpoint must use HTTPS/i,
  );
  assert.throws(
    () =>
      new OllamaStructuredProvider({
        baseUrl: "http://user:password@127.0.0.1:11434",
      }),
    /must not contain userinfo/i,
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "http://api.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: "token" },
      }),
    /remote endpoint must use HTTPS/i,
  );
});

test("OpenAI-compatible credentials come only from the injected environment and stay out of errors", async () => {
  const secret = "super-secret-token";
  const calls = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return textResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      });
    },
  });

  const output = await provider.generate({
    model: "smart-model",
    messages: MESSAGES,
    schema: SCHEMA,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(OpenAICompatibleProvider, OpenAiCompatibleProvider);
  assert.equal(calls[0].url, "https://models.example/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(JSON.stringify(provider).includes(secret), false);

  const failing = new OpenAiCompatibleProvider({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
    fetch: async () => textResponse(secret, { ok: false, status: 401 }),
  });
  await assert.rejects(
    failing.generate({ model: "smart-model", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_HTTP_FAILED" &&
      !error.message.includes(secret),
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: secret },
        apiKey: secret,
      }),
    (error) => !error.message.includes(secret),
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: secret },
        environment: { MODEL_TOKEN: secret },
      }),
    /ambiguous/i,
  );

  let getterCalls = 0;
  const unsafeOptions = {
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
  };
  Object.defineProperty(unsafeOptions, "apiKey", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return secret;
    },
  });
  assert.throws(() => new OpenAiCompatibleProvider(unsafeOptions));
  assert.equal(getterCalls, 0);
});

test("providers bound response bytes and timeout without exposing response content", async () => {
  const oversized = new OllamaStructuredProvider({
    maxResponseBytes: 1_024,
    fetch: async () => textResponse("sensitive".repeat(200)),
  });
  await assert.rejects(
    oversized.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE" &&
      !error.message.includes("sensitive"),
  );

  const timedOut = new OllamaStructuredProvider({
    timeoutMs: 10,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    timedOut.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_TIMEOUT",
  );

  const bodyFailure = new OllamaStructuredProvider({
    fetch: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        pull() {
          throw new Error("sensitive body reader failure");
        },
      }),
    }),
  });
  await assert.rejects(
    bodyFailure.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID" &&
      !error.message.includes("sensitive"),
  );

  let unboundedRead = false;
  const unbounded = new OllamaStructuredProvider({
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        unboundedRead = true;
        return "sensitive".repeat(1_000_000);
      },
    }),
  });
  await assert.rejects(
    unbounded.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(unboundedRead, false);
});

test("structured providers propagate external cancellation without misreporting a timeout", async () => {
  const factories = [
    (fetch) => new OllamaStructuredProvider({ fetch, timeoutMs: 100 }),
    (fetch) => new OpenAiCompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 100,
    }),
  ];

  for (const createProvider of factories) {
    let observedSignal = null;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const provider = createProvider(async (_url, { signal }) => {
      observedSignal = signal;
      markStarted();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const pending = provider.generate({
      model: "model",
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await assert.rejects(
      pending,
      (error) =>
        error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
        error.statusCode === 499,
    );
    assert.equal(observedSignal.aborted, true);
  }
});

test("structured providers do not start fetch after immediate cancellation", async () => {
  const factories = [
    (fetch) => new OllamaStructuredProvider({ fetch, timeoutMs: 100 }),
    (fetch) => new OpenAiCompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 100,
    }),
  ];

  for (const createProvider of factories) {
    let fetchCalls = 0;
    const provider = createProvider(async () => {
      fetchCalls += 1;
      throw new Error("fetch must not start");
    });
    const controller = new AbortController();
    const pending = provider.generate({
      model: "model",
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      pending,
      (error) =>
        error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
        error.statusCode === 499,
    );
    assert.equal(fetchCalls, 0);
  }
});

test("BrainRouter requires explicit remoteData authorization per classification", async () => {
  const calls = [];
  const remoteProvider = {
    id: "remote-brain",
    kind: "openai-compatible",
    remote: true,
    async generate(request) {
      calls.push(request);
      return '{"ok":true}';
    },
  };
  const router = new BrainRouter({ providers: [remoteProvider] });
  const brain = {
    provider: "remote-brain",
    model: "smart-model",
    remoteData: remoteData(),
  };

  await assert.rejects(
    router.generate({ brain, messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "REMOTE_DATA_CLASSIFICATION_REQUIRED",
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    router.generate({ brain, messages: MESSAGES, schema: SCHEMA, dataClasses: ["code"] }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(calls.length, 0);

  const output = await router.generate({
    brain: { ...brain, remoteData: remoteData({ code: true }) },
    messages: MESSAGES,
    schema: SCHEMA,
    dataClasses: ["code"],
    signal: new AbortController().signal,
  });
  assert.equal(output, '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(router.describe(brain), {
    provider: "remote-brain",
    model: "smart-model",
    remote: true,
    remoteData: remoteData(),
  });
  assert.equal(Object.isFrozen(router.describe(brain)), true);
});

test("BrainRouter rejects a pre-cancelled request before provider admission", async () => {
  let providerCalls = 0;
  const router = new BrainRouter({
    providers: [{
      id: "local",
      remote: false,
      async generate() {
        providerCalls += 1;
        return '{"ok":true}';
      },
    }],
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    router.generate({
      brain: {
        provider: "local",
        model: "qwen",
        remoteData: remoteData(),
      },
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    }),
    (error) => error.code === "BRAIN_REQUEST_CANCELLED" && error.statusCode === 499,
  );
  assert.equal(providerCalls, 0);
});
