import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { ProcessExclusiveGuard } from "./process-exclusive-guard.js";

const RUNTIME_GUARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

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

export function projectScopedRuntimeGuardName({ projectRoot, guardName }) {
  if (typeof guardName !== "string" || !RUNTIME_GUARD_NAME.test(guardName)) {
    throw new TypeError("guardName must be a safe process guard name");
  }
  const projectDigest = projectIdentityDigest({ projectRoot });
  const scopeDigest = createHash("sha256")
    .update(`${projectDigest}\0${guardName}`, "utf8")
    .digest("hex");
  return `mydashboard-runtime-${scopeDigest}`;
}

export function createProjectScopedGuardFactory({
  projectRoot,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  return (options = {}) => createGuard({
    ...options,
    name: projectScopedRuntimeGuardName({
      projectRoot,
      guardName: options.name,
    }),
  });
}
