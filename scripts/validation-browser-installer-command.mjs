import { runBoundedValidationCommand } from "./system-validation-command.mjs";

const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000;
const INSTALLER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function runValidationBrowserInstallerCommand(command, arguments_, {
  cwd,
  env,
  timeoutMs = INSTALLER_TIMEOUT_MS,
  maxStdoutBytes = INSTALLER_MAX_OUTPUT_BYTES,
  maxStderrBytes = INSTALLER_MAX_OUTPUT_BYTES,
} = {}) {
  return runBoundedValidationCommand(command, arguments_, {
    cwd,
    env,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
  });
}
