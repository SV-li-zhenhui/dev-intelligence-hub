import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJsonStringify } from "./canonical-json-digest.js";
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from "./private-directory-manager.js";
import {
  createProductionCodexCredentialFilePort,
} from "./windows-codex-credential-file.js";

const CREDENTIAL_LIMIT = 65_536;
const ENVELOPE_LIMIT = 192 * 1024;
const ENVELOPE_NAME = "credential.json";
const AUTH_NAME = "auth.json";
const PUBLIC_FAILURE = Symbol("public Codex login broker failure");
const SNAPSHOT_STATE = new WeakMap();
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
    Array.isArray(value) ||
    utilTypes.isProxy(value)
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
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    keys.some((key) =>
      !("value" in descriptors[key]) || descriptors[key].enumerable !== true)
  ) {
    throw blocked();
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function signalValue(value) {
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
  if (!Object.isFrozen(value)) throw blocked();
  const identity = exactDataRecord(value, ["path", "device", "inode"]);
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
    !Buffer.isBuffer(value) ||
    utilTypes.isProxy(value) ||
    value.length < 1 ||
    value.length > CREDENTIAL_LIMIT
  ) {
    throw source ? sourceUnsafe() : blocked();
  }
  return Buffer.from(value);
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
  try {
    text = UTF8_DECODER.decode(bytes);
    if (!text.endsWith("\n")) throw blocked();
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    throw blocked();
  }
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
  if (`${canonicalJsonStringify(envelope)}\n` !== text) throw blocked();
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
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalizedForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
  if (
    !Array.isArray(values.protectedRoots) ||
    utilTypes.isProxy(values.protectedRoots) ||
    values.protectedRoots.length < 1 ||
    values.protectedRoots.some((root) => typeof root !== "string") ||
    typeof values.now !== "function"
  ) {
    throw blocked();
  }
  const protectedRoots = Object.freeze(values.protectedRoots.map(absolutePath));
  return Object.freeze({
    locations: resolved,
    protectedRoots,
    now: values.now,
  });
}

function validateNonOverlap(configuration) {
  const { locations, protectedRoots } = configuration;
  const isolatedRoots = [
    path.dirname(locations.sourceFile),
    locations.mirrorRoot,
    locations.probeRoot,
    ...protectedRoots,
  ].map(normalizedForComparison);
  for (let left = 0; left < isolatedRoots.length; left += 1) {
    for (let right = left + 1; right < isolatedRoots.length; right += 1) {
      if (
        pathContains(isolatedRoots[left], isolatedRoots[right]) ||
        pathContains(isolatedRoots[right], isolatedRoots[left])
      ) {
        throw blocked();
      }
    }
  }
}

function validatedDependencies(dependencies) {
  const values = exactDataRecord(dependencies, ["filePort", "privateDirectoryManager"]);
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
  const snapshots = new WeakSet();
  let privateStatePromise = null;

  async function preparePrivate(signal) {
    if (configuration === null || dependencies === null) throw blocked();
    validateNonOverlap(configuration);
    if (privateStatePromise === null) {
      privateStatePromise = (async () => {
        const validateLocation = async () => validateNonOverlap(configuration);
        const mirrorRoot = await dependencies.privateDirectoryManager.prepare({
          directory: configuration.locations.mirrorRoot,
          signal,
          validateLocation,
        });
        validateNonOverlap(configuration);
        const mirrorDirectory = await dependencies.privateDirectoryManager.prepare({
          directory: configuration.locations.mirrorDirectory,
          signal,
          validateLocation,
        });
        validateNonOverlap(configuration);
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
    const state = Object.freeze({ sourceDigest, credential: Buffer.from(credential) });
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
    if (state === undefined) throw blocked();
    return state;
  }

  async function beginTask(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["signal"]);
      signal = signalValue(values.signal);
      throwIfAborted(signal);
      if (configuration === null || dependencies === null) throw blocked();
      validateNonOverlap(configuration);
      let source;
      try {
        source = await readSource(signal);
      } catch (error) {
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
      const privateState = await preparePrivate(signal);
      const existing = await readMirror(privateState, signal, false);
      let credential;
      if (existing === null || existing.sourceDigest !== sourceDigest) {
        credential = source;
        await publish(privateState, existing, sourceDigest, credential, signal);
      } else {
        credential = existing.credential;
      }
      return createSnapshot(sourceDigest, credential);
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  async function stageTask(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["snapshot", "codexHome", "signal"]);
      signal = signalValue(values.signal);
      throwIfAborted(signal);
      const state = snapshotState(values.snapshot);
      const codexHome = exactDirectoryIdentity(values.codexHome);
      await dependencies.filePort.writeNewPrivate({
        directory: codexHome,
        name: AUTH_NAME,
        bytes: credentialBytes(state.credential),
        signal,
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
      const currentSource = await readSource(signal, { capture: true });
      if (sha256(currentSource) !== state.sourceDigest) throw blocked();
      const privateState = await preparePrivate(signal);
      const existing = await readMirror(privateState, signal, true);
      if (existing.sourceDigest !== state.sourceDigest) throw blocked();
      await publish(privateState, existing, state.sourceDigest, credential, signal);
    } catch (error) {
      throw sanitize(error, signal);
    }
  }

  async function stageProbe(options) {
    let signal = null;
    try {
      const values = exactDataRecord(options, ["codexHome", "signal"]);
      signal = signalValue(values.signal);
      throwIfAborted(signal);
      const codexHome = exactDirectoryIdentity(values.codexHome);
      const privateState = await preparePrivate(signal);
      const existing = await readMirror(privateState, signal, false);
      if (existing === null) throw unavailable();
      await dependencies.filePort.writeNewPrivate({
        directory: codexHome,
        name: AUTH_NAME,
        bytes: credentialBytes(existing.credential),
        signal,
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
  const mirrorRoot = path.join(home, ".mydashboard-cli-credentials-v1");
  return {
    sourceFile: path.join(codexRoot, AUTH_NAME),
    mirrorRoot,
    mirrorDirectory: path.join(mirrorRoot, "codex-login"),
    probeRoot: path.join(home, ".mydashboard-codex-login-probe-v1"),
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
      filePort: createProductionCodexCredentialFilePort(),
      privateDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
    },
  );
}
