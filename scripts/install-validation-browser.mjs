import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runValidationBrowserInstallerCommand } from "./validation-browser-installer-command.mjs";

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
try {
  const result = await runValidationBrowserInstallerCommand(
    process.execPath,
    [playwrightCli, "install", ...forwardedArguments, "chromium-headless-shell"],
    {
      cwd: root,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
      },
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.signal !== null) {
    throw new Error(`validation browser installer exited by ${result.signal}`);
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
} catch (error) {
  if (typeof error?.stdout === "string") process.stdout.write(error.stdout);
  if (typeof error?.stderr === "string") process.stderr.write(error.stderr);
  throw error;
}
