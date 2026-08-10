import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyTestRunnerResult,
  discoverTestFiles,
  PRIORITY_TEST_ENTRY_FILE,
  PRIORITY_TEST_FILE,
  orderTestFiles,
  runTestSuite,
  testRunnerOptions,
} from "./run-test-suite.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const standaloneEnvironment = { ...process.env };
delete standaloneEnvironment.NODE_TEST_CONTEXT;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForCondition(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`${description} within ${timeoutMs}ms`);
}

function terminateOwnedProcess(pid) {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function forceTerminateScheduler(pid) {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGKILL");
    return;
  }
  const result = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `scheduler termination failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("the complete suite starts U9 first without dropping or duplicating tests", () => {
  const discovered = [
    "work-coordination-service.test.js",
    PRIORITY_TEST_FILE,
    "action-admission-gate.test.js",
  ];

  const ordered = orderTestFiles(discovered);

  assert.equal(ordered[0], PRIORITY_TEST_ENTRY_FILE);
  assert.equal(ordered.includes(PRIORITY_TEST_FILE), false);
  assert.deepEqual(
    ordered
      .map((file) =>
        file === PRIORITY_TEST_ENTRY_FILE ? PRIORITY_TEST_FILE : file
      )
      .sort((left, right) => left.localeCompare(right, "en")),
    [...discovered].sort((left, right) => left.localeCompare(right, "en")),
  );
  assert.equal(new Set(ordered).size, discovered.length);
  assert.deepEqual(testRunnerOptions(ordered, path.join("root", "test")), {
    concurrency: 4,
    cwd: "root",
    files: ordered.map((file) => path.join("test", file)),
  });
});

test("the complete suite refuses an ambiguous or missing priority target", () => {
  assert.throws(
    () => orderTestFiles(["one.test.js", "one.test.js", PRIORITY_TEST_FILE]),
    /unique/u,
  );
  assert.throws(
    () => orderTestFiles(["one.test.js", "two.test.js"]),
    /priority/u,
  );
});

test("the scheduler includes every discovered test exactly once and invokes concurrency four", async () => {
  const independentlyDiscovered = readdirSync(testDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => entry.name);
  const discovered = discoverTestFiles(testDirectory);
  const ordered = orderTestFiles(discovered);
  const represented = ordered.map((file) =>
    file === PRIORITY_TEST_ENTRY_FILE ? PRIORITY_TEST_FILE : file
  );

  assert.deepEqual(
    [...discovered].sort((left, right) => left.localeCompare(right, "en")),
    [...independentlyDiscovered].sort((left, right) =>
      left.localeCompare(right, "en")
    ),
  );
  assert.equal(ordered[0], PRIORITY_TEST_ENTRY_FILE);
  assert.equal(discovered.includes("test-suite-runner.test.js"), true);
  assert.equal(ordered.includes(PRIORITY_TEST_FILE), false);
  assert.equal(
    represented.filter((file) => file === PRIORITY_TEST_FILE).length,
    1,
  );
  assert.deepEqual(
    [...represented].sort((left, right) => left.localeCompare(right, "en")),
    [...discovered].sort((left, right) => left.localeCompare(right, "en")),
  );
  assert.equal(
    readFileSync(path.join(testDirectory, PRIORITY_TEST_ENTRY_FILE), "utf8")
      .trim(),
    `import "./${PRIORITY_TEST_FILE}";`,
  );

  let invocation;
  const pending = runTestSuite({
    runTests(options) {
      invocation = options;
      const stream = new EventEmitter();
      stream.compose = () => Readable.from([]);
      return stream;
    },
    testDirectory,
  });

  assert.deepEqual(await pending, { code: 0, signal: null });
  assert.deepEqual(invocation, testRunnerOptions(ordered, testDirectory));
  assert.equal(
    JSON.stringify(invocation).match(
      /(?:timeout|testNamePatterns|only|testSkipPatterns)/gu,
    ),
    null,
  );
  assert.equal(
    invocation.files.some((file) => path.isAbsolute(file)),
    false,
  );
});

test("a deep checkout stays out of the aggregate test command vector", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "scheduler-deep-checkout-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const projectDirectory = path.join(
    root,
    "controlled-depth-segment-000000000001",
    "controlled-depth-segment-000000000002",
    "controlled-depth-segment-000000000003",
  );
  const deepTestDirectory = path.join(projectDirectory, "test");
  mkdirSync(deepTestDirectory, { recursive: true });

  const intendedTests = readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => entry.name);
  for (const file of intendedTests) {
    writeFileSync(path.join(deepTestDirectory, file), "");
  }
  writeFileSync(path.join(deepTestDirectory, PRIORITY_TEST_ENTRY_FILE), "");
  writeFileSync(
    path.join(deepTestDirectory, "run-test-suite.mjs"),
    readFileSync(path.join(testDirectory, "run-test-suite.mjs")),
  );

  const ordered = orderTestFiles(intendedTests);
  const absoluteVector = [
    "--test",
    "--test-concurrency=4",
    ...ordered.map((file) => path.join(deepTestDirectory, file)),
  ];
  assert.ok(absoluteVector.join(" ").length > 32_767);

  const result = spawnSync(
    process.execPath,
    [path.join(deepTestDirectory, "run-test-suite.mjs")],
    {
      encoding: "utf8",
      env: standaloneEnvironment,
      windowsHide: true,
    },
  );

  assert.equal(
    result.status,
    0,
    `deep scheduler failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
});

