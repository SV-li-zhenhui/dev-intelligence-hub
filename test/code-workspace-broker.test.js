import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";

async function fixture(t, {
  files = { "src/app.js": "export const value = 1;\n" },
  writablePaths = ["src", "test", "docs", "README.md"],
  limits = {},
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "code-workspace-broker-"));
  const sourceRoot = path.join(root, "source");
  const scratchRoot = path.join(root, "scratch");
  await mkdir(sourceRoot);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(sourceRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    sourceRoot,
    scratchRoot,
    broker: new CodeWorkspaceBroker({
      scratchRoot,
      limits,
      workspaces: [{
        id: "dashboard",
        sourceRoot,
        writablePaths,
      }],
    }),
  };
}

test("unknown workspaces are rejected with a stable error code", async () => {
  const broker = new CodeWorkspaceBroker({ workspaces: [] });

  await assert.rejects(
    broker.createExecution({ workspaceId: "missing" }),
    (error) => error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("a sanitized copy supports bounded edits and reports changes without touching source", async (t) => {
  const original = "export const value = 1;\n";
  const { broker, sourceRoot } = await fixture(t, {
    files: {
      "src/app.js": original,
      "test/app.test.js": "test('old', () => {});\n",
      "README.md": "# Dashboard\n",
      ".git/config": "secret",
      "data/state.json": "{}",
      ".env": "TOKEN=secret",
      "src/certificate.pem": "secret",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "run-one",
  });

  assert.equal(execution.workspaceId, "dashboard");
  assert.equal(execution.executionId, "run-one");
  assert.match(execution.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(execution.workspaceRevision, execution.sourceRevision);
  assert.equal(
    await broker.getSandboxWorkspacePath(execution),
    await realpath(path.join(broker.scratchRoot, "dashboard", "run-one")),
  );
  assert.deepEqual(await broker.listFiles(execution), [
    "README.md",
    "src/app.js",
    "test/app.test.js",
  ]);
  const app = await broker.readFile({ ...execution, path: "src\\app.js" });
  const written = await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: app.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  assert.equal(written.beforeWorkspaceRevision, execution.workspaceRevision);
  assert.notEqual(written.workspaceRevision, execution.workspaceRevision);
  await broker.writeFile({
    ...execution,
    path: "docs/notes.md",
    content: "value = 2\n",
    expectedSha256: null,
  });
  const oldTest = await broker.readFile({ ...execution, path: "test/app.test.js" });
  await broker.deleteFile({
    ...execution,
    path: "test/app.test.js",
    expectedSha256: oldTest.sha256,
  });

  const search = await broker.searchText({ ...execution, query: "value = 2" });
  const manifest = await broker.getChangeManifest(execution);
  assert.deepEqual(search.matches.map((match) => match.path), [
    "docs/notes.md",
    "src/app.js",
  ]);
  assert.deepEqual(manifest.created.map((entry) => entry.path), ["docs/notes.md"]);
  assert.deepEqual(manifest.modified.map((entry) => entry.path), ["src/app.js"]);
  assert.deepEqual(manifest.deleted.map((entry) => entry.path), ["test/app.test.js"]);
  assert.equal(await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"), original);
  assert.equal(await readFile(path.join(sourceRoot, "test", "app.test.js"), "utf8"), "test('old', () => {});\n");
  await assert.rejects(access(path.join(sourceRoot, "docs", "notes.md")));
});

test("discard waits for queued work and removes only the requested execution", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const discardedExecution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "discarded-run",
  });
  const siblingExecution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "sibling-run",
  });
  const discardedRoot = path.join(scratchRoot, "dashboard", "discarded-run");

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(
    discardedExecution,
    async () => {
      markLocked();
      await release;
    },
  );
  await locked;

  let discardFinished = false;
  const discarding = broker.discardExecution(discardedExecution).then((result) => {
    discardFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discardFinished, false);
  await access(discardedRoot);

  releaseLock();
  await holdingLock;
  assert.deepEqual(await discarding, {
    workspaceId: "dashboard",
    executionId: "discarded-run",
    discarded: true,
  });
  await assert.rejects(access(discardedRoot));
  await assert.rejects(
    broker.listFiles(discardedExecution),
    (error) => error.code === "EXECUTION_NOT_FOUND",
  );
  assert.deepEqual(await broker.listFiles(siblingExecution), ["src/app.js"]);
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("discard is idempotent and removes executions not indexed after restart", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "restart-run",
  });
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot,
        writablePaths: ["src"],
      },
    ],
  });

  const expected = {
    workspaceId: "dashboard",
    executionId: "restart-run",
    discarded: true,
  };
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "restart-run")),
  );
});

