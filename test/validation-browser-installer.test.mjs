import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  runValidationBrowserInstallerCommand,
} from "../scripts/validation-browser-installer-command.mjs";

const execute = promisify(execFile);

async function waitForProcessMarker(marker) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return Number(await readFile(marker, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("browser installer child did not publish its process marker");
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

test("validation browser installer targets project data and headless shell", async () => {
  const { stdout } = await execute(process.execPath, [
    "scripts/install-validation-browser.mjs",
    "--dry-run",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });

  assert.match(stdout, /chromium-headless-shell/u);
  assert.equal(
    stdout.toLowerCase().includes(
      path.join(process.cwd(), "data", "playwright-browsers").toLowerCase(),
    ),
    true,
  );
});

test("validation browser installer reaps a child that exceeds its deadline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-installer-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "pid.txt");
  const running = runValidationBrowserInstallerCommand(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 500,
    },
  );
  const processId = await waitForProcessMarker(marker);

  await assert.rejects(running, { code: "VALIDATION_COMMAND_TIMEOUT" });
  assert.equal(processExists(processId), false);
});
