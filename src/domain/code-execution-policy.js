const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DEFAULT_EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "data",
  "logs",
  "validation-artifacts",
  ".ssh",
]);
const DEFAULT_EXCLUDED_FILES = new Set([
  "config.local.json",
  ".npmrc",
  ".gitconfig",
]);

export class CodeExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeExecutionError";
    this.code = code;
  }
}

function invalidPath() {
  return new CodeExecutionError("INVALID_PATH", "工作区路径不安全");
}

function validateId(value, code, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new CodeExecutionError(code, `${label} 不安全`);
  }
  return value;
}

export function validateWorkspaceId(value) {
  return validateId(value, "INVALID_WORKSPACE_ID", "workspaceId");
}

export function validateExecutionId(value) {
  return validateId(value, "INVALID_EXECUTION_ID", "executionId");
}

export function normalizeWorkspacePath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string" || value.includes("\0")) throw invalidPath();
  if (value === "") {
    if (allowRoot) return "";
    throw invalidPath();
  }
  if (/^[\\/]/.test(value) || /^[a-z]:/i.test(value)) throw invalidPath();

  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      /[. ]$/.test(segment) ||
      WINDOWS_DEVICE_NAME.test(segment)
    ) {
      throw invalidPath();
    }
  }
  return segments.join("/");
}

function pathIncludes(parent, candidate) {
  const comparableParent =
    process.platform === "win32" ? parent.toLowerCase() : parent;
  const comparableCandidate =
    process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return (
    comparableCandidate === comparableParent ||
    comparableCandidate.startsWith(`${comparableParent}/`)
  );
}

function isDefaultExcluded(relativePath) {
  return relativePath.split("/").some((segment) => {
    const name = segment.toLowerCase();
    return (
      DEFAULT_EXCLUDED_SEGMENTS.has(name) ||
      DEFAULT_EXCLUDED_FILES.has(name) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      name.startsWith(".code-broker-tmp-") ||
      name.endsWith(".pem") ||
      name.endsWith(".key")
    );
  });
}

export class CodeExecutionPolicy {
  constructor({ writablePaths = [], excludePaths = [] } = {}) {
    this.writablePaths = writablePaths.map((value) =>
      normalizeWorkspacePath(value),
    );
    this.excludePaths = excludePaths.map((value) =>
      normalizeWorkspacePath(value),
    );
  }

  isExcluded(relativePath) {
    if (relativePath === "") return false;
    return (
      isDefaultExcluded(relativePath) ||
      this.excludePaths.some((excluded) => pathIncludes(excluded, relativePath))
    );
  }

  assertAccessible(value, options = {}) {
    const relativePath = normalizeWorkspacePath(value, options);
    if (this.isExcluded(relativePath)) {
      throw new CodeExecutionError("PATH_EXCLUDED", "该工作区路径不可访问");
    }
    return relativePath;
  }

  assertWritable(value) {
    const relativePath = this.assertAccessible(value);
    const allowed = this.writablePaths.some((writable) =>
      pathIncludes(writable, relativePath),
    );
    if (!allowed) {
      throw new CodeExecutionError("WRITE_NOT_ALLOWED", "该工作区路径不可写");
    }
    return relativePath;
  }
}
