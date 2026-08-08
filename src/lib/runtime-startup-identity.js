import { computeVersionedRuntimeSourceIdentity } from "./runtime-source-identity.js";

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
  const identity = await computeVersionedRuntimeSourceIdentity(root);
  if (identity === null) {
    throw new Error("runtime startup requires a clean versioned source");
  }
  return runtimeIdentity(identity);
}

export async function verifyRuntimeStartupIdentity(root, capturedIdentity) {
  const captured = runtimeIdentity(capturedIdentity);
  const current = await captureRuntimeStartupIdentity(root);
  if (FIELDS.some((field) => current[field] !== captured[field])) {
    throw new Error("runtime source changed while application modules loaded");
  }
  return captured;
}
