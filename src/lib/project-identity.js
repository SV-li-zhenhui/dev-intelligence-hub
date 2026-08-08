import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

function canonicalProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.includes("\0")) {
    throw new TypeError("projectRoot must be a filesystem path");
  }
  return realpathSync.native(path.resolve(projectRoot));
}

export function projectIdentityDigest({ projectRoot, projectDigest = null }) {
  if (projectDigest !== null) {
    if (typeof projectDigest !== "string") {
      throw new TypeError("projectDigest must be a string or null");
    }
    return projectDigest;
  }
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const identity = process.platform === "win32"
    ? canonicalRoot.toUpperCase()
    : canonicalRoot;
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
