import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProductionSupervisedCliBrainProvider,
  createTestSupervisedCliBrainProvider,
  SupervisedCliBrainProvider,
} from "../src/adapters/supervised-cli-brain-provider.js";
import { BrainRouter } from "../src/services/brain-router.js";

const SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    order: { type: "number" },
  },
});
const PRIVATE_PROMPT = "PRIVATE_PROMPT_MUST_STAY_IN_STDIN";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function brainRequest(overrides = {}) {
  return {
    model: "bounded-model",
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: PRIVATE_PROMPT },
    ],
    schema: SCHEMA,
    ...overrides,
  };
}

function testDescriptor(kind) {
  return Object.freeze({
    command: path.join(
      path.parse(process.cwd()).root,
      "verified-cli-fixtures",
      kind === "codex-cli" ? "codex.exe" : "claude.exe",
    ),
    prefixArgs: Object.freeze([]),
  });
}

function recordingLocator(descriptor) {
  const calls = [];
  return {
    calls,
    async resolve(kind) {
      calls.push(kind);
      return descriptor;
    },
  };
}

function recordingRunner(handler) {
  const calls = [];
  return {
    calls,
    async run(invocation) {
      calls.push(invocation);
      return handler(invocation, calls.length - 1);
    },
  };
}

function cleanupFileSystem(overrides = {}) {
  return Object.freeze({
    lstat,
    opendir,
    realpath,
    rename,
    rmdir,
    unlink,
    ...overrides,
  });
}

async function within(milliseconds, promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("provider request did not settle within its test bound")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function successfulProcess(stdoutBytes = Buffer.alloc(0)) {
  const bytes = Buffer.from(stdoutBytes);
  return {
    exitCode: 0,
    signal: null,
    stdout: bytes.toString("utf8"),
    stderr: "",
    stdoutBytes: bytes,
    stderrBytes: Buffer.alloc(0),
  };
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  assert.ok(index + 1 < args.length, `missing ${flag} value`);
  return args[index + 1];
}

function claudeEnvelope(result = '{"ok":true,"order":2}', overrides = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 20,
    duration_api_ms: 10,
    num_turns: 1,
    result,
    session_id: "isolated-session",
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { "bounded-model": { inputTokens: 10, outputTokens: 5 } },
    permission_denials: [],
    uuid: "isolated-result",
    ...overrides,
  };
}

function providerOptions(cliKind) {
  return {
    id: cliKind,
    cliKind,
    timeoutMs: 300_000,
    maxResponseBytes: 128 * 1024,
    maxRequestBytes: 256 * 1024,
  };
}

