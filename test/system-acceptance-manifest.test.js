import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const manifestScript = path.resolve(
  import.meta.dirname,
  "../scripts/system-acceptance-manifest.mjs",
);

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadManifestModule() {
  try {
    return await import("../scripts/system-acceptance-manifest.mjs");
  } catch (error) {
    assert.fail(`acceptance manifest module is unavailable: ${error.message}`);
  }
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-manifest-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "validation@example.invalid");
  await git(root, "config", "user.name", "Validation Fixture");
  await writeFile(
    path.join(root, ".gitignore"),
    "validation-artifacts/\n.review-results/\n",
  );
  await writeFile(path.join(root, "source.txt"), "accepted source\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "accepted source");
  const headOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const treeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const source = {
    schemaVersion: 1,
    headOid,
    treeOid,
    clean: true,
    changeCount: 0,
    statusDigest: sha256(""),
  };
  const validation = {
    schemaVersion: 1,
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:10:00.000Z",
    status: "passed",
    node: "v24.0.0",
    platform: "fixture/x64",
    options: { withDocker: true, withLiveUi: true },
    source: { started: source, finished: source, stable: true },
    steps: [
      {
        name: "node syntax aggregate",
        kind: "aggregate",
        status: "passed",
        durationMs: 75,
        fileCount: 4,
      },
      {
        name: "complete Node test suite",
        command: { executable: "npm", arguments: ["test"] },
        status: "passed",
        durationMs: 100,
        exitCode: 0,
        signal: null,
        testResults: {
          summary: {
            tests: 2,
            passed: 1,
            failed: 0,
            cancelled: 0,
            skipped: 1,
            todo: 0,
          },
          cases: [
            { name: "accepted behavior", status: "passed" },
            { name: "documented platform case", status: "skipped", reason: "fixture" },
          ],
        },
      },
      {
        name: "real Docker sandbox boundary",
        command: {
          executable: "node",
          arguments: ["--test", "test/docker-test-sandbox.integration.test.js"],
        },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
      },
      {
        name: "live desktop and mobile UI behavior",
        command: { executable: "node", arguments: ["scripts/validate-ui.mjs"] },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
      },
    ],
  };
  await mkdir(path.join(root, "validation-artifacts"), { recursive: true });
  await mkdir(path.join(root, ".review-results"), { recursive: true });
  const validationPath = path.join(
    root,
    "validation-artifacts/system-validation.json",
  );
  await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  const artifacts = [
    ["validation-artifacts/results.json", "{\"ui\":\"passed\"}\n"],
    ["validation-artifacts/desktop-1440.png", "desktop fixture"],
    ["validation-artifacts/mobile-390.png", "mobile fixture"],
  ];
  for (const [relativePath, contents] of artifacts) {
    await writeFile(path.join(root, relativePath), contents);
  }
  const reviews = [
    { scope: "security-reliability", path: ".review-results/security.md" },
    { scope: "maintainability-usability", path: ".review-results/product.md" },
  ];
  await writeFile(path.join(root, reviews[0].path), "# Ready\nP0/P1/P2: 0\n");
  await writeFile(path.join(root, reviews[1].path), "# Ready\nP0/P1/P2: 0\n");
  return { artifacts, root, reviews, source, validation, validationPath };
}

test("builds a sanitized manifest that binds validation, artifacts, and reviews to HEAD", async (t) => {
  const fixture = await createFixture(t);
  const { buildAcceptanceManifest } = await loadManifestModule();

  const manifest = await buildAcceptanceManifest({
    root: fixture.root,
    validationReportPath: fixture.validationPath,
    artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
    reviewReports: fixture.reviews,
    generatedAt: "2026-08-09T00:11:00.000Z",
  });

  assert.equal(manifest.status, "passed");
  assert.deepEqual(manifest.source, fixture.source);
  assert.equal(manifest.validation.path, "validation-artifacts/system-validation.json");
  assert.equal(
    manifest.validation.sha256,
    sha256(await readFile(fixture.validationPath)),
  );
  assert.deepEqual(manifest.validation.steps, fixture.validation.steps);
  assert.deepEqual(
    manifest.artifacts.map(({ path: artifactPath }) => artifactPath),
    fixture.artifacts.map(([relativePath]) => relativePath),
  );
  assert.deepEqual(
    manifest.reviews.map(({ scope, path: reviewPath }) => ({ scope, path: reviewPath })),
    fixture.reviews,
  );
  assert.equal(
    [...manifest.artifacts, ...manifest.reviews].every(({ sha256: digest }) =>
      /^[a-f0-9]{64}$/u.test(digest)
    ),
    true,
  );
  assert.equal(JSON.stringify(manifest).includes(fixture.root), false);
});

test("rejects a validation report that is stale or lacks two independent reviews", async (t) => {
  const fixture = await createFixture(t);
  const { buildAcceptanceManifest } = await loadManifestModule();
  const stale = structuredClone(fixture.validation);
  stale.source.finished.headOid = "f".repeat(stale.source.finished.headOid.length);
  await writeFile(fixture.validationPath, `${JSON.stringify(stale, null, 2)}\n`);

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /validation source states differ|validation report does not match the current HEAD/u,
  );

  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(fixture.validation, null, 2)}\n`,
  );
  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews.slice(0, 1),
    }),
    /at least two independent review reports are required/u,
  );
});

test("writes the local manifest to the requested repository-relative artifact path", async (t) => {
  const fixture = await createFixture(t);
  const { writeAcceptanceManifest } = await loadManifestModule();
  const outputPath = "validation-artifacts/system-acceptance-manifest.json";

  const manifest = await writeAcceptanceManifest({
    root: fixture.root,
    validationReportPath: fixture.validationPath,
    artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
    reviewReports: fixture.reviews,
    generatedAt: "2026-08-09T00:11:00.000Z",
    outputPath,
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.root, outputPath), "utf8")),
    manifest,
  );
});

test("the command line writes the default manifest from two named reviews", async (t) => {
  const fixture = await createFixture(t);
  const outputPath = path.join(
    fixture.root,
    "validation-artifacts/system-acceptance-manifest.json",
  );

  await execFileAsync(process.execPath, [
    manifestScript,
    "--review",
    `${fixture.reviews[0].scope}=${fixture.reviews[0].path}`,
    "--review",
    `${fixture.reviews[1].scope}=${fixture.reviews[1].path}`,
  ], {
    cwd: fixture.root,
    encoding: "utf8",
    windowsHide: true,
  });

  const manifest = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(manifest.status, "passed");
  assert.deepEqual(
    manifest.reviews.map(({ scope, path: reviewPath }) => ({ scope, path: reviewPath })),
    fixture.reviews,
  );
  assert.equal(JSON.stringify(manifest).includes(fixture.root), false);
});
