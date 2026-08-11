import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProductionCodexLoginCredentialBroker,
  createTestCodexLoginCredentialBroker,
} from "../src/adapters/codex-login-credential-broker.js";

function brokerFailure(code) {
  return Object.assign(new Error(`fictional ${code} private detail`), { code });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function directoryIdentity(directory) {
  const resolved = await realpath(directory);
  const details = await lstat(resolved, { bigint: true });
  return Object.freeze({
    path: resolved,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-codex-broker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probeRoot = path.join(root, "probe-root");
  const protectedRoot = path.join(root, "protected-root");
  const invocationPath = path.join(root, "provider-invocation");
  await mkdir(protectedRoot);
  await mkdir(invocationPath);
  const calls = {
    beginTask: [],
    stageTask: [],
    captureTask: [],
    stageProbe: [],
    locator: [],
    process: [],
    prepare: [],
    cleanup: [],
  };
  let snapshotSequence = 0;
  const store = overrides.store ?? {
    async beginTask(options) {
      calls.beginTask.push(options);
      snapshotSequence += 1;
      return Object.freeze(Object.create(null, {
        sequence: { value: snapshotSequence },
      }));
    },
    async stageTask(options) { calls.stageTask.push(options); },
    async captureTask(options) { calls.captureTask.push(options); },
    async stageProbe(options) { calls.stageProbe.push(options); },
  };
  const descriptor = Object.freeze({
    command: path.join(root, "codex.exe"),
    prefixArgs: Object.freeze([]),
  });
  const commandLocator = overrides.commandLocator ?? {
    async resolve(kind, options) {
      calls.locator.push({ kind, options });
      return descriptor;
    },
  };
  const processRunner = overrides.processRunner ?? {
    async run(options) {
      calls.process.push(options);
      return {
        exitCode: 0,
        signal: null,
        stdout: "Logged in using ChatGPT\r\n",
        stderr: "",
        stdoutBytes: 27,
        stderrBytes: 0,
      };
    },
  };
  const privateDirectoryManager = overrides.privateDirectoryManager ?? {
    async prepare({ directory, signal, validateLocation }) {
      if (signal?.aborted) throw brokerFailure("ABORT_ERR");
      await validateLocation();
      await mkdir(directory, { recursive: false }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await validateLocation();
      const identity = await directoryIdentity(directory);
      calls.prepare.push(identity);
      return identity;
    },
  };
  const prepareCleanupTrees = overrides.prepareCleanupTrees ?? (async (roots, options) => {
    calls.cleanup.push({ roots, options });
    let closed = false;
    return Object.freeze({
      async commit() {
        assert.equal(closed, false);
        closed = true;
        for (const identity of roots) {
          assert.deepEqual(await directoryIdentity(identity.path), identity);
          await rm(identity.path, { recursive: true, force: false });
        }
      },
      async close() { closed = true; },
    });
  });
  let uuidSequence = 0;
  const broker = createTestCodexLoginCredentialBroker({
    probeRoot,
    protectedRoots: [protectedRoot],
  }, {
    store,
    commandLocator,
    processRunner,
    privateDirectoryManager,
    prepareCleanupTrees,
    randomUUID() {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    },
  });
  return {
    broker,
    calls,
    descriptor,
    invocation: await directoryIdentity(invocationPath),
    probeRoot,
    root,
  };
}

test("FIFO admission removes a cancelled waiter without reordering later work", async (t) => {
  const current = await fixture(t);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const thirdController = new AbortController();
  const first = await current.broker.acquire({ signal: firstController.signal });
  const second = current.broker.acquire({ signal: secondController.signal });
  const third = current.broker.acquire({ signal: thirdController.signal });

  secondController.abort();
  await assert.rejects(second, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  assert.equal(current.calls.beginTask.length, 1);

  first.release({ safe: true });
  const thirdLease = await third;
  assert.equal(current.calls.beginTask.length, 2);
  assert.equal(current.calls.stageTask.length, 0);
  assert.equal(current.calls.process.length, 0);
  thirdLease.release({ safe: true });
  await current.broker.close();
});

test("a failed beginTask releases FIFO ownership for the next waiter", async (t) => {
  let attempts = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        attempts += 1;
        if (attempts === 1) {
          throw brokerFailure("CODEX_LOGIN_FILE_UNAVAILABLE");
        }
        return Object.freeze(Object.create(null));
      },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() {},
    },
  });

  const first = current.broker.acquire({ signal: new AbortController().signal });
  const second = current.broker.acquire({ signal: new AbortController().signal });
  await assert.rejects(first, {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const lease = await second;
  assert.equal(attempts, 2);
  lease.release({ safe: true });
  await current.broker.close();
});

test("a blocked beginTask permanently fences later admission", async (t) => {
  let attempts = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        attempts += 1;
        throw brokerFailure("CODEX_LOGIN_BROKER_BLOCKED");
      },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() {},
    },
  });

  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  assert.equal(attempts, 1, "a blocked credential store must not be called again");
  await current.broker.close();
});