test("Codex runs once with fixed no-authority flags and an isolated environment", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-provider-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const locator = recordingLocator(descriptor);
  let invocationDirectory;
  const environment = {
    OPENAI_API_KEY: "codex-test-credential",
    PATH: "HOST_PATH_MUST_NOT_ESCAPE",
    GH_TOKEN: "GITHUB_TOKEN_MUST_NOT_ESCAPE",
    GITHUB_TOKEN: "GITHUB_TOKEN_MUST_NOT_ESCAPE",
    SSH_AUTH_SOCK: "SSH_AGENT_MUST_NOT_ESCAPE",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "private-helper",
    NODE_OPTIONS: "--require=private-hook.js",
    USERPROFILE: "HOST_PROFILE_MUST_NOT_ESCAPE",
  };
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    assert.equal(invocation.executable, descriptor);
    assert.deepEqual(invocation.args.slice(0, 23), [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--strict-config",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "image_generation",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--color",
    ]);
    assert.equal(invocation.args[23], "never");
    assert.equal(argumentValue(invocation.args, "--model"), "bounded-model");
    assert.equal(argumentValue(invocation.args, "-C"), invocation.cwd);
    assert.equal(invocation.args.at(-1), "-");
    for (const forbidden of [
      "resume",
      "--add-dir",
      "workspace-write",
      "--dangerously-bypass-approvals-and-sandbox",
      "--full-auto",
      "--plugin-dir",
      "--mcp-config",
    ]) {
      assert.equal(invocation.args.includes(forbidden), false, forbidden);
    }
    assert.equal(invocation.args.join(" ").includes(PRIVATE_PROMPT), false);
    assert.equal(invocation.args.join(" ").includes(process.cwd()), false);

    const payload = JSON.parse(Buffer.from(invocation.input).toString("utf8"));
    assert.equal(payload.schemaVersion, 1);
    assert.match(payload.instruction, /one JSON object|一个 JSON 对象/i);
    assert.deepEqual(payload.messages, brainRequest().messages);
    assert.deepEqual(payload.schema, SCHEMA);

    const childEnvironment = invocation.env;
    assert.deepEqual(Object.keys(childEnvironment).sort(), [
      "APPDATA",
      "CI",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_COLOR",
      "OPENAI_API_KEY",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    for (const forbidden of [
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
    ]) {
      assert.equal(Object.hasOwn(childEnvironment, forbidden), false, forbidden);
    }
    assert.equal(childEnvironment.OPENAI_API_KEY, "codex-test-credential");
    assert.equal(Object.hasOwn(childEnvironment, "ANTHROPIC_API_KEY"), false);
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]) {
      assert.equal(path.relative(invocation.cwd, childEnvironment[name]).startsWith(".."), false, name);
      assert.equal(childEnvironment[name].includes("HOST_PROFILE"), false, name);
    }

    const schemaFile = argumentValue(invocation.args, "--output-schema");
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    assert.deepEqual(JSON.parse(await readFile(schemaFile, "utf8")), SCHEMA);
    if (process.platform !== "win32") {
      assert.equal((await lstat(schemaFile)).mode & 0o777, 0o600);
      assert.equal((await lstat(invocation.cwd)).mode & 0o777, 0o700);
    }
    await writeFile(resultFile, '{"order":2,"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true,"order":2}');
  assert.equal(provider.kind, "codex-cli");
  assert.equal(provider.remote, true);
  assert.equal(provider.singleAttempt, true);
  assert.deepEqual(locator.calls, ["codex-cli"]);
  assert.equal(runner.calls.length, 1);
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("Claude runs once with tools disabled and accepts only its exact success envelope", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-claude-provider-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("claude-cli");
  const locator = recordingLocator(descriptor);
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    assert.equal(invocation.executable, descriptor);
    for (const [flag, value] of [
      ["--output-format", "json"],
      ["--input-format", "text"],
      ["--tools", ""],
      ["--permission-mode", "dontAsk"],
      ["--mcp-config", "{}"],
      ["--model", "bounded-model"],
    ]) {
      assert.equal(argumentValue(invocation.args, flag), value, flag);
    }
    for (const flag of [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--no-chrome",
      "--no-session-persistence",
    ]) {
      assert.equal(invocation.args.includes(flag), true, flag);
    }
    for (const forbidden of [
      "--max-turns",
      "--system-prompt",
      "--system-prompt-file",
      "--json-schema",
      "--allowedTools",
      "--dangerously-skip-permissions",
      "--add-dir",
      "--resume",
      "--continue",
      "--plugin-dir",
    ]) {
      assert.equal(invocation.args.includes(forbidden), false, forbidden);
    }
    assert.equal(invocation.args.join(" ").includes(PRIVATE_PROMPT), false);
    const payload = JSON.parse(Buffer.from(invocation.input).toString("utf8"));
    assert.deepEqual(payload.messages, brainRequest().messages);
    assert.deepEqual(payload.schema, SCHEMA);
    assert.equal(invocation.env.ANTHROPIC_API_KEY, "claude-test-credential");
    assert.equal(Object.hasOwn(invocation.env, "OPENAI_API_KEY"), false);
    assert.equal(
      Object.hasOwn(invocation.env, "CLAUDE_CODE_OAUTH_TOKEN"),
      false,
    );
    assert.deepEqual(Object.keys(invocation.env).sort(), [
      "ANTHROPIC_API_KEY",
      "APPDATA",
      "CI",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_COLOR",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    return successfulProcess(
      Buffer.from(JSON.stringify(claudeEnvelope()), "utf8"),
    );
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: {
        ANTHROPIC_API_KEY: "claude-test-credential",
        CLAUDE_CODE_OAUTH_TOKEN: "HOST_LOGIN_MUST_NOT_ESCAPE",
      },
      temporaryRoot,
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true,"order":2}');
  assert.equal(runner.calls.length, 1);
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("credentials, cancellation, and request limits fail before locator or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-admission-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const locator = recordingLocator(descriptor);
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const environment = {};
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) => error.code === "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);

  environment.OPENAI_API_KEY = "configured-after-startup";
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    (error) => error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("private cancellation reason"),
  );
  assert.equal(locator.calls.length, 0);

  const bounded = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), maxRequestBytes: 1_024 },
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );
  await assert.rejects(
    bounded.generate(brainRequest({
      messages: [{ role: "user", content: "x".repeat(2_000) }],
    })),
    { code: "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE" },
  );
  assert.equal(locator.calls.length, 0);

  await assert.rejects(
    bounded.generate(brainRequest({
      messages: [{ role: "user", content: "x".repeat(670) }],
    })),
    { code: "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE" },
  );
  assert.equal(locator.calls.length, 0);

  for (const model of [
    "--dangerously-skip-permissions",
    "-c",
    "model with spaces",
  ]) {
    await assert.rejects(
      provider.generate(brainRequest({ model })),
      /CLI model is invalid/,
    );
  }
  assert.equal(locator.calls.length, 0);

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(locator.calls.length, 1);
  assert.equal(runner.calls.length, 1);
});

