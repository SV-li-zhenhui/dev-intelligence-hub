import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTestGhLoginCredentialSource,
} from "../src/adapters/gh-login-credential-source.js";
import {
  TokenEnvCredentialSource,
} from "../src/adapters/token-env-credential-source.js";
import {
  createCredentialLease,
} from "../src/lib/github-credential-source.js";

const TOKEN = "ghp_fictionalCredentialValue123456789";
const ACTOR = "owner-login";

function failure(code, privateDetail = "private failure detail") {
  return Object.assign(new Error(privateDetail), { code });
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
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

async function assertEmptyDirectory(directory) {
  const handle = await opendir(directory);
  try {
    assert.equal(await handle.read(), null);
  } finally {
    await handle.close();
  }
}

async function fixture(t, overrides = {}) {
  const parent = await temporaryDirectory(t, "github-credential-source-");
  const runtimeTemporaryRoot = path.join(parent, "private-runtime-temp");
  const repositoryRoot = path.join(parent, "repository");
  await mkdir(runtimeTemporaryRoot);
  await mkdir(repositoryRoot);
  const ghCommand = path.join(
    parent,
    process.platform === "win32" ? "gh.exe" : "gh",
  );
  const descriptor = Object.freeze({
    command: ghCommand,
    prefixArgs: Object.freeze([]),
  });
  const calls = { pin: [], prepare: [], run: [], cleanup: [] };
  const environment = overrides.environment ?? {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\owner",
    APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
    GH_TOKEN: "host-gh-secret",
    GITHUB_TOKEN: "host-github-secret",
    GITHUB_REPOSITORY: "private/repository",
    GIT_DIR: "private-git-dir",
    SSH_AUTH_SOCK: "private-agent",
    NODE_OPTIONS: "--require private-model-hook",
    HTTPS_PROXY: "http://private-proxy.invalid",
    OPENAI_API_KEY: "private-model-secret",
    GH_CONFIG_DIR: "C:\\private-gh-config",
    PATH: "C:\\untrusted-bin",
  };
  const privateDirectoryManager = overrides.privateDirectoryManager ?? {
    async prepare({ directory, signal, validateLocation }) {
      if (signal?.aborted) throw failure("ABORT_ERR");
      await validateLocation();
      await mkdir(directory).catch((error) => {
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
  const processRunner = overrides.processRunner ?? {
    async run(options) {
      calls.run.push(options);
      await assertEmptyDirectory(options.cwd);
      return {
        exitCode: 0,
        signal: null,
        stdout: `${TOKEN}\r\n`,
        stderr: "",
        stdoutBytes: Buffer.from(`${TOKEN}\r\n`, "utf8"),
        stderrBytes: Buffer.alloc(0),
      };
    },
  };
  let uuidSequence = 0;
  const clock = overrides.clock ?? (() => 1_000_000);
  const source = await createTestGhLoginCredentialSource({
    actorAccountId: ACTOR,
    ghCommand,
    runtimeTemporaryRoot,
    protectedRoots: [repositoryRoot],
  }, {
    platform: overrides.platform ?? "win32",
    environment,
    clock,
    randomUUID: overrides.randomUUID ?? (() => {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    }),
    executablePinner: overrides.executablePinner ?? (async (command, options) => {
      calls.pin.push({ command, options });
      return descriptor;
    }),
    processRunner,
    privateDirectoryManager,
    prepareCleanupTrees,
  });
  return {
    calls,
    descriptor,
    ghCommand,
    parent,
    repositoryRoot,
    runtimeTemporaryRoot,
    source,
  };
}

async function acquire(source, overrides = {}) {
  return source.acquire({
    actorAccountId: ACTOR,
    signal: null,
    deadline: Date.now() + 60_000,
    ...overrides,
  });
}

test("credential leases expose a secret for one callback and release idempotently", async () => {
  const lease = createCredentialLease(TOKEN);
  assert.deepEqual(Reflect.ownKeys(lease).sort(), ["release", "use"]);
  assert.equal(JSON.stringify(lease), "{}");
  assert.equal("token" in lease, false);

  const result = await lease.use(async (token) => {
    assert.equal(token, TOKEN);
    return "callback result";
  });
  assert.equal(result, "callback result");
  assert.equal(lease.release(), undefined);
  assert.equal(lease.release(), undefined);
  await assert.rejects(lease.use(() => {}), TypeError);
});

test("credential leases stop exposing the token when the callback fails", async () => {
  const lease = createCredentialLease(TOKEN);
  await assert.rejects(
    lease.use(() => { throw new Error("consumer failed"); }),
    /consumer failed/,
  );
  await assert.rejects(lease.use(() => TOKEN), TypeError);
  assert.equal(JSON.stringify(lease).includes(TOKEN), false);
});

test("token-env reads its fixed own environment field only at acquire", async () => {
  const environment = {};
  const source = new TokenEnvCredentialSource({
    actorAccountId: ACTOR,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    environment,
  });
  environment.MYDASHBOARD_GITHUB_TOKEN = TOKEN;

  const lease = await acquire(source);
  delete environment.MYDASHBOARD_GITHUB_TOKEN;
  assert.equal(await lease.use((token) => token === TOKEN), true);
  await assert.rejects(acquire(source), { code: "GITHUB_CREDENTIAL_MISSING" });
});

test("token-env preserves the legacy name, actor, and token validation", async () => {
  assert.throws(
    () => new TokenEnvCredentialSource({
      actorAccountId: ACTOR,
      tokenEnv: "lowercase_token",
      environment: {},
    }),
    TypeError,
  );
  for (const token of ["", " leading", "trailing ", "line\nvalue", "x".repeat(4_097)]) {
    const source = new TokenEnvCredentialSource({
      actorAccountId: ACTOR,
      tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
      environment: { MYDASHBOARD_GITHUB_TOKEN: token },
    });
    await assert.rejects(acquire(source), { code: "GITHUB_CREDENTIAL_MISSING" });
  }
  const source = new TokenEnvCredentialSource({
    actorAccountId: ACTOR,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    environment: { MYDASHBOARD_GITHUB_TOKEN: TOKEN },
  });
  await assert.rejects(
    acquire(source, { actorAccountId: "other-owner" }),
    { code: "GITHUB_ACTOR_MISMATCH" },
  );
});

test("gh-login pins once and invokes only the fixed auth token command", async (t) => {
  const current = await fixture(t);
  assert.equal(current.calls.pin.length, 1);
  assert.equal(current.calls.pin[0].command, current.ghCommand);

  const lease = await acquire(current.source);
  assert.equal(await lease.use((token) => token === TOKEN), true);
  assert.equal(current.calls.run.length, 1);
  const invocation = current.calls.run[0];
  assert.equal(invocation.executable, current.descriptor);
  assert.deepEqual(invocation.args, [
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    ACTOR,
  ]);
  assert.deepEqual(invocation.input, Buffer.alloc(0));
  assert.equal(invocation.timeoutMs, 15_000);
  assert.equal(invocation.maxStdoutBytes, 4_096);
  assert.equal(invocation.maxStderrBytes, 8_192);
  assert.equal(path.dirname(invocation.cwd), current.runtimeTemporaryRoot);
  assert.notEqual(invocation.cwd, current.repositoryRoot);
  assert.deepEqual(invocation.env, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\owner",
    APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    TEMP: invocation.cwd,
    TMP: invocation.cwd,
    TMPDIR: invocation.cwd,
  });
  await assert.rejects(lstat(invocation.cwd), { code: "ENOENT" });
  assert.equal(current.calls.cleanup.length, 1);
});

test("gh-login rejects actor injection and protected temporary roots before spawn", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    acquire(current.source, { actorAccountId: `${ACTOR}\n--hostname evil.invalid` }),
    { code: "GITHUB_ACTOR_MISMATCH" },
  );
  assert.equal(current.calls.run.length, 0);

  await assert.rejects(
    createTestGhLoginCredentialSource({
      actorAccountId: ACTOR,
      ghCommand: current.ghCommand,
      runtimeTemporaryRoot: current.repositoryRoot,
      protectedRoots: [current.repositoryRoot],
    }, {
      platform: "win32",
      environment: {},
      clock: () => 1_000_000,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      executablePinner: async () => current.descriptor,
      processRunner: { async run() { throw new Error("must not run"); } },
      privateDirectoryManager: {
        async prepare() { throw new Error("must not prepare"); },
      },
      prepareCleanupTrees: async () => { throw new Error("must not clean"); },
    }),
    { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" },
  );

  await assert.rejects(
    createTestGhLoginCredentialSource({
      actorAccountId: ACTOR,
      ghCommand: current.ghCommand,
      runtimeTemporaryRoot: path.join(current.repositoryRoot, "private-temp"),
      protectedRoots: [current.repositoryRoot],
    }, {
      platform: "win32",
      environment: {},
      clock: () => 1_000_000,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      executablePinner: async () => current.descriptor,
      processRunner: { async run() { throw new Error("must not run"); } },
      privateDirectoryManager: {
        async prepare() { throw new Error("must not prepare"); },
      },
      prepareCleanupTrees: async () => { throw new Error("must not clean"); },
    }),
    { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" },
  );
});

test("gh-login accepts only one strict UTF-8 token line", async (t) => {
  const valid = [Buffer.from(TOKEN), Buffer.from(`${TOKEN}\r\n`)];
  const invalid = [
    Buffer.alloc(0),
    Buffer.from(`${TOKEN}\n`),
    Buffer.from(` ${TOKEN}`),
    Buffer.from(`${TOKEN} `),
    Buffer.from(`${TOKEN}\r\nextra`),
    Buffer.from(`${TOKEN}\r\n\r\n`),
    Buffer.from([0xff, 0xfe]),
    Buffer.alloc(4_097, 0x78),
  ];
  for (const stdoutBytes of valid) {
    await t.test(`valid ${stdoutBytes.length} bytes`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run(options) {
            return {
              exitCode: 0,
              signal: null,
              stdout: stdoutBytes.toString("utf8"),
              stderr: "",
              stdoutBytes,
              stderrBytes: Buffer.alloc(0),
            };
          },
        },
      });
      const lease = await acquire(current.source);
      assert.equal(await lease.use((token) => token), TOKEN);
    });
  }
  for (const stdoutBytes of invalid) {
    await t.test(`invalid ${stdoutBytes.length} bytes`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() {
            return {
              exitCode: 0,
              signal: null,
              stdout: "redacted fixture output",
              stderr: "",
              stdoutBytes,
              stderrBytes: Buffer.alloc(0),
            };
          },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === "GITHUB_CREDENTIAL_OUTPUT_INVALID" &&
        !error.message.includes(TOKEN) &&
        !JSON.stringify(error).includes(TOKEN));
    });
  }
});

