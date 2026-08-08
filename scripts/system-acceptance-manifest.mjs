import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertStableCleanRepository,
  captureRepositoryState,
} from "./system-validation-provenance.mjs";

const REQUIRED_ARTIFACTS = new Set([
  "validation-artifacts/desktop-1440.png",
  "validation-artifacts/mobile-390.png",
  "validation-artifacts/results.json",
]);
const MAXIMUM_EVIDENCE_BYTES = 64 * 1024 * 1024;
const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const REVIEW_SCOPES = new Set([
  "security-reliability",
  "maintainability-usability",
]);
const REQUIRED_COMMANDS = new Map([
  [
    "git diff --check",
    { executable: "git", arguments: ["diff", "--check"] },
  ],
  [
    "complete Node test suite",
    {
      executable: "node",
      arguments: ["--test", "--test-reporter=tap", "test/*.test.js"],
    },
  ],
  [
    "configuration form browser behavior",
    {
      executable: "node",
      arguments: ["test/browser/configuration-form-playwright.mjs"],
    },
  ],
  [
    "confirmation history browser behavior",
    {
      executable: "node",
      arguments: ["test/browser/confirmation-history-playwright.mjs"],
    },
  ],
  [
    "real Docker sandbox boundary",
    {
      executable: "node",
      arguments: ["--test", "test/docker-test-sandbox.integration.test.js"],
    },
  ],
  [
    "live desktop and mobile UI behavior",
    { executable: "node", arguments: ["scripts/validate-ui.mjs"] },
  ],
]);
const execFileAsync = promisify(execFile);
const SOURCE_DIRECTORIES = Object.freeze([
  "src",
  "public",
  "scripts",
  "test",
  "test-support",
]);
const ALLOWED_TEST_SKIPS = new Map([
  ["linked blob", "symlink creation is unavailable on this host"],
  [
    "broker rejects a Git executable-mode receipt that differs from the POSIX materialization",
    "NTFS does not represent Git executable bits",
  ],
  [
    "requires a non-dangerous executable mode for Git on Unix",
    "POSIX executable mode is unavailable on Windows",
  ],
  [
    "real Docker sandbox denies host network, secrets, and source writes",
    "requires MYDASHBOARD_DOCKER_INTEGRATION=1",
  ],
  [
    "rejects revoked execute permission or privileged Git modes before invocation",
    "Windows executable authority is ACL-based",
  ],
  [
    "Codex result files reject symlinks outside the invocation",
    "file symlinks require Windows Developer Mode or elevated privilege",
  ],
  [
    "runtime source identity rejects symlinks in packaged directories",
    "file symlinks are unavailable on this host",
  ],
]);

async function canonicalRepositoryRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("repository root must be a non-empty string");
  }
  const resolved = path.resolve(root);
  try {
    const supplied = await lstat(resolved, { bigint: true });
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) {
      throw new Error("invalid root");
    }
    const canonical = await realpath(resolved);
    const canonicalMetadata = await lstat(canonical, { bigint: true });
    if (
      !canonicalMetadata.isDirectory() ||
      canonicalMetadata.isSymbolicLink()
    ) {
      throw new Error("invalid root");
    }
    return canonical;
  } catch {
    throw new Error("repository root is not a canonical directory");
  }
}

function relativeFile(root, filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("acceptance evidence path must be a non-empty string");
  }
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("acceptance evidence must stay inside the repository");
  }
  return {
    absolutePath,
    relativePath: relativePath.replaceAll("\\", "/"),
  };
}

async function evidenceLstat(absolutePath, relativePath) {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch {
    throw new Error(`acceptance evidence could not be read: ${relativePath}`);
  }
}

function metadataSnapshot(metadata) {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    links: metadata.nlink,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  };
}

function sameMetadata(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

async function evidenceAncestors(root, relativePath) {
  const snapshots = [];
  let ancestor = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const metadata = await evidenceLstat(ancestor, relativePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `acceptance evidence path contains a symbolic link or junction: ${relativePath}`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `acceptance evidence ancestor is not a directory: ${relativePath}`,
      );
    }
    snapshots.push({
      absolutePath: ancestor,
      metadata: metadataSnapshot(metadata),
    });
  }
  return snapshots;
}

