import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { terminateProcessTree } from "../src/lib/managed-process.js";
import {
  createTestSupervisedProcessRunner,
  SupervisedProcessRunner,
} from "../src/lib/supervised-process-runner.js";

const WINDOWS_JOB_OBJECT_SKIP = process.platform !== "win32"
  ? "requires Windows Job Object process supervision"
  : false;

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitForMarker(marker, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readFile(marker, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(10, remainingMs)),
      );
    }
  }
  throw new Error("supervised child did not publish its marker");
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(processId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(processId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function inertChild(processId = 424_242) {
  const child = new EventEmitter();
  child.pid = processId;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  return child;
}

function testExecutable(command = process.execPath) {
  return Object.freeze({
    command,
    prefixArgs: Object.freeze([]),
  });
}

function testRunner(overrides = {}) {
  return createTestSupervisedProcessRunner({
    descriptorMaterializer: async (descriptor) => descriptor,
    ...overrides,
  });
}

function request(cwd, script, overrides = {}) {
  return {
    executable: testExecutable(),
    args: ["-e", script],
    cwd,
    env: {},
    input: Buffer.alloc(0),
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    ...overrides,
  };
}

test("supervised runner delivers only the explicit cwd, environment, and stdin", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-io-");
  const runner = testRunner();
  const secretParentKey = "MYDASHBOARD_SUPERVISED_PARENT_SECRET";
  const original = process.env[secretParentKey];
  process.env[secretParentKey] = "must-not-be-inherited";
  t.after(() => {
    if (original === undefined) delete process.env[secretParentKey];
    else process.env[secretParentKey] = original;
  });

  const result = await runner.run(request(
    directory,
    `let input = "";
     process.stdin.setEncoding("utf8");
     process.stdin.on("data", (chunk) => { input += chunk; });
     process.stdin.on("end", () => process.stdout.write(JSON.stringify({
       cwd: process.cwd(),
       allowed: process.env.RUNNER_ALLOWED,
       inherited: process.env.${secretParentKey} || null,
       input,
     })));`,
    {
      env: { RUNNER_ALLOWED: "explicit-child-value" },
      input: Buffer.from("bounded request", "utf8"),
    },
  ));

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: path.resolve(directory),
    allowed: "explicit-child-value",
    inherited: null,
    input: "bounded request",
  });
  assert.equal(process.env[secretParentKey], "must-not-be-inherited");
});

test("supervised runner rejects a pre-aborted request without spawning", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-pre-abort-");
  const marker = path.join(directory, "spawned.txt");
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));

  await assert.rejects(
    testRunner().run(request(
      directory,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
      { signal: controller.signal },
    )),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("private cancellation reason"),
  );
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

test("descriptor verification is bounded by the request timeout", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-verify-timeout-");
  let activeMaterializers = 0;
  let spawnCalls = 0;
  const runner = testRunner({
    descriptorMaterializer: async (_descriptor, { signal }) => {
      activeMaterializers += 1;
      try {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      } finally {
        activeMaterializers -= 1;
      }
    },
    spawnImpl() {
      spawnCalls += 1;
      return inertChild();
    },
    platform: "linux",
  });
  const guarded = Promise.race([
    runner.run(request(directory, "", { timeoutMs: 20 })),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("descriptor verification escaped its deadline")),
      500,
    )),
  ]);

  await assert.rejects(
    guarded,
    (error) => error?.code === "STRUCTURED_PROVIDER_TIMEOUT",
  );
  assert.equal(activeMaterializers, 0);
  assert.equal(spawnCalls, 0);
});