test("cancellation bounds unresolved CLI discovery and a later attempt recovers", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-discovery-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  let resolveCalls = 0;
  let discoverySignal = null;
  let discoveryStarted;
  const started = new Promise((resolve) => { discoveryStarted = resolve; });
  const locator = {
    async resolve(_kind, options = {}) {
      resolveCalls += 1;
      discoverySignal = options.signal ?? null;
      if (resolveCalls === 1) {
        discoveryStarted();
        return new Promise(() => {});
      }
      return descriptor;
    },
  };
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  controller.abort(new Error("private cancellation reason"));

  await within(1_000, cancelled);
  assert.equal(discoverySignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(resolveCalls, 2);
});

test("the configured timeout bounds unresolved CLI discovery before spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-discovery-timeout-");
  let discoverySignal = null;
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: {
        async resolve(_kind, options = {}) {
          discoverySignal = options.signal ?? null;
          return new Promise(() => {});
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
    },
  );

  await within(
    3_000,
    assert.rejects(provider.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_TIMEOUT",
    }),
  );
  assert.equal(discoverySignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
});

test("cancellation bounds stale scanning and does not poison later use", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  let scavengeCalls = 0;
  let scavengeSignal = null;
  let scavengeStarted;
  const started = new Promise((resolve) => { scavengeStarted = resolve; });
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async ({ signal }) => {
        scavengeCalls += 1;
        scavengeSignal = signal;
        if (scavengeCalls === 1) {
          scavengeStarted();
          return new Promise(() => {});
        }
      },
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  controller.abort();

  await within(1_000, cancelled);
  assert.equal(scavengeSignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(scavengeCalls, 2);
});

test("CLI discovery and initialization consume the runner's one total deadline", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-total-deadline-");
  const temporaryRoot = path.join(parent, "runtime");
  let monotonicTime = 10_000;
  let discoverySignal = null;
  let scavengeSignal = null;
  const runner = recordingRunner(async (invocation) => {
    assert.equal(invocation.timeoutMs, 500);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: {
        async resolve(_kind, options = {}) {
          discoverySignal = options.signal ?? null;
          monotonicTime += 200;
          return testDescriptor("codex-cli");
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      monotonicClock: () => monotonicTime,
      staleInvocationScavenger: async ({ signal }) => {
        scavengeSignal = signal;
        monotonicTime += 300;
      },
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(discoverySignal instanceof AbortSignal, true);
  assert.equal(scavengeSignal, discoverySignal);
  assert.equal(runner.calls.length, 1);
});

test("protected roots reject equality and both ancestor directions before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-protected-roots-");
  const protectedRoot = path.join(parent, "protected");
  const nestedRoot = path.join(protectedRoot, "nested");
  const protectedDescendant = path.join(nestedRoot, "runtime");
  await mkdir(nestedRoot, { recursive: true });
  const protectedMode = (await lstat(protectedRoot)).mode & 0o777;

  for (const temporaryRoot of [
    protectedRoot,
    protectedDescendant,
    parent,
  ]) {
    const locator = recordingLocator(testDescriptor("codex-cli"));
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions("codex-cli"),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: { OPENAI_API_KEY: "credential" },
        temporaryRoot,
        protectedRoots: [protectedRoot],
      },
    );

    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
        !error.message.includes(parent),
    );
    assert.equal(locator.calls.length, 0);
    assert.equal(runner.calls.length, 0);
  }
  await assert.rejects(lstat(protectedDescendant), { code: "ENOENT" });
  if (process.platform !== "win32") {
    assert.equal((await lstat(protectedRoot)).mode & 0o777, protectedMode);
  }
});

