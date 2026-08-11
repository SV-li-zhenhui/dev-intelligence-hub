import { spawn } from "node:child_process";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAXIMUM_CREDENTIAL_BYTES = 65_536;
const MAXIMUM_PRIVATE_FILE_BYTES = 192 * 1024;
const MAXIMUM_PACKET_BYTES = 384 * 1024;
const MAXIMUM_STDERR_BYTES = 4_096;
const MAXIMUM_NAME_BYTES = 128;
const PUBLIC_FAILURE = Symbol("public credential file failure");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const HELPER_REQUEST_KEYS = Object.freeze({
  "read-source": ["schemaVersion", "operation", "fileBase64", "maximumBytes"],
  "read-private": ["schemaVersion", "operation", "directory", "name", "maximumBytes", "required"],
  "write-new-private": ["schemaVersion", "operation", "directory", "name", "bytesBase64"],
  "replace-private": ["schemaVersion", "operation", "directory", "name", "bytesBase64"],
  "remove-private": ["schemaVersion", "operation", "directory", "name"],
});

function publicFailure(code, message, name = "Error") {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: `${name}: ${message}`,
    writable: true,
  });
  Object.defineProperty(error, PUBLIC_FAILURE, { value: true });
  return error;
}

function operationFailed() {
  return publicFailure(
    "CODEX_CREDENTIAL_FILE_OPERATION_FAILED",
    "Codex credential file operation failed",
  );
}

function sourceUnsafe() {
  return publicFailure(
    "CODEX_CREDENTIAL_SOURCE_UNSAFE",
    "Codex credential source is unsafe",
  );
}

function sourceMissing() {
  return publicFailure("ENOENT", "Codex credential source is unavailable");
}

function aborted() {
  return publicFailure(
    "ABORT_ERR",
    "Codex credential file operation was aborted",
    "AbortError",
  );
}

function throwIfAborted(signal) {
  if (signal.aborted) throw aborted();
}

function exactDataRecord(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw operationFailed();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw operationFailed();
  }
  if (prototype !== Object.prototype && prototype !== null) throw operationFailed();
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== [...expectedKeys].sort()[index]) ||
    keys.some((key) =>
      !("value" in descriptors[key]) || descriptors[key].enumerable !== true)
  ) {
    throw operationFailed();
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function operationOptions(value, expectedKeys) {
  return exactDataRecord(value, expectedKeys);
}

function requestPacket(request) {
  const expectedKeys = HELPER_REQUEST_KEYS[request.operation];
  exactDataRecord(request, expectedKeys);
  const packet = Buffer.from(JSON.stringify(request), "utf8");
  if (packet.length === 0 || packet.length > MAXIMUM_PACKET_BYTES) {
    throw operationFailed();
  }
  return packet;
}

function signalValue(value) {
  if (!(value instanceof AbortSignal)) throw operationFailed();
  return value;
}

function sourceMaximum(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_CREDENTIAL_BYTES
  ) {
    throw operationFailed();
  }
  return value;
}

function privateMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PRIVATE_FILE_BYTES) {
    throw operationFailed();
  }
  return value;
}

function absoluteWindowsPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    value.includes("\0") ||
    value.includes("/") ||
    !/^[A-Za-z]:\\/u.test(value) ||
    !path.win32.isAbsolute(value)
  ) {
    throw operationFailed();
  }
  return value;
}

function exactDirectoryIdentity(value) {
  if (!Object.isFrozen(value)) throw operationFailed();
  const directory = exactDataRecord(value, ["path", "device", "inode"]);
  absoluteWindowsPath(directory.path);
  if (
    typeof directory.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(directory.device) ||
    typeof directory.inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(directory.inode)
  ) {
    throw operationFailed();
  }
  return Object.freeze({
    path: directory.path,
    device: directory.device,
    inode: directory.inode,
  });
}

function directChildName(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_NAME_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value.includes("..") ||
    /[. ]$/u.test(value)
  ) {
    throw operationFailed();
  }
  const stem = value.split(".", 1)[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
    throw operationFailed();
  }
  return value;
}

