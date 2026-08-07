import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createControlledGitRuntimeBundle } from "../src/controlled-git-runtime.js";

const execFile = promisify(execFileCallback);

function locateGit() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return path.resolve(candidate);
  const implementation = path.join(
    path.dirname(path.dirname(candidate)),
    "mingw64",
    "bin",
    "git.exe",
  );
  return existsSync(implementation) ? path.resolve(implementation) : null;
}

async function git(gitCommand, cwd, args) {
  return execFile(gitCommand, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

async function repositoryState(gitCommand, repositoryRoot) {
  const [status, head] = await Promise.all([
    git(gitCommand, repositoryRoot, ["status", "--porcelain=v1"]),
    git(gitCommand, repositoryRoot, ["rev-parse", "HEAD"]),
  ]);
  return { status: status.stdout, head: head.stdout.trim() };
}

async function mirrorRefs(gitCommand, mirrorRoot) {
  return (
    await git(gitCommand, mirrorRoot, [
      "--git-dir=.",
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ])
  ).stdout;
}

function inputBinding({ baseOid, headOid }) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/runtime-test",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/runtime-test#42",
    workKey: "pr:acme/runtime-test#42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: headOid,
    eventId: "github-event-pr-42",
    eventDigest: "1".repeat(64),
    inputDigest: "2".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-test-user",
      baseRepository: "acme/runtime-test",
      baseRefName: "main",
      baseRefOid: baseOid,
      headRepository: "contributor/runtime-test",
      headRefName: "feature",
      headRefOid: headOid,
    },
  };
}

async function createFixture(t, gitCommand) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-git-runtime-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const baseMirrorRoot = path.join(root, "base.git");
  const headMirrorRoot = path.join(root, "head.git");
  const preparationRoot = path.join(root, "preparations");
  await Promise.all([mkdir(sourceRoot), mkdir(preparationRoot)]);
  await git(gitCommand, sourceRoot, ["init", "--initial-branch=main", "--object-format=sha1"]);
  await git(gitCommand, sourceRoot, ["config", "user.name", "MyDashboard Test"]);
  await git(gitCommand, sourceRoot, ["config", "user.email", "mydashboard@example.invalid"]);
  await mkdir(path.join(sourceRoot, "src"));
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "common content\n");
  await writeFile(path.join(sourceRoot, "src", "untouched.txt"), "common file\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "common ancestor"]);

  await git(gitCommand, sourceRoot, ["switch", "--create", "feature"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "head content\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "head change"]);
  const headOid = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();

  await git(gitCommand, sourceRoot, ["switch", "main"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "base content\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "base change"]);
  const baseOid = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();

  await git(gitCommand, root, ["clone", "--bare", "--no-local", "--single-branch", "--branch", "main", sourceRoot, baseMirrorRoot]);
  await git(gitCommand, root, ["clone", "--bare", "--no-local", "--single-branch", "--branch", "feature", sourceRoot, headMirrorRoot]);
  return { baseMirrorRoot, baseOid, headMirrorRoot, headOid, preparationRoot, sourceRoot };
}

const gitCommand = locateGit();

test(
  "default controlled Git runtime prepares, verifies, and materializes a real conflicted PR",
  { skip: gitCommand === null ? "trusted Git is unavailable" : false },
  async (t) => {
    const setup = await createFixture(t, gitCommand);
    const sourceBefore = await repositoryState(gitCommand, setup.sourceRoot);
    const mirrorsBefore = await Promise.all([
      mirrorRefs(gitCommand, setup.baseMirrorRoot),
      mirrorRefs(gitCommand, setup.headMirrorRoot),
    ]);
    const bundle = await createControlledGitRuntimeBundle({
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: { "contributor/runtime-test": setup.headMirrorRoot },
    });
    const binding = inputBinding(setup);

    const source = await bundle.preparer.prepare(binding);
    assert.equal(source.kind, "conflict_preparation");
    assert.deepEqual(source.inputBinding, binding);
    assert.deepEqual(source.writeScope, { mode: "exact_files", paths: ["src/conflict.txt"] });
    assert.equal(source.preparationBinding.gitTarget.headRefOid, setup.headOid);

    const verified = await bundle.verifier.verify(source.preparationBinding);
    assert.deepEqual(verified, source.preparationBinding);

    const targetRoot = path.join(path.dirname(setup.preparationRoot), "materialized");
    await mkdir(targetRoot);
    const receipt = await bundle.materializer.materialize({
      binding: source.preparationBinding,
      targetRoot,
      excludePaths: [],
    });
    const conflictPath = path.join(targetRoot, "src", "conflict.txt");
    const conflictContent = await readFile(conflictPath, "utf8");
    assert.equal(receipt.preparationId, source.preparationBinding.preparationId);
    assert.equal(receipt.resultTreeOid, source.preparationBinding.resultTreeOid);
    assert.equal(receipt.evidenceDigest, source.preparationBinding.evidenceDigest);
    assert.equal(receipt.fileCount, 2);
    assert.deepEqual(receipt.files.map((file) => file.path).sort(), ["src/conflict.txt", "src/untouched.txt"]);
    assert.match(conflictContent, /^<<<<<<< /mu);
    assert.match(conflictContent, /head content/u);
    assert.match(conflictContent, /base content/u);
    assert.equal(await readFile(path.join(targetRoot, "src", "untouched.txt"), "utf8"), "common file\n");
    assert.deepEqual(source.writeScope.paths, ["src/conflict.txt"]);
    assert.deepEqual(await repositoryState(gitCommand, setup.sourceRoot), sourceBefore);
    assert.deepEqual(await Promise.all([
      mirrorRefs(gitCommand, setup.baseMirrorRoot),
      mirrorRefs(gitCommand, setup.headMirrorRoot),
    ]), mirrorsBefore);
  },
);