test("protected-root real-path aliases are rejected before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-protected-alias-");
  const protectedRoot = path.join(parent, "protected");
  const protectedAlias = path.join(parent, "protected-alias");
  await mkdir(protectedRoot);
  try {
    await symlink(protectedRoot, protectedAlias, "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("directory symlinks require Windows Developer Mode or elevated privilege");
      return;
    }
    throw error;
  }
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(protectedRoot, "runtime"),
      protectedRoots: [protectedAlias],
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("a replaced validated root fails before a second discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-root-replaced-");
  const temporaryRoot = path.join(parent, "runtime");
  const replacedRoot = path.join(parent, "runtime-original");
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  await rename(temporaryRoot, replacedRoot);
  await mkdir(temporaryRoot);

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 1);
  assert.equal(runner.calls.length, 1);
});

test("Git metadata in an invocation-root ancestor fails closed before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-git-ancestor-");
  const temporaryRoot = path.join(parent, "runtime", "isolated");
  await writeFile(path.join(parent, ".git"), "gitdir: private-host-path", "utf8");
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
      !error.message.includes(parent) &&
      !JSON.stringify(error).includes(parent),
  );
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("remote data denial reaches neither supervised CLI locator nor runner", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-routing-denial-");
  for (const kind of ["codex-cli", "claude-cli"]) {
    const locator = recordingLocator(testDescriptor(kind));
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions(kind),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: kind === "codex-cli"
          ? { OPENAI_API_KEY: "private-codex-key" }
          : { ANTHROPIC_API_KEY: "private-claude-key" },
        temporaryRoot: path.join(parent, kind),
      },
    );
    const router = new BrainRouter({ providers: [provider] });
    const configuredBrain = {
      provider: kind,
      model: "bounded-model",
      remoteData: { requirements: false, code: false, memory: false },
    };

    assert.equal(router.describe(configuredBrain).singleAttempt, true);
    await assert.rejects(
      router.generate({
        brain: configuredBrain,
        messages: brainRequest().messages,
        schema: SCHEMA,
        dataClasses: ["requirements"],
      }),
      (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
    );
    assert.equal(locator.calls.length, 0);
    assert.equal(runner.calls.length, 0);
  }
});

test("an unavailable known CLI stays redacted and never reaches the runner", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-unavailable-");
  for (const kind of ["codex-cli", "claude-cli"]) {
    const locatorCalls = [];
    const locator = {
      async resolve(value) {
        locatorCalls.push(value);
        throw Object.assign(new Error("private executable lookup detail"), {
          code: "STRUCTURED_PROVIDER_UNAVAILABLE",
        });
      },
    };
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions(kind),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: kind === "codex-cli"
          ? { OPENAI_API_KEY: "private-codex-key" }
          : { ANTHROPIC_API_KEY: "private-claude-key" },
        temporaryRoot: path.join(parent, kind),
      },
    );

    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
        error.statusCode === 503 &&
        !error.message.includes("private executable lookup detail"),
    );
    assert.deepEqual(locatorCalls, [kind]);
    assert.equal(runner.calls.length, 0);
  }
});

test("internal TypeErrors are redacted after request admission", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-type-error-");
  const privatePath = path.join(parent, "private-host-path", "codex.exe");
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: {
        async resolve() {
          throw new TypeError(`cannot inspect ${privatePath}`);
        },
      },
      environment: { OPENAI_API_KEY: "private-key" },
      temporaryRoot: path.join(parent, "runtime"),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
      !error.message.includes(privatePath) &&
      !JSON.stringify(error).includes(privatePath),
  );
  assert.equal(runner.calls.length, 0);
});

