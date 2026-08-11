import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { ProductionCliCompositionGrant } from "../composition-root.js";
import {
  createProductionCodexLoginCredentialStore,
  productionCodexLoginLocations,
} from "../lib/codex-login-credential-store.js";
import { KnownCliLocator } from "../lib/known-cli-locator.js";
import {
  prepareCleanupTreesByIdentity,
  PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
} from "../lib/private-directory-manager.js";
import { SupervisedProcessRunner } from "../lib/supervised-process-runner.js";

const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const STATUS_TEXT = "Logged in using ChatGPT";
const STATUS_TIMEOUT_MS = 10_000;
const STATUS_OUTPUT_LIMIT = 4_096;
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_MAXIMUM_ENTRIES = 128;
const CLEANUP_MAXIMUM_DEPTH = 16;
const CLEANUP_MAXIMUM_BYTES = 16 * 1024 * 1024;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATUS_STATES = new Set([
  "available",
  "file_login_unavailable",
  "unsafe_source",
  "broker_blocked",
  "cli_unavailable",
]);
const ERROR_DEFINITIONS = Object.freeze({
  STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE: Object.freeze({
    message: "Structured CLI provider credential is unavailable",
    statusCode: 503,
  }),
  STRUCTURED_PROVIDER_UNAVAILABLE: Object.freeze({
    message: "Structured CLI provider is unavailable",
    statusCode: 503,
  }),
  STRUCTURED_PROVIDER_CANCELLED: Object.freeze({
    message: "Structured CLI provider request was cancelled",
    statusCode: 499,
  }),
  STRUCTURED_PROVIDER_CLEANUP_FAILED: Object.freeze({
    message: "Structured CLI provider cleanup failed",
    statusCode: 500,
  }),
});

export class CodexLoginCredentialBrokerError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code] ??
      ERROR_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE;
    super(definition.message);
    this.name = "CodexLoginCredentialBrokerError";
    this.code = ERROR_DEFINITIONS[code] === undefined
      ? "STRUCTURED_PROVIDER_UNAVAILABLE"
      : code;
    this.statusCode = definition.statusCode;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function brokerError(code) {
  return new CodexLoginCredentialBrokerError(code);
}

function failureCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function plainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function operationPort(value) {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    !utilTypes.isProxy(value);
}

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!plainRecord(value)) throw new TypeError("Codex login broker input is invalid");
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("Codex login broker input is invalid");
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    throw new TypeError("Codex login broker input is invalid");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(descriptors);
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.some((key) =>
      !Object.hasOwn(descriptors[key], "value") ||
      descriptors[key].enumerable !== true)
  ) {
    throw new TypeError("Codex login broker input is invalid");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function normalizeSignal(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    !(value instanceof AbortSignal)
  ) {
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return value;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw brokerError("STRUCTURED_PROVIDER_CANCELLED");
}

function normalizeAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("Codex login broker path is invalid");
  }
  return path.resolve(value);
}

