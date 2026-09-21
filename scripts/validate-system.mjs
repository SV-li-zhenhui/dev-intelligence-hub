import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
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
  prepareIsolatedValidationEnvironment,
  VALIDATION_CONTROLLED_VARIABLES,
  VALIDATION_ISOLATED_VARIABLES,
} from "./system-validation-environment.mjs";
import {
  distributionTestPath,
  selectCommittedNodeTestFiles,
  u9PriorityTestPath,
} from "./system-node-test-contract.mjs";
import {
  runBoundedValidationCommand,
} from "./system-validation-command.mjs";
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
const forbiddenNodeEnvironmentVariables = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_V8_COVERAGE",
]);
const inheritedForbiddenNodeEnvironmentVariables =
  forbiddenNodeEnvironmentVariables.filter((name) =>
    Object.hasOwn(process.env, name)
  );
let validationEnvironment = null;
const defaultCommandLimits = Object.freeze({
  timeoutMs: 120_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
});
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
  environment: {
    schemaVersion: 2,
    policy: "isolated-profile-allowlist-v2",
    inheritedVariables: [],
    isolatedVariables: [...VALIDATION_ISOLATED_VARIABLES],
    controlledVariables: [...VALIDATION_CONTROLLED_VARIABLES],
    credentialVariablesInherited: false,
    dependencyInstallationNetwork: "offline",
    forbiddenVariables: [...forbiddenNodeEnvironmentVariables],
    inheritedForbiddenVariables: [
      ...inheritedForbiddenNodeEnvironmentVariables,
    ],
  },
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
const hostIntegratedEnvironmentEvidence = Object.freeze(
  process.platform === "win32"
    ? {
        APPDATA: "null-device",
        HOME: "null-device",
        USERPROFILE: "null-device",
      }
    : { APPDATA: "null-device" },
);
const validationRunDirectory = await prepareValidationRunDirectory({
  root,
  runId: report.runId,
});
let executionSource = null;
let validationEnvironmentContext = null;

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