test("discard after restart does not require the old workspace registration", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "removed-workspace-run",
  });
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [],
  });
  const expected = {
    workspaceId: "dashboard",
    executionId: "removed-workspace-run",
    discarded: true,
  };

  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "removed-workspace-run")),
  );
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("discard rejects escaping identifiers and symlinked storage roots", async (t) => {
  const { broker, root, scratchRoot, sourceRoot } = await fixture(t);
  const outsideRoot = path.join(root, "outside");
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, "keep.txt"), "keep");

  await assert.rejects(
    broker.discardExecution({
      workspaceId: "dashboard",
      executionId: "../outside",
    }),
    (error) => error.code === "INVALID_EXECUTION_ID",
  );

  const workspaceScratch = path.join(scratchRoot, "dashboard");
  await mkdir(workspaceScratch, { recursive: true });
  try {
    await symlink(
      outsideRoot,
      path.join(workspaceScratch, "linked-run"),
      "junction",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot,
        writablePaths: ["src"],
      },
    ],
  });

  await assert.rejects(
    restartedBroker.discardExecution({
      workspaceId: "dashboard",
      executionId: "linked-run",
    }),
    (error) => error.code === "SYMLINK_REJECTED",
  );
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");

  await rm(workspaceScratch, { recursive: true, force: true });
  await symlink(outsideRoot, workspaceScratch, "junction");
  await assert.rejects(
    restartedBroker.discardExecution({
      workspaceId: "dashboard",
      executionId: "escaped-run",
    }),
    (error) => error.code === "SYMLINK_REJECTED",
  );
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");
});

test("discard unlinks nested symlinks without following them", async (t) => {
  const { broker, root, scratchRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "nested-link-run",
  });
  const outsideRoot = path.join(root, "outside-nested");
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, "keep.txt"), "keep");
  const executionRoot = path.join(
    scratchRoot,
    "dashboard",
    "nested-link-run",
  );
  try {
    await symlink(
      outsideRoot,
      path.join(executionRoot, "linked-outside"),
      "junction",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }

  await broker.discardExecution(execution);

  await assert.rejects(access(executionRoot));
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");
});

test("workspace revisions guard writes and stay locked during sandbox work", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "revision-run",
  });
  const current = await broker.readFile({ ...execution, path: "src/app.js" });
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "stale\n",
      expectedSha256: current.sha256,
      expectedWorkspaceRevision: "0".repeat(64),
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const checking = broker.withLockedExecution(execution, async (context) => {
    assert.equal(context.workspaceRevision, execution.workspaceRevision);
    assert.equal(path.isAbsolute(context.workspacePath), true);
    markLocked();
    await release;
    return "checked";
  });
  await locked;
  let writeFinished = false;
  const writing = broker
    .writeFile({
      ...execution,
      path: "src/app.js",
      content: "updated\n",
      expectedSha256: current.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    })
    .then((result) => {
      writeFinished = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeFinished, false);
  releaseLock();

  const checked = await checking;
  assert.equal(checked.result, "checked");
  assert.equal(checked.beforeWorkspaceRevision, execution.workspaceRevision);
  assert.equal(checked.afterWorkspaceRevision, execution.workspaceRevision);
  const write = await writing;
  assert.notEqual(write.workspaceRevision, execution.workspaceRevision);

  const sandboxFailure = Object.assign(new Error("sandbox stopped"), {
    code: "SANDBOX_TIMEOUT",
    details: { cleanupPending: true },
  });
  await assert.rejects(
    broker.withLockedExecution(execution, async () => {
      throw sandboxFailure;
    }),
    (error) => error === sandboxFailure,
  );
});

