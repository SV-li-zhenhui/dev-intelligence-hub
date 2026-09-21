import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
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
import { deflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const manifestScript = path.resolve(
  import.meta.dirname,
  "../scripts/system-acceptance-manifest.mjs",
);
const defaultValidationLimits = Object.freeze({
  timeoutMs: 120_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
});

function validationLimits(name) {
  if (name === "complete Node test suite") {
    return {
      timeoutMs: 15 * 60_000,
      maxStdoutBytes: 32 * 1024 * 1024,
      maxStderrBytes: 8 * 1024 * 1024,
    };
  }
  if (name === "live desktop and mobile UI behavior") {
    return {
      timeoutMs: 10 * 60_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: defaultValidationLimits.maxStderrBytes,
    };
  }
  if (name === "open-source distribution suite") {
    return {
      timeoutMs: 10 * 60_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: defaultValidationLimits.maxStderrBytes,
    };
  }
  if (
    name === "configuration form browser behavior" ||
    name === "confirmation history browser behavior" ||
    name === "real Docker sandbox boundary"
  ) {
    return {
      ...defaultValidationLimits,
      timeoutMs: 10 * 60_000,
    };
  }
  return { ...defaultValidationLimits };
}

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

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk("IEND"),
  ]);
}

async function loadManifestModule() {
  try {
    return await import("../scripts/system-acceptance-manifest.mjs");
  } catch (error) {
    assert.fail(`acceptance manifest module is unavailable: ${error.message}`);
  }
}

