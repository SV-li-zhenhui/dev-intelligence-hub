import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertStableCleanRepository,
  captureRepositoryState,
} from "./system-validation-provenance.mjs";

const REQUIRED_ARTIFACTS = new Set([
  "validation-artifacts/desktop-1440.png",
  "validation-artifacts/mobile-390.png",
  "validation-artifacts/results.json",
]);

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

async function evidenceFile(root, filePath) {
  const resolved = relativeFile(root, filePath);
  const metadata = await lstat(resolved.absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`acceptance evidence is not a regular file: ${resolved.relativePath}`);
  }
  const contents = await readFile(resolved.absolutePath);
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
    fields.some((field) => !Number.isSafeInteger(summary?.[field])) ||
    !Array.isArray(cases)
  ) {
    throw new Error("complete Node test results are incomplete");
  }
  if (summary.failed !== 0 || summary.cancelled !== 0 || summary.todo !== 0) {
    throw new Error("complete Node test results are not release-clean");
  }
  if (summary.tests !== summary.passed + summary.skipped) {
    throw new Error("complete Node test result counts are inconsistent");
  }
  if (
    cases.length < summary.tests ||
    cases.some(({ name, status }) =>
      typeof name !== "string" ||
      name === "" ||
      !["passed", "skipped", "failed", "todo"].includes(status)
    )
  ) {
    throw new Error("complete Node test identities are incomplete");
  }
}

function validateReport(report, currentSource) {
  if (report?.status !== "passed") {
    throw new Error("system validation report is not passed");
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
  for (const step of report.steps) {
    if (step?.kind === "aggregate") {
      if (
        step.status !== "passed" ||
        !Number.isSafeInteger(step.durationMs) ||
        !Number.isSafeInteger(step.fileCount)
      ) {
        throw new Error("system validation contains an invalid aggregate result");
      }
      continue;
    }
    if (
      step?.status !== "passed" ||
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
  validateTestResults(testStep);
}

export async function buildAcceptanceManifest({
  root,
  validationReportPath,
  artifactPaths,
  reviewReports,
  generatedAt = new Date().toISOString(),
}) {
  const canonicalRoot = path.resolve(root);
  if (!Array.isArray(reviewReports) || reviewReports.length < 2) {
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
  validateReport(validationReport, currentSource);

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
    scopes.add(review.scope);
    reviewPaths.add(file.path);
    reviews.push({
      scope: review.scope,
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt,
    status: "passed",
    source: currentSource,
    validation: {
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
  const root = path.resolve(options.root);
  const output = relativeFile(root, outputPath);
  const manifest = await buildAcceptanceManifest({ ...options, root });
  await mkdir(path.dirname(output.absolutePath), { recursive: true });
  await writeFile(
    output.absolutePath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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