test("terminating the scheduler leaves no owned runner or grandchild", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "scheduler-lifecycle-"));
  const fixtureTestDirectory = path.join(root, "test");
  const readyPath = path.join(root, "owned-processes.json");
  mkdirSync(fixtureTestDirectory, { recursive: true });
  writeFileSync(
    path.join(fixtureTestDirectory, PRIORITY_TEST_ENTRY_FILE),
    "",
  );
  writeFileSync(path.join(fixtureTestDirectory, PRIORITY_TEST_FILE), "");
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const grandchildPath = path.join(
    testDirectory,
    "fixtures",
    "scheduler-owned-grandchild.mjs",
  );
  writeFileSync(
    path.join(fixtureTestDirectory, "owned-process.test.js"),
    readFileSync(
      path.join(testDirectory, "fixtures", "scheduler-owned-process.mjs"),
    ),
  );

  const schedulerProcess = spawn(
    process.execPath,
    [
      path.join(testDirectory, "scheduler-lifecycle-host.mjs"),
      fixtureTestDirectory,
    ],
    {
      env: {
        ...standaloneEnvironment,
        SCHEDULER_GRANDCHILD_PATH: grandchildPath,
        SCHEDULER_READY_PATH: readyPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let schedulerStderr = "";
  schedulerProcess.stderr.setEncoding("utf8");
  schedulerProcess.stderr.on("data", (chunk) => {
    schedulerStderr += chunk;
  });
  let owned;
  t.after(() => {
    for (const pid of [
      owned?.grandchildPid,
      owned?.workerPid,
      owned?.runnerPid,
      schedulerProcess.pid,
    ]) {
      terminateOwnedProcess(pid);
    }
    rmSync(root, { force: true, recursive: true });
  });

  try {
    await waitForCondition(
      () => {
        try {
          owned = JSON.parse(readFileSync(readyPath, "utf8"));
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      },
      "owned process fixture did not reach the vulnerable interval",
    );
  } catch (error) {
    error.message += `\nscheduler stderr:\n${schedulerStderr}`;
    throw error;
  }
  assert.equal(isProcessAlive(owned.runnerPid), true);
  assert.equal(isProcessAlive(owned.workerPid), true);
  assert.equal(isProcessAlive(owned.grandchildPid), true);

  forceTerminateScheduler(schedulerProcess.pid);
  await waitForCondition(
    () => schedulerProcess.exitCode !== null || schedulerProcess.signalCode !== null,
    "scheduler did not terminate",
  );
  await waitForCondition(
    () => !isProcessAlive(owned.runnerPid) &&
      !isProcessAlive(owned.workerPid) &&
      !isProcessAlive(owned.grandchildPid),
    "owned runner process chain survived scheduler termination",
  );
  assert.equal(
    owned.runnerPid,
    schedulerProcess.pid,
    "the scheduler must be the aggregate runner instead of wrapping one",
  );
});

test("the scheduler propagates aggregate failures and process results", async () => {
  const failedResult = runTestSuite({
    runTests() {
      const stream = new EventEmitter();
      stream.compose = () => Readable.from([]);
      queueMicrotask(() => stream.emit("test:fail"));
      return stream;
    },
    testDirectory,
  });
  assert.deepEqual(await failedResult, { code: 1, signal: null });

  const exitTarget = {
    exitCode: undefined,
    kill() {
      assert.fail("an ordinary exit must not signal the scheduler");
    },
    pid: 41,
  };
  applyTestRunnerResult({ code: 23, signal: null }, exitTarget);
  assert.equal(exitTarget.exitCode, 23);

  const signalCalls = [];
  const signalTarget = {
    exitCode: undefined,
    kill(pid, signal) {
      signalCalls.push({ pid, signal });
    },
    pid: 42,
  };
  applyTestRunnerResult({ code: null, signal: "SIGTERM" }, signalTarget);
  assert.equal(signalTarget.exitCode, undefined);
  assert.deepEqual(signalCalls, [{ pid: 42, signal: "SIGTERM" }]);
});

test("the scheduler exposes child exit and signal failures through a real process", () => {
  const schedulerUrl = pathToFileURL(
    path.join(testDirectory, "run-test-suite.mjs"),
  ).href;
  const runResultProcess = (result) => {
    const source = [
      `import { applyTestRunnerResult } from ${JSON.stringify(schedulerUrl)};`,
      `applyTestRunnerResult(${JSON.stringify(result)});`,
    ].join("\n");
    return spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { encoding: "utf8", windowsHide: true },
    );
  };

  const failed = runResultProcess({ code: 23, signal: null });
  assert.equal(failed.error, undefined);
  assert.equal(failed.status, 23);
  assert.equal(failed.signal, null);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "");

  const signalled = runResultProcess({ code: null, signal: "SIGTERM" });
  assert.equal(signalled.error, undefined);
  assert.equal(signalled.stdout, "");
  assert.equal(signalled.stderr, "");
  if (process.platform === "win32") {
    assert.equal(signalled.status, 1);
    assert.equal(signalled.signal, null);
  } else {
    assert.equal(signalled.status, null);
    assert.equal(signalled.signal, "SIGTERM");
  }
});