async function assertEvidenceAncestorsUnchanged(snapshots, relativePath) {
  for (const snapshot of snapshots) {
    const metadata = await evidenceLstat(snapshot.absolutePath, relativePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !sameMetadata(snapshot.metadata, metadataSnapshot(metadata))
    ) {
      throw new Error(`acceptance evidence path changed while read: ${relativePath}`);
    }
  }
}

async function openedEvidenceFile(absolutePath, relativePath) {
  const flags = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);
  try {
    return await open(absolutePath, flags);
  } catch {
    throw new Error(`acceptance evidence could not be read: ${relativePath}`);
  }
}

async function evidenceHandleStat(handle, relativePath) {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    throw new Error(`acceptance evidence could not be read: ${relativePath}`);
  }
}

async function assertSafeOutputAncestors(root, relativePath) {
  const segments = relativePath.split("/");
  const snapshots = [];
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    let metadata;
    try {
      metadata = await lstat(ancestor, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`manifest output path could not be inspected: ${relativePath}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `manifest output path contains a symbolic link or junction: ${relativePath}`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(`manifest output ancestor is not a directory: ${relativePath}`);
    }
    snapshots.push({
      absolutePath: ancestor,
      metadata: metadataSnapshot(metadata),
    });
  }
  return snapshots;
}

function sameAncestorSnapshots(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((snapshot, index) =>
      snapshot.absolutePath === right[index].absolutePath &&
      snapshot.metadata.device === right[index].metadata.device &&
      snapshot.metadata.inode === right[index].metadata.inode &&
      snapshot.metadata.mode === right[index].metadata.mode
    )
  );
}

async function publishManifest(root, output, manifest) {
  try {
    await mkdir(path.dirname(output.absolutePath), { recursive: true });
  } catch {
    throw new Error(`manifest output directory could not be created: ${output.relativePath}`);
  }
  const outputAncestors = await assertSafeOutputAncestors(
    root,
    output.relativePath,
  );
  if (outputAncestors === null) {
    throw new Error(`manifest output directory is unavailable: ${output.relativePath}`);
  }
  const temporaryPath = path.join(
    path.dirname(output.absolutePath),
    `.${path.basename(output.absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle = null;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    const beforePublish = await assertSafeOutputAncestors(
      root,
      output.relativePath,
    );
    if (!sameAncestorSnapshots(outputAncestors, beforePublish)) {
      throw new Error(`manifest output path changed before publication: ${output.relativePath}`);
    }
    try {
      await link(temporaryPath, output.absolutePath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("acceptance manifest output already exists");
      }
      throw new Error(`acceptance manifest could not be published: ${output.relativePath}`);
    }
    try {
      await unlink(temporaryPath);
      temporaryExists = false;
    } catch {
      try {
        await unlink(output.absolutePath);
      } catch {
        // The failure is still surfaced; recovery must inspect this exact output.
      }
      throw new Error(`acceptance manifest publication cleanup failed: ${output.relativePath}`);
    }
    const afterPublish = await assertSafeOutputAncestors(
      root,
      output.relativePath,
    );
    let publishedMetadata;
    try {
      publishedMetadata = await lstat(output.absolutePath, { bigint: true });
    } catch {
      throw new Error(`acceptance manifest publication is missing: ${output.relativePath}`);
    }
    if (
      !sameAncestorSnapshots(outputAncestors, afterPublish) ||
      !publishedMetadata.isFile() ||
      publishedMetadata.isSymbolicLink() ||
      publishedMetadata.nlink !== 1n
    ) {
      throw new Error(`acceptance manifest publication is unsafe: ${output.relativePath}`);
    }
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => {});
    }
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

async function evidenceFile(root, filePath) {
  const resolved = relativeFile(root, filePath);
  const ancestors = await evidenceAncestors(root, resolved.relativePath);
  const pathMetadata = await evidenceLstat(
    resolved.absolutePath,
    resolved.relativePath,
  );
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error(`acceptance evidence is not a regular file: ${resolved.relativePath}`);
  }
  if (pathMetadata.nlink !== 1n) {
    throw new Error(
      `hard-linked acceptance evidence is forbidden: ${resolved.relativePath}`,
    );
  }
  if (
    pathMetadata.size < 0n ||
    pathMetadata.size > BigInt(MAXIMUM_EVIDENCE_BYTES)
  ) {
    throw new Error(`acceptance evidence is too large: ${resolved.relativePath}`);
  }
  const initial = metadataSnapshot(pathMetadata);
  const handle = await openedEvidenceFile(
    resolved.absolutePath,
    resolved.relativePath,
  );
  let contents;
  try {
    const opened = await evidenceHandleStat(handle, resolved.relativePath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameMetadata(initial, metadataSnapshot(opened))
    ) {
      throw new Error(
        `acceptance evidence changed before it was read: ${resolved.relativePath}`,
      );
    }
    try {
      contents = await handle.readFile();
    } catch {
      throw new Error(
        `acceptance evidence could not be read: ${resolved.relativePath}`,
      );
    }
    const finished = await evidenceHandleStat(handle, resolved.relativePath);
    const finalPathMetadata = await evidenceLstat(
      resolved.absolutePath,
      resolved.relativePath,
    );
    if (
      !sameMetadata(initial, metadataSnapshot(finished)) ||
      !sameMetadata(initial, metadataSnapshot(finalPathMetadata)) ||
      contents.length !== Number(finished.size)
    ) {
      throw new Error(
        `acceptance evidence changed while it was read: ${resolved.relativePath}`,
      );
    }
    await assertEvidenceAncestorsUnchanged(ancestors, resolved.relativePath);
  } finally {
    await handle.close().catch(() => {});
  }
  return {
    path: resolved.relativePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
    contents,
  };
}

function validateTestResults(step) {
  const { summary, cases } = step.testResults ?? {};
  const fields = ["tests", "passed", "failed", "cancelled", "skipped", "todo"];
  if (
    fields.some((field) =>
      !Number.isSafeInteger(summary?.[field]) || summary[field] < 0
    ) ||
    !Array.isArray(cases)
  ) {
    throw new Error("complete Node test results are incomplete");
  }
  if (summary.failed !== 0 || summary.cancelled !== 0 || summary.todo !== 0) {
    throw new Error("complete Node test results are not release-clean");
  }
  if (
    summary.tests <= 0 ||
    summary.tests !==
      summary.passed +
      summary.failed +
      summary.cancelled +
      summary.skipped +
      summary.todo
  ) {
    throw new Error("complete Node test result counts are inconsistent");
  }
  if (
    cases.length !== summary.tests ||
    cases.some(({ name, status }) =>
      typeof name !== "string" ||
      name === "" ||
      !["passed", "skipped", "failed", "cancelled", "todo"].includes(status)
    )
  ) {
    throw new Error("complete Node test identities are incomplete");
  }
  if (
    cases.some(
      ({ identity, name }, index) => identity !== `tap:${index + 1}:${name}`,
    ) ||
    new Set(cases.map(({ identity }) => identity)).size !== cases.length
  ) {
    throw new Error("complete Node test identities are not unique and sequential");
  }
  const actual = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  for (const testCase of cases) actual[testCase.status] += 1;
  if (
    Object.keys(actual).some((status) => actual[status] !== summary[status])
  ) {
    throw new Error("complete Node test case statuses contradict the summary");
  }
  for (const testCase of cases) {
    if (testCase.status === "skipped") {
      if (
        ALLOWED_TEST_SKIPS.get(testCase.name) !== testCase.reason ||
        typeof testCase.reason !== "string" ||
        testCase.reason === ""
      ) {
        throw new Error("complete Node test skip is not explicitly allowed");
      }
    } else if (testCase.reason !== undefined) {
      throw new Error("complete Node non-skipped test must not carry a skip reason");
    }
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function invalidReview() {
  throw new Error(
    "independent review report must be machine-readable Ready evidence",
  );
}

function validatedReview(file, declaredScope, validationReport, validationFile) {
  if (!file.path.endsWith(".json")) return invalidReview();
  let review;
  try {
    review = JSON.parse(file.contents.toString("utf8"));
  } catch {
    return invalidReview();
  }
  if (
    !hasExactKeys(review, [
      "findings",
      "reviewedAt",
      "reviewerId",
      "reviewerRunId",
      "reviewId",
      "schemaVersion",
      "scope",
      "validation",
      "verdict",
    ]) ||
    review.schemaVersion !== 1 ||
    !UUID_V4.test(review.reviewId) ||
    typeof review.reviewerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(review.reviewerId) ||
    !UUID_V4.test(review.reviewerRunId) ||
    review.scope !== declaredScope ||
    !REVIEW_SCOPES.has(review.scope) ||
    review.verdict !== "ready" ||
    typeof review.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    new Date(review.reviewedAt).toISOString() !== review.reviewedAt ||
    Date.parse(review.reviewedAt) < Date.parse(validationReport.finishedAt) ||
    !hasExactKeys(review.validation, [
      "headOid",
      "reportSha256",
      "runId",
      "treeOid",
    ]) ||
    review.validation.runId !== validationReport.runId ||
    review.validation.headOid !== validationReport.source.finished.headOid ||
    review.validation.treeOid !== validationReport.source.finished.treeOid ||
    review.validation.reportSha256 !== validationFile.sha256 ||
    !SHA_256.test(review.validation.reportSha256) ||
    !hasExactKeys(review.findings, ["p0", "p1", "p2", "p3"]) ||
    ["p0", "p1", "p2", "p3"].some(
      (priority) =>
        !Number.isSafeInteger(review.findings[priority]) ||
        review.findings[priority] < 0,
    ) ||
    review.findings.p0 !== 0 ||
    review.findings.p1 !== 0 ||
    review.findings.p2 !== 0
  ) {
    return invalidReview();
  }
  return review;
}

function commandMatches(actual, expected) {
  return (
    actual?.executable === expected.executable &&
    Array.isArray(actual.arguments) &&
    actual.arguments.length === expected.arguments.length &&
    actual.arguments.every((value, index) => value === expected.arguments[index])
  );
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function committedSyntaxFiles(root, headOid) {
  let output;
  try {
    ({ stdout: output } = await execFileAsync(
      "git",
      [
        "ls-tree",
        "-rz",
        "--full-tree",
        headOid,
        "--",
        ...SOURCE_DIRECTORIES,
      ],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch {
    throw new Error("unable to derive the committed syntax contract");
  }
  const bytes = Buffer.from(output);
  if (bytes.length === 0 || bytes.at(-1) !== 0) {
    throw new Error("committed syntax contract is empty or malformed");
  }
  const files = [];
  for (const record of bytes.toString("utf8").slice(0, -1).split("\0")) {
    const match = record.match(
      /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u,
    );
    if (!match) {
      throw new Error("committed syntax contract contains a malformed entry");
    }
    const [, mode, type, , relativePath] = match;
    if (
      relativePath.includes("\\") ||
      relativePath.includes("\uFFFD") ||
      path.posix.isAbsolute(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath ||
      relativePath.split("/").some((segment) => segment === "..")
    ) {
      throw new Error("committed syntax contract contains an unsafe path");
    }
    if (
      type === "blob" &&
      ["100644", "100755"].includes(mode) &&
      /\.(?:js|mjs)$/u.test(relativePath)
    ) {
      files.push(relativePath);
    }
  }
  files.sort(compareUtf8Paths);
  if (files.length === 0 || new Set(files).size !== files.length) {
    throw new Error("committed syntax contract has no unique source files");
  }
  return files;
}

function requiredStepContracts(syntaxFiles) {
  return [
    {
      name: "git diff --check",
      command: REQUIRED_COMMANDS.get("git diff --check"),
    },
    ...syntaxFiles.map((relativePath) => ({
      name: `syntax:${relativePath}`,
      command: {
        executable: "node",
        arguments: ["--check", relativePath],
      },
    })),
    { name: "node syntax aggregate", kind: "aggregate" },
    {
      name: "complete Node test suite",
      command: REQUIRED_COMMANDS.get("complete Node test suite"),
    },
    {
      name: "configuration form browser behavior",
      command: REQUIRED_COMMANDS.get("configuration form browser behavior"),
    },
    {
      name: "confirmation history browser behavior",
      command: REQUIRED_COMMANDS.get("confirmation history browser behavior"),
    },
    {
      name: "real Docker sandbox boundary",
      command: REQUIRED_COMMANDS.get("real Docker sandbox boundary"),
      environment: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
    },
    {
      name: "live desktop and mobile UI behavior",
      command: REQUIRED_COMMANDS.get("live desktop and mobile UI behavior"),
    },
  ];
}

function validateReport(report, currentSource, syntaxFiles) {
  if (report?.status !== "passed") {
    throw new Error("system validation report is not passed");
  }
  if (!UUID_V4.test(report.runId)) {
    throw new Error("system validation report has no valid run identity");
  }
  if (report.options?.withDocker !== true || report.options?.withLiveUi !== true) {
    throw new Error("system validation report omitted Docker or live UI acceptance");
  }
  if (report.source?.stable !== true) {
    throw new Error("system validation source is not stable");
  }
  try {
    assertStableCleanRepository(report.source.started, report.source.finished);
  } catch {
    throw new Error("validation source states differ");
  }
  try {
    assertStableCleanRepository(report.source.finished, currentSource);
  } catch {
    throw new Error("validation report does not match the current HEAD");
  }
  if (!Array.isArray(report.steps) || report.steps.length === 0) {
    throw new Error("system validation report has no command steps");
  }
  const stepNames = report.steps.map((step) => step?.name);
  if (
    stepNames.some((name) => typeof name !== "string" || name === "") ||
    new Set(stepNames).size !== stepNames.length
  ) {
    throw new Error("validation step names must be unique");
  }
  if (
    report.steps.some(
      (step) => step?.kind === "aggregate" && step.name !== "node syntax aggregate",
    )
  ) {
    throw new Error("unknown aggregate validation step");
  }
  const contracts = requiredStepContracts(syntaxFiles);
  if (
    contracts.length !== report.steps.length ||
    contracts.some((contract, index) => contract.name !== report.steps[index].name)
  ) {
    throw new Error("validation steps do not match the committed command contract");
  }
  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index];
    const step = report.steps[index];
    if (
      contract.kind === "aggregate"
        ? step.kind !== "aggregate"
        : step.kind !== undefined || !commandMatches(step.command, contract.command)
    ) {
      throw new Error("mandatory validation command does not match its contract");
    }
    const expectedEnvironment = contract.environment;
    const actualEnvironment = step.environment;
    if (
      expectedEnvironment === undefined
        ? actualEnvironment !== undefined
        : actualEnvironment === null ||
          typeof actualEnvironment !== "object" ||
          Array.isArray(actualEnvironment) ||
          Object.keys(actualEnvironment).length !== 1 ||
          actualEnvironment.MYDASHBOARD_DOCKER_INTEGRATION !== "1"
    ) {
      throw new Error("Docker validation environment does not match its contract");
    }
  }
  for (const step of report.steps) {
    if (step?.kind === "aggregate") {
      if (step.name !== "node syntax aggregate") {
        throw new Error("unknown aggregate validation step");
      }
      if (
        step.status !== "passed" ||
        !Number.isSafeInteger(step.durationMs) ||
        step.durationMs < 0 ||
        !Number.isSafeInteger(step.fileCount) ||
        step.fileCount !== syntaxFiles.length
      ) {
        throw new Error("system validation contains an invalid aggregate result");
      }
      continue;
    }
    if (
      step?.status !== "passed" ||
      !Number.isSafeInteger(step.durationMs) ||
      step.durationMs < 0 ||
      step.exitCode !== 0 ||
      step.signal !== null ||
      typeof step.command?.executable !== "string" ||
      !Array.isArray(step.command.arguments)
    ) {
      throw new Error("system validation contains an incomplete command result");
    }
  }
  const testStep = report.steps.find(
    ({ name }) => name === "complete Node test suite",
  );
  const dockerStep = report.steps.find(
    ({ name }) => name === "real Docker sandbox boundary",
  );
  const uiStep = report.steps.find(
    ({ name }) => name === "live desktop and mobile UI behavior",
  );
  if (!testStep || !dockerStep || !uiStep) {
    throw new Error("system validation omitted a mandatory acceptance command");
  }
  for (const [name, command] of REQUIRED_COMMANDS) {
    const step = report.steps.find((candidate) => candidate.name === name);
    if (!commandMatches(step?.command, command)) {
      throw new Error("mandatory validation command does not match its contract");
    }
  }
  validateTestResults(testStep);
}

export async function buildAcceptanceManifest({
  root,
  validationReportPath,
  artifactPaths,
  reviewReports,
  generatedAt = new Date().toISOString(),
}) {
  const canonicalRoot = await canonicalRepositoryRoot(root);
  if (!Array.isArray(reviewReports) || reviewReports.length !== 2) {
    throw new Error("at least two independent review reports are required");
  }
  if (!Array.isArray(artifactPaths)) {
    throw new Error("acceptance artifact paths are required");
  }
  const validationFile = await evidenceFile(canonicalRoot, validationReportPath);
  let validationReport;
  try {
    validationReport = JSON.parse(validationFile.contents.toString("utf8"));
  } catch {
    throw new Error("system validation report is not valid JSON");
  }
  const currentSource = await captureRepositoryState(canonicalRoot);
  const syntaxFiles = await committedSyntaxFiles(
    canonicalRoot,
    currentSource.headOid,
  );
  validateReport(validationReport, currentSource, syntaxFiles);

  const artifacts = await Promise.all(
    artifactPaths.map((artifactPath) => evidenceFile(canonicalRoot, artifactPath)),
  );
  const artifactNames = new Set(artifacts.map(({ path: artifactPath }) => artifactPath));
  if (
    artifactNames.size !== artifacts.length ||
    [...REQUIRED_ARTIFACTS].some((required) => !artifactNames.has(required))
  ) {
    throw new Error("acceptance artifacts are incomplete or duplicated");
  }

  const scopes = new Set();
  const reviewPaths = new Set();
  const reviewIds = new Set();
  const reviewerIds = new Set();
  const reviewerRunIds = new Set();
  const reviews = [];
  for (const review of reviewReports) {
    if (
      typeof review?.scope !== "string" ||
      review.scope.trim() === "" ||
      scopes.has(review.scope)
    ) {
      throw new Error("independent review scopes must be non-empty and unique");
    }
    const file = await evidenceFile(canonicalRoot, review.path);
    if (reviewPaths.has(file.path)) {
      throw new Error("independent review report paths must be unique");
    }
    const evidence = validatedReview(
      file,
      review.scope,
      validationReport,
      validationFile,
    );
    if (
      reviewIds.has(evidence.reviewId) ||
      reviewerIds.has(evidence.reviewerId) ||
      reviewerRunIds.has(evidence.reviewerRunId)
    ) {
      throw new Error("independent review identities must be unique");
    }
    scopes.add(review.scope);
    reviewPaths.add(file.path);
    reviewIds.add(evidence.reviewId);
    reviewerIds.add(evidence.reviewerId);
    reviewerRunIds.add(evidence.reviewerRunId);
    reviews.push({
      scope: review.scope,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      reviewId: evidence.reviewId,
      reviewerId: evidence.reviewerId,
      reviewerRunId: evidence.reviewerRunId,
      reviewedAt: evidence.reviewedAt,
      verdict: evidence.verdict,
      findings: structuredClone(evidence.findings),
    });
  }
  if (
    scopes.size !== REVIEW_SCOPES.size ||
    [...REVIEW_SCOPES].some((scope) => !scopes.has(scope))
  ) {
    throw new Error("independent review scopes do not cover the required lenses");
  }

  return {
    schemaVersion: 1,
    runId: validationReport.runId,
    generatedAt,
    status: "passed",
    source: currentSource,
    validation: {
      runId: validationReport.runId,
      path: validationFile.path,
      sha256: validationFile.sha256,
      bytes: validationFile.bytes,
      startedAt: validationReport.startedAt,
      finishedAt: validationReport.finishedAt,
      node: validationReport.node,
      platform: validationReport.platform,
      options: validationReport.options,
      steps: structuredClone(validationReport.steps),
    },
    artifacts: artifacts.map(({ contents: _contents, ...artifact }) => artifact),
    reviews,
  };
}

export async function writeAcceptanceManifest({ outputPath, ...options }) {
  const root = await canonicalRepositoryRoot(options.root);
  const output = relativeFile(root, outputPath);
  const manifest = await buildAcceptanceManifest({ ...options, root });
  await assertSafeOutputAncestors(root, output.relativePath);
  await publishManifest(root, output, manifest);
  return manifest;
}

function commandLineReviews(arguments_) {
  const reviews = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--review" || index + 1 >= arguments_.length) {
      throw new Error(
        "usage: system-acceptance-manifest.mjs --review <scope>=<path> --review <scope>=<path>",
      );
    }
    const value = arguments_[index + 1];
    index += 1;
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("review argument must use <scope>=<path>");
    }
    reviews.push({
      scope: value.slice(0, separator),
      path: value.slice(separator + 1),
    });
  }
  return reviews;
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const manifest = await writeAcceptanceManifest({
    root: process.cwd(),
    validationReportPath: "validation-artifacts/system-validation.json",
    artifactPaths: [...REQUIRED_ARTIFACTS],
    reviewReports: commandLineReviews(process.argv.slice(2)),
    outputPath: "validation-artifacts/system-acceptance-manifest.json",
  });
  process.stdout.write(
    `acceptance manifest written for ${manifest.source.headOid}\n`,
  );
}
