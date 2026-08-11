import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedArguments = new Set(["--dry-run", "--force", "--no-progress"]);
const forwardedArguments = process.argv.slice(2);
if (forwardedArguments.some((argument) => !allowedArguments.has(argument))) {
  throw new Error("unsupported validation browser install argument");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");
const browserDirectory = path.join(root, "data", "playwright-browsers");
const require = createRequire(import.meta.url);
const playwrightDirectory = path.dirname(require.resolve("playwright/package.json"));
const playwrightCli = path.join(playwrightDirectory, "cli.js");
const cliStats = await stat(playwrightCli);
if (!cliStats.isFile()) throw new Error("Playwright CLI is unavailable");

process.stdout.write(`Validation browser directory: ${browserDirectory}\n`);
const child = spawn(process.execPath, [
  playwrightCli,
  "install",
  ...forwardedArguments,
  "chromium-headless-shell",
], {
  cwd: root,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
  },
  stdio: "inherit",
  windowsHide: true,
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`validation browser installer exited by ${signal}`));
      return;
    }
    resolve(code);
  });
});
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
