import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-validation-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "validation@example.invalid");
  await git(root, "config", "user.name", "Validation Fixture");
  await writeFile(path.join(root, "tracked.txt"), "accepted\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

async function createValidationFixture(t) {
  const root = await createRepository(t);
  for (const directory of [
    "public",
    "scripts",
    "src",
    "test/browser",
    "test-support",
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const relativePath of [
    "scripts/system-validation-provenance.mjs",
    "scripts/validate-system.mjs",
  ]) {
    await writeFile(
      path.join(root, relativePath),
      await readFile(path.join(projectRoot, relativePath)),
    );
  }
  await writeFile(path.join(root, ".gitignore"), "validation-artifacts/\n");
  await writeFile(path.join(root, "src/app.js"), "export const ready = true;\n");
  await writeFile(
    path.join(root, "test/smoke.test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('fixture passes', () => {});",
      "test('fixture skip', { skip: 'fixture reason' }, () => {});",
      "test('validation reporter options stay outside tested processes', () => {",
      "  assert.equal(process.env.NODE_OPTIONS?.includes('--test-reporter') ?? false, false);",
      "});",
      "",
    ].join("\n"),
  );
  for (const fixture of [
    "configuration-form-playwright.mjs",
    "confirmation-history-playwright.mjs",
  ]) {
    await writeFile(path.join(root, "test/browser", fixture), "process.exitCode = 0;\n");
  }
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "validation-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test test/smoke.test.js" },
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "validation fixture");
  return root;
}

function validationEnvironment() {
  const environment = {
    ...process.env,
  };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function loadProvenanceModule() {
  try {
    return await import("../scripts/system-validation-provenance.mjs");
  } catch (error) {
    assert.fail(`validation provenance module is unavailable: ${error.message}`);
  }
}

test("captures an exact, path-free source identity from a clean Git repository", async (t) => {
  const root = await createRepository(t);
  const expectedHeadOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const expectedTreeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const { captureRepositoryState } = await loadProvenanceModule();

  const state = await captureRepositoryState(root);

  assert.deepEqual(state, {
    schemaVersion: 1,
    headOid: expectedHeadOid,
    treeOid: expectedTreeOid,
    clean: true,
    changeCount: 0,
    statusDigest: createHash("sha256").update("").digest("hex"),
  });
  assert.equal(JSON.stringify(state).includes(root), false);
});

test("reports dirty source without exposing changed paths", async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await writeFile(path.join(root, "untracked-secret-name.txt"), "fixture\n");
  const { captureRepositoryState } = await loadProvenanceModule();

  const state = await captureRepositoryState(root);

  assert.equal(state.clean, false);
  assert.equal(state.changeCount, 2);
  assert.match(state.statusDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(state).includes("untracked-secret-name.txt"), false);
  assert.equal(JSON.stringify(state).includes(root), false);
});

test("acceptance rejects dirty or changed source state", async () => {
  const { assertStableCleanRepository } = await loadProvenanceModule();
  const clean = {
    schemaVersion: 1,
    headOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    clean: true,
    changeCount: 0,
    statusDigest: "3".repeat(64),
  };

  assert.doesNotThrow(() => assertStableCleanRepository(clean, clean));
  assert.throws(
    () => assertStableCleanRepository({ ...clean, clean: false, changeCount: 1 }, clean),
    /repository was not clean when validation started/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, clean: false, changeCount: 1 }),
    /repository was not clean when validation finished/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, headOid: "4".repeat(40) }),
    /repository HEAD changed during validation/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, treeOid: "5".repeat(40) }),
    /repository tree changed during validation/u,
  );
});

test("the system validator binds a passing report to one clean Git source state", async (t) => {
  const root = await createValidationFixture(t);
  const expectedHeadOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const expectedTreeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");

  await execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: validationEnvironment(),
    windowsHide: true,
  });

  const report = JSON.parse(await readFile(
    path.join(root, "validation-artifacts/system-validation.json"),
    "utf8",
  ));
  assert.equal(report.status, "passed");
  assert.deepEqual(report.source.started, report.source.finished);
  assert.equal(report.source.stable, true);
  assert.equal(report.source.started.headOid, expectedHeadOid);
  assert.equal(report.source.started.treeOid, expectedTreeOid);
  assert.equal(report.source.started.clean, true);
  assert.deepEqual(
    report.steps.find(({ name }) => name === "git diff --check").command,
    { executable: "git", arguments: ["diff", "--check"] },
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "syntax:src/app.js").command,
    { executable: "node", arguments: ["--check", "src/app.js"] },
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "complete Node test suite").command,
    {
      executable: "node",
      arguments: ["--test", "--test-reporter=tap", "test/*.test.js"],
    },
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "complete Node test suite").testResults,
    {
      summary: {
        tests: 3,
        passed: 2,
        failed: 0,
        cancelled: 0,
        skipped: 1,
        todo: 0,
      },
      cases: [
        { name: "fixture passes", status: "passed" },
        {
          name: "fixture skip",
          status: "skipped",
          reason: "fixture reason",
        },
        {
          name: "validation reporter options stay outside tested processes",
          status: "passed",
        },
      ],
    },
  );
  assert.equal(
    report.steps.every(({ command, exitCode, signal }) =>
      command === undefined || (exitCode === 0 && signal === null)
    ),
    true,
  );
  assert.equal(JSON.stringify(report).includes(root), false);
});

test("the system validator fails before acceptance when tracked source is dirty", async (t) => {
  const root = await createValidationFixture(t);
  await writeFile(path.join(root, "src/app.js"), "export const ready = false;\n");

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: validationEnvironment(),
      windowsHide: true,
    }),
  );

  const report = JSON.parse(await readFile(
    path.join(root, "validation-artifacts/system-validation.json"),
    "utf8",
  ));
  assert.equal(report.status, "failed");
  assert.equal(report.source.started.clean, false);
  assert.match(report.error, /repository was not clean when validation started/u);
  assert.equal(JSON.stringify(report).includes(root), false);
});
