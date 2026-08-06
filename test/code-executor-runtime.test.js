import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodeExecutorRuntimeError,
  createCodeExecutorRuntime,
} from "../src/code-executor-runtime.js";
import { mergeConfig } from "../src/lib/config.js";
import { StateStore } from "../src/lib/state-store.js";

const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "code-executor-runtime-"));
  const sourceBaseRoot = path.join(root, "sources");
  await mkdir(path.join(sourceBaseRoot, "dashboard", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(sourceBaseRoot, "dashboard", "src", "app.js"),
    "export const value = 1;\n",
  );
  await mkdir(path.join(sourceBaseRoot, "product", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(sourceBaseRoot, "product", "src", "app.js"),
    "export const product = true;\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    runtimeRoot: path.join(root, "runtime"),
    sourceBaseRoot,
    store: new StateStore(path.join(root, "state")),
  };
}

function enabledConfig(root) {
  return {
    enabled: true,
    docker: {
      executable: path.join(root, "docker.exe"),
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        writablePaths: ["src"],
      },
    ],
    profiles: {
      "node-tests": { kind: "node-test", image, timeoutMs: 30_000 },
    },
    requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
  };
}

function pullRequestBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/dashboard#42",
    workKey: "pr:acme/dashboard#42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: "1".repeat(40),
    eventId: "github-event-pr-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    ...overrides,
  };
}

function fakeGitSnapshotter(sourceRoot, {
  gitCommand = path.resolve(sourceRoot, "..", "..", "git.exe"),
  gitExecutableSha256 = "e".repeat(64),
  gitExecutableBytes = 1,
  gitExecutableMode = 0o755,
  gitExecutableUid = 0,
  gitExecutableGid = 0,
  boundaryDigest = "a".repeat(64),
  objectFormat = "sha1",
  content = "export const value = 'fixed-head';\n",
  preflightError = null,
  extraBoundary = {},
} = {}) {
  const calls = { preflight: [], materialize: [] };
  return {
    calls,
    async preflight(request) {
      calls.preflight.push(structuredClone(request));
      if (preflightError) throw preflightError;
      return {
        schemaVersion: 1,
        gitCommand,
        gitExecutableSha256,
        gitExecutableBytes,
        gitExecutableMode,
        gitExecutableUid,
        gitExecutableGid,
        canonicalRoot: path.resolve(sourceRoot),
        absoluteGitDir: path.resolve(sourceRoot, ".git"),
        commonDir: path.resolve(sourceRoot, ".git"),
        objectDirectory: path.resolve(sourceRoot, ".git", "objects"),
        objectFormat,
        oidLength: objectFormat === "sha1" ? 40 : 64,
        boundaryDigest,
        ...extraBoundary,
      };
    },
    async materialize(request) {
      calls.materialize.push(structuredClone(request));
      const value = Buffer.from(content);
      const relativePath = "src/app.js";
      const target = path.join(request.targetRoot, "src", "app.js");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value);
      return {
        headOid: request.headOid,
        baseline: new Map([
          [
            relativePath,
            createHash("sha256").update(value).digest("hex"),
          ],
        ]),
        modes: new Map([[relativePath, "100644"]]),
        fileCount: 1,
        totalBytes: value.length,
      };
    },
  };
}

test("disabled runtime constructs nothing", async (t) => {
  const setup = await fixture(t);

  assert.equal(
    await createCodeExecutorRuntime(
      { enabled: false },
      { runtimeRoot: setup.runtimeRoot },
    ),
    null,
  );
  await assert.rejects(access(setup.runtimeRoot), (error) => error.code === "ENOENT");
});

