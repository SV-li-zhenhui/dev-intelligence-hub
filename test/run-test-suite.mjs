import { globSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { finished } from "node:stream/promises";
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

export function testRunnerOptions(orderedFiles, testDirectory) {
  const cwd = path.dirname(testDirectory);
  return {
    concurrency: 4,
    cwd,
    files: orderedFiles.map((file) =>
      path.relative(cwd, path.join(testDirectory, file))
    ),
  };
}

export function applyTestRunnerResult(result, targetProcess = process) {
  if (result.signal !== null) {
    targetProcess.kill(targetProcess.pid, result.signal);
    return;
  }
  targetProcess.exitCode = result.code;
}

export async function runTestSuite({
  output = process.stdout,
  runTests = run,
  testDirectory = defaultTestDirectory,
} = {}) {
  const discovered = discoverTestFiles(testDirectory);
  const ordered = orderTestFiles(discovered);
  const testStream = runTests(testRunnerOptions(ordered, testDirectory));
  let code = 0;
  testStream.on("test:fail", () => {
    code = 1;
  });
  const reporterStream = testStream.compose(tap);
  reporterStream.pipe(output, { end: false });
  await finished(reporterStream);
  return { code, signal: null };
}

const invokedDirectly = process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) applyTestRunnerResult(await runTestSuite());