test("gh-login rejects stderr, truncation, and nonzero or missing login without details", async (t) => {
  const cases = [
    {
      result: {
        exitCode: 0,
        signal: null,
        stdoutBytes: Buffer.from(TOKEN),
        stderrBytes: Buffer.from("private stderr"),
      },
      code: "GITHUB_CREDENTIAL_OUTPUT_INVALID",
    },
    {
      result: {
        exitCode: 0,
        signal: null,
        stdoutBytes: Buffer.from(TOKEN),
        stderrBytes: Buffer.alloc(0),
        truncated: true,
      },
      code: "GITHUB_CREDENTIAL_OUTPUT_INVALID",
    },
    {
      result: {
        exitCode: 1,
        signal: null,
        stdoutBytes: Buffer.from("private stdout"),
        stderrBytes: Buffer.from("not logged in"),
      },
      code: "GITHUB_LOGIN_UNAVAILABLE",
    },
    {
      error: failure("STRUCTURED_PROVIDER_PROCESS_EXITED", "private gh stderr"),
      code: "GITHUB_LOGIN_UNAVAILABLE",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.code, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() {
            if (entry.error) throw entry.error;
            return entry.result;
          },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === entry.code &&
        !error.message.includes("private") &&
        !JSON.stringify(error).includes("private"));
    });
  }
});

