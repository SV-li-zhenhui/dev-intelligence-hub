import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";

import { canonicalJsonStringify } from "../lib/canonical-json-digest.js";
import { KnownCliLocator } from "../lib/known-cli-locator.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";
import {
  normalizeStructuredBrainRequest,
  readStructuredBrainGenerateInput,
} from "../lib/structured-brain-request.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { SupervisedProcessRunner } from "../lib/supervised-process-runner.js";

const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const CLI_KINDS = new Set(["codex-cli", "claude-cli"]);
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const API_KEY = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const INVALID_PATH_TEXT = /[\u0000\r\n]/;
const INVOCATION_MARKER = ".mydashboard-invocation.json";
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_SCAVENGE_ENTRIES = 128;
const MAX_MARKER_BYTES = 4 * 1024;
const MAX_RESULT_DEPTH = 64;
const MAX_RESULT_NODES = 20_000;
const MAX_RESULT_KEYS = 20_000;
const MAX_LOCAL_IO_SETTLEMENT_MS = 1_000;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INSTRUCTION =
  "Return exactly one JSON object that matches the supplied schema. " +
  "Do not call tools or perform actions. The object has no action authority.";
const OPTION_KEYS = Object.freeze([
  "id",
  "cliKind",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
]);
const CLAUDE_REQUIRED_KEYS = Object.freeze([
  "type",
  "subtype",
  "is_error",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "result",
  "session_id",
  "total_cost_usd",
]);
const CLAUDE_OPTIONAL_KEYS = new Set([
  "usage",
  "modelUsage",
  "permission_denials",
  "uuid",
]);
const FAILURE_DEFINITIONS = Object.freeze({
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
  STRUCTURED_PROVIDER_TIMEOUT: Object.freeze({
    message: "Structured CLI provider request timed out",
    statusCode: 504,
  }),
  STRUCTURED_PROVIDER_OUTPUT_LIMIT: Object.freeze({
    message: "Structured CLI provider output exceeded its limit",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_PROCESS_FAILED: Object.freeze({
    message: "Structured CLI provider process failed",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_REAP_FAILED: Object.freeze({
    message: "Structured CLI provider process could not be reaped safely",
    statusCode: 500,
  }),
  STRUCTURED_PROVIDER_REQUEST_TOO_LARGE: Object.freeze({
    message: "Structured provider request exceeds the configured limit",
    statusCode: 413,
  }),
  STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE: Object.freeze({
    message: "Structured CLI provider response exceeds the configured limit",
    statusCode: 413,
  }),
  STRUCTURED_PROVIDER_RESPONSE_INVALID: Object.freeze({
    message: "Structured CLI provider response is invalid",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_CLEANUP_FAILED: Object.freeze({
    message: "Structured CLI provider cleanup failed",
    statusCode: 500,
  }),
});
const FAILURE_PRECEDES_DEADLINE = new Set([
  "STRUCTURED_PROVIDER_REAP_FAILED",
  "STRUCTURED_PROVIDER_CLEANUP_FAILED",
]);

export class SupervisedCliBrainProviderError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "SupervisedCliBrainProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerError(code) {
  const definition = FAILURE_DEFINITIONS[code];
  if (!definition) {
    return new SupervisedCliBrainProviderError(
      "STRUCTURED_PROVIDER_UNAVAILABLE",
      FAILURE_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE.message,
      FAILURE_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE.statusCode,
    );
  }
  return new SupervisedCliBrainProviderError(
    code,
    definition.message,
    definition.statusCode,
  );
}

function sanitizeInputFailure(error) {
  if (error instanceof TypeError) return error;
  const code = typeof error?.code === "string" ? error.code : null;
  return providerError(
    Object.hasOwn(FAILURE_DEFINITIONS, code)
      ? code
      : "STRUCTURED_PROVIDER_UNAVAILABLE",
  );
}

function sanitizeRuntimeFailure(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  return providerError(
    Object.hasOwn(FAILURE_DEFINITIONS, code)
      ? code
      : "STRUCTURED_PROVIDER_UNAVAILABLE",
  );
}

function createRequestDeadline({
  signal,
  timeoutMs,
  monotonicClock,
  startedAt,
}) {
  const controller = new AbortController();
  let failure = null;
  let timer = null;
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const finish = (code) => {
    if (failure) return;
    failure = providerError(code);
    resolveTerminal(Object.freeze({ status: "terminal" }));
    controller.abort(failure);
  };
  const onAbort = () => finish("STRUCTURED_PROVIDER_CANCELLED");
  const remainingMs = () => {
    if (failure) throw failure;
    const elapsed = monotonicClock() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs) {
      finish("STRUCTURED_PROVIDER_TIMEOUT");
      throw failure;
    }
    return Math.max(1, Math.ceil(timeoutMs - elapsed));
  };
  const run = async (operation, { settlementTimeoutMs = 0 } = {}) => {
    remainingMs();
    const operationResult = Promise.resolve()
      .then(() => operation(Object.freeze({
        signal: controller.signal,
        timeoutMs: remainingMs(),
      })))
      .then(
        (value) => Object.freeze({ status: "fulfilled", value }),
        (error) => Object.freeze({ status: "rejected", error }),
      );
    let outcome = await Promise.race([operationResult, terminal]);
    if (outcome.status === "terminal" && settlementTimeoutMs > 0) {
      let settlementTimer;
      try {
        outcome = await Promise.race([
          operationResult,
          new Promise((resolve) => {
            settlementTimer = setTimeout(
              () => resolve(Object.freeze({ status: "settlement-timeout" })),
              settlementTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (settlementTimer) clearTimeout(settlementTimer);
      }
    }
    if (
      outcome.status === "rejected" &&
      FAILURE_PRECEDES_DEADLINE.has(outcome.error?.code)
    ) {
      throw outcome.error;
    }
    if (failure) throw failure;
    remainingMs();
    if (outcome.status === "rejected") throw outcome.error;
    return outcome.value;
  };
  const throwIfExpired = () => {
    remainingMs();
  };
  const dispose = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (!failure) {
    let initialRemaining = 0;
    try {
      initialRemaining = remainingMs();
    } catch {
      // The terminal failure is read through the normal request path so its
      // listener and timer lifecycle still reaches dispose().
    }
    if (!failure) {
      timer = setTimeout(
        () => finish("STRUCTURED_PROVIDER_TIMEOUT"),
        initialRemaining,
      );
    }
  }
  return Object.freeze({
    signal: controller.signal,
    remainingMs,
    run,
    throwIfExpired,
    dispose,
  });
}

function exactDataObject(value, allowedKeys, requiredKeys, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(message);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(message);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(message);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported range`);
  }
  return value;
}

function providerOptions(rawOptions) {
  const options = exactDataObject(
    rawOptions,
    OPTION_KEYS,
    ["id", "cliKind"],
    "Supervised CLI provider options are invalid",
  );
  if (typeof options.id !== "string" || !SAFE_ID.test(options.id)) {
    throw new TypeError("provider id is invalid");
  }
  if (!CLI_KINDS.has(options.cliKind)) {
    throw new TypeError("cliKind is invalid");
  }
  return Object.freeze({
    id: options.id,
    cliKind: options.cliKind,
    timeoutMs: boundedInteger(
      options.timeoutMs ?? 300_000,
      "timeoutMs",
      1_000,
      3_600_000,
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? 128 * 1024,
      "maxResponseBytes",
      1_024,
      1024 * 1024,
    ),
    maxRequestBytes: boundedInteger(
      options.maxRequestBytes ?? 256 * 1024,
      "maxRequestBytes",
      1_024,
      1024 * 1024,
    ),
  });
}

function temporaryRootPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    INVALID_PATH_TEXT.test(value)
  ) {
    throw new TypeError("temporaryRoot is invalid");
  }
  return path.resolve(value);
}

function defaultProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function providerDependencies(constructionToken, rawDependencies) {
  if (constructionToken !== TEST_CONSTRUCTION_TOKEN) {
    return Object.freeze({
      processRunner: new SupervisedProcessRunner(),
      commandLocator: new KnownCliLocator(),
      environment: process.env,
      temporaryRoot: path.join(tmpdir(), "mydashboard-supervised-cli-v1"),
      clock: Date.now,
      monotonicClock: () => performance.now(),
      processId: process.pid,
      isProcessAlive: defaultProcessAlive,
      staleInvocationScavenger: scavengeStaleInvocations,
      codexResultReader: readCodexResult,
    });
  }
  const dependencies = exactDataObject(
    rawDependencies,
    [
      "processRunner",
      "commandLocator",
      "environment",
      "temporaryRoot",
      "clock",
      "monotonicClock",
      "processId",
      "isProcessAlive",
      "staleInvocationScavenger",
      "codexResultReader",
    ],
    ["processRunner", "commandLocator", "environment", "temporaryRoot"],
    "Supervised CLI provider test dependencies are invalid",
  );
  return Object.freeze({
    ...dependencies,
    clock: dependencies.clock ?? Date.now,
    monotonicClock: dependencies.monotonicClock ?? (() => performance.now()),
    processId: dependencies.processId ?? process.pid,
    isProcessAlive: dependencies.isProcessAlive ?? defaultProcessAlive,
    staleInvocationScavenger:
      dependencies.staleInvocationScavenger ?? scavengeStaleInvocations,
    codexResultReader: dependencies.codexResultReader ?? readCodexResult,
  });
}

function validateDependencies(dependencies) {
  if (
    typeof dependencies.processRunner?.run !== "function" ||
    typeof dependencies.commandLocator?.resolve !== "function" ||
    dependencies.environment === null ||
    typeof dependencies.environment !== "object" ||
    utilTypes.isProxy(dependencies.environment) ||
    typeof dependencies.clock !== "function" ||
    typeof dependencies.monotonicClock !== "function" ||
    typeof dependencies.isProcessAlive !== "function" ||
    typeof dependencies.staleInvocationScavenger !== "function" ||
    typeof dependencies.codexResultReader !== "function" ||
    !Number.isSafeInteger(dependencies.processId) ||
    dependencies.processId < 1
  ) {
    throw new TypeError("Supervised CLI provider dependencies are invalid");
  }
}

function credential(environment, cliKind) {
  const name = cliKind === "codex-cli"
    ? "OPENAI_API_KEY"
    : "ANTHROPIC_API_KEY";
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !API_KEY.test(descriptor.value)
  ) {
    throw providerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  return Object.freeze({ name, value: descriptor.value });
}

function canonicalPath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function throwIfRequestAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof SupervisedCliBrainProviderError
    ? signal.reason
    : providerError("STRUCTURED_PROVIDER_CANCELLED");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function trustedDirectory(directory, expectedRoot = null, signal = null) {
  throwIfRequestAborted(signal);
  const details = await lstat(directory, { bigint: true });
  throwIfRequestAborted(signal);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  const resolved = await realpath(directory);
  throwIfRequestAborted(signal);
  if (canonicalPath(resolved) !== canonicalPath(directory)) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  if (expectedRoot && !inside(expectedRoot, resolved)) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  return Object.freeze({
    path: resolved,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

async function writeNewFile(file, bytes, signal = null) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    throwIfRequestAborted(signal);
    await handle.writeFile(bytes);
    throwIfRequestAborted(signal);
    await handle.sync();
    throwIfRequestAborted(signal);
  } finally {
    await handle?.close();
  }
  if (process.platform !== "win32") await chmod(file, 0o600);
  throwIfRequestAborted(signal);
  return lstat(file, { bigint: true });
}

function sameDirectoryIdentity(invocation, details) {
  return (
    details.isDirectory() &&
    !details.isSymbolicLink() &&
    details.dev.toString() === invocation.device &&
    details.ino.toString() === invocation.inode
  );
}

async function removeVerifiedInvocation(invocation, root) {
  const quarantine = path.join(root, `.cleanup-${randomUUID()}`);
  try {
    await rename(invocation.path, quarantine);
    const details = await lstat(quarantine, { bigint: true });
    if (!sameDirectoryIdentity(invocation, details)) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const resolved = await realpath(quarantine);
    if (
      canonicalPath(resolved) !== canonicalPath(quarantine) ||
      !inside(root, resolved)
    ) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    await rm(quarantine, { recursive: true, force: false });
  } catch {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
}

function markerValue(value, cliKind) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 4
  ) {
    return null;
  }
  for (const key of ["schemaVersion", "kind", "ownerPid", "createdAt"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  const createdAt = Date.parse(value.createdAt);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== cliKind ||
    !Number.isSafeInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }
  return Object.freeze({ ...value, createdAtMs: createdAt });
}

async function readSmallRegularFile(file, maximumBytes, signal = null) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    throwIfRequestAborted(signal);
    const details = await handle.stat({ bigint: true });
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.nlink !== 1n ||
      details.size > BigInt(maximumBytes)
    ) {
      return null;
    }
    const bytes = await handle.readFile();
    throwIfRequestAborted(signal);
    if (bytes.byteLength > maximumBytes) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function fatalUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
}

function invocationPrefix(cliKind) {
  return `invocation-${cliKind}-`;
}

async function scavengeStaleInvocations({
  root,
  cliKind,
  clock,
  isProcessAlive,
  signal = null,
}) {
  throwIfRequestAborted(signal);
  const prefix = invocationPrefix(cliKind);
  const directoryHandle = await opendir(root);
  try {
    for (
      let inspected = 0;
      inspected < MAX_SCAVENGE_ENTRIES;
      inspected += 1
    ) {
      throwIfRequestAborted(signal);
      const entry = await directoryHandle.read();
      throwIfRequestAborted(signal);
      if (entry === null) break;
      if (
        !entry.name.startsWith(prefix) ||
        !/^[a-z0-9._-]+$/i.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      const directory = path.join(root, entry.name);
      try {
        const identity = await trustedDirectory(directory, root, signal);
        const markerBytes = await readSmallRegularFile(
          path.join(directory, INVOCATION_MARKER),
          MAX_MARKER_BYTES,
          signal,
        );
        throwIfRequestAborted(signal);
        if (!markerBytes) continue;
        let parsed;
        try {
          parsed = parseJsonWithUniqueKeys(fatalUtf8(markerBytes));
        } catch {
          continue;
        }
        const marker = markerValue(parsed, cliKind);
        if (!marker || clock() - marker.createdAtMs < STALE_AFTER_MS) continue;
        let alive = true;
        try {
          alive = Boolean(isProcessAlive(marker.ownerPid));
        } catch {
          alive = true;
        }
        if (alive) continue;
        throwIfRequestAborted(signal);
        await removeVerifiedInvocation(identity, root);
      } catch {
        throwIfRequestAborted(signal);
        // Unknown, live, raced, or untrusted entries are deliberately retained.
      }
    }
  } finally {
    await directoryHandle.close().catch(() => {});
  }
}

async function createInvocation({ root, cliKind, processId, clock, signal }) {
  throwIfRequestAborted(signal);
  const directory = await mkdtemp(path.join(root, invocationPrefix(cliKind)));
  let identity = null;
  try {
    throwIfRequestAborted(signal);
    if (process.platform !== "win32") await chmod(directory, 0o700);
    throwIfRequestAborted(signal);
    identity = await trustedDirectory(directory, root, signal);
    const marker = {
      schemaVersion: 1,
      kind: cliKind,
      ownerPid: processId,
      createdAt: new Date(clock()).toISOString(),
    };
    await writeNewFile(
      path.join(directory, INVOCATION_MARKER),
      Buffer.from(JSON.stringify(marker), "utf8"),
      signal,
    );
    const profiles = {
      home: path.join(directory, "profile", "home"),
      appData: path.join(directory, "profile", "appdata"),
      localAppData: path.join(directory, "profile", "local-appdata"),
      xdgConfig: path.join(directory, "profile", "xdg-config"),
      xdgCache: path.join(directory, "profile", "xdg-cache"),
      xdgData: path.join(directory, "profile", "xdg-data"),
      temporary: path.join(directory, "temporary"),
    };
    for (const profile of Object.values(profiles)) {
      throwIfRequestAborted(signal);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      throwIfRequestAborted(signal);
      if (process.platform !== "win32") await chmod(profile, 0o700);
    }
    throwIfRequestAborted(signal);
    return Object.freeze({ ...identity, profiles: Object.freeze(profiles) });
  } catch (failure) {
    try {
      const cleanupIdentity = identity ??
        await trustedDirectory(directory, root);
      await removeVerifiedInvocation(cleanupIdentity, root);
    } catch {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    throw failure;
  }
}

function childEnvironment(invocation, configuredCredential) {
  const { profiles } = invocation;
  return {
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
    [configuredCredential.name]: configuredCredential.value,
  };
}

function requestPayload(request, maximumBytes) {
  const text = canonicalJsonStringify({
    schemaVersion: 1,
    instruction: INSTRUCTION,
    messages: request.messages,
    schema: request.schema,
  });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > maximumBytes) {
    throw providerError("STRUCTURED_PROVIDER_REQUEST_TOO_LARGE");
  }
  return bytes;
}

function assertSafeCliModel(model) {
  if (!SAFE_CLI_MODEL.test(model)) {
    throw new TypeError("CLI model is invalid");
  }
}

function codexArguments({ request, invocation, schemaFile, resultFile }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--strict-config",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    "--disable",
    "multi_agent",
    "--disable",
    "hooks",
    "--color",
    "never",
    "--output-schema",
    schemaFile,
    "--output-last-message",
    resultFile,
    "--model",
    request.model,
    "-C",
    invocation.path,
    "-",
  ];
}

function claudeArguments(request) {
  return [
    "--print",
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--safe-mode",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--no-chrome",
    "--no-session-persistence",
    "--model",
    request.model,
  ];
}

function resultBudget() {
  return { nodes: MAX_RESULT_NODES, keys: MAX_RESULT_KEYS };
}

function cloneResultJson(value, depth = 0, budget = resultBudget()) {
  if (depth > MAX_RESULT_DEPTH || budget.nodes-- <= 0) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    budget.keys -= value.length;
    if (budget.keys < 0) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    return value.map((entry) => cloneResultJson(entry, depth + 1, budget));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const keys = Reflect.ownKeys(value);
  budget.keys -= keys.length;
  if (
    budget.keys < 0 ||
    keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return Object.fromEntries(
    keys.map((key) => [key, cloneResultJson(value[key], depth + 1, budget)]),
  );
}

function structuredResult(text) {
  let parsed;
  try {
    parsed = parseJsonWithUniqueKeys(text);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return canonicalJsonStringify(cloneResultJson(parsed));
}

function plainMetadataObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  cloneResultJson(value);
}

function claudeResult(bytes) {
  let envelope;
  try {
    envelope = parseJsonWithUniqueKeys(fatalUtf8(bytes));
  } catch (error) {
    if (error instanceof SupervisedCliBrainProviderError) throw error;
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.getPrototypeOf(envelope) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const keys = Reflect.ownKeys(envelope);
  const allowed = new Set([...CLAUDE_REQUIRED_KEYS, ...CLAUDE_OPTIONAL_KEYS]);
  if (
    CLAUDE_REQUIRED_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    envelope.type !== "result" ||
    envelope.subtype !== "success" ||
    envelope.is_error !== false ||
    envelope.num_turns !== 1 ||
    !Number.isSafeInteger(envelope.duration_ms) ||
    envelope.duration_ms < 0 ||
    !Number.isSafeInteger(envelope.duration_api_ms) ||
    envelope.duration_api_ms < 0 ||
    typeof envelope.result !== "string" ||
    typeof envelope.session_id !== "string" ||
    !envelope.session_id ||
    !Number.isFinite(envelope.total_cost_usd) ||
    envelope.total_cost_usd < 0
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (Object.hasOwn(envelope, "permission_denials")) {
    if (
      !Array.isArray(envelope.permission_denials) ||
      Object.getPrototypeOf(envelope.permission_denials) !== Array.prototype ||
      envelope.permission_denials.length !== 0
    ) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
  }
  if (Object.hasOwn(envelope, "uuid") && typeof envelope.uuid !== "string") {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  for (const name of ["usage", "modelUsage"]) {
    if (Object.hasOwn(envelope, name)) plainMetadataObject(envelope[name]);
  }
  return structuredResult(envelope.result);
}

function processBytes(result, maximumBytes) {
  if (
    !Buffer.isBuffer(result?.stdoutBytes) &&
    !(result?.stdoutBytes instanceof Uint8Array)
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const bytes = Buffer.from(result.stdoutBytes);
  if (bytes.byteLength > maximumBytes) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
  }
  return bytes;
}

async function readCodexResult(
  file,
  identity,
  maximumBytes,
  { signal = null } = {},
) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    throwIfRequestAborted(signal);
    const before = await handle.stat({ bigint: true });
    throwIfRequestAborted(signal);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.dev !== identity.dev ||
      before.ino !== identity.ino
    ) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    if (before.size > BigInt(maximumBytes)) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
    }
    const bytes = await handle.readFile(
      signal === null ? undefined : { signal },
    );
    throwIfRequestAborted(signal);
    const after = await handle.stat({ bigint: true });
    throwIfRequestAborted(signal);
    if (
      bytes.byteLength > maximumBytes ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1n ||
      after.size !== BigInt(bytes.byteLength)
    ) {
      throw providerError(
        bytes.byteLength > maximumBytes
          ? "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE"
          : "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      );
    }
    return structuredResult(fatalUtf8(bytes));
  } catch (error) {
    if (error instanceof SupervisedCliBrainProviderError) throw error;
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  } finally {
    await handle?.close();
  }
}

export class SupervisedCliBrainProvider {
  #timeoutMs;
  #maxResponseBytes;
  #maxRequestBytes;
  #processRunner;
  #commandLocator;
  #environment;
  #temporaryRoot;
  #clock;
  #monotonicClock;
  #processId;
  #isProcessAlive;
  #staleInvocationScavenger;
  #codexResultReader;
  #rootPath = null;
  #scavenged = false;
  #descriptorValue = null;

  constructor(rawOptions, constructionToken, rawDependencies) {
    if (arguments.length > 1 && constructionToken !== TEST_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        "Production supervised CLI providers do not accept replacement dependencies",
      );
    }
    const options = providerOptions(rawOptions);
    const dependencies = providerDependencies(constructionToken, rawDependencies);
    validateDependencies(dependencies);
    this.id = options.id;
    this.kind = options.cliKind;
    this.remote = true;
    this.singleAttempt = true;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#maxRequestBytes = options.maxRequestBytes;
    this.#processRunner = dependencies.processRunner;
    this.#commandLocator = dependencies.commandLocator;
    this.#environment = dependencies.environment;
    this.#temporaryRoot = temporaryRootPath(dependencies.temporaryRoot);
    this.#clock = dependencies.clock;
    this.#monotonicClock = dependencies.monotonicClock;
    this.#processId = dependencies.processId;
    this.#isProcessAlive = dependencies.isProcessAlive;
    this.#staleInvocationScavenger =
      dependencies.staleInvocationScavenger;
    this.#codexResultReader = dependencies.codexResultReader;
    Object.freeze(this);
  }

  async #root(signal) {
    if (this.#rootPath) return this.#rootPath;
    throwIfRequestAborted(signal);
    await mkdir(this.#temporaryRoot, { recursive: true, mode: 0o700 });
    const identity = await trustedDirectory(this.#temporaryRoot, null, signal);
    if (process.platform !== "win32") await chmod(identity.path, 0o700);
    throwIfRequestAborted(signal);
    this.#rootPath ??= identity.path;
    return this.#rootPath;
  }

  async #scavenge(root, signal) {
    if (this.#scavenged) return;
    throwIfRequestAborted(signal);
    await this.#staleInvocationScavenger({
      root,
      cliKind: this.kind,
      clock: this.#clock,
      isProcessAlive: this.#isProcessAlive,
      signal,
    });
    throwIfRequestAborted(signal);
    this.#scavenged = true;
  }

  async #descriptor(deadline) {
    if (this.#descriptorValue) return this.#descriptorValue;
    const descriptor = await deadline.run(({ signal }) =>
      this.#commandLocator.resolve(this.kind, { signal }));
    deadline.throwIfExpired();
    this.#descriptorValue ??= descriptor;
    return this.#descriptorValue;
  }

  async #invoke({
    request,
    wireInput,
    deadline,
    configuredCredential,
    descriptor,
  }) {
    const root = await deadline.run(({ signal }) => this.#root(signal));
    await deadline.run(({ signal }) => this.#scavenge(root, signal));
    const invocation = await deadline.run(
      ({ signal }) => createInvocation({
        root,
        cliKind: this.kind,
        processId: this.#processId,
        clock: this.#clock,
        signal,
      }),
      { settlementTimeoutMs: MAX_LOCAL_IO_SETTLEMENT_MS },
    );
    let result;
    let failure = null;
    try {
      const environment = childEnvironment(invocation, configuredCredential);
      if (this.kind === "codex-cli") {
        const schemaFile = path.join(invocation.path, "output-schema.json");
        const resultFile = path.join(invocation.path, "last-message.json");
        await deadline.run(
          ({ signal }) => writeNewFile(
            schemaFile,
            Buffer.from(canonicalJsonStringify(request.schema), "utf8"),
            signal,
          ),
          { settlementTimeoutMs: MAX_LOCAL_IO_SETTLEMENT_MS },
        );
        const resultIdentity = await deadline.run(
          ({ signal }) => writeNewFile(resultFile, Buffer.alloc(0), signal),
          { settlementTimeoutMs: MAX_LOCAL_IO_SETTLEMENT_MS },
        );
        await this.#processRunner.run({
          executable: descriptor,
          args: codexArguments({
            request,
            invocation,
            schemaFile,
            resultFile,
          }),
          cwd: invocation.path,
          env: environment,
          input: wireInput,
          signal: deadline.signal,
          timeoutMs: deadline.remainingMs(),
          maxStdoutBytes: this.#maxResponseBytes,
          maxStderrBytes: this.#maxResponseBytes,
        });
        deadline.throwIfExpired();
        result = await deadline.run(
          ({ signal }) => this.#codexResultReader(
            resultFile,
            resultIdentity,
            this.#maxResponseBytes,
            { signal },
          ),
        );
      } else {
        const processResult = await this.#processRunner.run({
          executable: descriptor,
          args: claudeArguments(request),
          cwd: invocation.path,
          env: environment,
          input: wireInput,
          signal: deadline.signal,
          timeoutMs: deadline.remainingMs(),
          maxStdoutBytes: this.#maxResponseBytes,
          maxStderrBytes: this.#maxResponseBytes,
        });
        deadline.throwIfExpired();
        result = claudeResult(
          processBytes(processResult, this.#maxResponseBytes),
        );
      }
    } catch (error) {
      failure = error;
    }

    if (failure?.code !== "STRUCTURED_PROVIDER_REAP_FAILED") {
      try {
        await removeVerifiedInvocation(invocation, root);
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
    if (failure) throw failure;
    return result;
  }

  async generate(rawRequest = {}) {
    const startedAt = this.#monotonicClock();
    let admitted;
    try {
      const input = readStructuredBrainGenerateInput(rawRequest);
      const signal = normalizeAbortSignal(input.signal);
      if (signal?.aborted) {
        throw providerError("STRUCTURED_PROVIDER_CANCELLED");
      }
      const request = normalizeStructuredBrainRequest(
        {
          model: input.model,
          messages: input.messages,
          schema: input.schema,
        },
        { maxRequestBytes: this.#maxRequestBytes },
      );
      assertSafeCliModel(request.model);
      admitted = Object.freeze({
        request,
        signal,
        wireInput: requestPayload(request, this.#maxRequestBytes),
      });
    } catch (error) {
      throw sanitizeInputFailure(error);
    }
    const deadline = createRequestDeadline({
      signal: admitted.signal,
      timeoutMs: this.#timeoutMs,
      monotonicClock: this.#monotonicClock,
      startedAt,
    });
    try {
      const configuredCredential = credential(this.#environment, this.kind);
      const descriptor = await this.#descriptor(deadline);
      const result = await this.#invoke({
        request: admitted.request,
        wireInput: admitted.wireInput,
        deadline,
        configuredCredential,
        descriptor,
      });
      deadline.throwIfExpired();
      return result;
    } catch (error) {
      if (FAILURE_PRECEDES_DEADLINE.has(error?.code)) {
        throw sanitizeRuntimeFailure(error);
      }
      try {
        deadline.throwIfExpired();
      } catch (deadlineError) {
        throw sanitizeRuntimeFailure(deadlineError);
      }
      throw sanitizeRuntimeFailure(error);
    } finally {
      deadline.dispose();
    }
  }
}

export function createProductionSupervisedCliBrainProvider(options) {
  return new SupervisedCliBrainProvider(options);
}

export function createTestSupervisedCliBrainProvider(options, dependencies) {
  return new SupervisedCliBrainProvider(
    options,
    TEST_CONSTRUCTION_TOKEN,
    dependencies,
  );
}
