import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeRuntimeSourceIdentity } from "../src/lib/runtime-source-identity.js";
import { verifyLiveDashboard } from "./system-live-validation.mjs";
import {
  prepareValidationRunDirectory,
  uiValidationCommandArguments,
  verifyUiArtifactReceipt,
} from "./system-ui-artifact-receipt.mjs";
import {
  createValidationSourceMaterialization,
} from "./system-validation-materialization.mjs";
import {
  assertStableCleanRepository,
  captureRepositoryState,
} from "./system-validation-provenance.mjs";

const root = path.resolve(import.meta.dirname, "..");
const argumentsSet = new Set(process.argv.slice(2));
const all = argumentsSet.has("--all");
const withDocker = all || argumentsSet.has("--with-docker");
const withLiveUi = all || argumentsSet.has("--with-live-ui");
const knownArguments = new Set(["--all", "--with-docker", "--with-live-ui"]);
const unknownArguments = [...argumentsSet].filter(
  (argument) => !knownArguments.has(argument),
);

if (unknownArguments.length > 0) {
  throw new Error(`unknown validation option: ${unknownArguments.join(", ")}`);
}

const report = {
  schemaVersion: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  options: { withDocker, withLiveUi },
  source: {
    started: null,
    finished: null,
    stable: false,
  },
  liveService: null,
  uiArtifactReceipt: null,
  executionSource: null,
  steps: [],
};
const validationRunDirectory = await prepareValidationRunDirectory({
  root,
  runId: report.runId,
});
let executionSource = null;

function commandLabel(command, arguments_) {
  return [command, ...arguments_].join(" ");
}

function emptyTreeObjectId(headOid) {
  const algorithm = headOid.length === 40 ? "sha1" : "sha256";
  return createHash(algorithm)
    .update(Buffer.from("tree 0\0", "utf8"))
    .digest("hex");
}

function sanitizedPathToken(value) {
  if (!path.isAbsolute(value)) return value.replaceAll("\\", "/");
  const relative = path.relative(root, value);
  if (relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..") {
    return relative.replaceAll("\\", "/");
  }
  return `<external:${path.basename(value)}>`;
}

function commandRecord(command, arguments_) {
  const npmExecutable = process.env.npm_execpath;
  if (
    command === process.execPath &&
    npmExecutable &&
    arguments_[0] === npmExecutable
  ) {
    return {
      executable: "npm",
      arguments: arguments_.slice(1).map(sanitizedPathToken),
    };
  }
  if (/^npm(?:\.cmd)?$/iu.test(command)) {
    return {
      executable: "npm",
      arguments: arguments_.map(sanitizedPathToken),
    };
  }
  return {
    executable: command === process.execPath
      ? "node"
      : sanitizedPathToken(command),
    arguments: arguments_.map(sanitizedPathToken),
  };
}

