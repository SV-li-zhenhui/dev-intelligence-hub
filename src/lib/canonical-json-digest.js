import { createHash } from "node:crypto";

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalJsonDigest(value) {
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex");
}