test("cancellation before the verification microtask never calls the materializer", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-verify-race-");
  const controller = new AbortController();
  let materializerCalls = 0;
  let spawnCalls = 0;
  const runner = testRunner({
    descriptorMaterializer: async (descriptor) => {
      materializerCalls += 1;
      return descriptor;
    },
    spawnImpl() {
      spawnCalls += 1;
      return inertChild();
    },
  });

  const running = runner.run(request(directory, "", {
    signal: controller.signal,
  }));
  controller.abort(new Error("private immediate cancellation"));

  await assert.rejects(
    running,
    (error) => error?.code === "STRUCTURED_PROVIDER_CANCELLED",
  );
  assert.equal(materializerCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("cancellation during descriptor verification prevents spawn", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-verify-abort-");
  const controller = new AbortController();
  let releaseVerification;
  let verificationStarted;
  const entered = new Promise((resolve) => {
    verificationStarted = resolve;
  });
  let spawnCalls = 0;
  const runner = testRunner({
    descriptorMaterializer: async () => {
      verificationStarted();
      return new Promise((resolve) => {
        releaseVerification = resolve;
      });
    },
    spawnImpl() {
      spawnCalls += 1;
      const child = inertChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    treeTerminator: async () => {},
    platform: "linux",
  });
  const running = runner.run(request(directory, "", {
    signal: controller.signal,
    timeoutMs: 5_000,
  }));
  await entered;

  controller.abort(new Error("private abort detail"));
  releaseVerification(testExecutable());

  await assert.rejects(
    running,
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("private abort detail"),
  );
  assert.equal(spawnCalls, 0);
});

test("a synchronously slow spawn cannot receive a second timeout budget", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-spawn-deadline-");
  let child;
  let zeroTimerFired = false;
  let zeroTimerFiredAtTermination = null;
  const runner = testRunner({
    platform: "linux",
    spawnImpl() {
      const blockedUntil = Date.now() + 80;
      while (Date.now() < blockedUntil) {
        // Deliberately model a synchronously slow process launch.
      }
      child = inertChild(515_151);
      setTimeout(() => {
        zeroTimerFired = true;
      }, 0);
      return child;
    },
    treeTerminator: async () => {
      zeroTimerFiredAtTermination = zeroTimerFired;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    },
  });

  await assert.rejects(
    runner.run(request(directory, "", { timeoutMs: 20 })),
    (error) => error?.code === "STRUCTURED_PROVIDER_TIMEOUT",
  );
  assert.equal(zeroTimerFiredAtTermination, false);
});

test("supervised runner aborts an active child only after reaping it", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-abort-");
  const marker = path.join(directory, "pid.txt");
  const controller = new AbortController();
  const running = testRunner().run(request(
    directory,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
     setInterval(() => {}, 1_000);`,
    { signal: controller.signal, timeoutMs: 10_000 },
  ));
  const processId = Number(await waitForMarker(marker));

  controller.abort(new Error("operator secret"));
  await assert.rejects(
    running,
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("operator secret"),
  );
  assert.equal(processExists(processId), false);
});

test("supervised runner timeout reaps the complete process tree", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-timeout-");
  const marker = path.join(directory, "pids.json");
  const running = testRunner().run(request(
    directory,
    `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
     require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
     setInterval(() => {}, 1_000);`,
    // The full suite starts thousands of tests in parallel on Windows. Give the
    // real Node parent enough admission/startup time to publish both PIDs; this
    // test is about timeout tree reaping, not sub-second process launch latency.
    { timeoutMs: 5_000 },
  ));
  const timedOut = assert.rejects(running, {
    code: "STRUCTURED_PROVIDER_TIMEOUT",
  });
  const processIds = JSON.parse(await waitForMarker(marker));

  await timedOut;
  for (const processId of processIds) assert.equal(processExists(processId), false);
});

test("supervised runner enforces stdout and stderr byte limits", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-output-");
  const runner = testRunner();
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(
      runner.run(request(
        directory,
        `process.${stream}.write("x".repeat(2_048));`,
      )),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_OUTPUT_LIMIT" &&
        !error.message.includes("xxxx"),
      stream,
    );
  }
});

test("supervised runner distinguishes and redacts a clean nonzero exit", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-redaction-");
  const runner = testRunner({
    platform: "linux",
    treeTerminator: async () => ({ status: "completed" }),
  });
  const secret = "nonzero-secret-must-not-escape";

  await assert.rejects(
    runner.run(request(
      directory,
      `const privateValue = ${JSON.stringify(secret)}; process.exit(privateValue ? 7 : 0);`,
    )),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_PROCESS_EXITED" &&
      !error.message.includes(secret) &&
      !JSON.stringify(error).includes(secret),
  );

  const missing = path.join(directory, "private-command-name.exe");
  await assert.rejects(
    runner.run(request(directory, "", {
      executable: testExecutable(missing),
    })),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
      !error.message.includes(missing),
  );
});

test("supervised runner converts stdout and stderr stream failures into redacted failures", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-stream-error-");
  const privateCanary = "private-stream-error-canary";

  for (const streamName of ["stdout", "stderr"]) {
    let child;
    const runner = testRunner({
      spawnImpl() {
        child = inertChild();
        // Keeps the RED fixture itself alive when the implementation has no handler.
        child[streamName].on("error", () => {});
        queueMicrotask(() => {
          child[streamName].emit("error", new Error(privateCanary));
          child.emit("close", 0, null);
        });
        return child;
      },
      treeTerminator: async () => {},
      platform: "linux",
      terminationTimeoutMs: 20,
    });

    await assert.rejects(
      runner.run(request(directory, "")),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_PROCESS_FAILED" &&
        !error.message.includes(privateCanary) &&
        !JSON.stringify(error).includes(privateCanary),
      streamName,
    );
  }
});

test("supervised runner has a hard reap deadline when termination never closes the child", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-reap-deadline-");

  for (const treeTerminator of [
    async () => {},
    async () => new Promise(() => {}),
  ]) {
    const runner = testRunner({
      spawnImpl: () => inertChild(),
      treeTerminator,
      platform: "linux",
      terminationTimeoutMs: 20,
    });
    const outcome = Promise.race([
      runner.run(request(directory, "", {
        timeoutMs: 5,
      })),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("runner remained pending past its hard deadline")),
        500,
      )),
    ]);

    await assert.rejects(
      outcome,
      (error) => error?.code === "STRUCTURED_PROVIDER_REAP_FAILED",
    );
  }
});

test("supervised runner contains descendants even when the direct child exits successfully", {
  skip: WINDOWS_JOB_OBJECT_SKIP,
}, async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-success-tree-");
  const marker = path.join(directory, "descendant-pid.txt");
  const descendantScript = "setInterval(() => {}, 1000)";
  const parentScript = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    writeFileSync(${JSON.stringify(marker)}, String(child.pid));
  `;

  await testRunner().run(request(
    directory,
    parentScript,
    { timeoutMs: 5_000 },
  ));
  const descendantPid = Number(await waitForMarker(marker));
  t.after(async () => {
    if (!processExists(descendantPid)) return;
    await terminateProcessTree(descendantPid, {
      platform: "win32",
      timeoutMs: 2_000,
    }).catch(() => {});
  });

  assert.equal(await waitForProcessExit(descendantPid), true);
});

test("a Windows child exit code of 125 is a process failure", {
  skip: WINDOWS_JOB_OBJECT_SKIP,
}, async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-exit-125-");

  await assert.rejects(
    testRunner().run(request(directory, "process.exit(125)")),
    (error) => error?.code === "STRUCTURED_PROVIDER_PROCESS_FAILED",
  );
});

test("production process supervision rejects arbitrary commands and dependency replacement", async (t) => {
  const directory = await temporaryDirectory(t, "supervised-runner-identity-");
  assert.throws(
    () => new SupervisedProcessRunner({ spawnImpl() {} }),
    /production.*dependencies|arguments/i,
  );

  await assert.rejects(
    new SupervisedProcessRunner().run(request(
      directory,
      'process.stdout.write("must-not-run")',
    )),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});