function run(command, arguments_, {
  name = commandLabel(command, arguments_),
  environment = process.env,
  environmentEvidence = null,
  quiet = false,
  parseOutput = null,
  outputField = "testResults",
  workingDirectory = root,
  recordedCommand = null,
  executionSourceDigest = null,
} = {}) {
  const startedAt = Date.now();
  process.stdout.write(`\n[validate] ${name}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: workingDirectory,
      env: environment,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    if (quiet) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const step = {
        name,
        command: recordedCommand === null
          ? commandRecord(command, arguments_)
          : structuredClone(recordedCommand),
        status: code === 0 && signal === null ? "passed" : "failed",
        durationMs,
        exitCode: code,
        signal,
        ...(executionSourceDigest === null
          ? {}
          : { executionSourceDigest }),
        ...(environmentEvidence === null
          ? {}
          : { environment: structuredClone(environmentEvidence) }),
      };
      let outputError = null;
      if (parseOutput !== null && code === 0 && signal === null) {
        try {
          step[outputField] = parseOutput(stdoutText);
        } catch (error) {
          outputError = error;
          step.status = "failed";
        }
      }
      report.steps.push(step);
      if (step.status === "passed") {
        process.stdout.write(`[validate] passed in ${durationMs} ms\n`);
        resolve({
          parsedOutput: parseOutput === null ? null : step[outputField],
          stderr: stderrText,
          stdout: stdoutText,
          step,
        });
        return;
      }
      const diagnostic = `${stdoutText}${stderrText}`.slice(-8_000);
      if (diagnostic) process.stderr.write(`${diagnostic}\n`);
      reject(outputError ?? new Error(
        `${name} failed with exit code ${String(code)}`,
      ));
    });
  });
}

async function runFromExecutionSource(command, arguments_, options = {}) {
  if (executionSource === null) {
    throw new Error("immutable validation source is unavailable");
  }
  await executionSource.verify();
  let outcome;
  let commandError = null;
  try {
    outcome = await run(command, arguments_, {
      ...options,
      workingDirectory:
        options.workingDirectory ?? executionSource.directory,
      executionSourceDigest: executionSource.identity.contentDigest,
    });
  } catch (error) {
    commandError = error;
  }
  try {
    await executionSource.verify();
  } catch (error) {
    throw error;
  }
  if (commandError !== null) throw commandError;
  return outcome;
}

function parseUiArtifactReceiptEnvelope(output) {
  const lines = output.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error("UI validation did not emit one artifact receipt envelope");
  }
  try {
    const envelope = JSON.parse(lines[0]);
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("invalid envelope");
    }
    return envelope;
  } catch {
    throw new Error("UI validation emitted an invalid artifact receipt envelope");
  }
}

function parseNodeTestTap(output) {
  const summary = {};
  const cases = [];
  const summaryNames = new Map([
    ["tests", "tests"],
    ["pass", "passed"],
    ["fail", "failed"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
    ["todo", "todo"],
  ]);
  for (const line of output.split(/\r?\n/u)) {
    const summaryMatch = line.match(
      /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u,
    );
    if (summaryMatch) {
      summary[summaryNames.get(summaryMatch[1])] = Number(summaryMatch[2]);
      continue;
    }
    const caseMatch = line.match(/^\s*(not )?ok \d+ - (.+)$/u);
    if (!caseMatch) continue;
    const directiveMatch = caseMatch[2].match(
      /^(.*?)(?:\s+#\s+(SKIP|TODO)(?:\s+(.*))?)?$/iu,
    );
    const name = directiveMatch[1];
    const directive = directiveMatch[2]?.toUpperCase() ?? null;
    const identity = `tap:${cases.length + 1}:${name}`;
    if (directive === "SKIP") {
      cases.push({
        identity,
        name,
        status: "skipped",
        ...(directiveMatch[3] ? { reason: directiveMatch[3] } : {}),
      });
    } else if (directive === "TODO") {
      cases.push({
        identity,
        name,
        status: "todo",
        ...(directiveMatch[3] ? { reason: directiveMatch[3] } : {}),
      });
    } else {
      cases.push({
        identity,
        name,
        status: caseMatch[1] ? "failed" : "passed",
      });
    }
  }
  for (const field of summaryNames.values()) {
    if (!Number.isSafeInteger(summary[field])) {
      throw new Error(`complete Node test suite omitted TAP ${field} summary`);
    }
  }
  return { summary, cases };
}

async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(entryPath));
    } else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function checkSyntax() {
  const directories = ["src", "public", "scripts", "test", "test-support"];
  const files = (
    await Promise.all(directories.map((directory) =>
      sourceFiles(path.join(executionSource.directory, directory))
    ))
  ).flat().sort();
  const startedAt = Date.now();
  process.stdout.write(`\n[validate] node syntax (${files.length} files)\n`);
  for (const file of files) {
    const relativePath = path.relative(executionSource.directory, file)
      .replaceAll("\\", "/");
    await runFromExecutionSource(process.execPath, ["--check", relativePath], {
      name: `syntax:${relativePath}`,
      quiet: true,
    });
  }
  report.steps.push({
    name: "node syntax aggregate",
    kind: "aggregate",
    status: "passed",
    durationMs: Date.now() - startedAt,
    fileCount: files.length,
    executionSourceDigest: executionSource.identity.contentDigest,
  });
}

async function verifyCurrentLiveDashboard() {
  const runtime = await computeRuntimeSourceIdentity(root);
  return verifyLiveDashboard({
    baseUrl: "http://127.0.0.1:4173",
    expectedRuntimeSource: {
      schemaVersion: 1,
      headOid: report.source.started.headOid,
      treeOid: report.source.started.treeOid,
      clean: true,
      runtimeDigest: runtime.digest,
      runtimeFileCount: runtime.fileCount,
      runtimeByteCount: runtime.byteCount,
    },
  });
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(validationRunDirectory.directory, "system-validation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

let validationError = null;
try {
  report.source.started = await captureRepositoryState(root);
  assertStableCleanRepository(report.source.started, report.source.started);
  executionSource = await createValidationSourceMaterialization({
    root,
    headOid: report.source.started.headOid,
    treeOid: report.source.started.treeOid,
  });
  report.executionSource = executionSource.identity;
  await run("git", [
    "diff",
    "--check",
    emptyTreeObjectId(report.source.started.headOid),
    report.source.started.headOid,
    "--",
  ], { name: "git diff --check" });
  await checkSyntax();
  await runFromExecutionSource(process.execPath, [
    "--test",
    "--test-reporter=tap",
    "test/*.test.js",
  ], {
    name: "complete Node test suite",
    quiet: true,
    parseOutput: parseNodeTestTap,
  });
  await runFromExecutionSource(process.execPath, [
    "test/browser/configuration-form-playwright.mjs",
  ], { name: "configuration form browser behavior" });
  await runFromExecutionSource(process.execPath, [
    "test/browser/confirmation-history-playwright.mjs",
  ], { name: "confirmation history browser behavior" });
  if (withDocker) {
    await runFromExecutionSource(process.execPath, [
      "--test",
      "test/docker-test-sandbox.integration.test.js",
    ], {
      name: "real Docker sandbox boundary",
      environment: {
        ...process.env,
        MYDASHBOARD_DOCKER_INTEGRATION: "1",
      },
      environmentEvidence: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
    });
  }
  if (withLiveUi) {
    report.liveService = await verifyCurrentLiveDashboard();
    const uiArguments = uiValidationCommandArguments({
      runId: report.runId,
      liveService: report.liveService,
    });
    const uiRun = await runFromExecutionSource(process.execPath, [
      path.join(executionSource.directory, "scripts/validate-ui.mjs"),
      ...uiArguments,
    ], {
      name: "live desktop and mobile UI behavior",
      quiet: true,
      parseOutput: parseUiArtifactReceiptEnvelope,
      outputField: "artifactReceiptEnvelope",
      workingDirectory: root,
      recordedCommand: {
        executable: "node",
        arguments: ["scripts/validate-ui.mjs", ...uiArguments],
      },
    });
    try {
      report.uiArtifactReceipt = await verifyUiArtifactReceipt({
        root,
        envelope: uiRun.parsedOutput,
        expectedRunId: report.runId,
        expectedLiveService: report.liveService,
      });
    } catch (error) {
      uiRun.step.status = "failed";
      throw error;
    }
  }
} catch (error) {
  validationError = error;
}

try {
  report.source.finished = await captureRepositoryState(root);
  if (report.source.started !== null) {
    assertStableCleanRepository(
      report.source.started,
      report.source.finished,
    );
    report.source.stable = true;
  }
} catch (error) {
  report.source.error = error instanceof Error ? error.message : String(error);
  validationError ??= error;
}

if (executionSource !== null) {
  try {
    await executionSource.verify();
  } catch (error) {
    validationError ??= error;
  }
  try {
    await executionSource.cleanup();
  } catch (error) {
    validationError ??= new Error("immutable validation source cleanup failed", {
      cause: error,
    });
  }
}

if (validationError === null) {
  report.status = "passed";
} else {
  report.status = "failed";
  report.error = validationError instanceof Error
    ? validationError.message
    : String(validationError);
  process.exitCode = 1;
}
await writeReport();
process.stdout.write(
  `\n[validate] report: ${validationRunDirectory.relativeDirectory}/system-validation.json\n`,
);

if (report.status === "passed") {
  process.stdout.write("\n[validate] whole-system validation passed\n");
} else {
  process.stderr.write(`\n[validate] ${report.error}\n`);
}