test("Claude rejects malformed, conflicting, oversized, and non-UTF-8 output", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-claude-invalid-");
  const temporaryRoot = path.join(parent, "runtime");
  const outputs = [
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { extra: true }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { is_error: true }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { subtype: "error" }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { num_turns: 2 }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { permission_denials: ["tool"] }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { structured_output: { ok: true } }))),
    Buffer.from(JSON.stringify(claudeEnvelope("not-json"))),
    Buffer.from(JSON.stringify(claudeEnvelope("[]"))),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '"is_error":false',
        '"is_error":true,"is_error":false',
      ),
    ),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '"is_error":false',
        '"is_\\u0065rror":true,"is_error":false',
      ),
    ),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '\\"ok\\":true',
        '\\"ok\\":false,\\"ok\\":true',
      ),
    ),
    Buffer.from([0xc3, 0x28]),
  ];

  for (const output of outputs) {
    let invocationDirectory;
    const runner = recordingRunner(async (invocation) => {
      invocationDirectory = invocation.cwd;
      return successfulProcess(output);
    });
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions("claude-cli"),
      {
        processRunner: runner,
        commandLocator: recordingLocator(testDescriptor("claude-cli")),
        environment: { ANTHROPIC_API_KEY: "private-credential" },
        temporaryRoot,
      },
    );
    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID" &&
        !error.message.includes(PRIVATE_PROMPT) &&
        !error.message.includes("private-credential") &&
        !error.message.includes(temporaryRoot) &&
        !JSON.stringify(error).includes(output.toString("utf8")),
    );
    await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
  }

  const oversizedRunner = recordingRunner(async () => successfulProcess(
    Buffer.from("x".repeat(128 * 1024 + 1)),
  ));
  const oversized = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: oversizedRunner,
      commandLocator: recordingLocator(testDescriptor("claude-cli")),
      environment: { ANTHROPIC_API_KEY: "private-credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(
    oversized.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE" },
  );
});

async function assertCodexResultLinkRejected(t, attack) {
  const parent = await temporaryDirectory(t, "supervised-codex-links-");
  const temporaryRoot = path.join(parent, "runtime");
  const victim = path.join(parent, "victim.json");
  await writeFile(victim, '{"private":true}', "utf8");
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await rm(resultFile);
    if (attack === "hardlink") await link(victim, resultFile);
    else await symlink(victim, resultFile, "file");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
    attack,
  );
  assert.equal(await readFile(victim, "utf8"), '{"private":true}');
}

test("Codex result files reject hardlinks outside the invocation", async (t) => {
  await assertCodexResultLinkRejected(t, "hardlink");
});

test("Codex result files reject symlinks outside the invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-symlink-probe-");
  const victim = path.join(parent, "victim.json");
  const probe = path.join(parent, "symlink-probe.json");
  await writeFile(victim, '{"private":true}', "utf8");
  try {
    await symlink(victim, probe, "file");
    await rm(probe);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("file symlinks require Windows Developer Mode or elevated privilege");
      return;
    }
    throw error;
  }
  await assertCodexResultLinkRejected(t, "symlink");
});

test("invocation initialization failure cleans its verified directory and the provider recovers", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-init-recovery-");
  const temporaryRoot = path.join(parent, "runtime");
  let clockCalls = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      clock: () => clockCalls++ === 0 ? Number.NaN : Date.now(),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.equal(runner.calls.length, 1);
});

test("temporary root and stale scan failures are retryable on the same provider", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-root-recovery-");
  const temporaryRoot = path.join(parent, "runtime");
  await writeFile(temporaryRoot, "blocks the first mkdir", "utf8");
  let scanCalls = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async () => {
        scanCalls += 1;
        if (scanCalls === 1) throw new Error("private transient scan failure");
      },
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  await rm(temporaryRoot);
  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  assert.equal(scanCalls, 1);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(scanCalls, 2);
  assert.equal(runner.calls.length, 1);
});

test("provider failures are redacted and clean only their verified invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-failure-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    throw Object.assign(new Error("PRIVATE_STDERR_AND_PATH_MUST_NOT_ESCAPE"), {
      code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
      statusCode: 502,
    });
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "private-credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_PROCESS_FAILED" &&
      !error.message.includes("PRIVATE_STDERR") &&
      !error.message.includes(PRIVATE_PROMPT) &&
      !error.message.includes("private-credential") &&
      !error.message.includes(temporaryRoot),
  );
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("cleanup failure takes precedence over an earlier process failure", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-failure-");
  const temporaryRoot = path.join(parent, "runtime");
  let movedInvocation;
  const runner = recordingRunner(async (invocation) => {
    movedInvocation = `${invocation.cwd}-original`;
    await rename(invocation.cwd, movedInvocation);
    await mkdir(invocation.cwd);
    await writeFile(
      path.join(invocation.cwd, "untrusted-raced-entry.txt"),
      "must-not-be-deleted",
      "utf8",
    );
    throw Object.assign(new Error("private process failure"), {
      code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
    });
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "private-key" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" &&
      !error.message.includes("private process failure") &&
      !error.message.includes(temporaryRoot),
  );
  assert.equal((await lstat(movedInvocation)).isDirectory(), true);
  const quarantines = (await readdir(temporaryRoot))
    .filter((name) => name.startsWith(".cleanup-"));
  assert.equal(quarantines.length, 1);
  assert.equal(
    await readFile(
      path.join(
        temporaryRoot,
        quarantines[0],
        "untrusted-raced-entry.txt",
      ),
      "utf8",
    ),
    "must-not-be-deleted",
  );
});

