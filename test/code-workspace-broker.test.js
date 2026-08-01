import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  assert.deepEqual(execution, { workspaceId: "dashboard", executionId: "run-one" });
  assert.deepEqual(await broker.listFiles(execution), [
    "README.md",
    "src/app.js",
    "test/app.test.js",
  ]);
  const app = await broker.readFile({ ...execution, path: "src\\app.js" });
  await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: app.sha256,
  });
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
