import { spawn } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "validation-artifacts");
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
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  options: { withDocker, withLiveUi },
  steps: [],
};

function commandLabel(command, arguments_) {
  return [command, ...arguments_].join(" ");
}

function run(command, arguments_, {
  name = commandLabel(command, arguments_),
  environment = process.env,
  quiet = false,
} = {}) {
  const startedAt = Date.now();
  process.stdout.write(`\n[validate] ${name}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
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
      const step = {
        name,
        status: code === 0 && signal === null ? "passed" : "failed",
        durationMs,
        exitCode: code,
        signal,
      };
      report.steps.push(step);
      if (step.status === "passed") {
        process.stdout.write(`[validate] passed in ${durationMs} ms\n`);
        resolve();
        return;
      }
      const diagnostic = Buffer.concat([...stdout, ...stderr])
        .toString("utf8")
        .slice(-8_000);
      if (diagnostic) process.stderr.write(`${diagnostic}\n`);
      reject(new Error(`${name} failed with exit code ${String(code)}`));
    });
  });
}

function npmCommand(arguments_) {
  if (process.env.npm_execpath) {
    return [process.execPath, [process.env.npm_execpath, ...arguments_]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", arguments_];
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
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
      sourceFiles(path.join(root, directory)),
    ))
  ).flat().sort();
  const startedAt = Date.now();
  process.stdout.write(`\n[validate] node syntax (${files.length} files)\n`);
  for (const file of files) {
    await run(process.execPath, ["--check", file], {
      name: `syntax:${path.relative(root, file).replaceAll("\\", "/")}`,
      quiet: true,
    });
  }
  report.steps.push({
    name: "node syntax aggregate",
    status: "passed",
    durationMs: Date.now() - startedAt,
    fileCount: files.length,
  });
}

async function requireLiveDashboard() {
  const response = await fetch("http://127.0.0.1:4173/api/health", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`live dashboard health returned HTTP ${response.status}`);
  }
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(artifacts, "system-validation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

try {
  await run("git", ["diff", "--check"], { name: "git diff --check" });
  await checkSyntax();
  const [npmExecutable, npmArguments] = npmCommand(["test"]);
  await run(npmExecutable, npmArguments, { name: "complete Node test suite" });
  await run(process.execPath, [
    "test/browser/configuration-form-playwright.mjs",
  ], { name: "configuration form browser behavior" });
  await run(process.execPath, [
    "test/browser/confirmation-history-playwright.mjs",
  ], { name: "confirmation history browser behavior" });
  if (withDocker) {
    await run(process.execPath, [
      "--test",
      "test/docker-test-sandbox.integration.test.js",
    ], {
      name: "real Docker sandbox boundary",
      environment: {
        ...process.env,
        MYDASHBOARD_DOCKER_INTEGRATION: "1",
      },
    });
  }
  if (withLiveUi) {
    await requireLiveDashboard();
    await run(process.execPath, ["scripts/validate-ui.mjs"], {
      name: "live desktop and mobile UI behavior",
    });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeReport();
}

if (report.status === "passed") {
  process.stdout.write("\n[validate] whole-system validation passed\n");
} else {
  process.stderr.write(`\n[validate] ${report.error}\n`);
}
