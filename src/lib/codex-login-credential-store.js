import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJsonStringify } from "./canonical-json-digest.js";
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from "./private-directory-manager.js";
import { projectIdentityDigest } from "./project-identity.js";
import {
  createProductionCodexCredentialFilePort,
} from "./windows-codex-credential-file.js";

const CREDENTIAL_LIMIT = 65_536;
const ENVELOPE_LIMIT = 192 * 1024;
const ENVELOPE_NAME = "credential.json";
const AUTH_NAME = "auth.json";
const PUBLIC_FAILURE = Symbol("public Codex login broker failure");
const SNAPSHOT_STATE = new WeakMap();
const STORE_COORDINATORS = new Map();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion",
  "sourceDigest",
  "credentialDigest",
  "credentialBase64",
  "updatedAt",
]);

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

function blocked() {
  return publicFailure(
    "CODEX_LOGIN_BROKER_BLOCKED",
    "Codex login credential broker is blocked",
  );
}

function unavailable() {
  return publicFailure(
    "CODEX_LOGIN_FILE_UNAVAILABLE",
    "Codex login credential file is unavailable",
  );
}

function sourceUnsafe() {
  return publicFailure(
    "CODEX_LOGIN_SOURCE_UNSAFE",
    "Codex login credential source is unsafe",
  );
}

function aborted() {
  return publicFailure(
    "ABORT_ERR",
    "Codex login credential operation was aborted",
    "AbortError",
  );
}

function isPublicFailure(error) {
  try {
    return error?.[PUBLIC_FAILURE] === true;
  } catch {
    return false;
  }
}

function failureCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function sanitize(error, signal) {
  if (signal?.aborted) return aborted();
  if (isPublicFailure(error)) return error;
  return blocked();
}

function throwIfAborted(signal) {
  if (signal.aborted) throw aborted();
}

function exactDataRecord(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw blocked();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw blocked();
  }
  if (prototype !== Object.prototype && prototype !== null) throw blocked();
  const expected = [...expectedKeys].sort();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw blocked();
  keys.sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    keys.some((key) =>
      !Object.hasOwn(descriptors[key], "value") || descriptors[key].enumerable !== true)
  ) {
    throw blocked();
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function signalValue(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw blocked();
  }
  if (!(value instanceof AbortSignal)) throw blocked();
  return value;
}

function absolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw blocked();
  }
  return path.resolve(value);
}

function exactDirectoryIdentity(value) {
  const identity = exactDataRecord(value, ["path", "device", "inode"]);
  if (!Object.isFrozen(value)) throw blocked();
  const resolvedPath = absolutePath(identity.path);
  if (
    resolvedPath !== identity.path ||
    typeof identity.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.inode)
  ) {
    throw blocked();
  }
  return value;
}

function credentialBytes(value, source = false) {
  if (
    utilTypes.isProxy(value) ||
    !Buffer.isBuffer(value) ||
    value.length < 1 ||
    value.length > CREDENTIAL_LIMIT
  ) {
    throw source ? sourceUnsafe() : blocked();
  }
  return Buffer.from(value);
}

function exactStringArray(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    !Array.isArray(value)
  ) {
    throw blocked();
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw blocked();
  }
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 1
  ) {
    throw blocked();
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) throw blocked();
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== lengthDescriptor.value + 1 || !keys.includes("length")) {
    throw blocked();
  }
  const result = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string"
    ) {
      throw blocked();
    }
    result.push(descriptor.value);
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw blocked();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw blocked();
  return credentialBytes(decoded);
}

function isoTimestamp(value) {
  if (typeof value !== "string") throw blocked();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw blocked();
  return value;
}

function jsonHasDuplicateKeys(text) {
  let index = 0;
  let duplicate = false;

  function skipWhitespace() {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  }

  function parseString() {
    const start = index;
    if (text[index] !== '"') throw blocked();
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    throw blocked();
  }

  function parseValue() {
    skipWhitespace();
    if (text[index] === "{") {
      parseObject();
      return;
    }
    if (text[index] === "[") {
      parseArray();
      return;
    }
    if (text[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index])) index += 1;
    JSON.parse(text.slice(start, index));
  }

  function parseObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") throw blocked();
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw blocked();
      index += 1;
      skipWhitespace();
    }
    throw blocked();
  }

  function parseArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw blocked();
      index += 1;
    }
    throw blocked();
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) throw blocked();
  return duplicate;
}

