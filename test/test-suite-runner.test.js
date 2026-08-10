import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyTestRunnerResult,
  discoverTestFiles,
  PRIORITY_TEST_ENTRY_FILE,
  PRIORITY_TEST_FILE,
  orderTestFiles,
  runTestSuite,
  testRunnerArguments,
  waitForExit,
} from "./run-test-suite.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

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
  assert.deepEqual(testRunnerArguments(ordered), [
    "--test",
    "--test-concurrency=4",
    ...ordered,
  ]);
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
  const independentlyDiscovered = globSync("*.test.js", { cwd: testDirectory });
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

  const child = new EventEmitter();
  let invocation;
  const pending = runTestSuite({
    spawnProcess(executable, args, options) {
      invocation = { executable, args, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    testDirectory,
  });

  assert.deepEqual(await pending, { code: 0, signal: null });
  const expectedPaths = ordered.map((file) => path.join(testDirectory, file));
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [
    "--test",
    "--test-concurrency=4",
    ...expectedPaths,
  ]);
  assert.deepEqual(invocation.options, {
    cwd: path.dirname(testDirectory),
    stdio: "inherit",
    windowsHide: true,
  });
  assert.equal(
    invocation.args.some((argument) =>
      /(?:timeout|test-name-pattern|test-only|test-skip)/u.test(argument)
    ),
    false,
  );
});

test("the scheduler propagates child errors, exit codes, and signals", async () => {
  const exited = new EventEmitter();
  const exitResult = waitForExit(exited);
  exited.emit("exit", 23, null);
  assert.deepEqual(await exitResult, { code: 23, signal: null });

  const signalled = new EventEmitter();
  const signalResult = waitForExit(signalled);
  signalled.emit("exit", null, "SIGTERM");
  assert.deepEqual(await signalResult, { code: null, signal: "SIGTERM" });

  const failed = new EventEmitter();
  const spawnFailure = new Error("spawn failed");
  const failedResult = waitForExit(failed);
  failed.emit("error", spawnFailure);
  await assert.rejects(failedResult, (error) => error === spawnFailure);

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
