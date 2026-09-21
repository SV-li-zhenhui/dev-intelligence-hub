import { spawn } from "node:child_process";
import { terminateProcessTree } from "../src/lib/managed-process.js";

const MAXIMUM_TIMEOUT_MS = 60 * 60 * 1000;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const TERMINATION_TIMEOUT_MS = 10_000;

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is outside the supported range`);
  }
  return value;
}

function commandError(code, message, cause = null) {
  const error = new Error(
    message,
    cause instanceof Error ? { cause } : undefined,
  );
  error.code = code;
  return error;
}

function appendBounded(state, chunk, maximum) {
  const bytes = Buffer.from(chunk);
  const remaining = maximum - state.bytes;
  if (bytes.length <= remaining) {
    state.chunks.push(bytes);
    state.bytes += bytes.length;
    return true;
  }
  if (remaining > 0) {
    state.chunks.push(bytes.subarray(0, remaining));
    state.bytes += remaining;
  }
  return false;
}

function outputText(state) {
  return Buffer.concat(state.chunks, state.bytes).toString("utf8");
}

export function runBoundedValidationCommand(command, arguments_, {
  cwd,
  env,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
} = {}) {
  if (typeof command !== "string" || command === "" || command.includes("\0")) {
    throw new TypeError("validation command is invalid");
  }
  if (
    !Array.isArray(arguments_) ||
    arguments_.some((argument) =>
      typeof argument !== "string" || argument.includes("\0")
    )
  ) {
    throw new TypeError("validation command arguments are invalid");
  }
  const boundedTimeout = boundedInteger(
    timeoutMs,
    "timeoutMs",
    MAXIMUM_TIMEOUT_MS,
  );
  const boundedStdout = boundedInteger(
    maxStdoutBytes,
    "maxStdoutBytes",
    MAXIMUM_OUTPUT_BYTES,
  );
  const boundedStderr = boundedInteger(
    maxStderrBytes,
    "maxStderrBytes",
    MAXIMUM_OUTPUT_BYTES,
  );

  return new Promise((resolve, reject) => {
    const stdout = { bytes: 0, chunks: [] };
    const stderr = { bytes: 0, chunks: [] };
    let child;
    let closed = false;
    let closeResult = null;
    let settled = false;
    let terminalError = null;
    let terminationPromise = null;
    let resolveClosed;
    const closedPromise = new Promise((resolveClose) => {
      resolveClosed = resolveClose;
    });

    const timer = setTimeout(() => {
      void terminate(commandError(
        "VALIDATION_COMMAND_TIMEOUT",
        `validation command timed out after ${boundedTimeout} ms`,
      ));
    }, boundedTimeout);

    const collected = () => ({
      stderr: outputText(stderr),
      stdout: outputText(stdout),
    });
    const settle = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const rejectWithOutput = (error) => {
      Object.assign(error, closeResult ?? { exitCode: null, signal: null });
      Object.assign(error, collected());
      settle(reject, error);
    };
    const waitForClose = async () => {
      if (closed) return true;
      let closeTimer;
      try {
        return await Promise.race([
          closedPromise.then(() => true),
          new Promise((resolveWait) => {
            closeTimer = setTimeout(
              () => resolveWait(false),
              TERMINATION_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    };
    const terminate = (error) => {
      if (settled) return Promise.resolve();
      terminalError ??= error;
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
          rejectWithOutput(terminalError);
          return;
        }
        let terminationError = null;
        try {
          await terminateProcessTree(child.pid, {
            force: true,
            timeoutMs: TERMINATION_TIMEOUT_MS,
          });
        } catch (caught) {
          terminationError = caught;
        }
        if (!closed) await waitForClose();
        if (!closed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The authoritative close check below remains fail-closed.
          }
          await waitForClose();
        }
        if (!closed || terminationError !== null) {
          rejectWithOutput(commandError(
            "VALIDATION_COMMAND_REAP_FAILED",
            "validation command process tree could not be reaped",
            terminationError,
          ));
          return;
        }
        rejectWithOutput(terminalError);
      })().catch((caught) => {
        rejectWithOutput(commandError(
          "VALIDATION_COMMAND_REAP_FAILED",
          "validation command process tree could not be reaped",
          caught,
        ));
      });
      return terminationPromise;
    };

    try {
      child = spawn(command, arguments_, {
        cwd,
        env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectWithOutput(commandError(
        "VALIDATION_COMMAND_UNAVAILABLE",
        "validation command could not be started",
        error,
      ));
      return;
    }

    child.stdout.on("data", (chunk) => {
      if (!appendBounded(stdout, chunk, boundedStdout)) {
        void terminate(commandError(
          "VALIDATION_COMMAND_OUTPUT_LIMIT",
          "validation command stdout exceeded its limit",
        ));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!appendBounded(stderr, chunk, boundedStderr)) {
        void terminate(commandError(
          "VALIDATION_COMMAND_OUTPUT_LIMIT",
          "validation command stderr exceeded its limit",
        ));
      }
    });
    child.stdout.on("error", (error) => {
      void terminate(commandError(
        "VALIDATION_COMMAND_STREAM_FAILED",
        "validation command stdout failed",
        error,
      ));
    });
    child.stderr.on("error", (error) => {
      void terminate(commandError(
        "VALIDATION_COMMAND_STREAM_FAILED",
        "validation command stderr failed",
        error,
      ));
    });
    child.once("error", (error) => {
      void terminate(commandError(
        "VALIDATION_COMMAND_UNAVAILABLE",
        "validation command could not be started",
        error,
      ));
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      closeResult = {
        exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
        signal: signal ?? null,
      };
      resolveClosed(closeResult);
      if (terminalError !== null) return;
      settle(resolve, {
        ...closeResult,
        ...collected(),
      });
    });
  });
}
