import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexCliSessionStore } from "../src/adapters/codex-cli-session-store.js";
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
      sessionIsolationKey: "codex-cli:api-key",
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

  assert.match(calls[0].sessionKey, /^auth-v2:[a-f0-9]{64}$/u);
  assert.notEqual(calls[0].sessionKey, "github:pull_request:example/software#24256");
});

test("BrainRouter partitions persistent history by provider, credential mode, policy and cumulative request classes", async () => {
  const calls = [];
  const makeProvider = (id, isolationKey) => ({
    ...provider(),
    id,
    supportsEntitySessions: true,
    sessionIsolationKey: isolationKey,
    async generate(request) {
      calls.push({ id, isolationKey, sessionKey: request.sessionKey });
      return '{"ok":true}';
    },
  });
  const router = new BrainRouter({ providers: [
    makeProvider("codex", "codex-cli:api-key"),
    makeProvider("other", "codex-cli:codex-login"),
  ] });
  const entity = "github:issue:example/product#12953";
  const request = (brain, dataClasses) => router.generate({
    brain,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses,
    sessionKey: entity,
  });
  const enabled = { ...BRAIN, remoteData: { requirements: true, code: true, memory: true } };
  await request(enabled, ["requirements", "memory"]);
  await request(enabled, ["memory", "requirements"]);
  await request(BRAIN, ["requirements"]);
  await request(enabled, ["requirements"]);
  await request({ ...enabled, provider: "other" }, ["requirements", "memory"]);
  assert.equal(calls[0].sessionKey, calls[1].sessionKey);
  for (const index of [2, 3, 4]) assert.notEqual(calls[index].sessionKey, calls[0].sessionKey);
  assert.notEqual(calls[2].sessionKey, calls[3].sessionKey);
  assert.notEqual(calls[3].sessionKey, calls[4].sessionKey);
  assert.equal(calls.every(({ sessionKey }) => sessionKey !== entity), true);
});

test("BrainRouter separates credential modes even when the configured provider ID is unchanged", async () => {
  const keys = [];
  const makeRouter = (sessionIsolationKey) => new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
    sessionIsolationKey,
    async generate({ sessionKey }) { keys.push(sessionKey); return '{"ok":true}'; },
  })] });
  const request = (router) => router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:issue:example/product#12953",
  });
  await request(makeRouter("codex-cli:api-key"));
  await request(makeRouter("codex-cli:codex-login"));
  assert.notEqual(keys[0], keys[1]);
});

test("BrainRouter leaves an unattested legacy CLI archive byte-for-byte intact", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "brain-router-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "store");
  const oldHome = path.join(directory, "old-home");
  const newHome = path.join(directory, "new-home");
  const legacyKey = "github:issue:example/product#12953";
  await mkdir(path.join(oldHome, "sessions"), { recursive: true });
  await writeFile(path.join(oldHome, "sessions", "rollout-legacy-id.jsonl"), "legacy memory history\n");
  const store = new CodexCliSessionStore({ root });
  await store.capture({ sessionKey: legacyKey, sessionId: "legacy-id", codexHome: oldHome });
  const [oldEntry] = await readdir(root);
  const oldRollout = path.join(root, oldEntry, "profile", "sessions", "rollout-legacy-id.jsonl");
  const oldMetadata = path.join(root, oldEntry, "metadata.json");
  const originalBytes = await Promise.all([readFile(oldRollout), readFile(oldMetadata)]);
  const stages = [];
  const router = new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
    sessionIsolationKey: "codex-cli:api-key",
    async generate({ sessionKey }) {
      stages.push(await store.stage({ sessionKey, codexHome: newHome }));
      return '{"ok":true}';
    },
  })] });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: legacyKey,
  });

  assert.deepEqual(stages, [{ sessionId: null }]);
  assert.deepEqual(await readFile(oldRollout), originalBytes[0]);
  assert.deepEqual(await readFile(oldMetadata), originalBytes[1]);
  assert.deepEqual(await readdir(root), [oldEntry]);
});

test("BrainRouter requires an explicit isolation scope for persistent providers", () => {
  assert.throws(() => new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
  })] }), /session isolation key is invalid/u);
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