function normalizeProtectedRoots(value) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    value.length < 1 ||
    value.length > 64
  ) {
    throw new TypeError("Codex login broker protected roots are invalid");
  }
  return Object.freeze([...new Set(value.map(normalizeAbsolutePath))]);
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertIsolatedProbeRoot(probeRoot, protectedRoots) {
  for (const protectedRoot of protectedRoots) {
    if (
      pathContains(protectedRoot, probeRoot) ||
      pathContains(probeRoot, protectedRoot)
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }
}

function exactDirectoryIdentity(value) {
  const identity = exactRecord(value, ["path", "device", "inode"]);
  if (
    !Object.isFrozen(value) ||
    normalizeAbsolutePath(identity.path) !== identity.path ||
    typeof identity.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.inode)
  ) {
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return value;
}

async function verifyDirectoryIdentity(identity) {
  const expected = exactDirectoryIdentity(identity);
  try {
    const resolved = await realpath(expected.path);
    const details = await lstat(resolved, { bigint: true });
    if (
      resolved !== expected.path ||
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.dev.toString() !== expected.device ||
      details.ino.toString() !== expected.inode
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  } catch (error) {
    if (error instanceof CodexLoginCredentialBrokerError) throw error;
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return expected;
}

function mapTaskFailure(error, signal) {
  const code = failureCode(error);
  if (
    code === "CODEX_LOGIN_BROKER_BLOCKED" ||
    code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" ||
    code === "STRUCTURED_PROVIDER_REAP_FAILED"
  ) {
    return brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  if (signal?.aborted || code === "ABORT_ERR") {
    return brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  if (
    code === "CODEX_LOGIN_FILE_UNAVAILABLE" ||
    code === "CODEX_LOGIN_SOURCE_UNSAFE" ||
    code === "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE"
  ) {
    return brokerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  if (code === "STRUCTURED_PROVIDER_CANCELLED") {
    return brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  return brokerError("STRUCTURED_PROVIDER_UNAVAILABLE");
}

function statusProjection(state) {
  if (!STATUS_STATES.has(state)) state = "broker_blocked";
  return Object.freeze({
    schemaVersion: 1,
    state,
    cliAvailable: state !== "cli_unavailable",
    fileLoginAvailable: state === "available",
  });
}

function statusStateFor(error, signal) {
  if (signal?.aborted || failureCode(error) === "ABORT_ERR") {
    throw brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  switch (failureCode(error)) {
    case "CODEX_LOGIN_FILE_UNAVAILABLE":
    case "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE":
      return "file_login_unavailable";
    case "CODEX_LOGIN_SOURCE_UNSAFE":
      return "unsafe_source";
    case "STRUCTURED_PROVIDER_UNAVAILABLE":
      return "cli_unavailable";
    default:
      return "broker_blocked";
  }
}

function brokerOptions(rawOptions) {
  const options = exactRecord(rawOptions, ["probeRoot", "protectedRoots"]);
  const probeRoot = normalizeAbsolutePath(options.probeRoot);
  const protectedRoots = normalizeProtectedRoots(options.protectedRoots);
  assertIsolatedProbeRoot(probeRoot, protectedRoots);
  return Object.freeze({ probeRoot, protectedRoots });
}

function brokerDependencies(rawDependencies) {
  const dependencies = exactRecord(rawDependencies, [
    "store",
    "commandLocator",
    "processRunner",
    "privateDirectoryManager",
    "prepareCleanupTrees",
    "randomUUID",
  ]);
  const requiredOperations = [
    [dependencies.store, ["beginTask", "stageTask", "captureTask", "stageProbe"]],
    [dependencies.commandLocator, ["resolve"]],
    [dependencies.processRunner, ["run"]],
    [dependencies.privateDirectoryManager, ["prepare"]],
  ];
  if (
    requiredOperations.some(([port, operations]) =>
      !operationPort(port) || operations.some((name) => typeof port[name] !== "function")) ||
    typeof dependencies.prepareCleanupTrees !== "function" ||
    typeof dependencies.randomUUID !== "function"
  ) {
    throw new TypeError("Codex login broker test dependencies are invalid");
  }
  return Object.freeze(dependencies);
}

function productionBrokerDependencies(protectedRoots) {
  const locations = productionCodexLoginLocations();
  return Object.freeze({
    options: Object.freeze({
      probeRoot: locations.probeRoot,
      protectedRoots,
    }),
    dependencies: Object.freeze({
      store: createProductionCodexLoginCredentialStore({ protectedRoots }),
      commandLocator: new KnownCliLocator(),
      processRunner: new SupervisedProcessRunner(),
      privateDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
      prepareCleanupTrees: prepareCleanupTreesByIdentity,
      randomUUID,
    }),
  });
}

function createAdmissionQueue() {
  let active = null;
  let blocked = false;
  let closed = false;
  const waiters = [];
  const idleWaiters = new Set();

  function admissionFailure() {
    return blocked
      ? brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED")
      : brokerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }

  function notifyIdle() {
    if (active !== null) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function rejectWaiters(errorFactory) {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(errorFactory());
    }
  }

  function drain() {
    if (active !== null) return;
    if (blocked || closed) {
      notifyIdle();
      return;
    }
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(brokerError("STRUCTURED_PROVIDER_CANCELLED"));
        continue;
      }
      const token = Object.freeze({});
      active = token;
      waiter.resolve(token);
      return;
    }
    notifyIdle();
  }

  function enter(signal) {
    throwIfCancelled(signal);
    if (blocked || closed) return Promise.reject(admissionFailure());
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        onAbort: null,
      };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        reject(brokerError("STRUCTURED_PROVIDER_CANCELLED"));
        if (active === null) drain();
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
      drain();
    });
  }

  function leave(token, { safe }) {
    if (token !== active) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    active = null;
    if (!safe) {
      blocked = true;
      rejectWaiters(() => brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED"));
      notifyIdle();
      return;
    }
    drain();
  }

  function closeAdmission() {
    if (!closed) {
      closed = true;
      rejectWaiters(() => brokerError("STRUCTURED_PROVIDER_UNAVAILABLE"));
      notifyIdle();
    }
  }

  async function waitUntilIdle(signal) {
    if (active === null) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        idleWaiters.delete(complete);
        resolve();
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        idleWaiters.delete(complete);
        reject(brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED"));
      };
      idleWaiters.add(complete);
      signal?.addEventListener("abort", cancel, { once: true });
      if (active === null) complete();
    });
  }

  return Object.freeze({ enter, leave, closeAdmission, waitUntilIdle });
}

function profileEnvironment(invocation, codexHome) {
  const profiles = {
    home: path.join(invocation.path, "home"),
    appData: path.join(invocation.path, "app-data"),
    localAppData: path.join(invocation.path, "local-app-data"),
    xdgConfig: path.join(invocation.path, "xdg-config"),
    xdgCache: path.join(invocation.path, "xdg-cache"),
    xdgData: path.join(invocation.path, "xdg-data"),
    temporary: path.join(invocation.path, "temporary"),
  };
  return Object.freeze({
    CODEX_HOME: codexHome,
    HOME: profiles.home,
    USERPROFILE: profiles.home,
    APPDATA: profiles.appData,
    LOCALAPPDATA: profiles.localAppData,
    XDG_CONFIG_HOME: profiles.xdgConfig,
    XDG_CACHE_HOME: profiles.xdgCache,
    XDG_DATA_HOME: profiles.xdgData,
    TEMP: profiles.temporary,
    TMP: profiles.temporary,
    TMPDIR: profiles.temporary,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
}

function createBroker(rawOptions, rawDependencies) {
  const options = brokerOptions(rawOptions);
  const dependencies = brokerDependencies(rawDependencies);
  const queue = createAdmissionQueue();

  async function prepareProbeRoot(signal) {
    assertIsolatedProbeRoot(options.probeRoot, options.protectedRoots);
    return dependencies.privateDirectoryManager.prepare({
      directory: options.probeRoot,
      signal,
      validateLocation() {
        assertIsolatedProbeRoot(options.probeRoot, options.protectedRoots);
      },
    });
  }

  async function prepareProbeInvocation(signal) {
    const probeRoot = await prepareProbeRoot(signal);
    await verifyDirectoryIdentity(probeRoot);
    const uuid = dependencies.randomUUID();
    if (typeof uuid !== "string" || !SAFE_UUID.test(uuid)) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const directory = path.join(probeRoot.path, `probe-${uuid}`);
    const invocation = await dependencies.privateDirectoryManager.prepare({
      directory,
      signal,
      async validateLocation() {
        await verifyDirectoryIdentity(probeRoot);
        if (path.dirname(directory) !== probeRoot.path) {
          throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      },
    });
    await verifyDirectoryIdentity(probeRoot);
    return verifyDirectoryIdentity(invocation);
  }

  async function prepareCodexHome(invocation, signal) {
    const verifiedInvocation = await verifyDirectoryIdentity(invocation);
    const directory = path.join(verifiedInvocation.path, "codex-home");
    const codexHome = await dependencies.privateDirectoryManager.prepare({
      directory,
      signal,
      async validateLocation() {
        await verifyDirectoryIdentity(verifiedInvocation);
        if (path.dirname(directory) !== verifiedInvocation.path) {
          throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      },
    });
    await verifyDirectoryIdentity(verifiedInvocation);
    return verifyDirectoryIdentity(codexHome);
  }

  async function cleanupProbe(invocation) {
    const cleanupSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    let session = null;
    try {
      session = await dependencies.prepareCleanupTrees([invocation], {
        maximumEntries: CLEANUP_MAXIMUM_ENTRIES,
        maximumDepth: CLEANUP_MAXIMUM_DEPTH,
        maximumBytes: CLEANUP_MAXIMUM_BYTES,
        signal: cleanupSignal,
      });
      if (
        session === null ||
        typeof session !== "object" ||
        typeof session.commit !== "function" ||
        typeof session.close !== "function"
      ) {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      await session.commit();
    } catch {
      try {
        await session?.close?.();
      } catch {
        // The stable cleanup failure below owns the public result.
      }
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  async function runStatus(invocation, codexHomePath, signal) {
    throwIfCancelled(signal);
    let descriptor;
    try {
      descriptor = await dependencies.commandLocator.resolve("codex-cli", { signal });
    } catch (error) {
      throw mapTaskFailure(error, signal);
    }
    let result;
    try {
      result = await dependencies.processRunner.run({
        executable: descriptor,
        args: ["login", "status"],
        cwd: invocation.path,
        env: profileEnvironment(invocation, codexHomePath),
        input: Buffer.alloc(0),
        signal,
        timeoutMs: STATUS_TIMEOUT_MS,
        maxStdoutBytes: STATUS_OUTPUT_LIMIT,
        maxStderrBytes: STATUS_OUTPUT_LIMIT,
      });
    } catch (error) {
      throw mapTaskFailure(error, signal);
    }
    const stdout = typeof result?.stdout === "string"
      ? result.stdout.replace(/\r\n?/gu, "\n").trim()
      : "";
    if (result?.exitCode !== 0 || result?.signal !== null || stdout !== STATUS_TEXT) {
      throw brokerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
    }
  }

  function createLease(token, snapshot) {
    let released = false;
    let stageStarted = false;
    let captureStarted = false;
    let codexHome = null;

    function assertActive() {
      if (released) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }

    async function stage(rawRequest) {
      assertActive();
      if (stageStarted) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      stageStarted = true;
      let signal = null;
      try {
        const request = exactRecord(rawRequest, ["invocation", "signal"]);
        signal = normalizeSignal(request.signal);
        const invocation = exactDirectoryIdentity(request.invocation);
        throwIfCancelled(signal);
        codexHome = await prepareCodexHome(invocation, signal);
        await dependencies.store.stageTask({ snapshot, codexHome, signal });
        return Object.freeze({ codexHome: codexHome.path });
      } catch (error) {
        throw mapTaskFailure(error, signal);
      }
    }

    async function capture(rawRequest) {
      assertActive();
      if (!stageStarted || codexHome === null || captureStarted) {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      captureStarted = true;
      let signal = null;
      try {
        const request = exactRecord(rawRequest, ["signal"]);
        signal = normalizeSignal(request.signal);
        throwIfCancelled(signal);
        await dependencies.store.captureTask({ snapshot, codexHome, signal });
      } catch (error) {
        throw mapTaskFailure(error, signal);
      }
    }

    function release(rawRequest) {
      assertActive();
      let request;
      try {
        request = exactRecord(rawRequest, ["safe"]);
      } catch {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      if (typeof request.safe !== "boolean") {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      released = true;
      queue.leave(token, { safe: request.safe });
    }

    return Object.freeze({ stage, capture, release });
  }

  async function acquire(rawRequest) {
    let signal = null;
    let token = null;
    try {
      const request = exactRecord(rawRequest, ["signal"]);
      signal = normalizeSignal(request.signal);
      token = await queue.enter(signal);
      const snapshot = await dependencies.store.beginTask({ signal });
      return createLease(token, snapshot);
    } catch (error) {
      const failure = mapTaskFailure(error, signal);
      if (token !== null) {
        queue.leave(token, {
          safe: failure.code !== "STRUCTURED_PROVIDER_CLEANUP_FAILED",
        });
      }
      throw failure;
    }
  }

  async function readStatus(rawRequest = {}) {
    let signal = null;
    let token = null;
    let invocation = null;
    let state = "broker_blocked";
    let failure = null;
    let lifecycleSafe = true;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      signal = normalizeSignal(request.signal, { optional: true });
      token = await queue.enter(signal);
      invocation = await prepareProbeInvocation(signal);
      const codexHome = await prepareCodexHome(invocation, signal);
      await dependencies.store.stageProbe({ codexHome, signal: signal ?? AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      await runStatus(invocation, codexHome.path, signal);
      state = "available";
    } catch (error) {
      try {
        state = statusStateFor(error, signal);
        if (state === "broker_blocked") lifecycleSafe = false;
      } catch (statusFailure) {
        failure = statusFailure;
      }
    } finally {
      if (invocation !== null) {
        try {
          await cleanupProbe(invocation);
        } catch {
          state = "broker_blocked";
          lifecycleSafe = false;
          failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      if (token !== null) queue.leave(token, { safe: lifecycleSafe });
    }
    if (failure !== null) throw failure;
    return statusProjection(state);
  }

  async function checkAvailability(rawRequest = {}) {
    let signal = null;
    let lease = null;
    let invocation = null;
    let failure = null;
    let cleanupSafe = true;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      signal = normalizeSignal(request.signal, { optional: true }) ??
        AbortSignal.timeout(STATUS_TIMEOUT_MS);
      lease = await acquire({ signal });
      invocation = await prepareProbeInvocation(signal);
      const staged = await lease.stage({ invocation, signal });
      await runStatus(invocation, staged.codexHome, signal);
      await lease.capture({ signal });
    } catch (error) {
      failure = mapTaskFailure(error, signal);
      if (failure.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED") {
        cleanupSafe = false;
      }
    } finally {
      if (invocation !== null) {
        try {
          await cleanupProbe(invocation);
        } catch {
          cleanupSafe = false;
          failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      if (lease !== null) {
        try {
          lease.release({ safe: cleanupSafe });
        } catch (error) {
          failure = mapTaskFailure(error, signal);
        }
      }
    }
    if (failure !== null) throw failure;
  }

  async function close(rawRequest = {}) {
    let signal = null;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      signal = normalizeSignal(request.signal, { optional: true });
      queue.closeAdmission();
      if (signal?.aborted) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      await queue.waitUntilIdle(signal);
    } catch (error) {
      if (error instanceof CodexLoginCredentialBrokerError) throw error;
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  return Object.freeze({ acquire, checkAvailability, readStatus, close });
}

export function createTestCodexLoginCredentialBroker(options, dependencies) {
  try {
    return createBroker(options, dependencies);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError("Codex login broker test dependencies are invalid");
    }
    throw error;
  }
}

export function createProductionCodexLoginCredentialBroker(grant) {
  if (!ProductionCliCompositionGrant.is(grant)) {
    throw new TypeError(
      "Production Codex login brokers require a lexical composition grant",
    );
  }
  const { options, dependencies } = grant.consume(productionBrokerDependencies);
  return createBroker(options, dependencies);
}
