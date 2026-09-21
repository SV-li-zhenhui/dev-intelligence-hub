import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitObjectSnapshotter } from "../src/adapters/git-object-snapshotter.js";

const execFile = promisify(execFileCallback);

function locateGit() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return path.resolve(candidate);
  const installationRoot = path.dirname(path.dirname(candidate));
  const implementation = path.join(
    installationRoot,
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
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
  });
}

function shellPath(value) {
  return value.replaceAll("\\", "/").replaceAll('"', '\\"');
}

const gitCommand = locateGit();

test(
  "real Git materialization stays on the sealed commit across new Head, dirty files, hooks, and filters",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "git-object-snapshot-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.join(root, "repository");
    const targetRoot = path.join(root, "snapshot");
    const hookSentinel = path.join(root, "hook-invoked.txt");
    const filterSentinel = path.join(root, "filter-invoked.txt");
    const filterScript = path.join(root, "filter.mjs");
    await Promise.all([
      mkdir(path.join(repository, "src"), { recursive: true }),
      mkdir(targetRoot),
    ]);
    await writeFile(
      path.join(repository, ".gitattributes"),
      "src/app.txt filter=sealed-test\n",
    );
    await writeFile(path.join(repository, "src", "app.txt"), "sealed old Head\n");
    await writeFile(path.join(repository, "script.sh"), "#!/bin/sh\nexit 0\n");
    await git(gitCommand, repository, ["init"]);
    await git(gitCommand, repository, ["config", "user.name", "MyDashboard Test"]);
    await git(gitCommand, repository, [
      "config",
      "user.email",
      "mydashboard@example.invalid",
    ]);
    await git(gitCommand, repository, ["add", "--all"]);
    await git(gitCommand, repository, [
      "update-index",
      "--chmod=+x",
      "script.sh",
    ]);
    await git(gitCommand, repository, ["commit", "-m", "sealed baseline"]);
    const sealedHead = (await git(gitCommand, repository, ["rev-parse", "HEAD"]))
      .stdout.trim();

    await writeFile(path.join(repository, "src", "app.txt"), "new committed Head\n");
    await git(gitCommand, repository, ["add", "--all"]);
    await git(gitCommand, repository, ["commit", "-m", "new current Head"]);
    const currentHead = (await git(gitCommand, repository, ["rev-parse", "HEAD"]))
      .stdout.trim();
    assert.notEqual(currentHead, sealedHead);
    await writeFile(path.join(repository, "src", "app.txt"), "dirty checkout\n");
    await writeFile(path.join(repository, "untracked.txt"), "untracked\n");

    await writeFile(
      filterScript,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], "filter invoked");',
        "process.stdin.pipe(process.stdout);",
        "",
      ].join("\n"),
    );
    const filterCommand = `"${shellPath(process.execPath)}" "${shellPath(filterScript)}" "${shellPath(filterSentinel)}"`;
    await git(gitCommand, repository, [
      "config",
      "filter.sealed-test.smudge",
      filterCommand,
    ]);
    const hook = path.join(repository, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf invoked > "${shellPath(hookSentinel)}"\n`,
    );
    await chmod(hook, 0o755);

    const snapshotter = new GitObjectSnapshotter({ gitCommand });
    const boundary = await snapshotter.preflight({ sourceRoot: repository });
    const materialized = await snapshotter.materialize({
      sourceRoot: repository,
      targetRoot,
      headOid: sealedHead,
      excludePaths: [],
      expectedBoundaryDigest: boundary.boundaryDigest,
      expectedGitCommand: boundary.gitCommand,
      expectedGitExecutableSha256: boundary.gitExecutableSha256,
      expectedGitExecutableBytes: boundary.gitExecutableBytes,
      expectedGitExecutableMode: boundary.gitExecutableMode,
      expectedGitExecutableUid: boundary.gitExecutableUid,
      expectedGitExecutableGid: boundary.gitExecutableGid,
    });

    assert.equal(materialized.headOid, sealedHead);
    assert.deepEqual(await readdir(targetRoot), [
      ".gitattributes",
      "script.sh",
      "src",
    ]);
    assert.equal(materialized.modes.get("script.sh"), "100755");
    assert.equal(
      await readFile(path.join(targetRoot, "src", "app.txt"), "utf8"),
      "sealed old Head\n",
    );
    await assert.rejects(access(path.join(targetRoot, "untracked.txt")), {
      code: "ENOENT",
    });
    await assert.rejects(access(hookSentinel), { code: "ENOENT" });
    await assert.rejects(access(filterSentinel), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(repository, "src", "app.txt"), "utf8"),
      "dirty checkout\n",
    );

    const missingTarget = path.join(root, "missing-snapshot");
    await mkdir(missingTarget);
    await assert.rejects(
      snapshotter.materialize({
        sourceRoot: repository,
        targetRoot: missingTarget,
        headOid: "f".repeat(sealedHead.length),
        excludePaths: [],
        expectedBoundaryDigest: boundary.boundaryDigest,
        expectedGitCommand: boundary.gitCommand,
        expectedGitExecutableSha256: boundary.gitExecutableSha256,
        expectedGitExecutableBytes: boundary.gitExecutableBytes,
        expectedGitExecutableMode: boundary.gitExecutableMode,
        expectedGitExecutableUid: boundary.gitExecutableUid,
        expectedGitExecutableGid: boundary.gitExecutableGid,
      }),
      { code: "GIT_HEAD_UNAVAILABLE" },
    );
    assert.deepEqual(await readdir(missingTarget), []);

    const includedConfig = path.join(root, "included.gitconfig");
    await writeFile(includedConfig, "[safe]\n\tvalue = true\n");
    await git(gitCommand, repository, [
      "config",
      "--local",
      "include.path",
      includedConfig,
    ]);
    await assert.rejects(
      snapshotter.preflight({ sourceRoot: repository }),
      { code: "GIT_SNAPSHOT_UNTRUSTED_CONFIG" },
    );
    await git(gitCommand, repository, [
      "config",
      "--local",
      "--unset-all",
      "include.path",
    ]);

    const objectInfo = path.join(repository, ".git", "objects", "info");
    await mkdir(objectInfo, { recursive: true });
    await writeFile(path.join(objectInfo, "alternates"), "C:/outside/objects\n");
    await assert.rejects(
      snapshotter.preflight({ sourceRoot: repository }),
      { code: "GIT_SNAPSHOT_ALTERNATE_OBJECT_STORE" },
    );
  },
);