test("enabled runtime resolves local workspaces and recovers before use", async (t) => {
  const setup = await fixture(t);
  const runtime = await createCodeExecutorRuntime(enabledConfig(setup.root), {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
  });

  assert.deepEqual(runtime.recovery, { recovered: true, cleanupPending: 0 });
  assert.deepEqual(runtime.authority, {
    workspaces: [
      {
        id: "dashboard",
        capabilities: ["directory_snapshot"],
        writablePaths: ["src"],
        requiredProfiles: [
          {
            id: "node-tests",
            configDigest: runtime.sandbox.getProfileFingerprint("node-tests"),
          },
        ],
        authorityDigest: runtime.authority.workspaces[0].authorityDigest,
      },
    ],
  });
  assert.match(
    runtime.authority.workspaces[0].authorityDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(Object.isFrozen(runtime.authority.workspaces[0]), true);
  assert.deepEqual(runtime.changePackageTargets, [
    {
      workspaceId: "dashboard",
      sourceRoot: path.join(setup.sourceBaseRoot, "dashboard"),
      targetAuthorityDigest: runtime.authority.workspaces[0].authorityDigest,
      writablePaths: ["src"],
      excludePaths: [],
    },
  ]);
  assert.equal(Object.isFrozen(runtime.changePackageTargets), true);
  assert.equal(Object.isFrozen(runtime.changePackageTargets[0]), true);
  assert.deepEqual(Object.keys(runtime.completedChangeExporter), ["export"]);
  assert.equal(Object.isFrozen(runtime.completedChangeExporter), true);
  assert.deepEqual(Object.keys(runtime.auditArtifactReader), ["read"]);
  assert.equal(Object.isFrozen(runtime.auditArtifactReader), true);
  const artifactRef = await runtime.journal.writeJson({
    sessionId: "runtime-session",
    actionId: "runtime-proof",
    kind: "output",
    value: { passed: true },
  });
  assert.deepEqual(
    await runtime.auditArtifactReader.read(artifactRef),
    Buffer.from('{"passed":true}\n'),
  );
  const session = await runtime.executor.start({
    sessionId: "runtime-session",
    workspaceId: "dashboard",
    requestedBy: { roleId: "r".repeat(65), workItemId: "dashboard#unit4" },
    inputBinding: null,
  });
  const read = await runtime.executor.perform({
    sessionId: session.id,
    action: {
      type: "read_text",
      actionId: "read-runtime-source",
      expectedWorkspaceRevision: session.workspaceRevision,
      path: "src/app.js",
    },
  });

  assert.equal(read.result.content, "export const value = 1;\n");
  assert.equal(read.session.status, "active");
  await assert.rejects(
    runtime.completedChangeExporter.export({
      sessionId: session.id,
      completedActionId: "complete-runtime-session",
      expectedWorkspaceRevision: session.workspaceRevision,
    }),
    (error) => error.code === "EXECUTOR_SESSION_NOT_COMPLETED",
  );
});

test("Git Head capability is advertised only after preflight and executes the sealed PR Head", async (t) => {
  const setup = await fixture(t);
  const config = enabledConfig(setup.root);
  config.gitCommand = path.join(setup.root, "git.exe");
  config.gitTimeoutMs = 12_345;
  config.workspaces[0].gitHeadSnapshot = true;
  const sourceRoot = path.join(setup.sourceBaseRoot, "dashboard");
  const gitSnapshotter = fakeGitSnapshotter(sourceRoot);

  const runtime = await createCodeExecutorRuntime(config, {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
    gitSnapshotter,
  });

  assert.deepEqual(gitSnapshotter.calls.preflight, [{ sourceRoot }]);
  assert.deepEqual(runtime.authority.workspaces[0].capabilities, [
    "directory_snapshot",
    "git_head_snapshot",
  ]);
  const inputBinding = pullRequestBinding();
  const session = await runtime.executor.start({
    sessionId: "git-head-session",
    workspaceId: "dashboard",
    requestedBy: { roleId: "developer", workItemId: "dashboard#pr42" },
    inputBinding,
  });
  assert.deepEqual(session.inputBinding, inputBinding);
  const read = await runtime.executor.perform({
    sessionId: session.id,
    action: {
      type: "read_text",
      actionId: "read-fixed-head-source",
      expectedWorkspaceRevision: session.workspaceRevision,
      path: "src/app.js",
    },
  });
  assert.equal(read.result.content, "export const value = 'fixed-head';\n");
  assert.equal(gitSnapshotter.calls.materialize.length, 1);
  assert.deepEqual(
    {
      sourceRoot: gitSnapshotter.calls.materialize[0].sourceRoot,
      headOid: gitSnapshotter.calls.materialize[0].headOid,
      excludePaths: gitSnapshotter.calls.materialize[0].excludePaths,
      expectedBoundaryDigest:
        gitSnapshotter.calls.materialize[0].expectedBoundaryDigest,
      expectedGitCommand:
        gitSnapshotter.calls.materialize[0].expectedGitCommand,
      expectedGitExecutableSha256:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableSha256,
      expectedGitExecutableBytes:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableBytes,
      expectedGitExecutableMode:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableMode,
      expectedGitExecutableUid:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableUid,
      expectedGitExecutableGid:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableGid,
    },
    {
      sourceRoot,
      headOid: inputBinding.headRefOid,
      excludePaths: [],
      expectedBoundaryDigest: "a".repeat(64),
      expectedGitCommand: path.join(setup.root, "git.exe"),
      expectedGitExecutableSha256: "e".repeat(64),
      expectedGitExecutableBytes: 1,
      expectedGitExecutableMode: 0o755,
      expectedGitExecutableUid: 0,
      expectedGitExecutableGid: 0,
    },
  );
});

test("explicit Git Head configuration fails startup on missing authority or preflight failure", async (t) => {
  const setup = await fixture(t);
  const optIn = enabledConfig(setup.root);
  optIn.workspaces[0].gitHeadSnapshot = true;

  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );

  optIn.gitCommand = path.join(setup.root, "git.exe");
  const preflightFailure = fakeGitSnapshotter(
    path.join(setup.sourceBaseRoot, "dashboard"),
    { preflightError: Object.assign(new Error("not a repository"), {
      code: "GIT_SNAPSHOT_ROOT_MISMATCH",
    }) },
  );
  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: preflightFailure,
    }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "GIT_HEAD_SNAPSHOT_PREFLIGHT_FAILED",
  );

  const invalidReceipt = fakeGitSnapshotter(
    path.join(setup.sourceBaseRoot, "dashboard"),
    { extraBoundary: { widened: true } },
  );
  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: invalidReceipt,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );

  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: fakeGitSnapshotter(
        path.join(setup.sourceBaseRoot, "dashboard"),
      ),
      broker: {},
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
});

