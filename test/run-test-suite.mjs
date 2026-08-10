import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRIORITY_TEST_FILE = "u9-mirrored-pr-end-to-end.test.js";
export const PRIORITY_TEST_ENTRY_FILE = "00-u9-priority.mjs";
const defaultTestDirectory = path.dirname(fileURLToPath(import.meta.url));

export function discoverTestFiles(testDirectory = defaultTestDirectory) {
  return globSync("*.test.js", { cwd: testDirectory });
}

export function orderTestFiles(discovered) {
  if (
    !Array.isArray(discovered) ||
    discovered.some((file) =>
      typeof file !== "string" ||
      file !== path.basename(file) ||
      !file.endsWith(".test.js")
    )
  ) {
    throw new TypeError("discovered test files are invalid");
  }
  if (new Set(discovered).size !== discovered.length) {
    throw new Error("discovered test files must be unique");
  }
  if (!discovered.includes(PRIORITY_TEST_FILE)) {
    throw new Error("the U9 priority test file is missing");
  }
  const sorted = [...discovered].sort((left, right) =>
    left.localeCompare(right, "en")
  );
  return [
    PRIORITY_TEST_ENTRY_FILE,
    ...sorted.filter((file) => file !== PRIORITY_TEST_FILE),
  ];
}

export function testRunnerArguments(orderedFiles) {
  return ["--test", "--test-concurrency=4", ...orderedFiles];
}

export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.removeListener("exit", onExit);
      reject(error);
    };
    const onExit = (code, signal) => {
      child.removeListener("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function applyTestRunnerResult(result, targetProcess = process) {
  if (result.signal !== null) {
    targetProcess.kill(targetProcess.pid, result.signal);
    return;
  }
  targetProcess.exitCode = result.code;
}

export async function runTestSuite({
  spawnProcess = spawn,
  testDirectory = defaultTestDirectory,
} = {}) {
  const projectDirectory = path.dirname(testDirectory);
  const discovered = discoverTestFiles(testDirectory);
  const ordered = orderTestFiles(discovered).map((file) =>
    path.join(testDirectory, file)
  );
  const child = spawnProcess(process.execPath, testRunnerArguments(ordered), {
    cwd: projectDirectory,
    stdio: "inherit",
    windowsHide: true,
  });
  return waitForExit(child);
}

const invokedDirectly = process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) applyTestRunnerResult(await runTestSuite());
