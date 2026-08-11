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
import {
  uiValidationCommandArguments,
  verifyUiArtifactReceipt,
} from "./system-ui-artifact-receipt.mjs";
import {
  deriveCommittedRuntimeSourceIdentity,
} from "./system-validation-materialization.mjs";
import {
  VALIDATION_CONTROLLED_VARIABLES,
  VALIDATION_INHERITED_VARIABLES,
  VALIDATION_ISOLATED_VARIABLES,
} from "./system-validation-environment.mjs";
import {
  selectCommittedNodeTestFiles,
  u9PriorityTestPath,
} from "./system-node-test-contract.mjs";

const MAXIMUM_EVIDENCE_BYTES = 64 * 1024 * 1024;
const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const REVIEW_SCOPES = new Set([
  "security-reliability",
  "maintainability-usability",
]);
const REVIEW_EVIDENCE_POLICY =
  "release-owner-attested-distinct-scopes-v1";
const DEFAULT_VALIDATION_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
});
const REQUIRED_COMMANDS = new Map([
  [
    "open-source distribution suite",
    {
      executable: "node",
      arguments: [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=tap",
        "test/open-source-distribution.mjs",
      ],
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
    "cleanup rejects a symbolic-link entry without touching its target",
    "file symlinks require Windows Developer Mode or elevated privilege",
  ],
  [
    "rejects a symbolic-link source when link creation is available",
    new Set([
      "Windows symbolic-link fixture capability unavailable: EPERM",
      "Windows symbolic-link fixture capability unavailable: EACCES",
      "Windows symbolic-link fixture capability unavailable: UNKNOWN",
    ]),
  ],
  [
    "rejects a wrong-owner source when owner reassignment is available",
    "Windows wrong-owner fixture capability unavailable: Set-Acl owner reassignment denied",
  ],
  [
    "runtime source identity rejects symlinks in packaged directories",
    "file symlinks are unavailable on this host",
  ],
  [
    "the real application server completes authenticated manager start and stop on an isolated port",
    "requires Windows PowerShell manager",
  ],
  [
    "PowerShell manager starts, identifies, reports, and gracefully stops only its process",
    "requires Windows PowerShell manager",
  ],
  [
    "PowerShell manager permits an exact offline restore only while the service is stopped",
    "requires Windows PowerShell manager",
  ],
  [
    "PowerShell 7 uses the same private ACL and authenticated lifecycle",
    new Set(["requires Windows PowerShell manager", "requires PowerShell 7"]),
  ],
  [
    "PowerShell manager refuses an unrecorded loopback listener without killing it",
    "requires Windows PowerShell manager",
  ],
  [
    "concurrent starts serialize and retain one health-bound process",
    "requires Windows PowerShell manager",
  ],
  [
    "a manager killed after durable control publication leaves a child that self-exits unclaimed",
    "requires Windows PowerShell manager",
  ],
  [
    "exclusive launch-result failure stops only the unpublished child and preserves the colliding file",
    "requires Windows PowerShell manager",
  ],
  [
    "exclusive control publication failure gracefully stops the authenticated child and preserves the owner file",
    "requires Windows PowerShell manager",
  ],
  [
    "tampered launch-result HMAC is rejected while the unclaimed child self-exits",
    "requires Windows PowerShell manager",
  ],
  [
    "tampered authenticated control fails closed without touching an unrelated Node process",
    "requires Windows PowerShell manager",
  ],
  [
    "junction aliases share the real-project mutex and one control plane",
    "requires Windows PowerShell manager",
  ],
  [
    "a dead recorded instance cannot authorize shutdown of a new listener on its old port",
    "requires Windows PowerShell manager",
  ],
  [
    "failure receipt retains control and prevents Restart from creating a new writer",
    "requires Windows PowerShell manager",
  ],
  [
    "broad-write ACL and runtime junctions are rejected before process control",
    "requires Windows PowerShell manager",
  ],
  [
    "supervised runner contains descendants even when the direct child exits successfully",
    "requires Windows Job Object process supervision",
  ],
  [
    "a Windows child exit code of 125 is a process failure",
    "requires Windows Job Object process supervision",
  ],
  [
    "the clean payload starts, reports status, and stops through its trusted manager",
    "requires PowerShell manager availability",
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

export async function readBoundedEvidenceHandle(
  handle,
  expectedBytes,
  relativePath,
) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > MAXIMUM_EVIDENCE_BYTES
  ) {
    throw new Error(`acceptance evidence has an invalid size: ${relativePath}`);
  }
  const contents = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const length = Math.min(64 * 1024, expectedBytes - offset);
    const { bytesRead } = await handle.read(
      contents,
      offset,
      length,
      offset,
    );
    if (bytesRead === 0) {
      throw new Error(`acceptance evidence shrank while it was read: ${relativePath}`);
    }
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: appendedBytes } = await handle.read(
    probe,
    0,
    1,
    expectedBytes,
  );
  if (appendedBytes !== 0) {
    throw new Error(`acceptance evidence grew while it was read: ${relativePath}`);
  }
  return contents;
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

async function createSafeOutputAncestors(root, relativePath) {
  const snapshots = [];
  let ancestor = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    for (const snapshot of snapshots) {
      const current = await lstat(snapshot.absolutePath, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== snapshot.metadata.device ||
        current.ino !== snapshot.metadata.inode ||
        current.mode !== snapshot.metadata.mode
      ) {
        throw new Error(
          `manifest output path changed before directory creation: ${relativePath}`,
        );
      }
    }
    let metadata;
    try {
      metadata = await lstat(ancestor, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`manifest output path could not be inspected: ${relativePath}`);
      }
      try {
        await mkdir(ancestor);
        metadata = await lstat(ancestor, { bigint: true });
      } catch {
        throw new Error(`manifest output directory could not be created: ${relativePath}`);
      }
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

export function assertAcceptanceSourceTransition(started, finished, phase) {
  try {
    assertStableCleanRepository(started, finished);
  } catch {
    throw new Error(`acceptance source changed ${phase}`);
  }
}

async function removePublishedManifest(output, publishedIdentity) {
  let current;
  try {
    current = await lstat(output.absolutePath, { bigint: true });
  } catch {
    return;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    !sameMetadata(publishedIdentity, metadataSnapshot(current))
  ) {
    throw new Error("stale acceptance manifest could not be safely invalidated");
  }
  try {
    await unlink(output.absolutePath);
    await syncOutputDirectory(path.dirname(output.absolutePath));
  } catch {
    throw new Error("stale acceptance manifest could not be invalidated");
  }
}

async function syncOutputDirectory(directory) {
  let handle = null;
  try {
    handle = await open(directory, fileConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)
    ) {
      return;
    }
    throw new Error("acceptance manifest directory could not be synchronized");
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

async function publishManifest(root, output, manifest) {
  const outputAncestors = await createSafeOutputAncestors(
    root,
    output.relativePath,
  );
  const temporaryPath = path.join(
    path.dirname(output.absolutePath),
    `.${path.basename(output.absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle = null;
  let temporaryExists = false;
  let publishedIdentity = null;
  const contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(contents);
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
    const sourceBeforePublication = await captureRepositoryState(root);
    assertAcceptanceSourceTransition(
      manifest.source,
      sourceBeforePublication,
      "before publication",
    );
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
    publishedIdentity = metadataSnapshot(publishedMetadata);
    const published = await evidenceFile(root, output.relativePath);
    if (
      published.bytes !== contents.length ||
      !published.contents.equals(contents)
    ) {
      throw new Error(
        `acceptance manifest publication bytes changed: ${output.relativePath}`,
      );
    }
    await syncOutputDirectory(path.dirname(output.absolutePath));
    const sourceAfterPublication = await captureRepositoryState(root);
    assertAcceptanceSourceTransition(
      manifest.source,
      sourceAfterPublication,
      "after publication",
    );
  } catch (error) {
    if (publishedIdentity !== null) {
      await removePublishedManifest(output, publishedIdentity);
    }
    throw error;
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
      contents = await readBoundedEvidenceHandle(
        handle,
        Number(pathMetadata.size),
        resolved.relativePath,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("acceptance evidence ")) {
        throw error;
      }
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
      const allowedReason = ALLOWED_TEST_SKIPS.get(testCase.name);
      if (
        (allowedReason instanceof Set
          ? !allowedReason.has(testCase.reason)
          : allowedReason !== testCase.reason) ||
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

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function invalidReview() {
  throw new Error(
    "independent review report must be machine-readable Ready evidence",
  );
}

function validatedReview(
  file,
  declaredScope,
  validationReport,
  validationFile,
  generatedAt,
) {
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
    Date.parse(review.reviewedAt) > Date.parse(generatedAt) ||
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

function emptyTreeObjectId(headOid) {
  const algorithm = headOid.length === 40 ? "sha1" : "sha256";
  return createHash(algorithm)
    .update(Buffer.from("tree 0\0", "utf8"))
    .digest("hex");
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validationCommandLimits(name) {
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
      maxStderrBytes: DEFAULT_VALIDATION_LIMITS.maxStderrBytes,
    };
  }
  if (name === "open-source distribution suite") {
    return {
      timeoutMs: 10 * 60_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: DEFAULT_VALIDATION_LIMITS.maxStderrBytes,
    };
  }
  if (
    name === "configuration form browser behavior" ||
    name === "confirmation history browser behavior" ||
    name === "real Docker sandbox boundary"
  ) {
    return {
      ...DEFAULT_VALIDATION_LIMITS,
      timeoutMs: 10 * 60_000,
    };
  }
  return { ...DEFAULT_VALIDATION_LIMITS };
}

async function committedNodeTestFiles(root, headOid, syntaxFiles) {
  const directFiles = syntaxFiles.filter((relativePath) =>
    /^test\/[^/]+$/u.test(relativePath)
  );
  let u9PrioritySource = Buffer.alloc(0);
  if (directFiles.includes(u9PriorityTestPath)) {
    try {
      ({ stdout: u9PrioritySource } = await execFileAsync(
        "git",
        ["cat-file", "blob", `${headOid}:${u9PriorityTestPath}`],
        {
          cwd: root,
          encoding: "buffer",
          maxBuffer: 1024,
          windowsHide: true,
        },
      ));
    } catch {
      throw new Error("committed U9 priority test contents are invalid");
    }
  }
  return selectCommittedNodeTestFiles({ directFiles, u9PrioritySource });
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

function requiredStepContracts(
  syntaxFiles,
  nodeTestFiles,
  uiArguments,
  headOid,
  platform,
) {
  const hostIntegratedEnvironment = platform.startsWith("win32/")
    ? {
        APPDATA: "null-device",
        HOME: "null-device",
        USERPROFILE: "null-device",
      }
    : { APPDATA: "null-device" };
  return [
    {
      name: "git diff --check",
      limits: validationCommandLimits("git diff --check"),
      command: {
        executable: "git",
        arguments: [
          "diff",
          "--check",
          emptyTreeObjectId(headOid),
          headOid,
          "--",
        ],
      },
    },
    ...syntaxFiles.map((relativePath) => ({
      name: `syntax:${relativePath}`,
      limits: validationCommandLimits(`syntax:${relativePath}`),
      command: {
        executable: "node",
        arguments: ["--check", relativePath],
      },
    })),
    { name: "node syntax aggregate", kind: "aggregate" },
    {
      name: "complete Node test suite",
      limits: validationCommandLimits("complete Node test suite"),
      command: {
        executable: "node",
        arguments: [
          "--test",
          "--test-concurrency=4",
          "--test-reporter=tap",
          ...nodeTestFiles,
        ],
      },
      environment: hostIntegratedEnvironment,
    },
    {
      name: "open-source distribution suite",
      limits: validationCommandLimits("open-source distribution suite"),
      command: REQUIRED_COMMANDS.get("open-source distribution suite"),
      environment: hostIntegratedEnvironment,
    },
    {
      name: "configuration form browser behavior",
      limits: validationCommandLimits("configuration form browser behavior"),
      command: REQUIRED_COMMANDS.get("configuration form browser behavior"),
      environment: hostIntegratedEnvironment,
    },
    {
      name: "confirmation history browser behavior",
      limits: validationCommandLimits("confirmation history browser behavior"),
      command: REQUIRED_COMMANDS.get("confirmation history browser behavior"),
      environment: hostIntegratedEnvironment,
    },
    {
      name: "real Docker sandbox boundary",
      limits: validationCommandLimits("real Docker sandbox boundary"),
      command: REQUIRED_COMMANDS.get("real Docker sandbox boundary"),
      environment: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
    },
    {
      name: "live desktop and mobile UI behavior",
      limits: validationCommandLimits("live desktop and mobile UI behavior"),
      command: {
        executable: "node",
        arguments: ["scripts/validate-ui.mjs", ...uiArguments],
      },
      environment: hostIntegratedEnvironment,
    },
  ];
}

function validateReport(
  report,
  currentSource,
  committedRuntimeSource,
  syntaxFiles,
  nodeTestFiles,
  verifiedUiReceipt,
) {
  if (
    !hasExactKeys(report, [
      "finishedAt",
      "environment",
      "executionSource",
      "liveService",
      "node",
      "options",
      "platform",
      "runId",
      "schemaVersion",
      "source",
      "startedAt",
      "status",
      "steps",
      "uiArtifactReceipt",
    ]) ||
    report.schemaVersion !== 1 ||
    typeof report.node !== "string" ||
    report.node === "" ||
    typeof report.platform !== "string" ||
    report.platform === "" ||
    !hasExactKeys(report.options, ["withDocker", "withLiveUi"])
  ) {
    throw new Error("system validation report schema is invalid");
  }
  if (
    !hasExactKeys(report.environment, [
      "controlledVariables",
      "credentialVariablesInherited",
      "dependencyInstallationNetwork",
      "forbiddenVariables",
      "inheritedForbiddenVariables",
      "inheritedVariables",
      "isolatedVariables",
      "policy",
      "schemaVersion",
    ]) ||
    report.environment.schemaVersion !== 2 ||
    report.environment.policy !== "isolated-profile-allowlist-v2" ||
    JSON.stringify(report.environment.forbiddenVariables) !==
      JSON.stringify(["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE"]) ||
    !Array.isArray(report.environment.inheritedForbiddenVariables) ||
    report.environment.inheritedForbiddenVariables.length !== 0 ||
    !Array.isArray(report.environment.inheritedVariables) ||
    new Set(report.environment.inheritedVariables).size !==
      report.environment.inheritedVariables.length ||
    report.environment.inheritedVariables.some(
      (name) => !VALIDATION_INHERITED_VARIABLES.includes(name),
    ) ||
    JSON.stringify([...report.environment.inheritedVariables].sort()) !==
      JSON.stringify(report.environment.inheritedVariables) ||
    JSON.stringify(report.environment.isolatedVariables) !==
      JSON.stringify(VALIDATION_ISOLATED_VARIABLES) ||
    JSON.stringify(report.environment.controlledVariables) !==
      JSON.stringify(VALIDATION_CONTROLLED_VARIABLES) ||
    report.environment.credentialVariablesInherited !== false ||
    report.environment.dependencyInstallationNetwork !== "offline"
  ) {
    throw new Error("system validation environment contract is invalid");
  }
  if (
    typeof report.startedAt !== "string" ||
    typeof report.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(report.startedAt)) ||
    !Number.isFinite(Date.parse(report.finishedAt)) ||
    new Date(report.startedAt).toISOString() !== report.startedAt ||
    new Date(report.finishedAt).toISOString() !== report.finishedAt ||
    Date.parse(report.startedAt) > Date.parse(report.finishedAt)
  ) {
    throw new Error("system validation report chronology is invalid");
  }
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
  if (
    !hasExactKeys(report.executionSource, [
      "contentDigest",
      "dependencyInstallation",
      "dependencyLockDigest",
      "fileCount",
      "headOid",
      "schemaVersion",
      "sealed",
      "totalBytes",
      "treeOid",
    ]) ||
    report.executionSource.schemaVersion !== 1 ||
    report.executionSource.headOid !== report.source.finished.headOid ||
    report.executionSource.treeOid !== report.source.finished.treeOid ||
    report.executionSource.sealed !== true ||
    report.executionSource.dependencyInstallation !==
      "npm-ci-offline-ignore-scripts-v1" ||
    !SHA_256.test(report.executionSource.dependencyLockDigest) ||
    !SHA_256.test(report.executionSource.contentDigest) ||
    !Number.isSafeInteger(report.executionSource.fileCount) ||
    report.executionSource.fileCount <= 0 ||
    !Number.isSafeInteger(report.executionSource.totalBytes) ||
    report.executionSource.totalBytes <= 0
  ) {
    throw new Error("system validation execution source is invalid");
  }
  if (!Array.isArray(report.steps) || report.steps.length === 0) {
    throw new Error("system validation report has no command steps");
  }
  let uiArguments;
  try {
    if (
      !hasExactKeys(report.liveService, [
        "instanceId",
        "processId",
        "runtimeSource",
        "startIdentity",
      ]) ||
      !Number.isSafeInteger(report.liveService.processId) ||
      report.liveService.processId <= 0 ||
      !UUID_V4.test(report.liveService.instanceId) ||
      !SHA_256.test(report.liveService.startIdentity)
    ) {
      throw new Error("invalid live service");
    }
    uiArguments = uiValidationCommandArguments({
      runId: report.runId,
      liveService: report.liveService,
    });
    const runtimeSource = report.liveService.runtimeSource;
    if (
      runtimeSource.headOid !== report.source.finished.headOid ||
      runtimeSource.treeOid !== report.source.finished.treeOid ||
      runtimeSource.schemaVersion !== committedRuntimeSource.schemaVersion ||
      runtimeSource.headOid !== committedRuntimeSource.headOid ||
      runtimeSource.treeOid !== committedRuntimeSource.treeOid ||
      runtimeSource.clean !== committedRuntimeSource.clean ||
      runtimeSource.runtimeDigest !== committedRuntimeSource.runtimeDigest ||
      runtimeSource.runtimeFileCount !==
        committedRuntimeSource.runtimeFileCount ||
      runtimeSource.runtimeByteCount !== committedRuntimeSource.runtimeByteCount
    ) {
      throw new Error("live runtime source mismatch");
    }
  } catch {
    throw new Error("system validation live runtime identity is invalid");
  }
  if (
    !hasExactKeys(report.uiArtifactReceipt, ["envelope", "receipt"]) ||
    JSON.stringify(report.uiArtifactReceipt) !== JSON.stringify(verifiedUiReceipt)
  ) {
    throw new Error("system validation UI artifact receipt is invalid");
  }
  const uiCompletedAt = verifiedUiReceipt.receipt.completedAt;
  if (
    Date.parse(uiCompletedAt) < Date.parse(report.startedAt) ||
    Date.parse(uiCompletedAt) > Date.parse(report.finishedAt)
  ) {
    throw new Error("system validation UI completion chronology is invalid");
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
  const contracts = requiredStepContracts(
    syntaxFiles,
    nodeTestFiles,
    uiArguments,
    currentSource.headOid,
    report.platform,
  );
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
        : !hasExactKeys(actualEnvironment, Object.keys(expectedEnvironment)) ||
          Object.entries(expectedEnvironment).some(
            ([name, value]) => actualEnvironment[name] !== value,
          )
    ) {
      throw new Error("validation step environment does not match its contract");
    }
    if (contract.kind !== "aggregate") {
      const expectedLimits = contract.limits;
      if (
        !hasExactKeys(step.limits, [
          "maxStderrBytes",
          "maxStdoutBytes",
          "timeoutMs",
        ]) ||
        step.limits.timeoutMs !== expectedLimits.timeoutMs ||
        step.limits.maxStdoutBytes !== expectedLimits.maxStdoutBytes ||
        step.limits.maxStderrBytes !== expectedLimits.maxStderrBytes ||
        step.lifecycleErrorCode !== undefined
      ) {
        throw new Error(
          "validation command limits do not match their contract",
        );
      }
    }
  }
  for (const step of report.steps) {
    const usesRepositorySource =
      step?.name === "open-source distribution suite";
    const requiresExecutionSource =
      step?.name !== "git diff --check" && !usesRepositorySource;
    if (
      requiresExecutionSource
        ? step?.executionSourceDigest !== report.executionSource.contentDigest
        : step?.executionSourceDigest !== undefined
    ) {
      throw new Error("validation step is not bound to its immutable execution source");
    }
    if (
      usesRepositorySource
        ? !hasExactKeys(step.repositorySource, ["headOid", "treeOid"]) ||
          step.repositorySource.headOid !== currentSource.headOid ||
          step.repositorySource.treeOid !== currentSource.treeOid
        : step?.repositorySource !== undefined
    ) {
      throw new Error("validation step is not bound to its clean repository source");
    }
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
  const distributionStep = report.steps.find(
    ({ name }) => name === "open-source distribution suite",
  );
  const dockerStep = report.steps.find(
    ({ name }) => name === "real Docker sandbox boundary",
  );
  const uiStep = report.steps.find(
    ({ name }) => name === "live desktop and mobile UI behavior",
  );
  if (!testStep || !distributionStep || !dockerStep || !uiStep) {
    throw new Error("system validation omitted a mandatory acceptance command");
  }
  if (
    JSON.stringify(uiStep.artifactReceiptEnvelope) !==
    JSON.stringify(verifiedUiReceipt.envelope)
  ) {
    throw new Error("UI validation command did not return the accepted receipt");
  }
  for (const [name, command] of REQUIRED_COMMANDS) {
    const step = report.steps.find((candidate) => candidate.name === name);
    if (!commandMatches(step?.command, command)) {
      throw new Error("mandatory validation command does not match its contract");
    }
  }
  validateTestResults(testStep);
  validateTestResults(distributionStep);
}

export async function buildAcceptanceManifest({
  root,
  validationReportPath,
  reviewReports,
  generatedAt = new Date().toISOString(),
}) {
  const canonicalRoot = await canonicalRepositoryRoot(root);
  if (!isCanonicalTimestamp(generatedAt)) {
    throw new Error("acceptance manifest generation time is invalid");
  }
  if (!Array.isArray(reviewReports) || reviewReports.length !== 2) {
    throw new Error("at least two independent review reports are required");
  }
  const sourceBeforeEvidence = await captureRepositoryState(canonicalRoot);
  assertAcceptanceSourceTransition(
    sourceBeforeEvidence,
    sourceBeforeEvidence,
    "before evidence reads",
  );
  const validationFile = await evidenceFile(canonicalRoot, validationReportPath);
  let validationReport;
  try {
    validationReport = JSON.parse(validationFile.contents.toString("utf8"));
  } catch {
    throw new Error("system validation report is not valid JSON");
  }
  const committedRuntimeSource = await deriveCommittedRuntimeSourceIdentity({
    root: canonicalRoot,
    headOid: sourceBeforeEvidence.headOid,
    treeOid: sourceBeforeEvidence.treeOid,
  });
  if (
    UUID_V4.test(validationReport?.runId) &&
    validationFile.path !==
      `validation-artifacts/runs/${validationReport.runId}/system-validation.json`
  ) {
    throw new Error("system validation report path does not match its run identity");
  }
  const syntaxFiles = await committedSyntaxFiles(
    canonicalRoot,
    sourceBeforeEvidence.headOid,
  );
  const nodeTestFiles = await committedNodeTestFiles(
    canonicalRoot,
    sourceBeforeEvidence.headOid,
    syntaxFiles,
  );
  let verifiedUiReceipt;
  try {
    verifiedUiReceipt = await verifyUiArtifactReceipt({
      root: canonicalRoot,
      envelope: validationReport.uiArtifactReceipt?.envelope,
      expectedRunId: validationReport.runId,
      expectedLiveService: validationReport.liveService,
    });
  } catch {
    throw new Error("system validation UI artifact receipt is invalid");
  }
  validateReport(
    validationReport,
    sourceBeforeEvidence,
    committedRuntimeSource,
    syntaxFiles,
    nodeTestFiles,
    verifiedUiReceipt,
  );
  if (Date.parse(generatedAt) < Date.parse(validationReport.finishedAt)) {
    throw new Error("acceptance manifest chronology is invalid");
  }

  const artifacts = [];
  for (const expected of verifiedUiReceipt.receipt.artifacts) {
    const artifact = await evidenceFile(canonicalRoot, expected.path);
    if (
      artifact.path !== expected.path ||
      artifact.bytes !== expected.bytes ||
      artifact.sha256 !== expected.sha256
    ) {
      throw new Error("acceptance UI artifact no longer matches its receipt");
    }
    artifacts.push(artifact);
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
      generatedAt,
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
  const sourceAfterEvidence = await captureRepositoryState(canonicalRoot);
  assertAcceptanceSourceTransition(
    sourceBeforeEvidence,
    sourceAfterEvidence,
    "after evidence reads",
  );

  return {
    schemaVersion: 1,
    runId: validationReport.runId,
    generatedAt,
    status: "passed",
    reviewEvidencePolicy: REVIEW_EVIDENCE_POLICY,
    source: sourceBeforeEvidence,
    validation: {
      runId: validationReport.runId,
      path: validationFile.path,
      sha256: validationFile.sha256,
      bytes: validationFile.bytes,
      startedAt: validationReport.startedAt,
      finishedAt: validationReport.finishedAt,
      node: validationReport.node,
      platform: validationReport.platform,
      environment: structuredClone(validationReport.environment),
      options: validationReport.options,
      executionSource: structuredClone(validationReport.executionSource),
      liveService: structuredClone(validationReport.liveService),
      uiArtifactReceipt: structuredClone(validationReport.uiArtifactReceipt),
      steps: structuredClone(validationReport.steps),
    },
    artifacts: artifacts.map(({ contents: _contents, ...artifact }) => artifact),
    reviews,
  };
}

export async function writeAcceptanceManifest({ outputPath = null, ...options }) {
  const root = await canonicalRepositoryRoot(options.root);
  const manifest = await buildAcceptanceManifest({ ...options, root });
  const requestedOutput = outputPath ??
    `validation-artifacts/runs/${manifest.runId}/system-acceptance-manifest.json`;
  const output = relativeFile(root, requestedOutput);
  await assertSafeOutputAncestors(root, output.relativePath);
  await publishManifest(root, output, manifest);
  return manifest;
}

function commandLineOptions(arguments_) {
  let validationReportPath = null;
  const reviews = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (
      arguments_[index] === "--validation-report" &&
      index + 1 < arguments_.length &&
      validationReportPath === null
    ) {
      validationReportPath = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (arguments_[index] !== "--review" || index + 1 >= arguments_.length) {
      throw new Error(
        "usage: system-acceptance-manifest.mjs --validation-report <path> --review <scope>=<path> --review <scope>=<path>",
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
  if (validationReportPath === null) {
    throw new Error("validation report path is required");
  }
  return { validationReportPath, reviews };
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const options = commandLineOptions(process.argv.slice(2));
  const manifest = await writeAcceptanceManifest({
    root: process.cwd(),
    validationReportPath: options.validationReportPath,
    reviewReports: options.reviews,
  });
  process.stdout.write(
    `acceptance manifest written for run ${manifest.runId} at ` +
      `validation-artifacts/runs/${manifest.runId}/system-acceptance-manifest.json\n`,
  );
}