test("cleanup retains an invocation whose entry count exceeds the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-count-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    for (let index = 0; index < 257; index += 1) {
      await writeFile(
        path.join(invocation.cwd, `entry-${String(index).padStart(3, "0")}`),
        "",
      );
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("cleanup retains an invocation whose directory depth exceeds the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-depth-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    let directory = invocation.cwd;
    for (let depth = 0; depth < 17; depth += 1) {
      directory = path.join(directory, `depth-${String(depth).padStart(2, "0")}`);
      await mkdir(directory);
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("cleanup retains an invocation whose aggregate regular-file bytes exceed the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-bytes-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    const oversized = path.join(invocation.cwd, "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 16 * 1024 * 1024 + 1);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("an unresolved cleanup operation is deadline-bounded and blocks providers sharing the root", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-hang-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  const firstRunner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const first = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: firstRunner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async unlink() {
          return new Promise(() => {});
        },
      }),
    },
  );

  await within(
    3_000,
    assert.rejects(first.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    }),
  );
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );

  const secondLocator = recordingLocator(testDescriptor("codex-cli"));
  const secondRunner = recordingRunner(async () => successfulProcess());
  const second = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: secondRunner,
      commandLocator: secondLocator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(second.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(secondLocator.calls.length, 0);
  assert.equal(secondRunner.calls.length, 0);
});

test("cancellation with no cleanup budget retains the invocation and reports cleanup failure", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const controller = new AbortController();
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    controller.abort(new Error("private cancellation"));
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" &&
      !error.message.includes("private cancellation") &&
      !error.message.includes(temporaryRoot),
  );
  assert.equal((await lstat(invocationDirectory)).isDirectory(), true);
});

test("cleanup rejects hard-linked and symbolic-link entries without touching their targets", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-links-");
  const victim = path.join(parent, "victim.txt");
  await writeFile(victim, "retain-me", "utf8");

  for (const attack of ["hardlink", "symlink"]) {
    if (attack === "symlink") {
      const probe = path.join(parent, "symlink-probe");
      try {
        await symlink(victim, probe, "file");
        await unlink(probe);
      } catch (error) {
        if (["EPERM", "EACCES"].includes(error?.code)) continue;
        throw error;
      }
    }
    const temporaryRoot = path.join(parent, `runtime-${attack}`);
    const runner = recordingRunner(async (invocation) => {
      const entry = path.join(invocation.cwd, `untrusted-${attack}`);
      if (attack === "hardlink") await link(victim, entry);
      else await symlink(victim, entry, "file");
      const resultFile = argumentValue(invocation.args, "--output-last-message");
      await writeFile(resultFile, '{"ok":true}', "utf8");
      return successfulProcess();
    });
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions("codex-cli"),
      {
        processRunner: runner,
        commandLocator: recordingLocator(testDescriptor("codex-cli")),
        environment: { OPENAI_API_KEY: "credential" },
        temporaryRoot,
      },
    );

    await assert.rejects(provider.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    });
    assert.equal(await readFile(victim, "utf8"), "retain-me");
  }
});

test("an unprovable process reap remains visible when the total deadline expires", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-reap-deadline-");
  let monotonicTime = 50_000;
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    monotonicTime += 1_001;
    const error = new Error("private process identity");
    error.code = "STRUCTURED_PROVIDER_REAP_FAILED";
    throw error;
  });
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
      monotonicClock: () => monotonicTime,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_REAP_FAILED",
  });
  assert.equal((await lstat(invocationDirectory)).isDirectory(), true);
});

