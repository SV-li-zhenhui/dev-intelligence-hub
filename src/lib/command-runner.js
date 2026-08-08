import { spawn } from "node:child_process";
import { normalizeAbortSignal } from "./structured-provider-request.js";

export class CommandError extends Error {
  constructor(command, code, stderr) {
    super(`${command} failed with exit code ${code}: ${stderr.trim()}`);
    this.name = "CommandError";
    this.code = code;
  }
}

function lifecycleError(command, code, message, cause) {
  const error = new Error(
    `${command} ${message}`,
    cause instanceof Error ? { cause } : undefined,
  );
  error.name = code === "COMMAND_ABORTED" ? "AbortError" : "CommandTimeoutError";
  error.code = code;
  return error;
}

function abortError(command, signal) {
  return lifecycleError(
    command,
    "COMMAND_ABORTED",
    "was aborted",
    signal?.reason,
  );
}

function timeoutError(command, timeoutMs) {
  return lifecycleError(
    command,
    "COMMAND_TIMEOUT",
    `timed out after ${timeoutMs} ms`,
  );
}

export function runCommand(
  command,
  args,
  { timeoutMs = 60_000, env = process.env, signal = null } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  signal = normalizeAbortSignal(signal);
  if (signal?.aborted) return Promise.reject(abortError(command, signal));

  return new Promise((resolve, reject) => {
    const invocation =
      process.platform === "win32" && command === "dws"
        ? {
            command: "C:\\Program Files\\nodejs\\node.exe",
            args: [
              `${env.APPDATA}\\npm\\node_modules\\dingtalk-workspace-cli\\bin\\dws.js`,
              ...args,
            ],
          }
        : { command, args };
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    let processError = null;
    let terminalError = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (operation, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const terminate = (error) => {
      if (terminalError || settled) return;
      terminalError = error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGKILL");
      } catch (killError) {
        terminalError = new AggregateError(
          [error, killError],
          `${command} could not be terminated`,
        );
        terminalError.code = error.code;
      }
    };
    const onAbort = () => terminate(abortError(command, signal));

    const timer = setTimeout(() => {
      terminate(timeoutError(command, timeoutMs));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      processError ||= error;
    });
    child.on("close", (code) => {
      if (terminalError) {
        settle(reject, terminalError);
        return;
      }
      if (processError) {
        settle(reject, processError);
        return;
      }
      if (code !== 0) {
        settle(reject, new CommandError(command, code, stderr));
        return;
      }
      settle(resolve, stdout);
    });
  });
}

export async function runJson(command, args, options) {
  const output = await runCommand(command, args, options);
  const start = Math.min(
    ...["{", "["]
      .map((character) => output.indexOf(character))
      .filter((index) => index >= 0),
  );
  if (!Number.isFinite(start)) {
    throw new Error(`${command} returned no JSON`);
  }
  return JSON.parse(output.slice(start));
}
