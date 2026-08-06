import assert from "node:assert/strict";
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
