import {
  captureVersionedRuntimeSourceCheckpoint,
} from "./runtime-source-identity.js";

const OBJECT_IDENTITY = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const FIELDS = Object.freeze([
  "clean",
  "headOid",
  "runtimeByteCount",
  "runtimeDigest",
  "runtimeFileCount",
  "schemaVersion",
  "treeOid",
]);
const startupHistoryByIdentity = new WeakMap();

function runtimeIdentity(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...FIELDS].sort().join("\0") ||
    value.schemaVersion !== 1 ||
    value.clean !== true ||
    !OBJECT_IDENTITY.test(value.headOid) ||
    !OBJECT_IDENTITY.test(value.treeOid) ||
    !SHA_256.test(value.runtimeDigest) ||
    !Number.isSafeInteger(value.runtimeFileCount) ||
    value.runtimeFileCount <= 0 ||
    !Number.isSafeInteger(value.runtimeByteCount) ||
    value.runtimeByteCount <= 0
  ) {
    throw new Error("runtime startup source identity is invalid");
  }
  return Object.freeze(structuredClone(value));
}

export async function captureRuntimeStartupIdentity(root) {
  const checkpoint = await captureVersionedRuntimeSourceCheckpoint(root);
  if (checkpoint === null) {
    throw new Error("runtime startup requires a clean versioned source");
  }
  if (!SHA_256.test(checkpoint.historyDigest)) {
    throw new Error("runtime startup source history is invalid");
  }
  const identity = runtimeIdentity(checkpoint.runtimeSource);
  startupHistoryByIdentity.set(identity, checkpoint.historyDigest);
  return identity;
}

export async function verifyRuntimeStartupIdentity(root, capturedIdentity) {
  const capturedHistory = startupHistoryByIdentity.get(capturedIdentity);
  if (capturedHistory === undefined) {
    throw new Error("runtime startup identity was not captured by this process");
  }
  const captured = runtimeIdentity(capturedIdentity);
  const current = await captureRuntimeStartupIdentity(root);
  if (FIELDS.some((field) => current[field] !== captured[field])) {
    throw new Error("runtime source changed while application modules loaded");
  }
  if (startupHistoryByIdentity.get(current) !== capturedHistory) {
    throw new Error(
      "repository history changed while application modules loaded",
    );
  }
  return capturedIdentity;
}