test("gh-login maps timeout, cancellation, output limits, and reap uncertainty", async (t) => {
  const mappings = [
    ["STRUCTURED_PROVIDER_TIMEOUT", "GITHUB_CREDENTIAL_TIMEOUT"],
    ["STRUCTURED_PROVIDER_CANCELLED", "GITHUB_CREDENTIAL_CANCELLED"],
    ["STRUCTURED_PROVIDER_OUTPUT_LIMIT", "GITHUB_CREDENTIAL_OUTPUT_INVALID"],
    ["STRUCTURED_PROVIDER_REAP_FAILED", "GITHUB_CREDENTIAL_CLEANUP_FAILED"],
    ["STRUCTURED_PROVIDER_UNAVAILABLE", "GITHUB_CLI_UNAVAILABLE"],
    ["STRUCTURED_PROVIDER_PROCESS_FAILED", "GITHUB_CLI_UNAVAILABLE"],
  ];
  for (const [runnerCode, expectedCode] of mappings) {
    await t.test(`${runnerCode} -> ${expectedCode}`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() { throw failure(runnerCode, `${TOKEN}-private-detail`); },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === expectedCode &&
        !error.message.includes(TOKEN) &&
        !JSON.stringify(error).includes(TOKEN));
    });
  }
});

test("gh-login uses the caller's remaining total deadline", async (t) => {
  let now = 1_000_000;
  const current = await fixture(t, {
    clock: () => now,
    processRunner: {
      async run(options) {
        current.calls.run.push(options);
        now += 5_001;
        return {
          exitCode: 0,
          signal: null,
          stdoutBytes: Buffer.from(TOKEN),
          stderrBytes: Buffer.alloc(0),
        };
      },
    },
  });
  await assert.rejects(
    acquire(current.source, { deadline: 1_005_000 }),
    { code: "GITHUB_CREDENTIAL_TIMEOUT" },
  );
  assert.equal(current.calls.run[0].timeoutMs, 5_000);
  assert.equal(current.calls.cleanup.length, 1);
});

test("gh-login cancellation and cleanup uncertainty fail closed", async (t) => {
  const controller = new AbortController();
  const cancelled = await fixture(t, {
    processRunner: {
      async run({ signal }) {
        controller.abort(new Error(`${TOKEN}-caller-reason`));
        assert.equal(signal.aborted, true);
        throw failure("STRUCTURED_PROVIDER_CANCELLED");
      },
    },
  });
  await assert.rejects(
    acquire(cancelled.source, { signal: controller.signal }),
    (error) => error?.code === "GITHUB_CREDENTIAL_CANCELLED" &&
      !error.message.includes(TOKEN),
  );

  const cleanupFailed = await fixture(t, {
    async prepareCleanupTrees() {
      throw failure("PRIVATE_CLEANUP_FAILURE", TOKEN);
    },
  });
  await assert.rejects(
    acquire(cleanupFailed.source),
    (error) => error?.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED" &&
      !error.message.includes(TOKEN) &&
      !JSON.stringify(error).includes(TOKEN),
  );
});