test("a critical stale-cleanup failure is not hidden by the total deadline", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-critical-cleanup-");
  let monotonicTime = 70_000;
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
      monotonicClock: () => monotonicTime,
      staleInvocationScavenger: async () => {
        monotonicTime += 1_001;
        const error = new Error("private cleanup path");
        error.code = "STRUCTURED_PROVIDER_CLEANUP_FAILED";
        throw error;
      },
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(runner.calls.length, 0);
});

test("cancellation bounds an unresolved Codex result read and retains the invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-result-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  let readerSignal = null;
  let readerStarted;
  const started = new Promise((resolve) => { readerStarted = resolve; });
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      codexResultReader: async (_file, _identity, _maximumBytes, { signal }) => {
        readerSignal = signal;
        readerStarted();
        return new Promise(() => {});
      },
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await started;
  controller.abort();

  await within(2_000, cancelled);
  assert.equal(readerSignal?.aborted, true);
  assert.equal((await lstat(invocationDirectory)).isDirectory(), true);
});

test("production provider construction has no dependency replacement seam", () => {
  assert.throws(
    () => new SupervisedCliBrainProvider(
      providerOptions("codex-cli"),
      {},
      { processRunner: {}, commandLocator: {} },
    ),
    /Production supervised CLI providers.*replacement dependencies/,
  );
  assert.throws(
    () => createProductionSupervisedCliBrainProvider({
      ...providerOptions("codex-cli"),
      processRunner: {},
    }),
    /options are invalid/,
  );
  for (const forbidden of [
    { temporaryRoot: path.join(process.cwd(), "replacement-root") },
    { protectedRoots: [process.cwd()] },
    { dependencies: {} },
  ]) {
    assert.throws(
      () => createProductionSupervisedCliBrainProvider({
        ...providerOptions("codex-cli"),
        ...forbidden,
      }),
      /options are invalid/,
    );
  }
});

test("the first use scavenges only stale verified residues and concurrent calls stay unique", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot, { recursive: true });
  const old = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
  const fresh = new Date().toISOString();
  const residues = [
    ["invocation-codex-cli-stale001", 111, old, true],
    ["invocation-codex-cli-live001", 222, old, true],
    ["invocation-codex-cli-fresh01", 333, fresh, true],
    ["invocation-codex-cli-unknown1", 444, old, false],
  ];
  for (const [name, ownerPid, createdAt, marked] of residues) {
    const directory = path.join(temporaryRoot, name);
    await mkdir(directory);
    if (marked) {
      await writeFile(
        path.join(directory, ".mydashboard-invocation.json"),
        JSON.stringify({ schemaVersion: 1, kind: "codex-cli", ownerPid, createdAt }),
        "utf8",
      );
    }
  }

  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const directories = [];
  const runner = recordingRunner(async (invocation) => {
    directories.push(invocation.cwd);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    if (directories.length === 2) release();
    await released;
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: (processId) => processId === 222,
    },
  );

  assert.deepEqual(
    await Promise.all([provider.generate(brainRequest()), provider.generate(brainRequest())]),
    ['{"ok":true}', '{"ok":true}'],
  );
  assert.equal(new Set(directories).size, 2);
  for (const directory of directories) {
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  }
  const remaining = await readdir(temporaryRoot);
  assert.equal(remaining.includes("invocation-codex-cli-stale001"), false);
  assert.equal(remaining.includes("invocation-codex-cli-live001"), true);
  assert.equal(remaining.includes("invocation-codex-cli-fresh01"), true);
  assert.equal(remaining.includes("invocation-codex-cli-unknown1"), true);
});

test("stale scavenging fails closed before mutation when the root exceeds 128 entries", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-bound-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1_000).toISOString();
  for (let index = 0; index < 129; index += 1) {
    const directory = path.join(
      temporaryRoot,
      `invocation-codex-cli-bounded${String(index).padStart(3, "0")}`,
    );
    await mkdir(directory);
    await writeFile(
      path.join(directory, ".mydashboard-invocation.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "codex-cli",
        ownerPid: 10_000 + index,
        createdAt: old,
      }),
      "utf8",
    );
  }
  let processChecks = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, '{"ok":true}', "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      clock: () => now,
      isProcessAlive: () => {
        processChecks += 1;
        return false;
      },
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(runner.calls.length, 0);
  assert.equal(processChecks, 0);
  assert.equal(
    (await readdir(temporaryRoot)).filter((name) =>
      name.startsWith("invocation-codex-cli-bounded")
    ).length,
    129,
  );
});