function privateBytes(value) {
  if (
    !Buffer.isBuffer(value) ||
    value.length < 1 ||
    value.length > MAXIMUM_PRIVATE_FILE_BYTES
  ) {
    throw operationFailed();
  }
  return value;
}

function canonicalBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw operationFailed();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw operationFailed();
  return decoded;
}

function exactResponse(value, keys) {
  return exactDataRecord(value, keys);
}

function readResponse(value, { maximumBytes, required, source }) {
  const header = exactDataRecord(value, Object.keys(value || {}));
  if (header.schemaVersion !== SCHEMA_VERSION || typeof header.status !== "string") {
    throw operationFailed();
  }
  if (header.status === "ok") {
    const response = exactResponse(value, ["schemaVersion", "status", "bytesBase64"]);
    const bytes = canonicalBase64(response.bytesBase64);
    if (bytes.length < 1 || bytes.length > maximumBytes) {
      throw source ? sourceUnsafe() : operationFailed();
    }
    return bytes;
  }
  exactResponse(value, ["schemaVersion", "status"]);
  if (header.status === "missing") {
    if (source) throw sourceMissing();
    if (!required) return null;
  }
  if (header.status === "source-unsafe" && source) throw sourceUnsafe();
  throw operationFailed();
}

function voidResponse(value) {
  const response = exactResponse(value, ["schemaVersion", "status"]);
  if (response.schemaVersion !== SCHEMA_VERSION || response.status !== "ok") {
    throw operationFailed();
  }
}

function sanitizeFailure(error, signal) {
  if (signal.aborted) return aborted();
  try {
    if (error?.[PUBLIC_FAILURE] === true) return error;
  } catch {
    // Untrusted failures are always replaced with a fresh public error.
  }
  return operationFailed();
}