test("version-guarded reads wait for queued mutations and reject stale snapshots", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "guarded-read-run",
  });
  const expectedRevision = {
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  };
  assert.deepEqual(await broker.listFiles(expectedRevision), ["src/app.js"]);
  const current = await broker.readFile({
    ...expectedRevision,
    path: "src/app.js",
  });
  assert.equal(
    (await broker.searchText({ ...expectedRevision, query: "value" })).matches
      .length,
    1,
  );
  assert.deepEqual(await broker.getChangeManifest(expectedRevision), {
    created: [],
    modified: [],
    deleted: [],
  });

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const writing = broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  let settledCount = 0;
  const staleRevision = expectedRevision;
  const guardedReads = [
    broker.listFiles(staleRevision),
    broker.readFile({ ...staleRevision, path: "src/app.js" }),
    broker.searchText({ ...staleRevision, query: "value" }),
    broker.getChangeManifest(staleRevision),
  ].map((operation) =>
    operation.then(
      (value) => {
        settledCount += 1;
        return { value };
      },
      (error) => {
        settledCount += 1;
        return { error };
      },
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  const settledWhileLocked = settledCount;
  releaseLock();
  await holdingLock;
  await writing;
  const results = await Promise.all(guardedReads);

  assert.equal(settledWhileLocked, 0);
  for (const result of results) {
    assert.equal(result.error?.code, "WORKSPACE_REVISION_MISMATCH");
  }
});

test("guarded reads reuse cached revisions while sealing scans scratch integrity", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/other.js": "export const other = 1;\n",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "cached-read-run",
  });
  const guardedRevision = {
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  };

  const scratchPath = await broker.getSandboxWorkspacePath(execution);
  await writeFile(
    path.join(scratchPath, "src", "other.js"),
    "export const other = 2;\n",
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await broker.listFiles(guardedRevision), [
      "src/app.js",
      "src/other.js",
    ]);
    assert.equal(
      (
        await broker.readFile({
          ...guardedRevision,
          path: "src/app.js",
        })
      ).content,
      "export const value = 1;\n",
    );
    assert.deepEqual(
      (
        await broker.searchText({
          ...guardedRevision,
          query: "value",
        })
      ).matches.map((match) => match.path),
      ["src/app.js"],
    );
  }
  await assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
});

test("successful writes and deletes atomically advance cached revision guards", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/old.js": "old\n",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "cached-mutation-run",
  });
  const app = await broker.readFile({ ...execution, path: "src/app.js" });
  const old = await broker.readFile({ ...execution, path: "src/old.js" });

  const written = await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: app.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const deleted = await broker.deleteFile({
    ...execution,
    path: "src/old.js",
    expectedSha256: old.sha256,
    expectedWorkspaceRevision: written.workspaceRevision,
  });

  assert.equal(deleted.beforeWorkspaceRevision, written.workspaceRevision);
  assert.notEqual(deleted.workspaceRevision, written.workspaceRevision);
  await assert.rejects(
    broker.readFile({
      ...execution,
      path: "src/app.js",
      expectedWorkspaceRevision: written.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
  assert.equal(
    (
      await broker.readFile({
        ...execution,
        path: "src/app.js",
        expectedWorkspaceRevision: deleted.workspaceRevision,
      })
    ).content,
    "export const value = 2;\n",
  );
  assert.equal(await broker.getWorkspaceRevision(execution), deleted.workspaceRevision);
});

test("sealing snapshots changes and rejects mutations queued behind it", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/old.js": "old\n",
    },
    writablePaths: ["src"],
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "seal-first-run",
  });
  const app = await broker.readFile({ ...execution, path: "src/app.js" });
  const old = await broker.readFile({ ...execution, path: "src/old.js" });

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const sealing = broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const writingRejected = assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "export const value = 2;\n",
      expectedSha256: app.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "EXECUTION_SEALED",
  );
  const deletingRejected = assert.rejects(
    broker.deleteFile({
      ...execution,
      path: "src/old.js",
      expectedSha256: old.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "EXECUTION_SEALED",
  );

  releaseLock();
  await holdingLock;
  const sealed = await sealing;
  await Promise.all([writingRejected, deletingRejected]);

  assert.equal(sealed.workspaceRevision, execution.workspaceRevision);
  assert.deepEqual(sealed.manifest, {
    created: [],
    modified: [],
    deleted: [],
  });
  sealed.manifest.created.push({ path: "caller-mutation" });
  const repeated = await broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  assert.deepEqual(repeated.manifest, {
    created: [],
    modified: [],
    deleted: [],
  });
  await assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: "0".repeat(64),
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
});