async function run(command, arguments_, {
  name = commandLabel(command, arguments_),
  environment = validationEnvironment,
  environmentEvidence = null,
  quiet = false,
  parseOutput = null,
  parseOutputOnFailure = false,
  outputField = "testResults",
  workingDirectory = root,
  recordedCommand = null,
  executionSourceDigest = null,
  repositorySource = null,
  timeoutMs = defaultCommandLimits.timeoutMs,
  maxStdoutBytes = defaultCommandLimits.maxStdoutBytes,
  maxStderrBytes = defaultCommandLimits.maxStderrBytes,
} = {}) {
  const startedAt = Date.now();
  process.stdout.write(`\n[validate] ${name}\n`);
  let commandResult;
  let lifecycleError = null;
  try {
    commandResult = await runBoundedValidationCommand(command, arguments_, {
      cwd: workingDirectory,
      env: environment,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    });
  } catch (error) {
    lifecycleError = error;
    commandResult = {
      exitCode: error?.exitCode ?? null,
      signal: error?.signal ?? null,
      stderr: error?.stderr ?? "",
      stdout: error?.stdout ?? "",
    };
  }
  const durationMs = Date.now() - startedAt;
  const { exitCode, signal, stderr: stderrText, stdout: stdoutText } =
    commandResult;
  if (!quiet) {
    if (stdoutText) process.stdout.write(stdoutText);
    if (stderrText) process.stderr.write(stderrText);
  }
  const commandSucceeded = lifecycleError === null &&
    exitCode === 0 && signal === null;
  const step = {
    name,
    command: recordedCommand === null
      ? commandRecord(command, arguments_)
      : structuredClone(recordedCommand),
    status: commandSucceeded ? "passed" : "failed",
    durationMs,
    exitCode,
    signal,
    limits: { timeoutMs, maxStdoutBytes, maxStderrBytes },
    ...(lifecycleError?.code
      ? { lifecycleErrorCode: lifecycleError.code }
      : {}),
    ...(executionSourceDigest === null
      ? {}
      : { executionSourceDigest }),
    ...(repositorySource === null
      ? {}
      : { repositorySource: structuredClone(repositorySource) }),
    ...(environmentEvidence === null
      ? {}
      : { environment: structuredClone(environmentEvidence) }),
  };
  let outputError = null;
  if (parseOutput !== null && (commandSucceeded || parseOutputOnFailure)) {
    try {
      step[outputField] = parseOutput(stdoutText);
    } catch (error) {
      if (commandSucceeded) {
        outputError = error;
        step.status = "failed";
      }
    }
  }
  report.steps.push(step);
  if (step.status === "passed") {
    process.stdout.write(`[validate] passed in ${durationMs} ms\n`);
    return {
      parsedOutput: parseOutput === null ? null : step[outputField],
      stderr: stderrText,
      stdout: stdoutText,
      step,
    };
  }
  if (quiet) {
    const diagnostic = `${stdoutText}${stderrText}`.slice(-8_000);
    if (diagnostic) process.stderr.write(`${diagnostic}\n`);
  }
  throw outputError ?? lifecycleError ?? new Error(
    `${name} failed with exit code ${String(exitCode)}`,
  );
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

async function runFromRepositorySource(command, arguments_, options = {}) {
  if (report.source.started === null) {
    throw new Error("repository validation source is unavailable");
  }
  const verifyRepositorySource = async () => {
    const current = await captureRepositoryState(root, {
      environment: validationEnvironment,
    });
    assertStableCleanRepository(report.source.started, current);
  };
  await verifyRepositorySource();
  let outcome;
  let commandError = null;
  try {
    outcome = await run(command, arguments_, {
      ...options,
      workingDirectory: root,
      repositorySource: {
        headOid: report.source.started.headOid,
        treeOid: report.source.started.treeOid,
      },
    });
  } catch (error) {
    commandError = error;
  }
  await verifyRepositorySource();
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

async function immutableNodeTestFiles(directory) {
  const entries = await readdir(path.join(directory, "test"), {
    withFileTypes: true,
  });
  const directFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => `test/${entry.name}`);
  const u9PrioritySource = directFiles.includes(u9PriorityTestPath)
    ? await readFile(path.join(directory, u9PriorityTestPath))
    : Buffer.alloc(0);
  return selectCommittedNodeTestFiles({ directFiles, u9PrioritySource });
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
  await executionSource.verify();
  let syntaxError = null;
  try {
    for (const file of files) {
      const relativePath = path.relative(executionSource.directory, file)
        .replaceAll("\\", "/");
      await run(process.execPath, ["--check", relativePath], {
        name: `syntax:${relativePath}`,
        quiet: true,
        workingDirectory: executionSource.directory,
        executionSourceDigest: executionSource.identity.contentDigest,
      });
    }
  } catch (error) {
    syntaxError = error;
  }
  await executionSource.verify();
  if (syntaxError !== null) throw syntaxError;
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
  if (executionSource === null) {
    throw new Error("immutable validation source is unavailable");
  }
  const runtime = await computeRuntimeSourceIdentity(executionSource.directory);
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

function validationHostIntegratedEnvironment() {
  if (validationEnvironment === null) {
    throw new Error("isolated validation environment is unavailable");
  }
  const environment = {
    ...validationEnvironment,
    APPDATA: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  if (process.platform === "win32") {
    environment.HOME = "C:\\NUL";
    environment.USERPROFILE = "C:\\NUL";
  }
  return Object.freeze(environment);
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
  if (inheritedForbiddenNodeEnvironmentVariables.length > 0) {
    throw new Error(
      "forbidden Node execution environment: " +
        inheritedForbiddenNodeEnvironmentVariables.join(", "),
    );
  }
  validationEnvironmentContext = await prepareIsolatedValidationEnvironment({
    playwrightBrowsersPath: path.join(root, "data", "playwright-browsers"),
  });
  validationEnvironment = validationEnvironmentContext.environment;
  report.environment = {
    ...validationEnvironmentContext.evidence,
    forbiddenVariables: [...forbiddenNodeEnvironmentVariables],
    inheritedForbiddenVariables: [
      ...inheritedForbiddenNodeEnvironmentVariables,
    ],
  };
  report.source.started = await captureRepositoryState(root, {
    environment: validationEnvironment,
  });
  assertStableCleanRepository(report.source.started, report.source.started);
  executionSource = await createValidationSourceMaterialization({
    root,
    headOid: report.source.started.headOid,
    treeOid: report.source.started.treeOid,
    environment: validationEnvironment,
    dependencyCacheDirectory:
      validationEnvironmentContext.dependencyCacheDirectory,
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
  const nodeTestFiles = await immutableNodeTestFiles(executionSource.directory);
  await runFromExecutionSource(process.execPath, [
    "--test",
    "--test-concurrency=4",
    "--test-reporter=tap",
    ...nodeTestFiles,
  ], {
    name: "complete Node test suite",
    environment: validationHostIntegratedEnvironment(),
    environmentEvidence: hostIntegratedEnvironmentEvidence,
    quiet: true,
    parseOutput: parseNodeTestTap,
    parseOutputOnFailure: true,
    timeoutMs: 15 * 60_000,
    maxStdoutBytes: 32 * 1024 * 1024,
    maxStderrBytes: 8 * 1024 * 1024,
  });
  await runFromRepositorySource(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    distributionTestPath,
  ], {
    name: "open-source distribution suite",
    environment: validationHostIntegratedEnvironment(),
    environmentEvidence: hostIntegratedEnvironmentEvidence,
    quiet: true,
    parseOutput: parseNodeTestTap,
    parseOutputOnFailure: true,
    timeoutMs: 10 * 60_000,
    maxStdoutBytes: 8 * 1024 * 1024,
  });
  await runFromExecutionSource(process.execPath, [
    "test/browser/configuration-form-playwright.mjs",
  ], {
    name: "configuration form browser behavior",
    environment: validationHostIntegratedEnvironment(),
    environmentEvidence: hostIntegratedEnvironmentEvidence,
    timeoutMs: 10 * 60_000,
  });
  await runFromExecutionSource(process.execPath, [
    "test/browser/confirmation-history-playwright.mjs",
  ], {
    name: "confirmation history browser behavior",
    environment: validationHostIntegratedEnvironment(),
    environmentEvidence: hostIntegratedEnvironmentEvidence,
    timeoutMs: 10 * 60_000,
  });
  if (withDocker) {
    await runFromExecutionSource(process.execPath, [
      "--test",
      "test/docker-test-sandbox.integration.test.js",
    ], {
      name: "real Docker sandbox boundary",
      environment: {
        ...validationEnvironment,
        MYDASHBOARD_DOCKER_INTEGRATION: "1",
      },
      environmentEvidence: { MYDASHBOARD_DOCKER_INTEGRATION: "1" },
      timeoutMs: 10 * 60_000,
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
      environment: validationHostIntegratedEnvironment(),
      environmentEvidence: hostIntegratedEnvironmentEvidence,
      quiet: true,
      parseOutput: parseUiArtifactReceiptEnvelope,
      outputField: "artifactReceiptEnvelope",
      timeoutMs: 10 * 60_000,
      maxStdoutBytes: 1024 * 1024,
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
  report.source.finished = await captureRepositoryState(root, {
    environment: validationEnvironment ?? undefined,
  });
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

if (validationEnvironmentContext !== null) {
  try {
    await validationEnvironmentContext.cleanup();
  } catch (error) {
    validationError ??= new Error("isolated validation environment cleanup failed", {
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