function operationSignal(options) {
  try {
    if (options === null || typeof options !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
    return descriptor && "value" in descriptor && descriptor.value instanceof AbortSignal
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

async function invokeWithAbort(invoke, request, signal, waitForAbortCleanup) {
  throwIfAborted(signal);
  let rejectAbort;
  const abortPromise = new Promise((resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(aborted());
  signal.addEventListener("abort", onAbort, { once: true });
  const invocation = Promise.resolve().then(() => invoke(request, { signal }));
  void invocation.catch(() => {});
  try {
    return await Promise.race([invocation, abortPromise]);
  } catch (error) {
    if (signal.aborted && waitForAbortCleanup) {
      try {
        await invocation;
      } catch {
        // The production transport settles only after the helper has closed.
      }
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function createPort(invoke, { waitForAbortCleanup = false } = {}) {
  const execute = async (signal, request, parse) => {
    try {
      requestPacket(request);
      const response = await invokeWithAbort(
        invoke,
        request,
        signal,
        waitForAbortCleanup,
      );
      throwIfAborted(signal);
      return parse(response);
    } catch (error) {
      throw sanitizeFailure(error, signal);
    }
  };

  return Object.freeze({
    async readSource(options) {
      try {
        const values = operationOptions(options, ["file", "maximumBytes", "signal"]);
        const signal = signalValue(values.signal);
        const maximumBytes = sourceMaximum(values.maximumBytes);
        const request = {
          schemaVersion: SCHEMA_VERSION,
          operation: "read-source",
          fileBase64: Buffer.from(absoluteWindowsPath(values.file), "utf8").toString("base64"),
          maximumBytes,
        };
        return await execute(signal, request, (response) =>
          readResponse(response, { maximumBytes, required: true, source: true }));
      } catch (error) {
        const signal = operationSignal(options);
        throw signal === null ? operationFailed() : sanitizeFailure(error, signal);
      }
    },

    async readPrivate(options) {
      try {
        const values = operationOptions(
          options,
          ["directory", "name", "maximumBytes", "required", "signal"],
        );
        const signal = signalValue(values.signal);
        const maximumBytes = privateMaximum(values.maximumBytes);
        if (typeof values.required !== "boolean") throw operationFailed();
        const request = {
          schemaVersion: SCHEMA_VERSION,
          operation: "read-private",
          directory: exactDirectoryIdentity(values.directory),
          name: directChildName(values.name),
          maximumBytes,
          required: values.required,
        };
        return await execute(signal, request, (response) => readResponse(response, {
          maximumBytes,
          required: values.required,
          source: false,
        }));
      } catch (error) {
        const signal = operationSignal(options);
        throw signal === null ? operationFailed() : sanitizeFailure(error, signal);
      }
    },

    async writeNewPrivate(options) {
      return writePrivate("write-new-private", options);
    },

    async replacePrivate(options) {
      return writePrivate("replace-private", options);
    },

    async removePrivate(options) {
      try {
        const values = operationOptions(options, ["directory", "name", "signal"]);
        const signal = signalValue(values.signal);
        const request = {
          schemaVersion: SCHEMA_VERSION,
          operation: "remove-private",
          directory: exactDirectoryIdentity(values.directory),
          name: directChildName(values.name),
        };
        await execute(signal, request, voidResponse);
      } catch (error) {
        const signal = operationSignal(options);
        throw signal === null ? operationFailed() : sanitizeFailure(error, signal);
      }
    },
  });

  async function writePrivate(operation, options) {
    try {
      const values = operationOptions(options, ["directory", "name", "bytes", "signal"]);
      const signal = signalValue(values.signal);
      const request = {
        schemaVersion: SCHEMA_VERSION,
        operation,
        directory: exactDirectoryIdentity(values.directory),
        name: directChildName(values.name),
        bytesBase64: privateBytes(values.bytes).toString("base64"),
      };
      await execute(signal, request, voidResponse);
    } catch (error) {
      const signal = operationSignal(options);
      throw signal === null ? operationFailed() : sanitizeFailure(error, signal);
    }
  }
}

function createProcessInvoke(spawnProcess, systemRoot) {
  return function processInvoke(request, { signal }) {
    const packet = requestPacket(request);
    if (
      typeof systemRoot !== "string" ||
      !/^[A-Za-z]:\\/u.test(systemRoot) ||
      systemRoot.includes("\0")
    ) {
      throw operationFailed();
    }
    const executable = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const helper = path.join(import.meta.dirname, "windows-codex-credential-helper.ps1");

    return new Promise((resolve, reject) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failed = false;
      const stdout = [];
      let child;
      try {
        child = spawnProcess(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            helper,
          ],
          {
            windowsHide: true,
            signal,
            stdio: ["pipe", "pipe", "pipe"],
            env: { SystemRoot: systemRoot, WINDIR: systemRoot },
          },
        );
      } catch {
        reject(operationFailed());
        return;
      }

      const failAndStop = () => {
        failed = true;
        child.kill();
      };
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAXIMUM_PACKET_BYTES) {
          failAndStop();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAXIMUM_STDERR_BYTES) failAndStop();
      });
      child.stdin.on("error", failAndStop);
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        if (signal.aborted) {
          reject(aborted());
          return;
        }
        if (failed || code !== 0 || stdoutBytes < 1) {
          reject(operationFailed());
          return;
        }
        try {
          const text = UTF8_DECODER.decode(Buffer.concat(stdout, stdoutBytes));
          if (text !== text.trim()) throw operationFailed();
          resolve(JSON.parse(text));
        } catch {
          reject(operationFailed());
        }
      });
      child.stdin.end(packet);
    });
  };
}

export function createTestCodexCredentialFilePort({ invoke, spawnProcess } = {}) {
  if ((typeof invoke === "function") === (typeof spawnProcess === "function")) {
    throw new TypeError("exactly one test transport is required");
  }
  if (typeof invoke === "function") return createPort(invoke);
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return createPort(
    createProcessInvoke(spawnProcess, systemRoot),
    { waitForAbortCleanup: true },
  );
}

export function createProductionCodexCredentialFilePort() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw operationFailed();
  }
  return createPort(
    createProcessInvoke(spawn, process.env.SystemRoot || process.env.WINDIR),
    { waitForAbortCleanup: true },
  );
}