test("Git snapshot command, boundary, format, and capability are sealed into workspace authority", async (t) => {
  const setup = await fixture(t);
  const sourceRoot = path.join(setup.sourceBaseRoot, "dashboard");
  const create = (suffix, {
    command = `git-${suffix}.exe`,
    gitExecutableSha256 = "e".repeat(64),
    gitExecutableMode = 0o755,
    boundaryDigest = "a".repeat(64),
    objectFormat = "sha1",
    enabled = true,
  } = {}) => {
    const config = enabledConfig(setup.root);
    if (enabled) {
      config.gitCommand = path.join(setup.root, command);
      config.workspaces[0].gitHeadSnapshot = true;
    }
    return createCodeExecutorRuntime(config, {
      runtimeRoot: path.join(setup.root, `runtime-git-${suffix}`),
      sourceBaseRoot: setup.sourceBaseRoot,
      store: new StateStore(path.join(setup.root, `state-git-${suffix}`)),
      ...(enabled
        ? {
            gitSnapshotter: fakeGitSnapshotter(sourceRoot, {
              gitCommand: path.join(setup.root, command),
              gitExecutableSha256,
              gitExecutableMode,
              boundaryDigest,
              objectFormat,
            }),
          }
        : {}),
    });
  };

  const [base, command, executable, executableMode, boundary, format, directory] = await Promise.all([
    create("base", { command: "git.exe" }),
    create("command", { command: "git-other.exe" }),
    create("executable", {
      command: "git.exe",
      gitExecutableSha256: "f".repeat(64),
    }),
    create("executable-mode", {
      command: "git.exe",
      gitExecutableMode: 0o555,
    }),
    create("boundary", { command: "git.exe", boundaryDigest: "b".repeat(64) }),
    create("format", { command: "git.exe", objectFormat: "sha256" }),
    create("directory", { enabled: false }),
  ]);
  const digest = (runtime) => runtime.authority.workspaces[0].authorityDigest;

  assert.notEqual(digest(base), digest(command));
  assert.notEqual(digest(base), digest(executable));
  assert.notEqual(digest(base), digest(executableMode));
  assert.notEqual(digest(base), digest(boundary));
  assert.notEqual(digest(base), digest(format));
  assert.notEqual(digest(base), digest(directory));
  assert.deepEqual(directory.authority.workspaces[0].capabilities, [
    "directory_snapshot",
  ]);
});

