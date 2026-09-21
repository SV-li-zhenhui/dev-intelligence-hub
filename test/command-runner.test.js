import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/lib/command-runner.js";

async function waitForProcessMarker(marker) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number(await readFile(marker, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("child process did not publish its marker");
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

test("runCommand passes an explicit environment without mutating the parent", async () => {
  const key = "MY_DASHBOARD_COMMAND_RUNNER_ENV_TEST";
  const original = process.env[key];
  const expected = "explicit-child-value";

  const output = await runCommand(
    process.execPath,
    ["-e", `process.stdout.write(process.env.${key} || "missing")`],
    { env: { ...process.env, [key]: expected } },
  );

  assert.equal(output, expected);
  assert.equal(process.env[key], original);
});

test("runCommand rejects a pre-aborted request without spawning", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "command-runner-aborted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "spawned.txt");
  const controller = new AbortController();
  controller.abort(new Error("shutdown requested"));

  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
      ],
      { signal: controller.signal },
    ),
    (error) => error?.code === "COMMAND_ABORTED" && error?.name === "AbortError",
  );
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

test("runCommand aborts an active child and rejects only after it closes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "command-runner-active-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "pid.txt");
  const controller = new AbortController();
  const running = runCommand(
    process.execPath,
    [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    { timeoutMs: 10_000, signal: controller.signal },
  );
  const processId = await waitForProcessMarker(marker);

  controller.abort(new Error("shutdown requested"));
  await assert.rejects(running, { code: "COMMAND_ABORTED" });
  assert.equal(processExists(processId), false);
});

test("runCommand timeout reaps the child before reporting failure", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "command-runner-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "pid.txt");
  const running = runCommand(
    process.execPath,
    [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    { timeoutMs: 500 },
  );
  const processId = await waitForProcessMarker(marker);

  await assert.rejects(running, { code: "COMMAND_TIMEOUT" });
  assert.equal(processExists(processId), false);
});