test("a mutation queued before sealing wins and makes the stale seal fail", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "write-first-run",
  });
  const current = await broker.readFile({ ...execution, path: "src/app.js" });
  await assert.rejects(
    broker.sealExecution(execution),
    (error) => error.code === "EXPECTED_WORKSPACE_REVISION_REQUIRED",
  );

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const writing = broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const staleSealRejected = assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );

  releaseLock();
  await holdingLock;
  const written = await writing;
  await staleSealRejected;

  const sealed = await broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: written.workspaceRevision,
  });
  assert.equal(sealed.workspaceRevision, written.workspaceRevision);
  assert.deepEqual(sealed.manifest.modified.map((entry) => entry.path), [
    "src/app.js",
  ]);
});

test("paths, secrets, write scope, and optimistic versions are enforced", async (t) => {
  const { broker, sourceRoot } = await fixture(t, {
    files: {
      "src/app.js": "old\n",
      "README.md": "read only\n",
      ".env.local": "TOKEN=secret",
    },
    writablePaths: ["src"],
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "secure-run",
  });

  await assert.rejects(
    broker.readFile({ ...execution, path: "../source/.env.local" }),
    (error) => error.code === "INVALID_PATH" && !error.message.includes(sourceRoot),
  );
  await assert.rejects(
    broker.readFile({ ...execution, path: ".env.local" }),
    (error) => error.code === "PATH_EXCLUDED",
  );
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "README.md",
      content: "changed",
      expectedSha256: null,
      writablePaths: ["README.md"],
    }),
    (error) => error.code === "WRITE_NOT_ALLOWED",
  );
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "changed",
      expectedSha256: "0".repeat(64),
    }),
    (error) => error.code === "SHA256_MISMATCH",
  );
  assert.equal(
    (await broker.readFile({ ...execution, path: "src/app.js" })).content,
    "old\n",
  );
});

test("source symlinks and junctions are rejected", async (t) => {
  const { broker, sourceRoot, root } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  try {
    await symlink(outside, path.join(sourceRoot, "linked"), "junction");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    broker.createExecution({ workspaceId: "dashboard", executionId: "linked-run" }),
    (error) => error.code === "SYMLINK_REJECTED" && !error.message.includes(root),
  );
});

test("file count, file size, search matches, and write bytes are bounded", async (t) => {
  const countFixture = await fixture(t, {
    files: { "src/a.js": "a", "src/b.js": "b" },
    limits: { maxFiles: 1 },
  });
  await assert.rejects(
    countFixture.broker.createExecution({ workspaceId: "dashboard", executionId: "count-run" }),
    (error) => error.code === "FILE_COUNT_LIMIT",
  );

  const sizeFixture = await fixture(t, {
    files: { "src/a.js": "12345" },
    limits: { maxFileBytes: 4 },
  });
  await assert.rejects(
    sizeFixture.broker.createExecution({ workspaceId: "dashboard", executionId: "size-run" }),
    (error) => error.code === "FILE_SIZE_LIMIT",
  );

  const bounded = await fixture(t, {
    files: { "src/a.js": "hit hit hit\n" },
    limits: { maxSearchMatches: 2, maxWriteBytes: 4 },
  });
  const execution = await bounded.broker.createExecution({
    workspaceId: "dashboard",
    executionId: "bounded-run",
  });
  assert.deepEqual(
    await bounded.broker.searchText({ ...execution, query: "hit" }),
    {
      matches: [
        { path: "src/a.js", line: 1, column: 1, text: "hit hit hit" },
        { path: "src/a.js", line: 1, column: 5, text: "hit hit hit" },
      ],
      truncated: true,
    },
  );
  const current = await bounded.broker.readFile({ ...execution, path: "src/a.js" });
  await assert.rejects(
    bounded.broker.writeFile({
      ...execution,
      path: "src/a.js",
      content: "12345",
      expectedSha256: current.sha256,
    }),
    (error) => error.code === "WRITE_SIZE_LIMIT",
  );
});