async function createFixture(t, {
  runtimeSourceMutator = (value) => value,
  uiCompletedAt = "2026-08-09T00:10:00.000Z",
  u9ImplementationSource = [
    "import test from 'node:test';",
    "test('accepted U9 behavior', () => {});",
    "",
  ].join("\n"),
  u9PrioritySource = 'import "./u9-mirrored-pr-end-to-end.mjs";\n',
  legacyU9Source = null,
} = {}) {
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
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "src/app.js"), "export const ready = true;\n");
  await writeFile(
    path.join(root, "test/open-source-distribution.mjs"),
    "export const distributionTest = true;\n",
  );
  await writeFile(
    path.join(root, "test/smoke.test.js"),
    "export const smokeTest = true;\n",
  );
  if (u9ImplementationSource !== null) {
    await writeFile(
      path.join(root, "test/u9-mirrored-pr-end-to-end.mjs"),
      u9ImplementationSource,
    );
  }
  if (u9PrioritySource !== null) {
    await writeFile(
      path.join(root, "test/00-u9-priority.mjs"),
      u9PrioritySource,
    );
  }
  if (legacyU9Source !== null) {
    await writeFile(
      path.join(root, "test/u9-mirrored-pr-end-to-end.test.js"),
      legacyU9Source,
    );
  }
  await writeFile(path.join(root, "source.txt"), "accepted source\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "acceptance-manifest-fixture",
    private: true,
    type: "module",
    files: ["src/", "source.txt"],
  }, null, 2)}\n`);
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "acceptance-manifest-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "acceptance-manifest-fixture" },
    },
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "accepted source");
  const headOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const treeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const objectFormat = await git(root, "rev-parse", "--show-object-format");
  const emptyTreeOid = createHash(objectFormat)
    .update(Buffer.from("tree 0\0", "utf8"))
    .digest("hex");
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
  const { computeRuntimeSourceIdentity } = await import(
    "../src/lib/runtime-source-identity.js"
  );
  const runtime = await computeRuntimeSourceIdentity(root);
  const committedRuntimeSource = {
    schemaVersion: 1,
    headOid,
    treeOid,
    clean: true,
    runtimeDigest: runtime.digest,
    runtimeFileCount: runtime.fileCount,
    runtimeByteCount: runtime.byteCount,
  };
  const runtimeSource = runtimeSourceMutator(
    structuredClone(committedRuntimeSource),
  );
  const liveService = {
    processId: 2468,
    instanceId: "12345678-1234-4123-8123-123456789abc",
    startIdentity: "d".repeat(64),
    runtimeSource,
  };
  const executionSource = {
    schemaVersion: 1,
    headOid,
    treeOid,
    sealed: true,
    dependencyInstallation: "npm-ci-offline-ignore-scripts-v1",
    dependencyLockDigest: "9".repeat(64),
    contentDigest: "e".repeat(64),
    fileCount: 3,
    totalBytes: 4_096,
  };
  const runId = "11111111-1111-4111-8111-111111111111";
  const {
    buildUiArtifactReceipt,
    uiValidationCommandArguments,
    writeUiArtifactReceipt,
  } = await import("../scripts/system-ui-artifact-receipt.mjs");
  const validation = {
    schemaVersion: 1,
    runId,
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:10:00.000Z",
    status: "passed",
    node: "v24.0.0",
    platform: "win32/x64",
    environment: {
      schemaVersion: 2,
      policy: "isolated-profile-allowlist-v2",
      inheritedVariables: ["PATH"],
      isolatedVariables: [
        "APPDATA",
        "HOME",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ],
      controlledVariables: [
        "GCM_INTERACTIVE",
        "GH_PROMPT_DISABLED",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "NO_COLOR",
        "PLAYWRIGHT_BROWSERS_PATH",
      ],
      credentialVariablesInherited: false,
      dependencyInstallationNetwork: "offline",
      forbiddenVariables: ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE"],
      inheritedForbiddenVariables: [],
    },
    options: { withDocker: true, withLiveUi: true },
    source: { started: source, finished: source, stable: true },
    executionSource,
    liveService,
    uiArtifactReceipt: null,
    steps: [
      {
        name: "git diff --check",
        command: {
          executable: "git",
          arguments: ["diff", "--check", emptyTreeOid, headOid, "--"],
        },
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
        name: "syntax:test/00-u9-priority.mjs",
        command: {
          executable: "node",
          arguments: ["--check", "test/00-u9-priority.mjs"],
        },
        status: "passed",
        durationMs: 25,
        exitCode: 0,
        signal: null,
      },
      {
        name: "syntax:test/open-source-distribution.mjs",
        command: {
          executable: "node",
          arguments: ["--check", "test/open-source-distribution.mjs"],
        },
        status: "passed",
        durationMs: 25,
        exitCode: 0,
        signal: null,
      },
      {
        name: "syntax:test/smoke.test.js",
        command: {
          executable: "node",
          arguments: ["--check", "test/smoke.test.js"],
        },
        status: "passed",
        durationMs: 25,
        exitCode: 0,
        signal: null,
      },
      {
        name: "syntax:test/u9-mirrored-pr-end-to-end.mjs",
        command: {
          executable: "node",
          arguments: ["--check", "test/u9-mirrored-pr-end-to-end.mjs"],
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
        durationMs: 125,
        fileCount: 5,
      },
      {
        name: "complete Node test suite",
        command: {
          executable: "node",
          arguments: [
            "--test",
            "--test-concurrency=4",
            "--test-reporter=tap",
            "test/00-u9-priority.mjs",
            "test/smoke.test.js",
          ],
        },
        status: "passed",
        durationMs: 100,
        exitCode: 0,
        signal: null,
        environment: {
          APPDATA: "null-device",
          HOME: "null-device",
          USERPROFILE: "null-device",
        },
        testResults: {
          summary: {
            tests: 3,
            passed: 2,
            failed: 0,
            cancelled: 0,
            skipped: 1,
            todo: 0,
          },
          cases: [
            {
              identity: "tap:1:accepted U9 behavior",
              name: "accepted U9 behavior",
              status: "passed",
            },
            {
              identity: "tap:2:accepted behavior",
              name: "accepted behavior",
              status: "passed",
            },
            {
              identity: "tap:3:real Docker sandbox denies host network, secrets, and source writes",
              name: "real Docker sandbox denies host network, secrets, and source writes",
              status: "skipped",
              reason: "requires MYDASHBOARD_DOCKER_INTEGRATION=1",
            },
          ],
        },
      },
      {
        name: "open-source distribution suite",
        command: {
          executable: "node",
          arguments: [
            "--test",
            "--test-concurrency=1",
            "--test-reporter=tap",
            "test/open-source-distribution.mjs",
          ],
        },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
        environment: {
          APPDATA: "null-device",
          HOME: "null-device",
          USERPROFILE: "null-device",
        },
        repositorySource: { headOid, treeOid },
        testResults: {
          summary: {
            tests: 1,
            passed: 1,
            failed: 0,
            cancelled: 0,
            skipped: 0,
            todo: 0,
          },
          cases: [{
            identity: "tap:1:accepted distribution behavior",
            name: "accepted distribution behavior",
            status: "passed",
          }],
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
        environment: {
          APPDATA: "null-device",
          HOME: "null-device",
          USERPROFILE: "null-device",
        },
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
        environment: {
          APPDATA: "null-device",
          HOME: "null-device",
          USERPROFILE: "null-device",
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
        environment: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
      },
      {
        name: "live desktop and mobile UI behavior",
        command: {
          executable: "node",
          arguments: [
            "scripts/validate-ui.mjs",
            ...uiValidationCommandArguments({
              runId,
              liveService,
            }),
          ],
        },
        status: "passed",
        durationMs: 50,
        exitCode: 0,
        signal: null,
        environment: {
          APPDATA: "null-device",
          HOME: "null-device",
          USERPROFILE: "null-device",
        },
      },
    ],
  };
  for (const step of validation.steps) {
    if (step.kind !== "aggregate") step.limits = validationLimits(step.name);
    if (
      step.name !== "git diff --check" &&
      step.name !== "open-source distribution suite"
    ) {
      step.executionSourceDigest = executionSource.contentDigest;
    }
  }
  await mkdir(path.join(root, "validation-artifacts"), { recursive: true });
  await mkdir(path.join(root, ".review-results"), { recursive: true });
  const uiDirectory = path.join(
    root,
    "validation-artifacts/runs",
    runId,
    "ui",
  );
  await mkdir(uiDirectory, { recursive: true });
  const scenarios = [
    "desktop-1440",
    "mobile-390",
    "confirmation-queue",
    "code-job-control-package-desktop-1100",
    "code-job-control-package-mobile-390",
    "external-review-confirmation",
    "system-status-initial-error",
    "system-status-stale-error",
    "system-status-stale-success",
  ];
  const results = {
    schemaVersion: 1,
    runId,
    status: "passed",
    liveService,
    scenarios: scenarios.map((name) => ({
      name,
      status: "passed",
      consoleErrors: 0,
      pageErrors: 0,
      horizontalOverflow: false,
      accessibilityFailures: 0,
    })),
    details: scenarios.map((name) => ({ name })),
  };
  await writeFile(
    path.join(uiDirectory, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  await writeFile(path.join(uiDirectory, "desktop-1440.png"), png(1440, 1000));
  await writeFile(path.join(uiDirectory, "mobile-390.png"), png(390, 844));
  const receipt = await buildUiArtifactReceipt({
    root,
    runId,
    liveService,
    completedAt: uiCompletedAt,
  });
  const envelope = await writeUiArtifactReceipt({ root, receipt });
  validation.uiArtifactReceipt = { envelope, receipt };
  validation.steps.at(-1).artifactReceiptEnvelope = envelope;
  const validationPath = path.join(
    root,
    "validation-artifacts/runs",
    runId,
    "system-validation.json",
  );
  await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  const artifacts = await Promise.all(receipt.artifacts.map(async ({ path: artifactPath }) => [
    artifactPath,
    await readFile(path.join(root, ...artifactPath.split("/"))),
  ]));
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
  return {
    artifacts,
    committedRuntimeSource,
    root,
    reviews,
    source,
    validation,
    validationPath,
  };
}

async function rewriteValidationAndReviewBindings(fixture, validation) {
  await writeFile(
    fixture.validationPath,
    `${JSON.stringify(validation, null, 2)}\n`,
  );
  const reportSha256 = sha256(await readFile(fixture.validationPath));
  for (const review of fixture.reviews) {
    const reviewPath = path.join(fixture.root, review.path);
    const evidence = JSON.parse(await readFile(reviewPath, "utf8"));
    evidence.validation.reportSha256 = reportSha256;
    await writeFile(reviewPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
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
  assert.equal(
    manifest.reviewEvidencePolicy,
    "release-owner-attested-distinct-scopes-v1",
  );
  assert.equal(manifest.runId, fixture.validation.runId);
  assert.deepEqual(manifest.source, fixture.source);
  assert.equal(
    manifest.validation.path,
    `validation-artifacts/runs/${fixture.validation.runId}/system-validation.json`,
  );
  assert.equal(manifest.validation.runId, fixture.validation.runId);
  assert.deepEqual(
    manifest.validation.liveService,
    fixture.validation.liveService,
  );
  assert.deepEqual(
    manifest.validation.executionSource,
    fixture.validation.executionSource,
  );
  assert.deepEqual(
    manifest.validation.uiArtifactReceipt,
    fixture.validation.uiArtifactReceipt,
  );
  assert.equal(
    manifest.validation.sha256,
    sha256(await readFile(fixture.validationPath)),
  );
  assert.deepEqual(manifest.validation.steps, fixture.validation.steps);
  assert.deepEqual(
    manifest.validation.steps.find(
      ({ name }) => name === "complete Node test suite",
    ).command.arguments,
    [
      "--test",
      "--test-concurrency=4",
      "--test-reporter=tap",
      "test/00-u9-priority.mjs",
      "test/smoke.test.js",
    ],
  );
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

for (const u9ContractFailure of [
  {
    name: "the priority entry is missing",
    fixtureOptions: { u9PrioritySource: null },
    expectedError: /committed U9 priority test is unavailable/u,
  },
  {
    name: "the mirrored implementation is missing",
    fixtureOptions: { u9ImplementationSource: null },
    expectedError: /committed U9 implementation test is unavailable/u,
  },
  {
    name: "the legacy direct path is present",
    fixtureOptions: {
      legacyU9Source: 'import "./u9-mirrored-pr-end-to-end.mjs";\n',
    },
    expectedError: /legacy direct U9 test path is ambiguous/u,
  },
  {
    name: "the priority entry is empty",
    fixtureOptions: { u9PrioritySource: "" },
    expectedError: /committed U9 priority test contents are invalid/u,
  },
  {
    name: "the priority entry imports another module",
    fixtureOptions: { u9PrioritySource: 'import "./smoke.test.js";\n' },
    expectedError: /committed U9 priority test contents are invalid/u,
  },
]) {
  test(`rejects a committed U9 test contract when ${u9ContractFailure.name}`, async (t) => {
    const fixture = await createFixture(t, u9ContractFailure.fixtureOptions);
    const { buildAcceptanceManifest } = await loadManifestModule();

    await assert.rejects(
      buildAcceptanceManifest({
        root: fixture.root,
        validationReportPath: fixture.validationPath,
        artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
        reviewReports: fixture.reviews,
      }),
      u9ContractFailure.expectedError,
    );
  });
}

test("rejects a validation report outside its run-specific artifact path", async (t) => {
  const fixture = await createFixture(t);
  const misplacedPath = path.join(
    fixture.root,
    "validation-artifacts/misplaced-system-validation.json",
  );
  await writeFile(misplacedPath, await readFile(fixture.validationPath));
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: misplacedPath,
      reviewReports: fixture.reviews,
    }),
    /system validation report path does not match its run identity/u,
  );
});

test("rejects a self-consistent live runtime digest not derived from HEAD", async (t) => {
  const fixture = await createFixture(t, {
    runtimeSourceMutator: (runtimeSource) => ({
      ...runtimeSource,
      runtimeDigest: "f".repeat(64),
    }),
  });
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /system validation live runtime identity is invalid/u,
  );
});

test("rejects incomplete acceptance chronology", async (t) => {
  await t.test("UI completion predates validation", async (t) => {
    const fixture = await createFixture(t, {
      uiCompletedAt: "2026-08-08T23:59:59.000Z",
    });
    const { buildAcceptanceManifest } = await loadManifestModule();
    await assert.rejects(
      buildAcceptanceManifest({
        root: fixture.root,
        validationReportPath: fixture.validationPath,
        reviewReports: fixture.reviews,
        generatedAt: "2026-08-09T00:11:00.000Z",
      }),
      /system validation UI completion chronology is invalid/u,
    );
  });

  await t.test("a review postdates generation", async (t) => {
    const fixture = await createFixture(t);
    const { buildAcceptanceManifest } = await loadManifestModule();
    await assert.rejects(
      buildAcceptanceManifest({
        root: fixture.root,
        validationReportPath: fixture.validationPath,
        reviewReports: fixture.reviews,
        generatedAt: "2026-08-09T00:10:01.500Z",
      }),
      /machine-readable Ready evidence/u,
    );
  });

  await t.test("generation is not canonical", async (t) => {
    const fixture = await createFixture(t);
    const { buildAcceptanceManifest } = await loadManifestModule();
    await assert.rejects(
      buildAcceptanceManifest({
        root: fixture.root,
        validationReportPath: fixture.validationPath,
        reviewReports: fixture.reviews,
        generatedAt: "not-a-timestamp",
      }),
      /acceptance manifest generation time is invalid/u,
    );
  });
});

test("rejects text files presented as UI screenshots", async (t) => {
  const fixture = await createFixture(t);
  const desktopPath = fixture.validation.uiArtifactReceipt.receipt.artifacts.find(
    ({ kind }) => kind === "desktop-screenshot",
  ).path;
  await writeFile(
    path.join(fixture.root, ...desktopPath.split("/")),
    "not a PNG image\n",
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /system validation UI artifact receipt is invalid/u,
  );
});

test("rejects unstructured UI results even when the expected file exists", async (t) => {
  const fixture = await createFixture(t);
  const resultsPath = fixture.validation.uiArtifactReceipt.receipt.artifacts.find(
    ({ kind }) => kind === "results",
  ).path;
  await writeFile(
    path.join(fixture.root, ...resultsPath.split("/")),
    "{}\n",
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /system validation UI artifact receipt is invalid/u,
  );
});

test("rejects UI artifacts replaced after the child receipt was published", async (t) => {
  const fixture = await createFixture(t);
  const mobilePath = fixture.validation.uiArtifactReceipt.receipt.artifacts.find(
    ({ kind }) => kind === "mobile-screenshot",
  ).path;
  await writeFile(
    path.join(fixture.root, ...mobilePath.split("/")),
    png(390, 900),
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /system validation UI artifact receipt is invalid/u,
  );
});

test("rejects a UI receipt and command copied from a different validation run", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const forgedPath = path.join(
    fixture.root,
    "validation-artifacts/runs",
    forged.runId,
    "system-validation.json",
  );
  await mkdir(path.dirname(forgedPath), { recursive: true });
  await writeFile(
    forgedPath,
    `${JSON.stringify(forged, null, 2)}\n`,
  );
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: forgedPath,
      reviewReports: fixture.reviews,
    }),
    /system validation UI artifact receipt is invalid/u,
  );
});

test("rejects a UI command that omits the run-bound receipt arguments", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps.find(
    ({ name }) => name === "live desktop and mobile UI behavior",
  ).command.arguments = ["scripts/validate-ui.mjs"];
  await rewriteValidationAndReviewBindings(fixture, forged);
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /mandatory validation command does not match its contract/u,
  );
});

test("rejects malformed validation chronology even with rebound review digests", async (t) => {
  const fixture = await createFixture(t);
  const malformed = structuredClone(fixture.validation);
  malformed.finishedAt = "not-a-date";
  await rewriteValidationAndReviewBindings(fixture, malformed);
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    }),
    /validation report chronology is invalid/u,
  );
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

test("acceptance source phase checks reject every clean-HEAD transition", async () => {
  const source = {
    schemaVersion: 1,
    headOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    clean: true,
    changeCount: 0,
    statusDigest: "3".repeat(64),
    headLogDigest: "4".repeat(64),
  };
  const { assertAcceptanceSourceTransition } = await loadManifestModule();

  assert.doesNotThrow(() =>
    assertAcceptanceSourceTransition(source, source, "after evidence reads")
  );
  assert.throws(
    () => assertAcceptanceSourceTransition(
      source,
      { ...source, headOid: "5".repeat(40), treeOid: "6".repeat(40) },
      "before publication",
    ),
    /acceptance source changed before publication/u,
  );
  assert.throws(
    () => assertAcceptanceSourceTransition(
      source,
      { ...source, headLogDigest: "7".repeat(64) },
      "after publication",
    ),
    /acceptance source changed after publication/u,
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
    /validation step environment does not match its contract/u,
  );
});

test("rejects browser validation without the null-device host profile boundary", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  delete forged.steps.find(
    ({ name }) => name === "configuration form browser behavior",
  ).environment.USERPROFILE;
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
    /validation step environment does not match its contract/u,
  );
});

test("rejects validation commands without the exact lifecycle limits", async (t) => {
  const fixture = await createFixture(t);
  const forged = structuredClone(fixture.validation);
  forged.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).limits.timeoutMs += 1;
  await rewriteValidationAndReviewBindings(fixture, forged);
  const { buildAcceptanceManifest } = await loadManifestModule();

  await assert.rejects(
    buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      artifactPaths: fixture.artifacts.map(([relativePath]) => relativePath),
      reviewReports: fixture.reviews,
    }),
    /validation command limits do not match their contract/u,
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
  results.summary.passed = 1;
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

test("accepts an explicitly documented Windows-only test skip", async (t) => {
  const fixture = await createFixture(t);
  const validation = structuredClone(fixture.validation);
  const results = validation.steps.find(
    ({ name }) => name === "complete Node test suite",
  ).testResults;
  results.cases[0] = {
    identity:
      "tap:1:PowerShell manager starts, identifies, reports, and gracefully stops only its process",
    name:
      "PowerShell manager starts, identifies, reports, and gracefully stops only its process",
    status: "skipped",
    reason: "requires Windows PowerShell manager",
  };
  results.summary.passed = 1;
  results.summary.skipped = 2;
  await rewriteValidationAndReviewBindings(fixture, validation);
  const { buildAcceptanceManifest } = await loadManifestModule();

  const manifest = await buildAcceptanceManifest({
    root: fixture.root,
    validationReportPath: fixture.validationPath,
    reviewReports: fixture.reviews,
  });

  assert.equal(manifest.status, "passed");
});

for (const [name, reason] of [
  [
    "cleanup rejects a symbolic-link entry without touching its target",
    "file symlinks require Windows Developer Mode or elevated privilege",
  ],
  ...["EPERM", "EACCES", "UNKNOWN"].map((errorCode) => [
    "rejects a symbolic-link source when link creation is available",
    `Windows symbolic-link fixture capability unavailable: ${errorCode}`,
  ]),
  [
    "rejects a wrong-owner source when owner reassignment is available",
    "Windows wrong-owner fixture capability unavailable: Set-Acl owner reassignment denied",
  ],
]) {
  test(`accepts the documented host-capability skip: ${name} (${reason})`, async (t) => {
    const fixture = await createFixture(t);
    const validation = structuredClone(fixture.validation);
    const results = validation.steps.find(
      ({ name: stepName }) => stepName === "complete Node test suite",
    ).testResults;
    results.cases[0] = {
      identity: `tap:1:${name}`,
      name,
      status: "skipped",
      reason,
    };
    results.summary.passed = 1;
    results.summary.skipped = 2;
    await rewriteValidationAndReviewBindings(fixture, validation);
    const { buildAcceptanceManifest } = await loadManifestModule();

    const manifest = await buildAcceptanceManifest({
      root: fixture.root,
      validationReportPath: fixture.validationPath,
      reviewReports: fixture.reviews,
    });

    assert.equal(manifest.status, "passed");
  });
}

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

test("bounded evidence reads reject growth without allocating appended bytes", async () => {
  const initial = Buffer.from("safe", "utf8");
  const appended = Buffer.alloc(8 * 1024 * 1024, 0x78);
  const contents = Buffer.concat([initial, appended]);
  let largestRequestedRead = 0;
  const handle = {
    async read(buffer, offset, length, position) {
      largestRequestedRead = Math.max(largestRequestedRead, length);
      const available = Math.max(0, Math.min(length, contents.length - position));
      contents.copy(buffer, offset, position, position + available);
      return { buffer, bytesRead: available };
    },
  };
  const { readBoundedEvidenceHandle } = await loadManifestModule();

  await assert.rejects(
    readBoundedEvidenceHandle(handle, initial.length, "evidence.json"),
    /acceptance evidence grew while it was read: evidence\.json/u,
  );
  assert.equal(largestRequestedRead <= 64 * 1024, true);
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

test("does not create external directories through an output junction", async (t) => {
  const fixture = await createFixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "mydashboard-output-side-effect-"));
  t.after(() => rm(external, { force: true, recursive: true }));
  const junction = path.join(fixture.root, "validation-artifacts/publish-side-effect");
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
      reviewReports: fixture.reviews,
      outputPath:
        "validation-artifacts/publish-side-effect/new/acceptance.json",
    }),
    /manifest output path contains a symbolic link or junction/u,
  );
  await assert.rejects(lstat(path.join(external, "new")), { code: "ENOENT" });
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
    "validation-artifacts/runs",
    fixture.validation.runId,
    "system-acceptance-manifest.json",
  );

  await execFileAsync(process.execPath, [
    manifestScript,
    "--validation-report",
    path.relative(fixture.root, fixture.validationPath).replaceAll("\\", "/"),
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
