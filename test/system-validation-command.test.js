import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runBoundedValidationCommand,
} from "../scripts/system-validation-command.mjs";

async function waitForProcessMarker(marker) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return Number(await readFile(marker, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("validation child did not publish its process marker");
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

function options(overrides = {}) {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 10_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    ...overrides,
  };
}

test("bounded validation waits for closed output streams", async () => {
  const expected = "x".repeat(256 * 1024);
  const result = await runBoundedValidationCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(256 * 1024))"],
    options(),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, "");
});

test("bounded validation reaps a timed-out process tree", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "validation-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "pid.txt");
  const running = runBoundedValidationCommand(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    options({ timeoutMs: 500 }),
  );
  const processId = await waitForProcessMarker(marker);

  await assert.rejects(running, { code: "VALIDATION_COMMAND_TIMEOUT" });
  assert.equal(processExists(processId), false);
});

test("bounded validation reaps a process that exceeds output limits", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "validation-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "pid.txt");
  const running = runBoundedValidationCommand(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)`,
    ],
    options({ maxStdoutBytes: 1024 }),
  );
  const processId = await waitForProcessMarker(marker);

  await assert.rejects(running, { code: "VALIDATION_COMMAND_OUTPUT_LIMIT" });
  assert.equal(processExists(processId), false);
});