test("a task lease stages and captures one isolated Codex home exactly once", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });

  const staged = await lease.stage({ invocation: current.invocation, signal });
  assert.equal(staged.codexHome, path.join(current.invocation.path, "codex-home"));
  assert.equal(current.calls.stageTask.length, 1);
  assert.equal(current.calls.stageTask[0].codexHome.path, staged.codexHome);
  assert.equal(Object.isFrozen(current.calls.stageTask[0].codexHome), true);
  await lease.capture({ signal });
  assert.equal(current.calls.captureTask.length, 1);
  assert.equal(
    current.calls.captureTask[0].codexHome,
    current.calls.stageTask[0].codexHome,
  );

  await assert.rejects(
    lease.stage({ invocation: current.invocation, signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(lease.capture({ signal }), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  lease.release({ safe: true });
  assert.throws(
    () => lease.release({ safe: true }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("an unsafe release permanently blocks queued and future task leases", async (t) => {
  const current = await fixture(t);
  const first = await current.broker.acquire({ signal: new AbortController().signal });
  const queued = current.broker.acquire({ signal: new AbortController().signal });

  first.release({ safe: false });
  await assert.rejects(queued, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("close rejects queued admission and waits for the active lease", async (t) => {
  const current = await fixture(t);
  const active = await current.broker.acquire({ signal: new AbortController().signal });
  const queued = current.broker.acquire({ signal: new AbortController().signal });
  const closeResult = deferred();
  void current.broker.close().then(closeResult.resolve, closeResult.reject);

  await assert.rejects(queued, { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
  const marker = Symbol("still waiting");
  assert.equal(await Promise.race([closeResult.promise, Promise.resolve(marker)]), marker);
  active.release({ safe: true });
  await closeResult.promise;
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("an aborted close reports a stable cleanup failure without force-releasing work", async (t) => {
  const current = await fixture(t);
  const active = await current.broker.acquire({ signal: new AbortController().signal });
  const controller = new AbortController();
  const closing = current.broker.close({ signal: controller.signal });
  controller.abort();
  await assert.rejects(closing, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  active.release({ safe: true });
  await current.broker.close();
});

test("readStatus runs only a bounded no-model login probe and removes its tree", async (t) => {
  const current = await fixture(t);
  const result = await current.broker.readStatus();

  assert.deepEqual(result, {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(current.calls.beginTask.length, 0);
  assert.equal(current.calls.stageProbe.length, 1);
  assert.deepEqual(current.calls.locator.map(({ kind }) => kind), ["codex-cli"]);
  assert.equal(current.calls.process.length, 1);
  const run = current.calls.process[0];
  assert.equal(run.executable, current.descriptor);
  assert.deepEqual(run.args, ["login", "status"]);
  assert.equal(run.input.length, 0);
  assert.equal(run.timeoutMs <= 10_000, true);
  assert.equal(run.maxStdoutBytes <= 4_096, true);
  assert.equal(run.maxStderrBytes <= 4_096, true);
  assert.equal(path.isAbsolute(run.cwd), true);
  assert.equal(run.env.CODEX_HOME, current.calls.stageProbe[0].codexHome.path);
  assert.equal(run.env.HOME.startsWith(`${run.cwd}${path.sep}`), true);
  assert.equal(run.env.USERPROFILE, run.env.HOME);
  assert.equal(Object.hasOwn(run.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(run.env, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(run.env, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(run.env, "NODE_OPTIONS"), false);
  assert.equal(current.calls.cleanup.length, 1);
  await assert.rejects(readFile(run.cwd), { code: "ENOENT" });
  await current.broker.close();
});

test("readStatus maps credential and CLI failures without leaking their detail", async (t) => {
  for (const [sourceCode, expectedState, locatorCalls] of [
    ["CODEX_LOGIN_FILE_UNAVAILABLE", "file_login_unavailable", 0],
    ["CODEX_LOGIN_SOURCE_UNSAFE", "unsafe_source", 0],
    ["CODEX_LOGIN_BROKER_BLOCKED", "broker_blocked", 0],
  ]) {
    await t.test(sourceCode, async (child) => {
      const current = await fixture(child, {
        store: {
          async beginTask() {},
          async stageTask() {},
          async captureTask() {},
          async stageProbe() { throw brokerFailure(sourceCode); },
        },
      });
      const status = await current.broker.readStatus();
      assert.equal(status.state, expectedState);
      assert.equal(status.cliAvailable, true);
      assert.equal(status.fileLoginAvailable, false);
      assert.equal(current.calls.locator.length, locatorCalls);
      assert.equal(JSON.stringify(status).includes("fictional"), false);
      await current.broker.close();
    });
  }

  await t.test("CLI unavailable", async (child) => {
    const current = await fixture(child, {
      commandLocator: {
        async resolve() {
          throw brokerFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
        },
      },
    });
    const status = await current.broker.readStatus();
    assert.deepEqual(status, {
      schemaVersion: 1,
      state: "cli_unavailable",
      cliAvailable: false,
      fileLoginAvailable: false,
    });
    assert.equal(current.calls.process.length, 0);
    await current.broker.close();
  });
});

test("cancelling an active readStatus probe cleans up without fencing later work", async (t) => {
  const probeStarted = deferred();
  const current = await fixture(t, {
    store: {
      async beginTask() { return Object.freeze(Object.create(null)); },
      async stageTask() {},
      async captureTask() {},
      async stageProbe({ signal }) {
        probeStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(brokerFailure("ABORT_ERR")), {
            once: true,
          });
        });
      },
    },
  });
  const controller = new AbortController();
  const status = current.broker.readStatus({ signal: controller.signal });
  await probeStarted.promise;
  controller.abort();
  await assert.rejects(status, { code: "STRUCTURED_PROVIDER_CANCELLED" });

  const lease = await current.broker.acquire({ signal: new AbortController().signal });
  lease.release({ safe: true });
  await current.broker.close();
});

test("checkAvailability uses a task snapshot, captures refresh, and makes no model call", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  await current.broker.checkAvailability({ signal });

  assert.equal(current.calls.beginTask.length, 1);
  assert.equal(current.calls.stageTask.length, 1);
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.captureTask.length, 1);
  assert.equal(current.calls.process.length, 1);
  assert.deepEqual(current.calls.process[0].args, ["login", "status"]);
  assert.equal(current.calls.cleanup.length, 1);
  await current.broker.close();
});

test("checkAvailability fences future work when credential publication is unsafe", async (t) => {
  let beginCalls = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        beginCalls += 1;
        return Object.freeze(Object.create(null));
      },
      async stageTask() {},
      async captureTask() {
        throw brokerFailure("CODEX_LOGIN_BROKER_BLOCKED");
      },
      async stageProbe() {},
    },
  });

  await assert.rejects(
    current.broker.checkAvailability({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  assert.equal(beginCalls, 1);
  await current.broker.close();
});

test("cleanup failure takes precedence over cancellation and fences the broker", async (t) => {
  const processStarted = deferred();
  const current = await fixture(t, {
    processRunner: {
      async run({ signal }) {
        processStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(brokerFailure("ABORT_ERR")), {
            once: true,
          });
        });
      },
    },
    async prepareCleanupTrees() {
      throw brokerFailure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    },
  });
  const controller = new AbortController();
  const check = current.broker.checkAvailability({ signal: controller.signal });
  await processStarted.promise;
  controller.abort();
  await assert.rejects(check, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("test construction accepts production-shaped class ports", async (t) => {
  class Locator {
    async resolve() {
      throw brokerFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
  }
  class Runner {
    async run() {
      throw new Error("must not run");
    }
  }
  const current = await fixture(t, {
    commandLocator: new Locator(),
    processRunner: new Runner(),
  });
  const status = await current.broker.readStatus();
  assert.equal(status.state, "cli_unavailable");
  await current.broker.close();
});

test("production construction rejects replacement or forged authority", () => {
  assert.throws(
    () => createProductionCodexLoginCredentialBroker({}),
    /lexical composition grant/u,
  );
  assert.throws(
    () => createTestCodexLoginCredentialBroker({}, {}),
    /test dependencies are invalid/u,
  );
});
