import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

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
