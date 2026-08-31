import assert from "node:assert/strict";
import test from "node:test";

import { BrainRouter } from "../src/services/brain-router.js";

const BRAIN = Object.freeze({
  provider: "codex",
  model: "bounded-model",
  remoteData: Object.freeze({
    requirements: true,
    code: true,
    memory: false,
  }),
});

function provider(overrides = {}) {
  return {
    id: "codex",
    remote: true,
    async generate() { return '{"ok":true}'; },
    ...overrides,
  };
}

test("BrainRouter preserves and invokes an optional provider availability check", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability({ signal }) {
        calls.push(signal);
      },
    })],
  });
  const controller = new AbortController();

  await router.checkAvailability(BRAIN, { signal: controller.signal });

  assert.deepEqual(calls, [controller.signal]);
});

test("BrainRouter forwards an assigned reasoning effort to the provider", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });
  const brain = {
    ...BRAIN,
    reasoningEffort: "high",
  };

  await router.generate({
    brain,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, "high");
});

test("BrainRouter forwards an entity session key to the provider", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      supportsEntitySessions: true,
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:pull_request:example/software#24256",
  });

  assert.equal(
    calls[0].sessionKey,
    "github:pull_request:example/software#24256",
  );
});

test("BrainRouter keeps non-session providers stateless for entity work", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:issue:example/product#12953",
  });

  assert.equal(Object.hasOwn(calls[0], "sessionKey"), false);
});

test("BrainRouter preserves prototype-defined availability", async () => {
  let calls = 0;
  class Provider {
    constructor() {
      this.id = "codex";
      this.remote = true;
    }

    async generate() { return '{"ok":true}'; }

    async checkAvailability() { calls += 1; }
  }
  const router = new BrainRouter({ providers: [new Provider()] });
  await router.checkAvailability(BRAIN);
  assert.equal(calls, 1);
});

test("BrainRouter treats a provider without an availability check as available", async () => {
  const router = new BrainRouter({ providers: [provider()] });
  assert.equal(await router.checkAvailability(BRAIN), undefined);
});

test("BrainRouter rejects cancellation before invoking provider availability", async () => {
  let calls = 0;
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability() { calls += 1; },
    })],
  });
  const controller = new AbortController();
  controller.abort(new Error("private reason"));

  await assert.rejects(
    router.checkAvailability(BRAIN, { signal: controller.signal }),
    (error) => error?.code === "BRAIN_REQUEST_CANCELLED" &&
      !error.message.includes("private reason"),
  );
  assert.equal(calls, 0);
});

test("BrainRouter propagates a stable provider availability failure", async () => {
  const expected = Object.assign(new Error("credential unavailable"), {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability() { throw expected; },
    })],
  });

  await assert.rejects(router.checkAvailability(BRAIN), (error) => error === expected);
});