function parseEnvelope(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    utilTypes.isProxy(bytes) ||
    bytes.length < 1 ||
    bytes.length > ENVELOPE_LIMIT
  ) {
    throw blocked();
  }
  let text;
  let parsed;
  let duplicateKeys;
  try {
    text = UTF8_DECODER.decode(bytes);
    if (!text.endsWith("\n")) throw blocked();
    const json = text.slice(0, -1);
    duplicateKeys = jsonHasDuplicateKeys(json);
    parsed = JSON.parse(json);
  } catch {
    throw blocked();
  }
  if (duplicateKeys) throw blocked();
  const envelope = exactDataRecord(parsed, ENVELOPE_KEYS);
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.sourceDigest) ||
    typeof envelope.credentialDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.credentialDigest)
  ) {
    throw blocked();
  }
  const credential = canonicalBase64(envelope.credentialBase64);
  if (sha256(credential) !== envelope.credentialDigest) throw blocked();
  isoTimestamp(envelope.updatedAt);
  if (!duplicateKeys && `${canonicalJsonStringify(envelope)}\n` !== text) throw blocked();
  return Object.freeze({
    sourceDigest: envelope.sourceDigest,
    credentialDigest: envelope.credentialDigest,
    credential,
  });
}

function envelopeBytes(sourceDigest, credential, now) {
  const envelope = {
    schemaVersion: 1,
    sourceDigest,
    credentialDigest: sha256(credential),
    credentialBase64: credential.toString("base64"),
    updatedAt: isoTimestamp(now().toISOString()),
  };
  const bytes = Buffer.from(`${canonicalJsonStringify(envelope)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > ENVELOPE_LIMIT) throw blocked();
  return bytes;
}

function pathContains(left, right) {
  if (path.parse(left).root !== path.parse(right).root) return false;
  const relative = path.relative(left, right);
  return relative === "" || (
    !path.isAbsolute(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}

function normalizedForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function storeCoordinator(mirrorDirectory) {
  const key = normalizedForComparison(mirrorDirectory);
  let coordinator = STORE_COORDINATORS.get(key);
  if (coordinator === undefined) {
    coordinator = {
      activeSourceDigest: null,
      generationEpoch: 0,
      generationRevoked: true,
      tail: Promise.resolve(),
    };
    STORE_COORDINATORS.set(key, coordinator);
  }
  return coordinator;
}

async function runExclusive(coordinator, operation) {
  const predecessor = coordinator.tail;
  let release;
  coordinator.tail = new Promise((resolve) => { release = resolve; });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

function validatedConfiguration(options) {
  const values = exactDataRecord(options, ["locations", "protectedRoots", "now"]);
  const locations = exactDataRecord(values.locations, [
    "sourceFile",
    "mirrorRoot",
    "mirrorDirectory",
    "probeRoot",
  ]);
  const resolved = Object.freeze({
    sourceFile: absolutePath(locations.sourceFile),
    mirrorRoot: absolutePath(locations.mirrorRoot),
    mirrorDirectory: absolutePath(locations.mirrorDirectory),
    probeRoot: absolutePath(locations.probeRoot),
  });
  if (
    path.basename(resolved.sourceFile) !== AUTH_NAME ||
    resolved.mirrorDirectory !== path.join(resolved.mirrorRoot, "codex-login")
  ) {
    throw blocked();
  }
  if (typeof values.now !== "function") throw blocked();
  const protectedRoots = Object.freeze(exactStringArray(values.protectedRoots).map(absolutePath));
  return Object.freeze({
    locations: resolved,
    protectedRoots,
    now: values.now,
  });
}

async function validateNonOverlap(configuration, dependencies, prepared = {}) {
  const { locations, protectedRoots } = configuration;
  const candidates = [
    path.dirname(locations.sourceFile),
    prepared.mirrorRoot?.path ?? locations.mirrorRoot,
    prepared.mirrorDirectory?.path ?? locations.mirrorDirectory,
    locations.probeRoot,
    ...protectedRoots,
  ];
  const canonical = [];
  for (const candidate of candidates) {
    canonical.push(normalizedForComparison(absolutePath(
      await dependencies.canonicalizePath(candidate),
    )));
  }
  const [
    sourceRoot,
    mirrorRoot,
    mirrorDirectory,
    probeRoot,
    ...canonicalProtectedRoots
  ] = canonical;
  if (!pathContains(mirrorRoot, mirrorDirectory)) throw blocked();
  const credentialRoots = [sourceRoot, mirrorRoot, probeRoot];
  for (let left = 0; left < credentialRoots.length; left += 1) {
    for (let right = left + 1; right < credentialRoots.length; right += 1) {
      if (
        pathContains(credentialRoots[left], credentialRoots[right]) ||
        pathContains(credentialRoots[right], credentialRoots[left])
      ) {
        throw blocked();
      }
    }
  }
  for (const credentialRoot of credentialRoots) {
    for (const protectedRoot of canonicalProtectedRoots) {
      if (
        pathContains(credentialRoot, protectedRoot) ||
        pathContains(protectedRoot, credentialRoot)
      ) {
        throw blocked();
      }
    }
  }
  for (const root of [sourceRoot, probeRoot, ...canonicalProtectedRoots]) {
    if (pathContains(root, mirrorDirectory) || pathContains(mirrorDirectory, root)) {
      throw blocked();
    }
  }
}

function validatedDependencies(dependencies) {
  const values = exactDataRecord(
    dependencies,
    ["canonicalizePath", "filePort", "privateDirectoryManager"],
  );
  if (typeof values.canonicalizePath !== "function") throw blocked();
  const filePort = exactDataRecord(values.filePort, [
    "readSource",
    "readPrivate",
    "writeNewPrivate",
    "replacePrivate",
    "removePrivate",
  ]);
  if (Object.values(filePort).some((operation) => typeof operation !== "function")) {
    throw blocked();
  }
  const manager = exactDataRecord(values.privateDirectoryManager, ["prepare"]);
  if (typeof manager.prepare !== "function") throw blocked();
  return Object.freeze({
    canonicalizePath: values.canonicalizePath,
    filePort: values.filePort,
    privateDirectoryManager: values.privateDirectoryManager,
  });
}

function createStore(configurationOptions, dependencyOptions) {
  let configuration;
  let dependencies;
  try {
    configuration = validatedConfiguration(configurationOptions);
    dependencies = validatedDependencies(dependencyOptions);
  } catch (error) {
    configuration = null;
    dependencies = null;
  }
  const coordinator = configuration === null
    ? { activeSourceDigest: null, generationEpoch: 0, generationRevoked: true, tail: Promise.resolve() }
    : storeCoordinator(configuration.locations.mirrorDirectory);
  const snapshots = new WeakSet();
  let privateStatePromise = null;

  function revokeGeneration() {
    coordinator.generationEpoch += 1;
    coordinator.activeSourceDigest = null;
    coordinator.generationRevoked = true;
  }

  function activateGeneration(sourceDigest) {
    if (
      coordinator.generationRevoked ||
      coordinator.activeSourceDigest !== sourceDigest
    ) {
      coordinator.generationEpoch += 1;
    }
    coordinator.activeSourceDigest = sourceDigest;
    coordinator.generationRevoked = false;
    return coordinator.generationEpoch;
  }

  async function preparePrivate(signal) {
    if (configuration === null || dependencies === null) throw blocked();
    await validateNonOverlap(configuration, dependencies);
    if (privateStatePromise === null) {
      privateStatePromise = (async () => {
        let prepared = {};
        const validateLocation = async () => {
          await validateNonOverlap(configuration, dependencies, prepared);
        };
        const mirrorRoot = await dependencies.privateDirectoryManager.prepare({
          directory: configuration.locations.mirrorRoot,
          signal,
          validateLocation,
        });
        prepared = { mirrorRoot };
        await validateNonOverlap(configuration, dependencies, prepared);
        const mirrorDirectory = await dependencies.privateDirectoryManager.prepare({
          directory: configuration.locations.mirrorDirectory,
          signal,
          validateLocation,
        });
        prepared = { mirrorRoot, mirrorDirectory };
        await validateNonOverlap(configuration, dependencies, prepared);
        return Object.freeze({ mirrorRoot, mirrorDirectory });
      })();
      void privateStatePromise.catch(() => {
        privateStatePromise = null;
      });
    }
    return privateStatePromise;
  }

  async function readSource(signal, { capture = false } = {}) {
    try {
      const bytes = await dependencies.filePort.readSource({
        file: configuration.locations.sourceFile,
        maximumBytes: CREDENTIAL_LIMIT,
        signal,
      });
      return credentialBytes(bytes, true);
    } catch (error) {
      if (capture) throw sanitize(error, signal);
      const code = failureCode(error);
      if (code === "ENOENT") throw unavailable();
      if (code === "CODEX_CREDENTIAL_SOURCE_UNSAFE") throw sourceUnsafe();
      if (isPublicFailure(error)) throw error;
      throw sanitize(error, signal);
    }
  }

  async function readMirror(privateState, signal, required = false) {
    const bytes = await dependencies.filePort.readPrivate({
      directory: privateState.mirrorDirectory,
      name: ENVELOPE_NAME,
      maximumBytes: ENVELOPE_LIMIT,
      required,
      signal,
    });
    return bytes === null ? null : parseEnvelope(bytes);
  }

  async function publish(privateState, existing, sourceDigest, credential, signal) {
    const bytes = envelopeBytes(sourceDigest, credential, configuration.now);
    const options = {
      directory: privateState.mirrorDirectory,
      name: ENVELOPE_NAME,
      bytes,
      signal,
    };
    if (existing === null) await dependencies.filePort.writeNewPrivate(options);
    else await dependencies.filePort.replacePrivate(options);
  }

  function createSnapshot(sourceDigest, credential) {
    const snapshot = Object.freeze(Object.create(null));
    const state = Object.freeze({
      sourceDigest,
      credential: Buffer.from(credential),
      generationEpoch: activateGeneration(sourceDigest),
    });
    snapshots.add(snapshot);
    SNAPSHOT_STATE.set(snapshot, state);
    return snapshot;
  }

  function snapshotState(snapshot) {
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      utilTypes.isProxy(snapshot) ||
      !snapshots.has(snapshot)
    ) {
      throw blocked();
    }
    const state = SNAPSHOT_STATE.get(snapshot);
    if (
      state === undefined ||
      coordinator.generationRevoked ||
      state.generationEpoch !== coordinator.generationEpoch ||
      state.sourceDigest !== coordinator.activeSourceDigest
    ) {
      throw blocked();
    }
    return state;
  }

  async function validateSourceGeneration(sourceDigest, signal) {
    try {
      const currentSource = await readSource(signal, { capture: true });
      if (sha256(currentSource) !== sourceDigest) throw blocked();
    } catch {
      revokeGeneration();
      throw blocked();
    }
  }

  async function beginTask(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["signal"]);
      signal = signalValue(values.signal);
      return await runExclusive(coordinator, async () => {
        throwIfAborted(signal);
        if (configuration === null || dependencies === null) throw blocked();
        await validateNonOverlap(configuration, dependencies);
        let source;
        try {
          source = await readSource(signal);
        } catch (error) {
          revokeGeneration();
          if (error?.code !== "CODEX_LOGIN_FILE_UNAVAILABLE") throw error;
          const privateState = await preparePrivate(signal);
          const existing = await readMirror(privateState, signal, false);
          if (existing !== null) {
            await dependencies.filePort.removePrivate({
              directory: privateState.mirrorDirectory,
              name: ENVELOPE_NAME,
              signal,
            });
          }
          throw unavailable();
        }
        const sourceDigest = sha256(source);
        if (
          !coordinator.generationRevoked &&
          coordinator.activeSourceDigest !== sourceDigest
        ) {
          revokeGeneration();
        }
        const privateState = await preparePrivate(signal);
        const existing = await readMirror(privateState, signal, false);
        let credential;
        if (existing === null || existing.sourceDigest !== sourceDigest) {
          credential = source;
          await validateSourceGeneration(sourceDigest, signal);
          await publish(privateState, existing, sourceDigest, credential, signal);
        } else {
          credential = existing.credential;
        }
        await validateSourceGeneration(sourceDigest, signal);
        return createSnapshot(sourceDigest, credential);
      });
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  async function stageTask(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["snapshot", "codexHome", "signal"]);
      signal = signalValue(values.signal);
      return await runExclusive(coordinator, async () => {
        throwIfAborted(signal);
        const state = snapshotState(values.snapshot);
        const codexHome = exactDirectoryIdentity(values.codexHome);
        await validateSourceGeneration(state.sourceDigest, signal);
        await dependencies.filePort.writeNewPrivate({
          directory: codexHome,
          name: AUTH_NAME,
          bytes: credentialBytes(state.credential),
          signal,
        });
        try {
          await validateSourceGeneration(state.sourceDigest, signal);
        } catch {
          try {
            await dependencies.filePort.removePrivate({
              directory: codexHome,
              name: AUTH_NAME,
              signal,
            });
          } catch {
            // Invocation cleanup remains the caller's fail-closed responsibility.
          }
          throw blocked();
        }
      });
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  async function captureTask(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["snapshot", "codexHome", "signal"]);
      signal = signalValue(values.signal);
      return await runExclusive(coordinator, async () => {
        throwIfAborted(signal);
        const state = snapshotState(values.snapshot);
        const codexHome = exactDirectoryIdentity(values.codexHome);
        const credential = credentialBytes(await dependencies.filePort.readPrivate({
          directory: codexHome,
          name: AUTH_NAME,
          maximumBytes: CREDENTIAL_LIMIT,
          required: true,
          signal,
        }));
        await validateSourceGeneration(state.sourceDigest, signal);
        const privateState = await preparePrivate(signal);
        const existing = await readMirror(privateState, signal, true);
        if (existing.sourceDigest !== state.sourceDigest) throw blocked();
        await validateSourceGeneration(state.sourceDigest, signal);
        await publish(privateState, existing, state.sourceDigest, credential, signal);
        await validateSourceGeneration(state.sourceDigest, signal);
      });
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  async function stageProbe(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["codexHome", "signal"]);
      signal = signalValue(values.signal);
      return await runExclusive(coordinator, async () => {
        throwIfAborted(signal);
        const codexHome = exactDirectoryIdentity(values.codexHome);
        let source;
        let sourceDigest;
        try {
          source = await readSource(signal);
          sourceDigest = sha256(source);
        } catch (error) {
          revokeGeneration();
          if (failureCode(error) === "CODEX_LOGIN_FILE_UNAVAILABLE") {
            const privateState = await preparePrivate(signal);
            const existing = await readMirror(privateState, signal, false);
            if (existing !== null) {
              await dependencies.filePort.removePrivate({
                directory: privateState.mirrorDirectory,
                name: ENVELOPE_NAME,
                signal,
              });
            }
          }
          throw error;
        }
        if (
          !coordinator.generationRevoked &&
          coordinator.activeSourceDigest !== sourceDigest
        ) {
          revokeGeneration();
        }
        const privateState = await preparePrivate(signal);
        const existing = await readMirror(privateState, signal, false);
        const credential = existing !== null &&
            existing.sourceDigest === sourceDigest
          ? existing.credential
          : source;
        await validateSourceGeneration(sourceDigest, signal);
        await dependencies.filePort.writeNewPrivate({
          directory: codexHome,
          name: AUTH_NAME,
          bytes: credentialBytes(credential),
          signal,
        });
        try {
          await validateSourceGeneration(sourceDigest, signal);
        } catch {
          try {
            await dependencies.filePort.removePrivate({
              directory: codexHome,
              name: AUTH_NAME,
              signal,
            });
          } catch {
            // Invocation cleanup remains the caller's fail-closed responsibility.
          }
          throw blocked();
        }
      });
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  return Object.freeze({ beginTask, stageTask, captureTask, stageProbe });
}

export function productionCodexLoginLocations() {
  const home = homedir();
  const configured = process.env.CODEX_HOME;
  let codexRoot;
  if (configured === undefined) {
    codexRoot = path.join(home, ".codex");
  } else {
    if (!path.isAbsolute(configured)) throw sourceUnsafe();
    try {
      const details = lstatSync(configured);
      if (!details.isDirectory() || details.isSymbolicLink()) throw sourceUnsafe();
    } catch {
      throw sourceUnsafe();
    }
    codexRoot = path.resolve(configured);
  }
  const projectRoot = path.resolve(import.meta.dirname, "../..");
  const projectDigest = projectIdentityDigest({ projectRoot });
  let runtimeBase;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (
      typeof localAppData !== "string" ||
      !path.isAbsolute(localAppData) ||
      localAppData.includes("\0")
    ) {
      throw blocked();
    }
    runtimeBase = path.join(localAppData, "MyDashboard", "runtime");
  } else {
    runtimeBase = path.join(home, ".local", "state", "mydashboard", "runtime");
  }
  const privateRuntime = path.join(runtimeBase, projectDigest);
  const mirrorRoot = path.join(privateRuntime, "cli-credentials-v1");
  return {
    sourceFile: path.join(codexRoot, AUTH_NAME),
    mirrorRoot,
    mirrorDirectory: path.join(mirrorRoot, "codex-login"),
    probeRoot: path.join(privateRuntime, "codex-login-probe-v1"),
  };
}

export function createTestCodexLoginCredentialStore(options, dependencies) {
  return createStore(options, dependencies);
}

export function createProductionCodexLoginCredentialStore(options) {
  let protectedRoots;
  try {
    ({ protectedRoots } = exactDataRecord(options, ["protectedRoots"]));
  } catch {
    throw blocked();
  }
  return createStore(
    {
      locations: productionCodexLoginLocations(),
      protectedRoots,
      now: () => new Date(),
    },
    {
      async canonicalizePath(candidate) {
        let existing = path.resolve(candidate);
        const suffix = [];
        while (true) {
          try {
            return path.join(await realpath(existing), ...suffix);
          } catch (error) {
            if (failureCode(error) !== "ENOENT") throw blocked();
            const parent = path.dirname(existing);
            if (parent === existing) throw blocked();
            suffix.unshift(path.basename(existing));
            existing = parent;
          }
        }
      },
      filePort: createProductionCodexCredentialFilePort(),
      privateDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
    },
  );
}