test("workspace authority binds source, exclusions, writes, and fixed profiles", async (t) => {
  const setup = await fixture(t);
  const makeRuntime = (config, suffix) =>
    createCodeExecutorRuntime(config, {
      runtimeRoot: path.join(setup.root, `runtime-${suffix}`),
      sourceBaseRoot: setup.sourceBaseRoot,
      store: new StateStore(path.join(setup.root, `state-${suffix}`)),
    });
  const base = enabledConfig(setup.root);
  const first = await makeRuntime(base, "base");
  const changedSource = structuredClone(base);
  changedSource.workspaces[0].sourceRoot = "product";
  const second = await makeRuntime(changedSource, "source");
  const changedExclusions = structuredClone(base);
  changedExclusions.workspaces[0].excludePaths = ["src/private"];
  const third = await makeRuntime(changedExclusions, "exclude");

  assert.notEqual(
    first.authority.workspaces[0].authorityDigest,
    second.authority.workspaces[0].authorityDigest,
  );
  assert.notEqual(
    first.authority.workspaces[0].authorityDigest,
    third.authority.workspaces[0].authorityDigest,
  );
});

test("invalid runtime state fails startup instead of exposing the executor", async (t) => {
  const setup = await fixture(t);
  await setup.store.write("code-executor-state", { invalid: true });

  await assert.rejects(
    createCodeExecutorRuntime(enabledConfig(setup.root), {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "EXECUTOR_STATE_INVALID",
  );
});

test("a local workspace replacement remains runnable after config merge", async (t) => {
  const setup = await fixture(t);
  const merged = mergeConfig(
    { codeExecutor: enabledConfig(setup.root) },
    {
      codeExecutor: {
        workspaces: [
          {
            id: "product",
            sourceRoot: "product",
            writablePaths: ["src"],
          },
        ],
        requiredProfilesByWorkspace: { product: ["node-tests"] },
      },
    },
  ).codeExecutor;

  const runtime = await createCodeExecutorRuntime(merged, {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
  });
  const session = await runtime.executor.start({
    sessionId: "product-session",
    workspaceId: "product",
    requestedBy: { roleId: "developer", workItemId: "product#unit4" },
    inputBinding: null,
  });

  assert.equal(session.workspaceId, "product");
});

test("enabled runtime rejects incomplete and unsafe composition config", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    createCodeExecutorRuntime({ enabled: true }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  const unboundWorkspace = enabledConfig(setup.root);
  unboundWorkspace.requiredProfilesByWorkspace = {};
  await assert.rejects(
    createCodeExecutorRuntime(unboundWorkspace, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  await assert.rejects(
    createCodeExecutorRuntime(enabledConfig(setup.root), {
      runtimeRoot: "relative-runtime",
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
});
