import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function loadIdentityModule() {
  try {
    return await import("../src/lib/runtime-source-identity.js");
  } catch (error) {
    assert.fail(`runtime source identity module is unavailable: ${error.message}`);
  }
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-source-id-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  const packageText = `${JSON.stringify({
    name: "source-identity-fixture",
    version: "1.0.0",
    files: ["public/index.html", "src/"],
  }, null, 2)}\n`;
  const files = new Map([
    ["package.json", packageText],
    ["README.md", "fixture readme\n"],
    ["public/index.html", "<!doctype html>\n"],
    ["src/app.js", "export const value = 1;\n"],
  ]);
  for (const [relativePath, contents] of files) {
    await writeFile(path.join(root, relativePath), contents);
  }
  return { files, root };
}

test("runtime source identity is deterministic, path-free, and covers packaged files", async (t) => {
  const fixture = await createFixture(t);
  const { computeRuntimeSourceIdentity } = await loadIdentityModule();

  const first = await computeRuntimeSourceIdentity(fixture.root);
  const second = await computeRuntimeSourceIdentity(fixture.root);

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.algorithm, "sha256");
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  assert.equal(first.fileCount, fixture.files.size);
  assert.equal(
    first.byteCount,
    [...fixture.files.values()].reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0,
    ),
  );
  assert.equal(JSON.stringify(first).includes(fixture.root), false);

  await writeFile(path.join(fixture.root, "outside.txt"), "not packaged\n");
  assert.deepEqual(await computeRuntimeSourceIdentity(fixture.root), first);

  await writeFile(path.join(fixture.root, "src/app.js"), "export const value = 2;\n");
  const changed = await computeRuntimeSourceIdentity(fixture.root);
  assert.notEqual(changed.digest, first.digest);
  assert.equal(changed.fileCount, first.fileCount);
});

test("runtime source identity rejects symlinks in packaged directories", async (t) => {
  const fixture = await createFixture(t);
  const { computeRuntimeSourceIdentity } = await loadIdentityModule();
  const outside = path.join(fixture.root, "outside.txt");
  await writeFile(outside, "outside\n");
  try {
    await symlink(outside, path.join(fixture.root, "src/link.js"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("file symlinks are unavailable on this host");
      return;
    }
    throw error;
  }
  await assert.rejects(
    computeRuntimeSourceIdentity(fixture.root),
    /runtime source entry must be a regular file or directory/u,
  );
});

test("runtime source identity rejects unsafe package entries", async (t) => {
  const fixture = await createFixture(t);
  const { computeRuntimeSourceIdentity } = await loadIdentityModule();
  const packageValue = JSON.parse(await readFile(
    path.join(fixture.root, "package.json"),
    "utf8",
  ));
  packageValue.files.push("../outside.txt");
  await writeFile(
    path.join(fixture.root, "package.json"),
    `${JSON.stringify(packageValue, null, 2)}\n`,
  );
  await assert.rejects(
    computeRuntimeSourceIdentity(fixture.root),
    /runtime package file entry is unsafe/u,
  );
});

test("versioned runtime identity freezes the clean commit, tree, and package digest", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.root, "init", "--quiet");
  await git(fixture.root, "config", "user.email", "runtime@example.invalid");
  await git(fixture.root, "config", "user.name", "Runtime Fixture");
  await git(fixture.root, "add", ".");
  await git(fixture.root, "commit", "--quiet", "-m", "runtime source");
  const { computeRuntimeSourceIdentity, computeVersionedRuntimeSourceIdentity } =
    await loadIdentityModule();

  const identity = await computeVersionedRuntimeSourceIdentity(fixture.root);

  assert.deepEqual(identity, {
    schemaVersion: 1,
    headOid: await git(fixture.root, "rev-parse", "--verify", "HEAD^{commit}"),
    treeOid: await git(fixture.root, "rev-parse", "--verify", "HEAD^{tree}"),
    clean: true,
    runtimeDigest: (await computeRuntimeSourceIdentity(fixture.root)).digest,
    runtimeFileCount: fixture.files.size,
    runtimeByteCount: [...fixture.files.values()].reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0,
    ),
  });

  await writeFile(path.join(fixture.root, "src/app.js"), "export const dirty = true;\n");
  assert.equal(await computeVersionedRuntimeSourceIdentity(fixture.root), null);
});

test("packaged runtime identity remains deterministic without Git metadata", async (t) => {
  const fixture = await createFixture(t);
  const { computeVersionedRuntimeSourceIdentity } = await loadIdentityModule();

  const first = await computeVersionedRuntimeSourceIdentity(fixture.root);
  const second = await computeVersionedRuntimeSourceIdentity(fixture.root);

  assert.deepEqual(first, second);
  assert.match(first.headOid, /^[a-f0-9]{64}$/u);
  assert.match(first.treeOid, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.headOid, first.treeOid);
  assert.equal(first.clean, true);
  assert.match(first.runtimeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(first.runtimeFileCount, fixture.files.size);
});
