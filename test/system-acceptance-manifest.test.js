import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/app.js"), "export const ready = true;\n");
  await writeFile(path.join(root, "source.txt"), "accepted source\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "accepted source");
  const headOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const treeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const headLogPath = await git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "logs/HEAD",
  );
  const source = {
    schemaVersion: 1,
    headOid,
    treeOid,
    clean: true,
    changeCount: 0,
    statusDigest: sha256(""),
    headLogDigest: sha256(await readFile(headLogPath)),
  };
  const validation = {
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:10:00.000Z",
    status: "passed",
    node: "v24.0.0",
    platform: "fixture/x64",
    options: { withDocker: true, withLiveUi: true },
    source: { started: source, finished: source, stable: true },
    steps: [
      {
        name: "git diff --check",
        command: { executable: "git", arguments: ["diff", "--check"] },
        status: "passed",
        durationMs: 25,
        exitCode: 0,
        signal: null,
      },
      {
        name: "syntax:src/app.js",
        command: {
          executable: "node",
          arguments: ["--check", "src/app.js"],
        },
        status: "passed",
        durationMs: 25,
        exitCode: 0,
        signal: null,
      },
      {
        name: "node syntax aggregate",
        kind: "aggregate",
        status: "passed",
        durationMs: 75,
        fileCount: 1,
      },
      {
        name: "complete Node test suite",
        command: {
          executable: "node",
          arguments: ["--test", "--test-reporter=tap", "test/*.test.js"],
        },
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
            {
              identity: "tap:1:accepted behavior",
              name: "accepted behavior",
              status: "passed",
            },
            {
              identity: "tap:2:real Docker sandbox denies host network, secrets, and source writes",
              name: "real Docker sandbox denies host network, secrets, and source writes",
              status: "skipped",
              reason: "requires MYDASHBOARD_DOCKER_INTEGRATION=1",
            },
          ],
        },
      },
      {
        name: "configuration form browser behavior",
        command: {
          executable: "node",
          arguments: ["test/browser/configuration-form-playwright.mjs"],
        },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
      },
      {
        name: "confirmation history browser behavior",
        command: {
          executable: "node",
          arguments: ["test/browser/confirmation-history-playwright.mjs"],
        },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
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
        environment: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
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
    { scope: "security-reliability", path: ".review-results/security.json" },
    { scope: "maintainability-usability", path: ".review-results/product.json" },
  ];
  const validationSha256 = sha256(await readFile(validationPath));
  for (let index = 0; index < reviews.length; index += 1) {
    const review = reviews[index];
    const sequence = String(index + 2).repeat(8);
    const evidence = {
      schemaVersion: 1,
      reviewId: `${sequence}-${sequence.slice(0, 4)}-4${sequence.slice(0, 3)}-8${sequence.slice(0, 3)}-${sequence}${sequence.slice(0, 4)}`,
      reviewerId: `independent-reviewer-${index + 1}`,
      reviewerRunId: `${sequence}-${sequence.slice(0, 4)}-4${sequence.slice(0, 3)}-9${sequence.slice(0, 3)}-${sequence}${sequence.slice(0, 4)}`,
      scope: review.scope,
      verdict: "ready",
      reviewedAt: `2026-08-09T00:10:0${index + 1}.000Z`,
      validation: {
        runId: validation.runId,
        headOid,
        treeOid,
        reportSha256: validationSha256,
      },
      findings: { p0: 0, p1: 0, p2: 0, p3: 0 },
    };
    await writeFile(
      path.join(root, review.path),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
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
  assert.equal(manifest.runId, fixture.validation.runId);
  assert.deepEqual(manifest.source, fixture.source);
  assert.equal(manifest.validation.path, "validation-artifacts/system-validation.json");
  assert.equal(manifest.validation.runId, fixture.validation.runId);
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

test("rejects opaque or Not Ready independent review reports", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.root, fixture.reviews[0].path),
    "# Not Ready\nP1: 1\n",
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /independent review report must be machine-readable Ready evidence/u,
  );
});

test("rejects forged mandatory validation commands", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).command = {
    executable: "node",
    arguments: ["-e", "process.exit(0)"],
  };
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /mandatory validation command does not match its contract/u,
  );
});

test("rejects duplicate validation step names", async (t) => {
  const fixture = await createFixture(t);
  const duplicated = structuredClone(fixture.validation);
  duplicated.steps.push(structuredClone(duplicated.steps.at(-1)));
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(duplicated, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /validation step names must be unique/u,
  );
});

test("rejects an unknown aggregate validation step", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps.push({
    name: "forged aggregate",
    kind: "aggregate",
    status: "passed",
    durationMs: 1,
    fileCount: 1,
  });
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /unknown aggregate validation step/u,
  );
});

test("rejects a syntax step omitted from the current committed source", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps = forged.steps.filter(({ name }) => name !== "syntax:src/app.js");
  forged.steps.find(
    ({ name }) => name === "node syntax aggregate",
  ).fileCount = 1;
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /validation steps do not match the committed command contract/u,
  );
});

test("rejects Docker validation without the exact integration environment", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps.find(
    ({ name }) => name === "real Docker sandbox boundary",
  ).environment.MYDASHBOARD_DOCKER_INTEGRATION = "0";
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /Docker validation environment does not match its contract/u,
  );
});

test("rejects TAP case statuses that contradict the summary", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  const results = forged.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).testResults;
  results.cases[0].status = "failed";
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /complete Node test case statuses contradict the summary/u,
  );
});

test("rejects duplicate or non-sequential TAP case identities", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  const cases = forged.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).testResults.cases;
  cases[1].identity = cases[0].identity;
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /complete Node test identities are not unique and sequential/u,
  );
});

test("rejects a test skip outside the documented allowlist", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  const results = forged.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).testResults;
  results.cases[0].status = "skipped";
  results.cases[0].reason = "unexpected environment gap";
  results.summary.passed = 0;
  results.summary.skipped = 2;
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /complete Node test skip is not explicitly allowed/u,
  );
});

test("rejects evidence reached through a repository junction ancestor", async (t) => {
  const fixture = await createFixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "mydashboard-evidence-"));
  t.after(() => rm(external, { force: true, recursive: true }));
  await writeFile(path.join(external, "security.md"), "# Ready\nP0/P1/P2: 0\n");
  const junction = path.join(fixture.root, ".review-results/external");
  try {
    await symlink(
      external,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("directory links are unavailable on this host");
      return;
    }
    throw error;
  }
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: [
        {
          scope: fixture.reviews[0].scope,
          path: ".review-results/external/security.md",
        },
        fixture.reviews[1],
      ],
    }),
    (error) => {
      assert.match(error.message, /symbolic link|junction|reparse/u);
      assert.equal(error.message.includes(fixture.root), false);
      assert.equal(error.message.includes(external), false);
      return true;
    },
  );
});

test("rejects hard-linked acceptance evidence", async (t) => {
  const fixture = await createFixture(t);
  const linkedPath = path.join(fixture.root, ".review-results/security-copy.md");
  try {
    await link(
      path.join(fixture.root, fixture.reviews[0].path),
      linkedPath,
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("hard links are unavailable on this host");
      return;
    }
    throw error;
  }
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: [
        {
          scope: fixture.reviews[0].scope,
          path: ".review-results/security-copy.md",
        },
        fixture.reviews[1],
      ],
    }),
    /hard-linked acceptance evidence is forbidden/u,
  );
});

test("sanitizes acceptance evidence filesystem failures", async (t) => {
  const fixture = await createFixture(t);
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: [
        {
          scope: fixture.reviews[0].scope,
          path: ".review-results/missing-security.md",
        },
        fixture.reviews[1],
      ],
    }),
    (error) => {
      assert.match(
        error.message,
        /acceptance evidence could not be read: \.review-results\/missing-security\.md/u,
      );
      assert.equal(error.message.includes(fixture.root), false);
      return true;
    },
  );
});

test("rejects manifest output through a repository junction ancestor", async (t) => {
  const fixture = await createFixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "mydashboard-output-"));
  t.after(() => rm(external, { force: true, recursive: true }));
  const junction = path.join(fixture.root, "validation-artifacts/publish");
  try {
    await symlink(
      external,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("directory links are unavailable on this host");
      return;
    }
    throw error;
  }
  const { writeAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    writeAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
      outputPath: "validation-artifacts/publish/acceptance.json",
    }),
    /manifest output path contains a symbolic link or junction/u,
  );
  await assert.rejects(
    readFile(path.join(external, "acceptance.json")),
    { code: "ENOENT" },
  );
});

test("never overwrites an existing acceptance manifest", async (t) => {
  const fixture = await createFixture(t);
  const outputPath = "validation-artifacts/existing-acceptance.json";
  const absoluteOutput = path.join(fixture.root, outputPath);
  await writeFile(absoluteOutput, "previous acceptance must remain\n");
  const { writeAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    writeAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
      outputPath,
    }),
    /acceptance manifest output already exists/u,
  );
  assert.equal(
    await readFile(absoluteOutput, "utf8"),
    "previous acceptance must remain\n",
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
