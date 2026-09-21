import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  CodeExecutionPolicy,
  normalizeWorkspacePath,
} from "../domain/code-execution-policy.js";
import { normalizeCodeExecutionSource } from "../domain/code-execution-source.js";
import { normalizeChangePackageManifest } from "../domain/change-package-contract.js";
import {
  createControlledCommitMessage,
  normalizeControlledCommitEvidence,
  sameControlledCommitEvidence,
} from "../domain/controlled-commit-evidence.js";
import {
  createConflictPreparationBinding,
  normalizeConflictPreparationBinding,
  sameConflictPreparationBinding,
} from "../domain/conflict-preparation-binding.js";
import { normalizePullRequestGitTarget } from "../domain/git-tool-contract.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "../lib/canonical-json-digest.js";
import {
  CONTROLLED_COMMIT_ID,
  CONTROLLED_COMMIT_SCRATCH_PREFIX,
  ControlledGitCommitBuilder,
} from "./controlled-git-commit-builder.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u;
const GITHUB_ACTION_MARKER =
  /^<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u;
const PUBLICATION_CREDENTIAL = /^[^\s\u0000-\u001f\u007f]{1,4096}$/u;
const MANIFEST_KIND = "controlled-git-conflict-preparation";
const DEFAULT_COMMIT_IDENTITY = Object.freeze({
  name: "MyDashboard PR Engineer",
  email: "pr-engineer@mydashboard.local",
  timezone: "+0000",
});
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "gitTarget",
  "baseBoundary",
  "headBoundary",
  "gitExecutable",
  "status",
  "mergeBaseOid",
  "resultTreeOid",
  "conflicts",
  "treeEntries",
  "resultObjects",
  "resultObjectDigest",
  "boundaryDigest",
  "evidenceDigest",
  "materialization",
]);
const BOUNDARY_KEYS = Object.freeze([
  "schemaVersion",
  "repository",
  "canonicalRoot",
  "objectDirectory",
  "objectFormat",
  "oidLength",
  "commitOid",
  "boundaryDigest",
]);
const DEFAULT_LIMITS = Object.freeze({
  maxConflicts: 32,
  maxFiles: 5_000,
  maxObjectFiles: 10_000,
  maxDirectories: 10_000,
  maxBlobBytes: 1_000_000,
  maxTotalBytes: 8_000_000,
  maxResultObjectBytes: 32_000_000,
  maxProtocolBytes: 1_000_000,
  maxManifestBytes: 16_000_000,
  maxPathBytes: 4_096,
  maxPathDepth: 128,
  maxSegmentBytes: 255,
  timeoutMs: 30_000,
});
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const SAFE_GIT_PREFIX = Object.freeze([
  "--no-lazy-fetch",
  "--no-pager",
  "--no-replace-objects",
  "-c",
  "core.longpaths=true",
]);
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const CODE_JOB_PATH_POLICY = new CodeExecutionPolicy();

export class ControlledGitServiceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlledGitServiceError";
    this.code = code;
  }
}

function controlledGitError(code, message, cause) {
  return new ControlledGitServiceError(code, message, { cause });
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactDataObject(value, keys, code = "INVALID_CONTROLLED_GIT_REQUEST") {
  if (!isPlainRecord(value)) {
    throw controlledGitError(code, "Controlled Git 请求无效");
  }
  const fields = new Map();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    throw controlledGitError(code, "Controlled Git 请求无效");
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw controlledGitError(code, "Controlled Git 请求无效");
    }
    fields.set(key, descriptor.value);
  }
  if (keys.some((key) => !fields.has(key))) {
    throw controlledGitError(code, "Controlled Git 请求无效");
  }
  return fields;
}

function dataObject(value, { allowed, required = allowed, code, message }) {
  if (!isPlainRecord(value)) throw controlledGitError(code, message);
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw controlledGitError(code, message);
    }
    fields.set(key, descriptor.value);
  }
  if (required.some((key) => !fields.has(key))) {
    throw controlledGitError(code, message);
  }
  return fields;
}

function bindDataMethod(port, name) {
  if (port === null || typeof port !== "object" || utilTypes.isProxy(port)) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_CONFIG",
      "Controlled Git dependency 无效",
    );
  }
  let current = port;
  while (current !== null) {
    if (utilTypes.isProxy(current)) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_CONFIG",
        "Controlled Git dependency 无效",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw controlledGitError(
          "INVALID_CONTROLLED_GIT_CONFIG",
          "Controlled Git dependency method 无效",
        );
      }
      return descriptor.value.bind(port);
    }
    current = Object.getPrototypeOf(current);
  }
  throw controlledGitError(
    "INVALID_CONTROLLED_GIT_CONFIG",
    "Controlled Git dependency method 缺失",
  );
}

function exactArray(value, code) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw controlledGitError(code, "Controlled Git preparation 已损坏");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw controlledGitError(code, "Controlled Git preparation 已损坏");
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw controlledGitError(code, "Controlled Git preparation 已损坏");
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function normalizeMaterializationExcludePaths(value) {
  const entries = exactArray(value, "INVALID_CONTROLLED_GIT_REQUEST");
  let policy;
  try {
    policy = new CodeExecutionPolicy({ excludePaths: entries });
  } catch (cause) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "excludePaths 无效",
      cause,
    );
  }
  const portablePaths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const normalized = policy.excludePaths[index];
    const portable = normalized.toLowerCase();
    if (entries[index] !== normalized || portablePaths.has(portable)) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "excludePaths 无效",
      );
    }
    portablePaths.add(portable);
  }
  return Object.freeze([...policy.excludePaths]);
}

function validateLimits(value) {
  if (!isPlainRecord(value)) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_CONFIG",
      "Controlled Git limits 无效",
    );
  }
  const allowed = Object.keys(DEFAULT_LIMITS);
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_CONFIG",
        "Controlled Git limits 无效",
      );
    }
    fields.set(key, descriptor.value);
  }
  const limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(fields) };
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_CONFIG",
        "Controlled Git limits 无效",
      );
    }
  }
  if (limits.maxBlobBytes > limits.maxTotalBytes) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_CONFIG",
      "Controlled Git limits 无效",
    );
  }
  return Object.freeze(limits);
}

function requireAbsolutePath(value, code, message) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw controlledGitError(code, message);
  }
  return path.resolve(value);
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDescendantPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return (
    samePath(left, right) ||
    isDescendantPath(left, right) ||
    isDescendantPath(right, left)
  );
}

function isNetworkPath(value) {
  if (process.platform !== "win32") return false;
  const normalized = path.win32.normalize(value).toLowerCase();
  return normalized.startsWith("\\\\") || normalized.startsWith("\\\\?\\unc\\");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function oidPattern(oidLength) {
  return oidLength === 40 ? SHA1 : SHA256;
}

function sameCanonicalValue(left, right) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function decodeUtf8(value, code, message) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw controlledGitError(code, message, cause);
  }
}

function bytesFromOutput(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function checkedProcessOutput(result, allowedExitCodes, maximumBytes) {
  const fields = dataObject(result, {
    allowed: [
      "exitCode",
      "signal",
      "stdout",
      "stderr",
      "truncated",
      "durationMs",
    ],
    required: ["exitCode", "signal", "stdout", "stderr", "truncated"],
    code: "CONTROLLED_GIT_PROCESS_FAILED",
    message: "Controlled Git 命令返回了无效结果",
  });
  const stdout = bytesFromOutput(fields.get("stdout"));
  const stderr = bytesFromOutput(fields.get("stderr"));
  if (
    !allowedExitCodes.includes(fields.get("exitCode")) ||
    fields.get("signal") !== null ||
    fields.get("truncated") !== false ||
    stdout === null ||
    stderr === null ||
    stdout.length > maximumBytes ||
    stderr.length !== 0
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROCESS_FAILED",
      "Controlled Git 命令执行失败",
    );
  }
  return { exitCode: fields.get("exitCode"), stdout };
}

function parseSingleOid(bytes, oidLength, code) {
  const text = decodeUtf8(bytes, code, "Git object id 输出不是 UTF-8");
  const value = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (/\r|\n/u.test(value) || !oidPattern(oidLength).test(value)) {
    throw controlledGitError(code, "Git 必须返回唯一 object id");
  }
  return value;
}

function parseMergeBase(bytes, exitCode, oidLength) {
  const text = decodeUtf8(
    bytes,
    "CONTROLLED_GIT_PROTOCOL_ERROR",
    "git merge-base 输出不是 UTF-8",
  );
  const normalized = text.replace(/\r\n/gu, "\n");
  if (exitCode === 1) {
    if (normalized.length !== 0) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "Unrelated merge-base 输出必须为空",
      );
    }
    throw controlledGitError(
      "CONTROLLED_GIT_UNRELATED_HISTORY",
      "Base 与 Head histories 不相关",
    );
  }
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (
    lines.length === 0 ||
    lines.some((entry) => !oidPattern(oidLength).test(entry))
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "git merge-base 输出无效",
    );
  }
  if (lines.length !== 1) {
    throw controlledGitError(
      "CONTROLLED_GIT_MULTIPLE_MERGE_BASES",
      "首版不支持 multiple merge bases",
    );
  }
  return lines[0];
}

function normalizeConflictPath(value, limits) {
  let normalized;
  try {
    normalized = normalizeWorkspacePath(value);
  } catch (cause) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
      "Git conflict 路径不安全",
      cause,
    );
  }
  const segments = normalized.split("/");
  if (
    normalized !== value ||
    normalized.normalize("NFC") !== normalized ||
    Buffer.byteLength(normalized, "utf8") > limits.maxPathBytes ||
    segments.length > limits.maxPathDepth ||
    segments.some(
      (segment) =>
        Buffer.byteLength(segment, "utf8") > limits.maxSegmentBytes ||
        segment.toLowerCase() === ".git",
    )
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
      "Git conflict 路径不安全",
    );
  }
  return normalized;
}

function parseMergeTree(bytes, exitCode, oidLength, limits) {
  const text = decodeUtf8(
    bytes,
    "CONTROLLED_GIT_PROTOCOL_ERROR",
    "git merge-tree 输出不是 UTF-8",
  );
  if (!text.endsWith("\0")) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "git merge-tree 输出缺少 NUL framing",
    );
  }
  const records = text.split("\0");
  if (records.pop() !== "") {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "git merge-tree 输出 framing 无效",
    );
  }
  const resultTreeOid = records.shift();
  if (!oidPattern(oidLength).test(resultTreeOid ?? "")) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "git merge-tree result tree 无效",
    );
  }
  if ((exitCode === 0) !== (records.length === 0)) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "git merge-tree exit status 与 conflict records 不一致",
    );
  }
  if (records.length === 0) {
    return { status: "clean", resultTreeOid, conflicts: [] };
  }
  if (records.length % 3 !== 0 || records.length / 3 > limits.maxConflicts) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
      "Git conflict 数量或 stage 结构不受支持",
    );
  }
  const parsed = records.map((record) => {
    const match = record.match(
      /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([^\0]+)$/u,
    );
    if (!match || !oidPattern(oidLength).test(match[2])) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "git merge-tree conflict record 无效",
      );
    }
    return {
      mode: match[1],
      oid: match[2],
      stage: Number(match[3]),
      path: normalizeConflictPath(match[4], limits),
    };
  });
  const conflicts = [];
  let previousComparablePath = null;
  for (let index = 0; index < parsed.length; index += 3) {
    const stages = parsed.slice(index, index + 3);
    const conflictPath = stages[0].path;
    const comparablePath = process.platform === "win32"
      ? conflictPath.toLowerCase()
      : conflictPath;
    if (
      stages.some(
        (stage, stageIndex) =>
          stage.path !== conflictPath ||
          stage.stage !== stageIndex + 1 ||
          stage.mode !== "100644",
      ) ||
      (previousComparablePath !== null &&
        comparablePath.localeCompare(previousComparablePath, "en") <= 0)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
        "仅支持排序后的 ordinary 100644 both-modified conflicts",
      );
    }
    previousComparablePath = comparablePath;
    conflicts.push({ path: conflictPath, mode: "100644", stages });
  }
  return { status: "conflicted", resultTreeOid, conflicts };
}

function splitNullProtocol(bytes, code, message) {
  if (bytes.length === 0) return [];
  const text = decodeUtf8(bytes, code, message);
  if (!text.endsWith("\0")) throw controlledGitError(code, message);
  const records = text.split("\0");
  records.pop();
  return records;
}

function parseRawDiff(bytes, oidLength, limits) {
  const records = splitNullProtocol(
    bytes,
    "CONTROLLED_GIT_PROTOCOL_ERROR",
    "git diff-tree 输出 framing 无效",
  );
  const changes = [];
  for (let index = 0; index < records.length;) {
    const header = records[index];
    index += 1;
    const match = header.match(
      /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([A-Z][0-9]*)$/u,
    );
    if (!match || index >= records.length) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "git diff-tree raw record 无效",
      );
    }
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    if (
      status !== "M" ||
      oldMode !== "100644" ||
      newMode !== "100644" ||
      !oidPattern(oidLength).test(oldOid) ||
      !oidPattern(oidLength).test(newOid)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
        "首版仅支持 ordinary 100644 content modifications",
      );
    }
    const relativePath = normalizeConflictPath(records[index], limits);
    index += 1;
    changes.push({ path: relativePath, oldOid, newOid });
  }
  const paths = changes.map(({ path: relativePath }) => relativePath);
  if (new Set(paths).size !== paths.length || paths.length > limits.maxFiles) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
      "Git changed paths 无效或超过限制",
    );
  }
  return changes;
}

function parseNumstat(bytes, limits) {
  const records = splitNullProtocol(
    bytes,
    "CONTROLLED_GIT_PROTOCOL_ERROR",
    "git diff --numstat 输出 framing 无效",
  );
  return records.map((record) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(record);
    if (!match) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "git diff --numstat record 无效",
      );
    }
    if (match[1] === "-" || match[2] === "-") {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
        "Binary Git changes 不受支持",
      );
    }
    const added = Number(match[1]);
    const deleted = Number(match[2]);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "git diff --numstat 数量无效",
      );
    }
    return {
      path: normalizeConflictPath(match[3], limits),
      added,
      deleted,
    };
  });
}

function assertMatchingChanges(rawChanges, numstatChanges) {
  const rawPaths = rawChanges.map(({ path: relativePath }) => relativePath);
  const numstatPaths = numstatChanges.map(({ path: relativePath }) => relativePath);
  if (
    rawPaths.length !== numstatPaths.length ||
    rawPaths.some((relativePath, index) => relativePath !== numstatPaths[index])
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_PROTOCOL_ERROR",
      "Git raw diff 与 numstat 不一致",
    );
  }
}

function parseResultTree(bytes, oidLength, limits) {
  const records = splitNullProtocol(
    bytes,
    "CONTROLLED_GIT_PROTOCOL_ERROR",
    "git ls-tree 输出 framing 无效",
  );
  if (records.length > limits.maxFiles) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_TREE",
      "Git result tree 文件数超过限制",
    );
  }
  const entries = records.map((record) => {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(record);
    if (
      !match ||
      match[1] !== "100644" ||
      match[2] !== "blob" ||
      !oidPattern(oidLength).test(match[3])
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_TREE",
        "Result tree 仅允许 ordinary 100644 blobs",
      );
    }
    const relativePath = normalizeConflictPath(match[4], limits);
    if (CODE_JOB_PATH_POLICY.isExcluded(relativePath)) {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_TREE",
        "Result tree 包含 Code Job 默认排除路径",
      );
    }
    return {
      path: relativePath,
      mode: "100644",
      oid: match[3],
    };
  });
  let previous = null;
  for (const entry of entries) {
    const comparable = process.platform === "win32"
      ? entry.path.toLowerCase()
      : entry.path;
    if (previous !== null && comparable.localeCompare(previous, "en") <= 0) {
      throw controlledGitError(
        "CONTROLLED_GIT_UNSUPPORTED_TREE",
        "Result tree 路径排序或文件系统身份冲突",
      );
    }
    previous = comparable;
  }
  return entries;
}

function gitBlobOid(objectFormat, bytes) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameStableIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

async function executableIdentity(gitCommand) {
  let initial;
  try {
    initial = await lstat(gitCommand);
  } catch (cause) {
    throw controlledGitError(
      "CONTROLLED_GIT_EXECUTABLE_UNTRUSTED",
      "Git executable 不可用",
      cause,
    );
  }
  let canonical;
  try {
    canonical = await realpath(gitCommand);
  } catch (cause) {
    throw controlledGitError(
      "CONTROLLED_GIT_EXECUTABLE_UNTRUSTED",
      "Git executable identity 不可用",
      cause,
    );
  }
  const windowsSegments = path.win32.normalize(canonical).toLowerCase().split("\\");
  const permissions = initial.mode & 0o7777;
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size < 1 ||
    initial.size > MAX_GIT_EXECUTABLE_BYTES ||
    !samePath(canonical, gitCommand) ||
    (process.platform !== "win32" &&
      ((permissions & 0o111) === 0 || (permissions & 0o7022) !== 0)) ||
    (process.platform === "win32" &&
      !(windowsSegments.at(-1) === "git.exe" &&
        windowsSegments.at(-2) === "bin" &&
        /^mingw(?:32|64)$/u.test(windowsSegments.at(-3) ?? "")))
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_EXECUTABLE_UNTRUSTED",
      "Git executable identity 不受信任",
    );
  }
  const bytes = await readFile(canonical);
  const final = await lstat(canonical);
  if (!sameFileIdentity(initial, final) || bytes.length !== initial.size) {
    throw controlledGitError(
      "CONTROLLED_GIT_EXECUTABLE_CHANGED",
      "Git executable 在身份检查期间发生变化",
    );
  }
  return deepFreeze({
    path: canonical,
    sha256: sha256(bytes),
    bytes: bytes.length,
    mode: permissions,
    uid: final.uid,
    gid: final.gid,
  });
}

function normalizeBoundary(value, expected) {
  const fields = exactDataObject(
    value,
    BOUNDARY_KEYS,
    "CONTROLLED_GIT_BOUNDARY_INVALID",
  );
  const oidLength = fields.get("oidLength");
  const objectFormat = fields.get("objectFormat");
  const canonicalRoot = requireAbsolutePath(
    fields.get("canonicalRoot"),
    "CONTROLLED_GIT_BOUNDARY_INVALID",
    "Mirror canonicalRoot 无效",
  );
  const objectDirectory = requireAbsolutePath(
    fields.get("objectDirectory"),
    "CONTROLLED_GIT_BOUNDARY_INVALID",
    "Mirror objectDirectory 无效",
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    fields.get("repository") !== expected.repository ||
    !samePath(canonicalRoot, expected.mirrorRoot) ||
    !isDescendantPath(canonicalRoot, objectDirectory) ||
    !((objectFormat === "sha1" && oidLength === 40) ||
      (objectFormat === "sha256" && oidLength === 64)) ||
    fields.get("commitOid") !== expected.expectedCommitOid ||
    !oidPattern(oidLength).test(fields.get("commitOid")) ||
    !SHA256.test(fields.get("boundaryDigest"))
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_BOUNDARY_INVALID",
      "Mirror preflight 证明无效",
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    repository: fields.get("repository"),
    canonicalRoot,
    objectDirectory,
    objectFormat,
    oidLength,
    commitOid: fields.get("commitOid"),
    boundaryDigest: fields.get("boundaryDigest"),
  });
}

function assertSeparateBoundaries(
  base,
  head,
  preparationRoot,
  gitExecutablePath,
) {
  if (
    base.objectFormat !== head.objectFormat ||
    base.oidLength !== head.oidLength
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_OBJECT_FORMAT_MISMATCH",
      "Base 与 Head object format 不一致",
    );
  }
  const crossPairs = [
    [base.canonicalRoot, head.canonicalRoot],
    [base.canonicalRoot, head.objectDirectory],
    [base.objectDirectory, head.canonicalRoot],
    [base.objectDirectory, head.objectDirectory],
  ];
  if (
    crossPairs.some(([left, right]) => pathsOverlap(left, right)) ||
    [base.canonicalRoot, base.objectDirectory, head.canonicalRoot, head.objectDirectory]
      .some(
        (source) =>
          pathsOverlap(source, preparationRoot) ||
          pathsOverlap(source, gitExecutablePath),
      ) ||
    pathsOverlap(preparationRoot, gitExecutablePath)
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_BOUNDARY_OVERLAP",
      "Controlled Git 的 mirror、preparation root 与 Git executable 必须隔离",
    );
  }
}

function validatedBlob(bytes, oid, limits, objectFormat) {
  if (
    bytes.length > limits.maxBlobBytes ||
    bytes.includes(0) ||
    gitBlobOid(objectFormat, bytes) !== oid
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
      "Conflict blob 是 binary 或超过限制",
    );
  }
  decodeUtf8(
    bytes,
    "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
    "Conflict blob 不是 UTF-8",
  );
  return deepFreeze({
    oid,
    byteLength: bytes.length,
    sha256: sha256(bytes),
  });
}

function normalizeExecutableEvidence(value, code) {
  const fields = exactDataObject(
    value,
    ["path", "sha256", "bytes", "mode", "uid", "gid"],
    code,
  );
  const executablePath = requireAbsolutePath(
    fields.get("path"),
    code,
    "Git executable path 无效",
  );
  if (
    !SHA256.test(fields.get("sha256")) ||
    !Number.isSafeInteger(fields.get("bytes")) ||
    fields.get("bytes") < 1 ||
    fields.get("bytes") > MAX_GIT_EXECUTABLE_BYTES ||
    !Number.isSafeInteger(fields.get("mode")) ||
    fields.get("mode") < 0 ||
    fields.get("mode") > 0o7777 ||
    !Number.isSafeInteger(fields.get("uid")) ||
    fields.get("uid") < 0 ||
    !Number.isSafeInteger(fields.get("gid")) ||
    fields.get("gid") < 0
  ) {
    throw controlledGitError(code, "Git executable evidence 无效");
  }
  return deepFreeze({
    path: executablePath,
    sha256: fields.get("sha256"),
    bytes: fields.get("bytes"),
    mode: fields.get("mode"),
    uid: fields.get("uid"),
    gid: fields.get("gid"),
  });
}

function normalizeFileEvidence(value, keys, { oidLength, limits, code }) {
  const fields = exactDataObject(value, keys, code);
  if (
    !Number.isSafeInteger(fields.get("byteLength")) ||
    fields.get("byteLength") < 0 ||
    fields.get("byteLength") > limits.maxBlobBytes ||
    !SHA256.test(fields.get("sha256")) ||
    (keys.includes("oid") && !oidPattern(oidLength).test(fields.get("oid")))
  ) {
    throw controlledGitError(code, "File evidence 无效");
  }
  return fields;
}

function publicPreparation(manifest) {
  return deepFreeze({
    schemaVersion: 1,
    preparationId: manifest.preparationId,
    status: manifest.status,
    baseCommitOid: manifest.gitTarget.baseRefOid,
    headCommitOid: manifest.gitTarget.headRefOid,
    mergeBaseOid: manifest.mergeBaseOid,
    resultTreeOid: manifest.resultTreeOid,
    conflicts: manifest.conflicts.map(({ path: conflictPath, mode }) => ({
      path: conflictPath,
      mode,
    })),
    boundaryDigest: manifest.boundaryDigest,
    evidenceDigest: manifest.evidenceDigest,
    resultObjectDigest: manifest.resultObjectDigest,
    materialization: manifest.materialization,
  });
}

function canonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "Controlled commit createdAt 无效",
    );
  }
  return value;
}

function normalizeCommitIdentity(value) {
  const fields = exactDataObject(
    value,
    ["name", "email", "timezone"],
    "INVALID_CONTROLLED_GIT_CONFIG",
  );
  const name = fields.get("name");
  const email = fields.get("email");
  const timezone = fields.get("timezone");
  const timezoneMatch = typeof timezone === "string"
    ? /^([+-])(\d{2})(\d{2})$/u.exec(timezone)
    : null;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > 128 ||
    /[<>\0\r\n]/u.test(name) ||
    typeof email !== "string" ||
    Buffer.byteLength(email, "utf8") > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(email) ||
    timezoneMatch === null ||
    Number(timezoneMatch[2]) > 14 ||
    Number(timezoneMatch[3]) > 59 ||
    (Number(timezoneMatch[2]) === 14 && Number(timezoneMatch[3]) !== 0)
  ) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_CONFIG",
      "Controlled commit identity 无效",
    );
  }
  return Object.freeze({ name, email, timezone });
}

function normalizeControlledCommitBlobs(value, manifest, limits) {
  const entries = exactArray(value, "INVALID_CONTROLLED_GIT_REQUEST");
  const references = new Map(
    [...manifest.changes.created, ...manifest.changes.modified]
      .map(({ blob }) => [blob.sha256, blob.bytes]),
  );
  if (entries.length !== references.size || entries.length > limits.maxFiles) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "Controlled commit blobs 未精确覆盖 change package",
    );
  }
  const blobs = [];
  let totalBytes = 0;
  const seen = new Set();
  for (const entry of entries) {
    const fields = exactDataObject(
      entry,
      ["sha256", "content"],
      "INVALID_CONTROLLED_GIT_REQUEST",
    );
    const digest = fields.get("sha256");
    const contentValue = fields.get("content");
    if (
      !SHA256.test(digest) ||
      seen.has(digest) ||
      !(Buffer.isBuffer(contentValue) || contentValue instanceof Uint8Array)
    ) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "Controlled commit blob 无效",
      );
    }
    const content = Buffer.from(contentValue);
    totalBytes += content.length;
    if (
      references.get(digest) !== content.length ||
      sha256(content) !== digest ||
      content.length > limits.maxBlobBytes ||
      totalBytes > limits.maxTotalBytes
    ) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "Controlled commit blob 与 change package 不一致",
      );
    }
    seen.add(digest);
    blobs.push({ sha256: digest, content });
  }
  if ([...references.keys()].some((digest) => !seen.has(digest))) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "Controlled commit blobs 未精确覆盖 change package",
    );
  }
  blobs.sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
  return blobs;
}

function normalizeControlledCommitRequest(value, limits) {
  const fields = exactDataObject(value, [
    "executionSource",
    "manifest",
    "blobs",
    "createdAt",
  ]);
  let executionSource;
  let manifest;
  let message;
  try {
    executionSource = normalizeCodeExecutionSource(fields.get("executionSource"));
    manifest = normalizeChangePackageManifest(fields.get("manifest"));
    message = createControlledCommitMessage({
      executionSource,
      manifest,
    });
  } catch (cause) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "Controlled commit source 或 change package 无效",
      cause,
    );
  }
  return {
    executionSource,
    manifest,
    blobs: normalizeControlledCommitBlobs(fields.get("blobs"), manifest, limits),
    createdAt: canonicalTimestamp(fields.get("createdAt")),
    message,
  };
}

function normalizeControlledCommitLookup(value) {
  const fields = exactDataObject(value, [
    "executionSource",
    "manifest",
    "createdAt",
  ]);
  let executionSource;
  let manifest;
  try {
    executionSource = normalizeCodeExecutionSource(fields.get("executionSource"));
    manifest = normalizeChangePackageManifest(fields.get("manifest"));
    createControlledCommitMessage({ executionSource, manifest });
  } catch (cause) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_REQUEST",
      "Controlled commit lookup source 或 change package 无效",
      cause,
    );
  }
  return {
    executionSource,
    manifest,
    createdAt: canonicalTimestamp(fields.get("createdAt")),
  };
}

function normalizeControlledCommitPublicationAction(value) {
  const fields = exactDataObject(
    value,
    [
      "type",
      "expectedOldOid",
      "remote",
      "controlledCommitEvidence",
      "inputBinding",
    ],
    "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
  );
  if (fields.get("type") !== "pull_request_push") {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Controlled commit publisher 只接受 pull_request_push",
    );
  }
  const remoteFields = exactDataObject(
    fields.get("remote"),
    ["repository", "refName"],
    "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
  );
  let inputBinding;
  let evidence;
  try {
    if (!isPlainRecord(fields.get("inputBinding"))) throw new TypeError();
    inputBinding = normalizePullRequestExecutionBinding(
      fields.get("inputBinding"),
    );
    evidence = normalizeControlledCommitEvidence(
      fields.get("controlledCommitEvidence"),
    );
  } catch (cause) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Controlled commit publication binding 无效",
      cause,
    );
  }
  if (inputBinding.schemaVersion !== 2) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Controlled commit publication 需要 v2 PR binding",
    );
  }
  const target = inputBinding.gitTarget;
  if (
    fields.get("expectedOldOid") !== target.headRefOid ||
    remoteFields.get("repository") !== target.headRepository ||
    remoteFields.get("refName") !== target.headRefName ||
    !samePullRequestExecutionBinding(
      evidence.executionSource.inputBinding,
      inputBinding,
    ) ||
    evidence.commit.parents[0] !== target.headRefOid ||
    evidence.commit.parents[1] !== target.baseRefOid
  ) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Controlled commit publication 未精确绑定 sealed commit 与 PR Head",
    );
  }
  return {
    type: "pull_request_push",
    expectedOldOid: target.headRefOid,
    remote: {
      repository: target.headRepository,
      refName: target.headRefName,
    },
    controlledCommitEvidence: evidence,
    inputBinding,
  };
}

function normalizeControlledCommitPublicationRequest(value) {
  const fields = exactDataObject(
    value,
    [
      "credential",
      "actorAccountId",
      "repository",
      "pullRequestNumber",
      "marker",
      "action",
    ],
    "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
  );
  const credential = fields.get("credential");
  const actorAccountId = fields.get("actorAccountId");
  const repository = fields.get("repository");
  const pullRequestNumber = fields.get("pullRequestNumber");
  const marker = fields.get("marker");
  if (
    typeof credential !== "string" ||
    !PUBLICATION_CREDENTIAL.test(credential) ||
    typeof actorAccountId !== "string" ||
    !GITHUB_LOGIN.test(actorAccountId) ||
    actorAccountId.includes("--") ||
    typeof repository !== "string" ||
    !GITHUB_REPOSITORY.test(repository) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    Object.is(pullRequestNumber, -0) ||
    pullRequestNumber < 1 ||
    typeof marker !== "string" ||
    !GITHUB_ACTION_MARKER.test(marker)
  ) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Controlled commit publication request 无效",
    );
  }
  const action = normalizeControlledCommitPublicationAction(
    fields.get("action"),
  );
  const target = action.inputBinding.gitTarget;
  if (
    repository !== action.inputBinding.repository ||
    pullRequestNumber !== action.inputBinding.pullRequestNumber ||
    actorAccountId.toLowerCase() !== target.sourceAccountId.toLowerCase()
  ) {
    throw controlledGitError(
      "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
      "Publisher actor、PR target 与 action binding 不一致",
    );
  }
  return {
    credential,
    actorAccountId: actorAccountId.toLowerCase(),
    repository,
    pullRequestNumber,
    marker,
    action,
  };
}

function publicationResult(status, commitOid = null) {
  if (["applied", "already"].includes(status)) {
    return deepFreeze({ status, receipt: { id: commitOid } });
  }
  if (status === "stale") return Object.freeze({ status: "stale" });
  return Object.freeze({
    status: "unknown",
    code: "CONTROLLED_GIT_PUBLISH_OUTCOME_UNKNOWN",
  });
}

function publicationProcessResult(value, maximumBytes) {
  const fields = dataObject(value, {
    allowed: [
      "exitCode",
      "signal",
      "stdout",
      "stderr",
      "truncated",
      "durationMs",
    ],
    required: ["exitCode", "signal", "stdout", "stderr", "truncated"],
    code: "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
    message: "Controlled Git publication process result 无效",
  });
  const stdout = bytesFromOutput(fields.get("stdout"));
  const stderr = bytesFromOutput(fields.get("stderr"));
  if (
    !Number.isSafeInteger(fields.get("exitCode")) ||
    fields.get("signal") !== null ||
    fields.get("truncated") !== false ||
    stdout === null ||
    stderr === null ||
    stdout.length > maximumBytes ||
    stderr.length > maximumBytes
  ) {
    throw controlledGitError(
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
      "Controlled Git publication process result 无效",
    );
  }
  return { exitCode: fields.get("exitCode"), stdout, stderr };
}

function parsePublishedHead(result, refName, oidLength) {
  if (
    result.exitCode === 2 &&
    result.stdout.length === 0 &&
    result.stderr.length === 0
  ) {
    return null;
  }
  if (result.exitCode !== 0 || result.stderr.length !== 0) return undefined;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    return undefined;
  }
  const normalized = text.replace(/\r\n/gu, "\n");
  const suffix = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (suffix.includes("\n")) return undefined;
  const separator = suffix.indexOf("\t");
  if (separator < 1 || suffix.indexOf("\t", separator + 1) !== -1) {
    return undefined;
  }
  const oid = suffix.slice(0, separator);
  return oidPattern(oidLength).test(oid) &&
      suffix.slice(separator + 1) === refName
    ? oid
    : undefined;
}

class BinaryExecFileRunner {
  async run({ command, args, cwd, env, input, timeoutMs, maxOutputBytes }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(
          command,
          args,
          {
            cwd,
            env,
            encoding: "buffer",
            killSignal: "SIGKILL",
            maxBuffer: maxOutputBytes,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(
                controlledGitError(
                  error.killed
                    ? "CONTROLLED_GIT_TIMEOUT"
                    : "CONTROLLED_GIT_OUTPUT_LIMIT",
                  "Controlled Git 命令超过资源限制",
                  error,
                ),
              );
              return;
            }
            resolve({
              exitCode: error
                ? Number.isSafeInteger(error.code)
                  ? error.code
                  : -1
                : 0,
              signal: error?.signal ?? null,
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
              stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
              truncated: false,
            });
          },
        );
      } catch (cause) {
        reject(
          controlledGitError(
            "CONTROLLED_GIT_PROCESS_FAILED",
            "Controlled Git 命令无法启动",
            cause,
          ),
        );
        return;
      }
      child.stdin?.once("error", (error) => {
        if (error?.code !== "EPIPE") child.kill("SIGKILL");
      });
      child.stdin?.end(input);
    });
  }
}

export class ControlledGitService {
  #commitBuilder;
  #commitIdentity;
  #gitCommand;
  #mirrorInspector;
  #preparationRoot;
  #run;
  #limits;

  constructor(value = {}) {
    const fields = dataObject(value, {
      allowed: [
        "gitCommand",
        "mirrorInspector",
        "preparationRoot",
        "processRunner",
        "limits",
        "commitIdentity",
      ],
      required: ["gitCommand", "mirrorInspector", "preparationRoot"],
      code: "INVALID_CONTROLLED_GIT_CONFIG",
      message: "Controlled Git config 无效",
    });
    const gitCommand = fields.get("gitCommand");
    const mirrorInspector = fields.get("mirrorInspector");
    const preparationRoot = fields.get("preparationRoot");
    const processRunner = fields.has("processRunner")
      ? fields.get("processRunner")
      : new BinaryExecFileRunner();
    const limits = fields.has("limits") ? fields.get("limits") : {};
    const commitIdentity = fields.has("commitIdentity")
      ? fields.get("commitIdentity")
      : DEFAULT_COMMIT_IDENTITY;
    this.#gitCommand = requireAbsolutePath(
      gitCommand,
      "INVALID_CONTROLLED_GIT_CONFIG",
      "gitCommand 必须是可信的绝对路径",
    );
    this.#preparationRoot = requireAbsolutePath(
      preparationRoot,
      "INVALID_CONTROLLED_GIT_CONFIG",
      "preparationRoot 必须是绝对路径",
    );
    if (
      isNetworkPath(this.#gitCommand) ||
      isNetworkPath(this.#preparationRoot) ||
      pathsOverlap(this.#gitCommand, this.#preparationRoot) ||
      mirrorInspector === null ||
      typeof mirrorInspector !== "object" ||
      processRunner === null ||
      typeof processRunner !== "object"
    ) {
      throw controlledGitError(
        pathsOverlap(this.#gitCommand, this.#preparationRoot)
          ? "CONTROLLED_GIT_BOUNDARY_OVERLAP"
          : "INVALID_CONTROLLED_GIT_CONFIG",
        "Controlled Git dependencies 无效",
      );
    }
    this.#mirrorInspector = bindDataMethod(mirrorInspector, "preflight");
    this.#run = bindDataMethod(processRunner, "run");
    this.#limits = validateLimits(limits);
    this.#commitIdentity = normalizeCommitIdentity(commitIdentity);
    this.#commitBuilder = new ControlledGitCommitBuilder({
      preparationRoot: this.#preparationRoot,
      identity: this.#commitIdentity,
      limits: this.#limits,
      fail: controlledGitError,
      assertRoot: () => this.#assertPreparationRoot(),
      verifyPreparation: (executionSource, manifest) =>
        this.#verifiedCommitPreparation(executionSource, manifest),
      normalizeBlobs: (blobs, manifest) =>
        normalizeControlledCommitBlobs(blobs, manifest, this.#limits),
      directoryEvidence: (root, options) =>
        this.#directoryEvidence(root, options),
      createObjectEnvironment: (resultObjects, ...alternates) =>
        this.#gitEnvironment(resultObjects, ...alternates),
      git: Object.freeze({
        readTree: (request) =>
          this.#runControlledCommitGit("read-tree", request),
        hashObject: (request) =>
          this.#runControlledCommitGit("hash-object", request),
        updateIndex: (request) =>
          this.#runControlledCommitGit("update-index", request),
        writeTree: (request) =>
          this.#runControlledCommitGit("write-tree", request),
        commitTree: (request) =>
          this.#runControlledCommitGit("commit-tree", request),
      }),
    });
    Object.freeze(this);
  }

  async inspectConflict(value) {
    const fields = exactDataObject(value, [
      "gitTarget",
      "baseMirrorRoot",
      "headMirrorRoot",
    ]);
    let gitTarget;
    try {
      gitTarget = normalizePullRequestGitTarget(fields.get("gitTarget"));
    } catch (cause) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "gitTarget 无效",
        cause,
      );
    }
    const baseMirrorRoot = requireAbsolutePath(
      fields.get("baseMirrorRoot"),
      "INVALID_CONTROLLED_GIT_REQUEST",
      "baseMirrorRoot 无效",
    );
    const headMirrorRoot = requireAbsolutePath(
      fields.get("headMirrorRoot"),
      "INVALID_CONTROLLED_GIT_REQUEST",
      "headMirrorRoot 无效",
    );
    await this.#assertPreparationRoot();
    const gitExecutable = await executableIdentity(this.#gitCommand);
    const baseRequest = {
      repository: gitTarget.baseRepository,
      mirrorRoot: baseMirrorRoot,
      expectedCommitOid: gitTarget.baseRefOid,
    };
    const headRequest = {
      repository: gitTarget.headRepository,
      mirrorRoot: headMirrorRoot,
      expectedCommitOid: gitTarget.headRefOid,
    };
    const baseBoundary = await this.#preflight(baseRequest);
    const headBoundary = await this.#preflight(headRequest);
    assertSeparateBoundaries(
      baseBoundary,
      headBoundary,
      this.#preparationRoot,
      gitExecutable.path,
    );

    let scratchRoot;
    try {
      scratchRoot = await mkdtemp(
        path.join(this.#preparationRoot, ".controlled-git-scratch-"),
      );
      const manifest = await this.#inspectInScratch({
        gitTarget,
        baseBoundary,
        headBoundary,
        gitExecutable,
        scratchRoot,
      });
      const finalBaseBoundary = await this.#preflight(baseRequest);
      const finalHeadBoundary = await this.#preflight(headRequest);
      if (
        !sameCanonicalValue(finalBaseBoundary, baseBoundary) ||
        !sameCanonicalValue(finalHeadBoundary, headBoundary)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_BOUNDARY_CHANGED",
          "Mirror boundary 在 conflict inspection 期间发生变化",
        );
      }
      if (
        !sameCanonicalValue(
          await executableIdentity(this.#gitCommand),
          gitExecutable,
        )
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_EXECUTABLE_CHANGED",
          "Git executable 在 inspection 期间发生变化",
        );
      }
      const persisted = await this.#persistPreparation(manifest, scratchRoot);
      scratchRoot = undefined;
      return publicPreparation(persisted);
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_INSPECTION_FAILED",
        "Controlled Git conflict inspection 失败",
        cause,
      );
    } finally {
      if (scratchRoot !== undefined) {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    }
  }

  async verifyPreparation(value) {
    const fields = exactDataObject(value, ["preparationId"]);
    const preparationId = fields.get("preparationId");
    if (!SHA256.test(preparationId)) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "preparationId 无效",
      );
    }
    const manifest = await this.#verifiedManifest(preparationId);
    return publicPreparation(manifest);
  }

  async verifyConflictPreparation(value) {
    const fields = exactDataObject(value, ["binding"]);
    let binding;
    try {
      binding = normalizeConflictPreparationBinding(fields.get("binding"));
    } catch (cause) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "Conflict preparation binding 无效",
        cause,
      );
    }
    const manifest = await this.#verifiedManifest(binding.preparationId);
    if (manifest.status !== "conflicted") {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
        "Conflict preparation binding 与 sealed evidence 不一致",
      );
    }
    const expected = createConflictPreparationBinding({
      preparation: publicPreparation(manifest),
      gitTarget: manifest.gitTarget,
    });
    if (!sameConflictPreparationBinding(binding, expected)) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
        "Conflict preparation binding 与 sealed evidence 不一致",
      );
    }
    return deepFreeze(expected);
  }

  async materializeConflictPreparationForCodeJob(value) {
    const fields = exactDataObject(value, [
      "binding",
      "targetRoot",
      "excludePaths",
    ]);
    const excludePaths = normalizeMaterializationExcludePaths(
      fields.get("excludePaths"),
    );
    const binding = await this.verifyConflictPreparation({
      binding: fields.get("binding"),
    });
    const receipt = await this.materializeForCodeJob({
      preparationId: binding.preparationId,
      targetRoot: fields.get("targetRoot"),
      excludePaths,
    });
    return deepFreeze({ ...receipt, binding });
  }

  async materializeForCodeJob(value) {
    const hasExcludePaths = isPlainRecord(value) &&
      Object.hasOwn(value, "excludePaths");
    const fields = exactDataObject(value, [
      "preparationId",
      "targetRoot",
      ...(hasExcludePaths ? ["excludePaths"] : []),
    ]);
    const excludePaths = hasExcludePaths
      ? normalizeMaterializationExcludePaths(fields.get("excludePaths"))
      : Object.freeze([]);
    const materializationPolicy = new CodeExecutionPolicy({ excludePaths });
    const preparationId = fields.get("preparationId");
    const targetRoot = requireAbsolutePath(
      fields.get("targetRoot"),
      "INVALID_CONTROLLED_GIT_REQUEST",
      "targetRoot 无效",
    );
    if (!SHA256.test(preparationId)) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "preparationId 无效",
      );
    }
    const manifest = await this.#verifiedManifest(preparationId);
    const targetBoundary = await this.#assertEmptyTarget(targetRoot, manifest);
    const preparationDirectory = await this.#preparationDirectory(preparationId);
    const createdFiles = [];
    const createdDirectories = { ordered: [], byPath: new Map() };
    const receiptFiles = [];
    let lease;
    let totalBytes = 0;
    try {
      lease = await this.#createMaterializationLease(
        targetBoundary,
        preparationId,
      );
      for (const entry of manifest.treeEntries) {
        if (materializationPolicy.isExcluded(entry.path)) continue;
        await this.#assertMaterializationFence(targetBoundary, lease);
        const content = await this.#readSealedBlob(
          preparationDirectory,
          entry,
          manifest.baseBoundary.objectFormat,
        );
        totalBytes += content.length;
        if (totalBytes > this.#limits.maxTotalBytes) {
          throw controlledGitError(
            "CONTROLLED_GIT_MATERIALIZATION_LIMIT",
            "Conflict marker files 超过总大小限制",
          );
        }
        const parentBoundaries = await this.#createParentDirectories(
          targetRoot,
          entry.path,
          createdDirectories,
          targetBoundary,
          lease,
        );
        const target = path.resolve(targetRoot, ...entry.path.split("/"));
        if (!isDescendantPath(targetRoot, target)) {
          throw controlledGitError(
            "CONTROLLED_GIT_TARGET_UNAVAILABLE",
            "Conflict path 逃逸 targetRoot",
          );
        }
        await this.#assertMaterializationFence(
          targetBoundary,
          lease,
          parentBoundaries,
        );
        const handle = await open(target, "wx", 0o644);
        let initialStats;
        try {
          initialStats = await handle.stat();
          if (!initialStats.isFile() || initialStats.nlink !== 1) {
            throw controlledGitError(
              "CONTROLLED_GIT_TARGET_CHANGED",
              "Code Job target file 身份不安全",
            );
          }
          createdFiles.push({ path: target, stats: initialStats, content });
          await handle.writeFile(content);
          await handle.chmod(0o644);
          await handle.sync();
          const finalStats = await handle.stat();
          if (
            !finalStats.isFile() ||
            finalStats.nlink !== 1 ||
            finalStats.size !== content.length ||
            !sameStableIdentity(initialStats, finalStats)
          ) {
            throw controlledGitError(
              "CONTROLLED_GIT_TARGET_CHANGED",
              "Code Job target file 在写入期间发生变化",
            );
          }
          createdFiles.at(-1).stats = finalStats;
          await this.#assertMaterializationFence(
            targetBoundary,
            lease,
            parentBoundaries,
          );
        } finally {
          await handle.close();
        }
        await this.#assertMaterializedFile(createdFiles.at(-1));
        receiptFiles.push(deepFreeze({
          path: entry.path,
          sha256: sha256(content),
          mode: entry.mode,
          bytes: content.length,
        }));
        await this.#assertMaterializationFence(
          targetBoundary,
          lease,
          parentBoundaries,
        );
      }
      await this.#assertMaterializationFence(
        targetBoundary,
        lease,
        createdDirectories.ordered,
      );
      for (const file of createdFiles) {
        await this.#assertMaterializedFile(file);
      }
      await this.#releaseMaterializationLease(targetBoundary, lease);
      lease = undefined;
      await this.#assertDirectoryBoundary(
        targetBoundary,
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job target root 在 materialization 结束时发生变化",
      );
    } catch (cause) {
      await this.#cleanupMaterialization({
        targetBoundary,
        lease,
        files: createdFiles,
        directories: createdDirectories.ordered,
      });
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_MATERIALIZATION_FAILED",
        "Conflict preparation 无法 materialize",
        cause,
      );
    }
    return deepFreeze({
      schemaVersion: 2,
      preparationId,
      targetRoot,
      materialization: "full-tree",
      excludePaths: [...excludePaths],
      files: receiptFiles,
      fileCount: receiptFiles.length,
      totalBytes,
      resultTreeOid: manifest.resultTreeOid,
      evidenceDigest: manifest.evidenceDigest,
      resultObjectDigest: manifest.resultObjectDigest,
      residual: null,
    });
  }

  async recoverControlledCommits() {
    try {
      return await this.#commitBuilder.recover();
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_COMMIT_RECOVERY_FAILED",
        "Controlled commit recovery 失败",
        cause,
      );
    }
  }

  async createControlledCommit(value) {
    const request = normalizeControlledCommitRequest(value, this.#limits);
    try {
      return await this.#commitBuilder.create(request);
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_COMMIT_FAILED",
        "Controlled Git commit 构建失败",
        cause,
      );
    }
  }

  async findControlledCommit(value) {
    const request = normalizeControlledCommitLookup(value);
    try {
      return await this.#commitBuilder.find(request);
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_COMMIT_LOOKUP_FAILED",
        "Controlled Git commit lookup 失败",
        cause,
      );
    }
  }

  async verifyControlledCommit(value) {
    const fields = exactDataObject(value, ["evidenceId"]);
    const evidenceId = fields.get("evidenceId");
    if (!CONTROLLED_COMMIT_ID.test(evidenceId)) {
      throw controlledGitError(
        "INVALID_CONTROLLED_GIT_REQUEST",
        "Controlled commit evidenceId 无效",
      );
    }
    try {
      return await this.#commitBuilder.verify(evidenceId);
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit 校验失败",
        cause,
      );
    }
  }

  async publishControlledCommit(value) {
    const request = normalizeControlledCommitPublicationRequest(value);
    const initialSource = await this.#controlledCommitPublicationSource(
      request.action,
    );
    let scratchRoot;
    let result = publicationResult("unknown");
    try {
      const scratch = await this.#createPublicationScratch(
        initialSource.evidence.commit.objectFormat,
      );
      scratchRoot = scratch.root;
      result = await this.#publishFromScratch(request, initialSource, scratch);
    } finally {
      if (scratchRoot !== undefined) {
        await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    return result;
  }

  async #publishFromScratch(request, initialSource, scratch) {
    const target = request.action.inputBinding.gitTarget;
    const commitOid = initialSource.evidence.commit.oid;
    const fullRefName = `refs/heads/${target.headRefName}`;
    const remoteUrl = `https://github.com/${target.headRepository}.git`;
    const initialEnvironment = this.#publicationEnvironment({
      credential: request.credential,
      scratch,
      source: initialSource,
    });
    const observedBefore = await this.#observePublishedHead({
      scratch,
      environment: initialEnvironment,
      remoteUrl,
      fullRefName,
      oidLength: commitOid.length,
    });
    if (observedBefore === undefined) return publicationResult("unknown");
    if (observedBefore === commitOid) {
      return publicationResult("already", commitOid);
    }
    if (observedBefore !== target.headRefOid) {
      return publicationResult("stale");
    }

    let finalSource;
    try {
      finalSource = await this.#controlledCommitPublicationSource(
        request.action,
      );
    } catch {
      return publicationResult("stale");
    }
    const environment = this.#publicationEnvironment({
      credential: request.credential,
      scratch,
      source: finalSource,
    });
    await this.#runPublicationGit({
      args: [
        ...SAFE_GIT_PREFIX,
        `--git-dir=${scratch.gitDirectory}`,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--no-signed",
        "--recurse-submodules=no",
        `--force-with-lease=${fullRefName}:${target.headRefOid}`,
        "--",
        remoteUrl,
        `${commitOid}:${fullRefName}`,
      ],
      cwd: scratch.root,
      environment,
      maxOutputBytes: 64 * 1024,
    });

    const observedAfter = await this.#observePublishedHead({
      scratch,
      environment,
      remoteUrl,
      fullRefName,
      oidLength: commitOid.length,
    });
    try {
      await this.#controlledCommitPublicationSource(request.action);
    } catch {
      return publicationResult("unknown");
    }
    return observedAfter === commitOid
      ? publicationResult("applied", commitOid)
      : publicationResult("unknown");
  }

  async #controlledCommitPublicationSource(action) {
    const source = await this.#commitBuilder.preparePublication(
      action.controlledCommitEvidence.evidenceId,
    );
    if (!sameControlledCommitEvidence(
      source.evidence,
      action.controlledCommitEvidence,
    )) {
      throw controlledGitError(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Publication action 与 sealed controlled commit 不一致",
      );
    }
    const preparation = await this.#verifiedCommitPreparation(
      source.evidence.executionSource,
      source.manifest,
    );
    return Object.freeze({
      evidence: source.evidence,
      commitObjectDirectory: source.objectDirectory,
      preparationObjectDirectory: path.join(
        this.#preparationRoot,
        "preparations",
        preparation.preparationId,
        "objects",
      ),
      baseObjectDirectory: preparation.baseBoundary.objectDirectory,
      headObjectDirectory: preparation.headBoundary.objectDirectory,
    });
  }

  async #createPublicationScratch(objectFormat) {
    await this.#assertPreparationRoot();
    const root = await mkdtemp(path.join(
      this.#preparationRoot,
      `${CONTROLLED_COMMIT_SCRATCH_PREFIX}publish-`,
    ));
    const gitDirectory = path.join(root, "git");
    const objectDirectory = path.join(root, "objects");
    const hooksDirectory = path.join(root, "no-hooks");
    await Promise.all([
      mkdir(path.join(gitDirectory, "refs", "heads"), { recursive: true }),
      mkdir(path.join(gitDirectory, "refs", "tags"), { recursive: true }),
      mkdir(path.join(objectDirectory, "info"), { recursive: true }),
      mkdir(path.join(objectDirectory, "pack"), { recursive: true }),
      mkdir(hooksDirectory),
    ]);
    const config = objectFormat === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
      : "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectFormat = sha256\n";
    await Promise.all([
      writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/unused\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(path.join(gitDirectory, "config"), config, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    return Object.freeze({
      root,
      gitDirectory,
      objectDirectory,
      hooksDirectory,
    });
  }

  #publicationEnvironment({ credential, scratch, source }) {
    const authorization = Buffer.from(
      `x-access-token:${credential}`,
      "utf8",
    ).toString("base64");
    return Object.freeze({
      ...this.#gitEnvironment(
        scratch.objectDirectory,
        source.commitObjectDirectory,
        source.preparationObjectDirectory,
        source.baseObjectDirectory,
        source.headObjectDirectory,
      ),
      GIT_CONFIG_COUNT: "8",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: scratch.hooksDirectory,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "credential.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
      GIT_CONFIG_KEY_3: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_3: `AUTHORIZATION: basic ${authorization}`,
      GIT_CONFIG_KEY_4: "http.followRedirects",
      GIT_CONFIG_VALUE_4: "false",
      GIT_CONFIG_KEY_5: "http.sslVerify",
      GIT_CONFIG_VALUE_5: "true",
      GIT_CONFIG_KEY_6: "protocol.allow",
      GIT_CONFIG_VALUE_6: "never",
      GIT_CONFIG_KEY_7: "protocol.https.allow",
      GIT_CONFIG_VALUE_7: "always",
    });
  }

  async #observePublishedHead({
    scratch,
    environment,
    remoteUrl,
    fullRefName,
    oidLength,
  }) {
    const result = await this.#runPublicationGit({
      args: [
        ...SAFE_GIT_PREFIX,
        `--git-dir=${scratch.gitDirectory}`,
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "ls-remote",
        "--exit-code",
        "--refs",
        "--",
        remoteUrl,
        fullRefName,
      ],
      cwd: scratch.root,
      environment,
      maxOutputBytes: 4_096,
    });
    if (result === null) return undefined;
    return parsePublishedHead(result, fullRefName, oidLength);
  }

  async #runPublicationGit({
    args,
    cwd,
    environment,
    maxOutputBytes,
  }) {
    try {
      const value = await this.#run({
        command: this.#gitCommand,
        args,
        cwd,
        env: environment,
        timeoutMs: this.#limits.timeoutMs,
        maxOutputBytes,
      });
      return publicationProcessResult(value, maxOutputBytes);
    } catch {
      return null;
    }
  }

  async #verifiedCommitPreparation(executionSource, manifest) {
    const binding = executionSource.preparationBinding;
    const preparation = await this.#verifiedManifest(binding.preparationId);
    if (preparation.status !== "conflicted") {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
        "Controlled commit 只接受 conflicted preparation",
      );
    }
    const expectedBinding = createConflictPreparationBinding({
      preparation: publicPreparation(preparation),
      gitTarget: preparation.gitTarget,
    });
    if (!sameConflictPreparationBinding(binding, expectedBinding)) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
        "Controlled commit execution source 与 sealed preparation 不一致",
      );
    }
    const treeByPath = new Map(
      preparation.treeEntries.map((entry) => [entry.path, entry]),
    );
    if (manifest.changes.modified.some(
      (change) => treeByPath.get(change.path)?.sha256 !== change.beforeSha256,
    )) {
      throw controlledGitError(
        "CONTROLLED_GIT_CHANGE_PACKAGE_MISMATCH",
        "Change package beforeSha256 未绑定 sealed result tree",
      );
    }
    return preparation;
  }

  async #inspectInScratch({
    gitTarget,
    baseBoundary,
    headBoundary,
    gitExecutable,
    scratchRoot,
  }) {
    const scratchGitDirectory = path.join(scratchRoot, "git");
    const resultObjectDirectory = path.join(scratchRoot, "result-objects");
    await mkdir(scratchGitDirectory);
    await mkdir(path.join(scratchGitDirectory, "refs", "heads"), {
      recursive: true,
    });
    await mkdir(path.join(scratchGitDirectory, "refs", "tags"), {
      recursive: true,
    });
    await mkdir(resultObjectDirectory);
    await mkdir(path.join(resultObjectDirectory, "info"));
    await mkdir(path.join(resultObjectDirectory, "pack"));
    const blobDirectory = path.join(scratchRoot, "blobs");
    await mkdir(blobDirectory);
    await writeFile(path.join(scratchGitDirectory, "HEAD"), "ref: refs/heads/unused\n");
    const config = baseBoundary.objectFormat === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
      : "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectFormat = sha256\n";
    await writeFile(path.join(scratchGitDirectory, "config"), config);

    const environment = this.#gitEnvironment(
      resultObjectDirectory,
      baseBoundary.objectDirectory,
      headBoundary.objectDirectory,
    );
    const prefix = [
      ...SAFE_GIT_PREFIX,
      `--git-dir=${scratchGitDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.commitGraph=false",
      "-c",
      "merge.conflictStyle=diff3",
    ];
    const mergeBaseOutput = checkedProcessOutput(
      await this.#runGit({
        args: [
          ...prefix,
          "merge-base",
          "--all",
          gitTarget.headRefOid,
          gitTarget.baseRefOid,
        ],
        cwd: scratchRoot,
        env: environment,
        maxOutputBytes: 256,
      }),
      [0, 1],
      256,
    );
    const mergeBaseOid = parseMergeBase(
      mergeBaseOutput.stdout,
      mergeBaseOutput.exitCode,
      baseBoundary.oidLength,
    );
    for (const tipOid of [gitTarget.headRefOid, gitTarget.baseRefOid]) {
      const raw = parseRawDiff(
        checkedProcessOutput(
          await this.#runGit({
            args: [
              ...prefix,
              "diff-tree",
              "--no-commit-id",
              "-r",
              "--raw",
              "-z",
              "-M",
              mergeBaseOid,
              tipOid,
            ],
            cwd: scratchRoot,
            env: environment,
            maxOutputBytes: this.#limits.maxProtocolBytes,
          }),
          [0],
          this.#limits.maxProtocolBytes,
        ).stdout,
        baseBoundary.oidLength,
        this.#limits,
      );
      const numstat = parseNumstat(
        checkedProcessOutput(
          await this.#runGit({
            args: [
              ...prefix,
              "diff",
              "--numstat",
              "-z",
              "--no-renames",
              mergeBaseOid,
              tipOid,
            ],
            cwd: scratchRoot,
            env: environment,
            maxOutputBytes: this.#limits.maxProtocolBytes,
          }),
          [0],
          this.#limits.maxProtocolBytes,
        ).stdout,
        this.#limits,
      );
      assertMatchingChanges(raw, numstat);
    }
    const mergeTreeOutput = checkedProcessOutput(
      await this.#runGit({
        args: [
          ...prefix,
          "merge-tree",
          "--write-tree",
          `--merge-base=${mergeBaseOid}`,
          "--no-messages",
          "-z",
          gitTarget.headRefOid,
          gitTarget.baseRefOid,
        ],
        cwd: scratchRoot,
        env: environment,
        maxOutputBytes: this.#limits.maxProtocolBytes,
      }),
      [0, 1],
      this.#limits.maxProtocolBytes,
    );
    const merge = parseMergeTree(
      mergeTreeOutput.stdout,
      mergeTreeOutput.exitCode,
      baseBoundary.oidLength,
      this.#limits,
    );
    const conflicts = [];
    let totalBytes = 0;
    for (const conflict of merge.conflicts) {
      const stages = [];
      for (const stage of conflict.stages) {
        const output = checkedProcessOutput(
          await this.#runGit({
            args: [...prefix, "cat-file", "blob", stage.oid],
            cwd: scratchRoot,
            env: environment,
            maxOutputBytes: this.#limits.maxBlobBytes,
          }),
          [0],
          this.#limits.maxBlobBytes,
        );
        totalBytes += output.stdout.length;
        if (totalBytes > this.#limits.maxTotalBytes) {
          throw controlledGitError(
            "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
            "Conflict evidence 超过总大小限制",
          );
        }
        stages.push(
          deepFreeze({
            stage: stage.stage,
            mode: stage.mode,
            ...validatedBlob(
              output.stdout,
              stage.oid,
              this.#limits,
              baseBoundary.objectFormat,
            ),
          }),
        );
        await this.#sealBlob(blobDirectory, output.stdout);
      }
      conflicts.push(
        deepFreeze({ path: conflict.path, mode: conflict.mode, stages }),
      );
    }
    const treeProtocol = checkedProcessOutput(
      await this.#runGit({
        args: [
          ...prefix,
          "ls-tree",
          "-rz",
          "--full-tree",
          merge.resultTreeOid,
        ],
        cwd: scratchRoot,
        env: environment,
        maxOutputBytes: this.#limits.maxProtocolBytes,
      }),
      [0],
      this.#limits.maxProtocolBytes,
    );
    const treeEntries = [];
    for (const entry of parseResultTree(
      treeProtocol.stdout,
      baseBoundary.oidLength,
      this.#limits,
    )) {
      const output = checkedProcessOutput(
        await this.#runGit({
          args: [...prefix, "cat-file", "blob", entry.oid],
          cwd: scratchRoot,
          env: environment,
          maxOutputBytes: this.#limits.maxBlobBytes,
        }),
        [0],
        this.#limits.maxBlobBytes,
      );
      totalBytes += output.stdout.length;
      if (totalBytes > this.#limits.maxTotalBytes) {
        throw controlledGitError(
          "CONTROLLED_GIT_UNSUPPORTED_TREE",
          "Result tree blobs 超过总大小限制",
        );
      }
      const evidence = validatedBlob(
        output.stdout,
        entry.oid,
        this.#limits,
        baseBoundary.objectFormat,
      );
      await this.#sealBlob(blobDirectory, output.stdout);
      treeEntries.push(deepFreeze({ ...entry, ...evidence }));
    }
    const conflictPaths = new Set(conflicts.map(({ path: relativePath }) => relativePath));
    const treePaths = new Set(treeEntries.map(({ path: relativePath }) => relativePath));
    if ([...conflictPaths].some((relativePath) => !treePaths.has(relativePath))) {
      throw controlledGitError(
        "CONTROLLED_GIT_PROTOCOL_ERROR",
        "Conflict path 不属于 result tree",
      );
    }
    const resultObjects = await this.#directoryEvidence(resultObjectDirectory, {
      maxFiles: this.#limits.maxObjectFiles,
      maxDirectories: this.#limits.maxDirectories,
      maxBytes: this.#limits.maxResultObjectBytes,
      allowedEmptyDirectories: ["info", "pack"],
      errorCode: "CONTROLLED_GIT_RESULT_OBJECT_INVALID",
    });
    const resultObjectDigest = canonicalJsonDigest(resultObjects);
    const boundaryDigest = canonicalJsonDigest({
      base: baseBoundary.boundaryDigest,
      head: headBoundary.boundaryDigest,
      gitExecutable,
    });
    const evidenceDigest = canonicalJsonDigest({
      conflicts,
      treeEntries,
      resultObjects,
    });
    return deepFreeze({
      schemaVersion: 1,
      kind: MANIFEST_KIND,
      gitTarget,
      baseBoundary,
      headBoundary,
      gitExecutable,
      status: merge.status,
      mergeBaseOid,
      resultTreeOid: merge.resultTreeOid,
      conflicts,
      treeEntries,
      resultObjects,
      resultObjectDigest,
      boundaryDigest,
      evidenceDigest,
      materialization: "full-tree",
    });
  }

  async #sealBlob(blobDirectory, bytes) {
    const digest = sha256(bytes);
    const target = path.join(blobDirectory, `${digest}.blob`);
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      if (!(await readFile(target)).equals(bytes)) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Sealed blob digest collision",
        );
      }
      return;
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #directoryEvidence(
    root,
    {
      maxFiles,
      maxDirectories,
      maxBytes,
      allowedEmptyDirectories = [],
      errorCode,
    },
  ) {
    const evidence = [];
    const directories = [];
    let totalBytes = 0;

    const fail = (message, cause) => {
      throw controlledGitError(errorCode, message, cause);
    };
    const normalizeEvidencePath = (relative) => {
      let normalized;
      try {
        normalized = normalizeWorkspacePath(relative);
      } catch (cause) {
        fail("Preparation file path 无效", cause);
      }
      const segments = normalized.split("/");
      if (
        normalized !== relative ||
        normalized.normalize("NFC") !== normalized ||
        Buffer.byteLength(normalized, "utf8") > this.#limits.maxPathBytes ||
        segments.length > this.#limits.maxPathDepth ||
        segments.some(
          (segment) =>
            Buffer.byteLength(segment, "utf8") > this.#limits.maxSegmentBytes,
        )
      ) {
        fail("Preparation file path 无效");
      }
      return normalized;
    };
    const directorySnapshot = async (absolute, relative) => {
      let initial;
      let canonical;
      let final;
      try {
        initial = await lstat(absolute);
        canonical = await realpath(absolute);
        final = await lstat(absolute);
      } catch (cause) {
        fail("Preparation directory identity 无效", cause);
      }
      if (
        initial.isSymbolicLink() ||
        !initial.isDirectory() ||
        !samePath(canonical, absolute) ||
        !sameFileIdentity(initial, final)
      ) {
        fail("Preparation directory identity 无效");
      }
      return { absolute, relative, stats: final };
    };
    const revalidateDirectory = async (snapshot) => {
      let current;
      let canonical;
      try {
        current = await lstat(snapshot.absolute);
        canonical = await realpath(snapshot.absolute);
      } catch (cause) {
        fail("Preparation directory 在读取期间变化", cause);
      }
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !samePath(canonical, snapshot.absolute) ||
        !sameFileIdentity(snapshot.stats, current)
      ) {
        fail("Preparation directory 在读取期间变化");
      }
    };

    directories.push(await directorySnapshot(root, ""));
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index];
      let entries;
      try {
        entries = await opendir(directory.absolute);
      } catch (cause) {
        fail("Preparation directory 不可读取", cause);
      }
      for await (const entry of entries) {
        const absolute = path.join(directory.absolute, entry.name);
        const relative = normalizeEvidencePath(
          directory.relative === ""
            ? entry.name
            : `${directory.relative}/${entry.name}`,
        );
        let stats;
        try {
          stats = await lstat(absolute);
        } catch (cause) {
          fail("Preparation entry 不可读取", cause);
        }
        if (stats.isSymbolicLink()) {
          fail("Preparation 包含 symlink");
        }
        if (stats.isDirectory()) {
          if (directories.length >= maxDirectories) {
            fail("Preparation directories 超过限制");
          }
          directories.push(await directorySnapshot(absolute, relative));
          continue;
        }
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          !Number.isSafeInteger(stats.size) ||
          stats.size < 0
        ) {
          fail("Preparation file identity 无效");
        }
        if (
          evidence.length >= maxFiles ||
          stats.size > maxBytes - totalBytes
        ) {
          fail("Preparation files 超过限制");
        }
        let canonical;
        try {
          canonical = await realpath(absolute);
        } catch (cause) {
          fail("Preparation file identity 无效", cause);
        }
        if (!samePath(canonical, absolute)) {
          fail("Preparation file identity 无效");
        }
        let bytes;
        let finalStats;
        try {
          bytes = await readFile(absolute);
          finalStats = await lstat(absolute);
        } catch (cause) {
          fail("Preparation file 在读取期间变化", cause);
        }
        if (!sameFileIdentity(stats, finalStats) || bytes.length !== stats.size) {
          fail("Preparation file 在读取期间变化");
        }
        totalBytes += bytes.length;
        evidence.push(deepFreeze({
          path: relative,
          byteLength: bytes.length,
          sha256: sha256(bytes),
        }));
      }
    }

    const expectedDirectories = new Set([""]);
    for (const relative of allowedEmptyDirectories) {
      expectedDirectories.add(normalizeEvidencePath(relative));
    }
    for (const entry of evidence) {
      const segments = entry.path.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        expectedDirectories.add(segments.slice(0, length).join("/"));
      }
    }
    const actualDirectories = new Set(
      directories.map(({ relative }) => relative),
    );
    if (
      [...actualDirectories].some(
        (relative) => !expectedDirectories.has(relative),
      ) ||
      allowedEmptyDirectories.some(
        (relative) => !actualDirectories.has(relative),
      )
    ) {
      fail("Preparation directory topology 未密封");
    }
    for (const directory of [...directories].reverse()) {
      await revalidateDirectory(directory);
    }
    evidence.sort((left, right) => left.path.localeCompare(right.path, "en"));
    return deepFreeze(evidence);
  }

  #gitEnvironment(resultObjectDirectory, ...alternateObjectDirectories) {
    const delimiter = path.delimiter;
    if (
      alternateObjectDirectories.length < 2 ||
      [...alternateObjectDirectories, resultObjectDirectory].some(
        (entry) => entry.includes("\0") || entry.includes(delimiter),
      )
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_BOUNDARY_INVALID",
        "Git object directory 无法安全编码为 alternates",
      );
    }
    return Object.freeze({
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        ...alternateObjectDirectories,
      ].join(delimiter),
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: NULL_DEVICE,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OBJECT_DIRECTORY: resultObjectDirectory,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    });
  }

  async #runControlledCommitGit(operation, request) {
    const prefix = [
      ...SAFE_GIT_PREFIX,
      `--git-dir=${request.gitDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.commitGraph=false",
    ];
    let args;
    let input;
    let returnsOid = false;
    switch (operation) {
      case "read-tree":
        args = [...prefix, "read-tree", request.treeOid];
        break;
      case "hash-object":
        args = [...prefix, "hash-object", "-w", "--stdin"];
        input = request.content;
        returnsOid = true;
        break;
      case "update-index":
        args = [...prefix, "update-index", "-z", "--index-info"];
        input = request.records;
        break;
      case "write-tree":
        args = [...prefix, "write-tree"];
        returnsOid = true;
        break;
      case "commit-tree":
        args = [
          ...prefix,
          "commit-tree",
          request.treeOid,
          "-p",
          request.parents[0],
          "-p",
          request.parents[1],
        ];
        input = request.message;
        returnsOid = true;
        break;
      default:
        throw controlledGitError(
          "CONTROLLED_GIT_COMMIT_PROTOCOL_ERROR",
          "Controlled commit Git operation 不在固定 allowlist",
        );
    }
    const maximumBytes = returnsOid ? 256 : 64;
    const output = checkedProcessOutput(
      await this.#runGit({
        args,
        cwd: request.cwd,
        env: request.environment,
        input,
        maxOutputBytes: maximumBytes,
      }),
      [0],
      maximumBytes,
    ).stdout;
    return returnsOid
      ? parseSingleOid(
          output,
          request.oidLength,
          "CONTROLLED_GIT_COMMIT_PROTOCOL_ERROR",
        )
      : undefined;
  }

  async #runGit({ args, cwd, env, input, maxOutputBytes }) {
    try {
      return await this.#run({
        command: this.#gitCommand,
        args,
        cwd,
        env,
        input,
        timeoutMs: this.#limits.timeoutMs,
        maxOutputBytes,
      });
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_PROCESS_FAILED",
        "Controlled Git 命令执行失败",
        cause,
      );
    }
  }

  async #preflight(request) {
    let value;
    try {
      value = await this.#mirrorInspector(request);
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREFLIGHT_FAILED",
        "Mirror preflight 失败",
        cause,
      );
    }
    return normalizeBoundary(value, request);
  }

  async #persistPreparation(manifest, scratchRoot) {
    const preparationId = canonicalJsonDigest(manifest);
    const document = deepFreeze({ ...manifest, preparationId });
    const serialized = Buffer.from(`${canonicalJsonStringify(document)}\n`, "utf8");
    if (serialized.length > this.#limits.maxManifestBytes) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_LIMIT",
        "Controlled Git manifest 超过大小限制",
      );
    }
    await rm(path.join(scratchRoot, "git"), { recursive: true, force: true });
    await rename(
      path.join(scratchRoot, "result-objects"),
      path.join(scratchRoot, "objects"),
    );
    const manifestPath = path.join(scratchRoot, "manifest.json");
    const handle = await open(manifestPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const preparations = await this.#preparationsDirectory();
    const target = path.join(preparations, preparationId);
    try {
      await rename(scratchRoot, target);
    } catch (cause) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(cause?.code)) throw cause;
      let existing;
      try {
        existing = await this.#loadManifest(preparationId);
        if (!sameCanonicalValue(existing, document)) {
          throw controlledGitError(
            "CONTROLLED_GIT_PREPARATION_TAMPERED",
            "Content-addressed preparation 已存在但内容不一致",
          );
        }
        await this.#verifyStoredEvidence(preparationId, existing);
      } catch (verificationCause) {
        if (
          verificationCause?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED"
        ) {
          throw verificationCause;
        }
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Content-addressed preparation 的 sealed evidence 无效",
          verificationCause,
        );
      }
      await rm(scratchRoot, { recursive: true, force: true });
      return existing;
    }
    return document;
  }

  async #verifiedManifest(preparationId) {
    await this.#assertPreparationRoot();
    const manifest = await this.#loadManifest(preparationId);
    if (
      !sameCanonicalValue(
        await executableIdentity(this.#gitCommand),
        manifest.gitExecutable,
      )
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_EXECUTABLE_CHANGED",
        "Preparation Git executable 已发生变化",
      );
    }
    const baseRequest = {
      repository: manifest.baseBoundary.repository,
      mirrorRoot: manifest.baseBoundary.canonicalRoot,
      expectedCommitOid: manifest.baseBoundary.commitOid,
    };
    const headRequest = {
      repository: manifest.headBoundary.repository,
      mirrorRoot: manifest.headBoundary.canonicalRoot,
      expectedCommitOid: manifest.headBoundary.commitOid,
    };
    const baseBoundary = await this.#preflight(baseRequest);
    const headBoundary = await this.#preflight(headRequest);
    assertSeparateBoundaries(
      baseBoundary,
      headBoundary,
      this.#preparationRoot,
      manifest.gitExecutable.path,
    );
    if (
      !sameCanonicalValue(baseBoundary, manifest.baseBoundary) ||
      !sameCanonicalValue(headBoundary, manifest.headBoundary)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_BOUNDARY_CHANGED",
        "Preparation mirror boundary 已发生变化",
      );
    }
    await this.#verifyStoredEvidence(preparationId, manifest);
    await this.#verifyGitEvidence(preparationId, manifest, {
      baseBoundary,
      headBoundary,
    });
    return manifest;
  }

  async #verifyStoredEvidence(preparationId, manifest) {
    const directory = await this.#preparationDirectory(preparationId);
    const topLevel = [];
    let entries;
    try {
      entries = await opendir(directory);
      for await (const entry of entries) {
        topLevel.push(entry.name);
        if (topLevel.length > 3) break;
      }
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Preparation directory 无法读取",
        cause,
      );
    }
    topLevel.sort();
    if (!sameCanonicalValue(topLevel, ["blobs", "manifest.json", "objects"])) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Preparation directory 包含未密封内容",
      );
    }
    const resultObjects = await this.#directoryEvidence(
      path.join(directory, "objects"),
      {
        maxFiles: this.#limits.maxObjectFiles,
        maxDirectories: this.#limits.maxDirectories,
        maxBytes: this.#limits.maxResultObjectBytes,
        allowedEmptyDirectories: ["info", "pack"],
        errorCode: "CONTROLLED_GIT_PREPARATION_TAMPERED",
      },
    );
    if (
      !sameCanonicalValue(resultObjects, manifest.resultObjects) ||
      canonicalJsonDigest(resultObjects) !== manifest.resultObjectDigest
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Result object evidence 已损坏",
      );
    }
    const expectedBlobs = new Map();
    for (const evidence of [
      ...manifest.treeEntries,
      ...manifest.conflicts.flatMap(({ stages }) => stages),
    ]) {
      expectedBlobs.set(evidence.sha256, {
        path: `${evidence.sha256}.blob`,
        byteLength: evidence.byteLength,
        sha256: evidence.sha256,
      });
      await this.#readSealedBlob(
        directory,
        evidence,
        manifest.baseBoundary.objectFormat,
      );
    }
    const actualBlobs = await this.#directoryEvidence(
      path.join(directory, "blobs"),
      {
        maxFiles: this.#limits.maxFiles + this.#limits.maxConflicts * 3,
        maxDirectories: this.#limits.maxDirectories,
        maxBytes: this.#limits.maxTotalBytes,
        errorCode: "CONTROLLED_GIT_PREPARATION_TAMPERED",
      },
    );
    const expected = [...expectedBlobs.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    );
    if (!sameCanonicalValue(actualBlobs, expected)) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Sealed blob set 已损坏",
      );
    }
  }

  async #verifyGitEvidence(preparationId, manifest, { baseBoundary, headBoundary }) {
    const preparationDirectory = await this.#preparationDirectory(preparationId);
    let scratchRoot;
    try {
      scratchRoot = await mkdtemp(
        path.join(this.#preparationRoot, ".controlled-git-verify-"),
      );
      const scratchGitDirectory = path.join(scratchRoot, "git");
      const resultObjectDirectory = path.join(scratchRoot, "result-objects");
      await mkdir(scratchGitDirectory);
      await mkdir(path.join(scratchGitDirectory, "refs", "heads"), {
        recursive: true,
      });
      await mkdir(path.join(scratchGitDirectory, "refs", "tags"), {
        recursive: true,
      });
      await mkdir(resultObjectDirectory);
      await mkdir(path.join(resultObjectDirectory, "info"));
      await mkdir(path.join(resultObjectDirectory, "pack"));
      await writeFile(path.join(scratchGitDirectory, "HEAD"), "ref: refs/heads/unused\n");
      const config = baseBoundary.objectFormat === "sha1"
        ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
        : "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectFormat = sha256\n";
      await writeFile(path.join(scratchGitDirectory, "config"), config);
      const environment = this.#gitEnvironment(
        resultObjectDirectory,
        path.join(preparationDirectory, "objects"),
        baseBoundary.objectDirectory,
        headBoundary.objectDirectory,
      );
      const prefix = [
        ...SAFE_GIT_PREFIX,
        `--git-dir=${scratchGitDirectory}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "core.commitGraph=false",
        "-c",
        "merge.conflictStyle=diff3",
      ];
      const mergeBaseOutput = checkedProcessOutput(
          await this.#runGit({
            args: [
              ...prefix,
              "merge-base",
              "--all",
              manifest.gitTarget.headRefOid,
              manifest.gitTarget.baseRefOid,
            ],
            cwd: scratchRoot,
            env: environment,
            maxOutputBytes: 256,
          }),
          [0, 1],
          256,
        );
      const mergeBaseOid = parseMergeBase(
        mergeBaseOutput.stdout,
        mergeBaseOutput.exitCode,
        baseBoundary.oidLength,
      );
      if (mergeBaseOid !== manifest.mergeBaseOid) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Merge base evidence 不一致",
        );
      }
      const mergeOutput = checkedProcessOutput(
        await this.#runGit({
          args: [
            ...prefix,
            "merge-tree",
            "--write-tree",
            `--merge-base=${mergeBaseOid}`,
            "--no-messages",
            "-z",
            manifest.gitTarget.headRefOid,
            manifest.gitTarget.baseRefOid,
          ],
          cwd: scratchRoot,
          env: environment,
          maxOutputBytes: this.#limits.maxProtocolBytes,
        }),
        [0, 1],
        this.#limits.maxProtocolBytes,
      );
      const merge = parseMergeTree(
        mergeOutput.stdout,
        mergeOutput.exitCode,
        baseBoundary.oidLength,
        this.#limits,
      );
      const expectedConflicts = manifest.conflicts.map(({ path: relativePath, mode, stages }) => ({
        path: relativePath,
        mode,
        stages: stages.map(({ stage, mode: stageMode, oid }) => ({
          stage,
          mode: stageMode,
          oid,
          path: relativePath,
        })),
      }));
      if (
        merge.status !== manifest.status ||
        merge.resultTreeOid !== manifest.resultTreeOid ||
        !sameCanonicalValue(merge.conflicts, expectedConflicts)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Merge tree evidence 不一致",
        );
      }
      const parsedTree = parseResultTree(
        checkedProcessOutput(
          await this.#runGit({
            args: [
              ...prefix,
              "ls-tree",
              "-rz",
              "--full-tree",
              manifest.resultTreeOid,
            ],
            cwd: scratchRoot,
            env: environment,
            maxOutputBytes: this.#limits.maxProtocolBytes,
          }),
          [0],
          this.#limits.maxProtocolBytes,
        ).stdout,
        baseBoundary.oidLength,
        this.#limits,
      );
      const expectedTree = manifest.treeEntries.map(({ path: relativePath, mode, oid }) => ({
        path: relativePath,
        mode,
        oid,
      }));
      if (!sameCanonicalValue(parsedTree, expectedTree)) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Result tree evidence 不一致",
        );
      }
    } finally {
      if (scratchRoot !== undefined) {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    }
  }

  async #loadManifest(preparationId) {
    const preparations = await this.#preparationsDirectory();
    const preparationDirectory = path.join(preparations, preparationId);
    const manifestPath = path.join(preparationDirectory, "manifest.json");
    let initialStats;
    try {
      initialStats = await lstat(manifestPath);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_NOT_FOUND",
          "Controlled Git preparation 不存在",
        );
      }
      throw cause;
    }
    if (
      initialStats.isSymbolicLink() ||
      !initialStats.isFile() ||
      initialStats.nlink !== 1 ||
      initialStats.size < 1 ||
      initialStats.size > this.#limits.maxManifestBytes ||
      !samePath(await realpath(manifestPath), manifestPath)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest 文件身份无效",
      );
    }
    const bytes = await readFile(manifestPath);
    const finalStats = await lstat(manifestPath);
    if (!sameFileIdentity(initialStats, finalStats) || bytes.length !== initialStats.size) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest 在读取期间发生变化",
      );
    }
    let document;
    try {
      document = JSON.parse(
        decodeUtf8(
          bytes,
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Controlled Git manifest 不是 UTF-8",
        ),
      );
    } catch (cause) {
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest 不是有效 JSON",
        cause,
      );
    }
    const fields = exactDataObject(
      document,
      [...MANIFEST_KEYS, "preparationId"],
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
    if (fields.get("preparationId") !== preparationId) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git preparation id 不一致",
      );
    }
    const manifest = Object.fromEntries(
      MANIFEST_KEYS.map((key) => [key, fields.get(key)]),
    );
    try {
      this.#validateManifest(manifest);
    } catch (cause) {
      if (cause?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED") throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest contract 无效",
        cause,
      );
    }
    if (
      canonicalJsonDigest(manifest) !== preparationId ||
      !bytes.equals(
        Buffer.from(`${canonicalJsonStringify(document)}\n`, "utf8"),
      )
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest digest 不一致",
      );
    }
    return deepFreeze({ ...manifest, preparationId });
  }

  #validateManifest(manifest) {
    let gitTarget;
    try {
      gitTarget = normalizePullRequestGitTarget(manifest.gitTarget);
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Manifest gitTarget 无效",
        cause,
      );
    }
    const baseBoundary = normalizeBoundary(manifest.baseBoundary, {
      repository: gitTarget.baseRepository,
      mirrorRoot: manifest.baseBoundary?.canonicalRoot,
      expectedCommitOid: gitTarget.baseRefOid,
    });
    const headBoundary = normalizeBoundary(manifest.headBoundary, {
      repository: gitTarget.headRepository,
      mirrorRoot: manifest.headBoundary?.canonicalRoot,
      expectedCommitOid: gitTarget.headRefOid,
    });
    const gitExecutable = normalizeExecutableEvidence(
      manifest.gitExecutable,
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.kind !== MANIFEST_KIND ||
      !sameCanonicalValue(gitTarget, manifest.gitTarget) ||
      !sameCanonicalValue(gitExecutable, manifest.gitExecutable) ||
      !samePath(gitExecutable.path, this.#gitCommand) ||
      !["clean", "conflicted"].includes(manifest.status) ||
      !oidPattern(baseBoundary.oidLength).test(manifest.mergeBaseOid) ||
      !oidPattern(baseBoundary.oidLength).test(manifest.resultTreeOid) ||
      manifest.materialization !== "full-tree" ||
      !SHA256.test(manifest.resultObjectDigest)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git manifest contract 无效",
      );
    }
    const conflicts = exactArray(
      manifest.conflicts,
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
    if (
      conflicts.length > this.#limits.maxConflicts ||
      (manifest.status === "clean") !== (conflicts.length === 0)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git conflict manifest 无效",
      );
    }
    let totalBytes = 0;
    let previousPath = null;
    for (const conflict of conflicts) {
      const conflictFields = exactDataObject(
        conflict,
        ["path", "mode", "stages"],
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
      );
      const conflictPath = normalizeConflictPath(
        conflictFields.get("path"),
        this.#limits,
      );
      const comparablePath = process.platform === "win32"
        ? conflictPath.toLowerCase()
        : conflictPath;
      const stages = exactArray(
        conflictFields.get("stages"),
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
      );
      if (
        conflictFields.get("mode") !== "100644" ||
        stages.length !== 3 ||
        (previousPath !== null && comparablePath.localeCompare(previousPath, "en") <= 0)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Controlled Git conflict entry 无效",
        );
      }
      previousPath = comparablePath;
      for (let index = 0; index < stages.length; index += 1) {
        const stageFields = exactDataObject(
          stages[index],
          ["stage", "mode", "oid", "byteLength", "sha256"],
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
        );
        totalBytes += stageFields.get("byteLength");
        if (
          stageFields.get("stage") !== index + 1 ||
          stageFields.get("mode") !== "100644" ||
          !oidPattern(baseBoundary.oidLength).test(stageFields.get("oid")) ||
          !Number.isSafeInteger(stageFields.get("byteLength")) ||
          stageFields.get("byteLength") < 0 ||
          stageFields.get("byteLength") > this.#limits.maxBlobBytes ||
          !SHA256.test(stageFields.get("sha256"))
        ) {
          throw controlledGitError(
            "CONTROLLED_GIT_PREPARATION_TAMPERED",
            "Conflict blob evidence 无效",
          );
        }
      }
    }
    const treeEntries = exactArray(
      manifest.treeEntries,
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
    if (treeEntries.length > this.#limits.maxFiles) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Result tree entries 超过限制",
      );
    }
    previousPath = null;
    const treePaths = new Set();
    for (const entry of treeEntries) {
      const fields = normalizeFileEvidence(
        entry,
        ["path", "mode", "oid", "byteLength", "sha256"],
        {
          oidLength: baseBoundary.oidLength,
          limits: this.#limits,
          code: "CONTROLLED_GIT_PREPARATION_TAMPERED",
        },
      );
      const relativePath = normalizeConflictPath(
        fields.get("path"),
        this.#limits,
      );
      const comparablePath = process.platform === "win32"
        ? relativePath.toLowerCase()
        : relativePath;
      if (
        fields.get("mode") !== "100644" ||
        (previousPath !== null && comparablePath.localeCompare(previousPath, "en") <= 0)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Result tree entry 无效",
        );
      }
      previousPath = comparablePath;
      treePaths.add(relativePath);
      totalBytes += fields.get("byteLength");
    }
    if (
      conflicts.some((conflict) => !treePaths.has(conflict.path))
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Conflict path 不属于 result tree",
      );
    }
    const resultObjects = exactArray(
      manifest.resultObjects,
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
    if (resultObjects.length > this.#limits.maxObjectFiles) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Result object files 超过限制",
      );
    }
    let resultObjectBytes = 0;
    previousPath = null;
    for (const entry of resultObjects) {
      const fields = normalizeFileEvidence(
        entry,
        ["path", "byteLength", "sha256"],
        {
          oidLength: baseBoundary.oidLength,
          limits: {
            ...this.#limits,
            maxBlobBytes: this.#limits.maxResultObjectBytes,
          },
          code: "CONTROLLED_GIT_PREPARATION_TAMPERED",
        },
      );
      let relativePath;
      try {
        relativePath = normalizeWorkspacePath(fields.get("path"));
      } catch (cause) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Result object path 无效",
          cause,
        );
      }
      if (
        relativePath !== fields.get("path") ||
        (previousPath !== null && relativePath.localeCompare(previousPath, "en") <= 0)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_TAMPERED",
          "Result object evidence 无效",
        );
      }
      previousPath = relativePath;
      resultObjectBytes += fields.get("byteLength");
    }
    if (
      totalBytes > this.#limits.maxTotalBytes ||
      resultObjectBytes > this.#limits.maxResultObjectBytes ||
      manifest.resultObjectDigest !== canonicalJsonDigest(resultObjects) ||
      manifest.boundaryDigest !==
        canonicalJsonDigest({
          base: baseBoundary.boundaryDigest,
          head: headBoundary.boundaryDigest,
          gitExecutable,
        }) ||
      manifest.evidenceDigest !== canonicalJsonDigest({
        conflicts,
        treeEntries,
        resultObjects,
      })
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git evidence digest 无效",
      );
    }
  }

  async #assertPreparationRoot() {
    let stats;
    try {
      stats = await lstat(this.#preparationRoot);
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_ROOT_UNAVAILABLE",
        "preparationRoot 不可用",
        cause,
      );
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !samePath(await realpath(this.#preparationRoot), this.#preparationRoot)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_ROOT_UNAVAILABLE",
        "preparationRoot 身份不安全",
      );
    }
  }

  async #preparationsDirectory() {
    await this.#assertPreparationRoot();
    const directory = path.join(this.#preparationRoot, "preparations");
    await mkdir(directory, { mode: 0o700 }).catch((cause) => {
      if (cause?.code !== "EEXIST") throw cause;
    });
    const stats = await lstat(directory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !samePath(await realpath(directory), directory)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_ROOT_UNAVAILABLE",
        "Preparations directory 身份不安全",
      );
    }
    return directory;
  }

  async #preparationDirectory(preparationId) {
    const parent = await this.#preparationsDirectory();
    const directory = path.join(parent, preparationId);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        throw controlledGitError(
          "CONTROLLED_GIT_PREPARATION_NOT_FOUND",
          "Controlled Git preparation 不存在",
        );
      }
      throw cause;
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !samePath(await realpath(directory), directory)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Controlled Git preparation directory 无效",
      );
    }
    return directory;
  }

  async #readSealedBlob(preparationDirectory, evidence, objectFormat) {
    const target = path.join(
      preparationDirectory,
      "blobs",
      `${evidence.sha256}.blob`,
    );
    let initial;
    try {
      initial = await lstat(target);
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Sealed blob 不可用",
        cause,
      );
    }
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      initial.nlink !== 1 ||
      initial.size !== evidence.byteLength ||
      !samePath(await realpath(target), target)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Sealed blob identity 无效",
      );
    }
    const bytes = await readFile(target);
    const final = await lstat(target);
    if (
      !sameFileIdentity(initial, final) ||
      sha256(bytes) !== evidence.sha256 ||
      gitBlobOid(objectFormat, bytes) !== evidence.oid ||
      bytes.includes(0)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_PREPARATION_TAMPERED",
        "Sealed blob evidence 无效",
      );
    }
    decodeUtf8(
      bytes,
      "CONTROLLED_GIT_PREPARATION_TAMPERED",
      "Sealed blob 不是 UTF-8",
    );
    return bytes;
  }

  async #assertEmptyTarget(targetRoot, manifest) {
    if (
      isNetworkPath(targetRoot) ||
      pathsOverlap(targetRoot, this.#preparationRoot) ||
      pathsOverlap(targetRoot, this.#gitCommand) ||
      [
        manifest.baseBoundary.canonicalRoot,
        manifest.baseBoundary.objectDirectory,
        manifest.headBoundary.canonicalRoot,
        manifest.headBoundary.objectDirectory,
      ].some((source) => pathsOverlap(targetRoot, source))
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_UNAVAILABLE",
        "Code Job targetRoot 与可信边界重叠",
      );
    }
    const boundary = await this.#captureDirectoryBoundary(
      targetRoot,
      "CONTROLLED_GIT_TARGET_UNAVAILABLE",
      "Code Job targetRoot 不可用",
    );
    let empty = true;
    let entries;
    try {
      entries = await opendir(targetRoot);
      for await (const _entry of entries) {
        empty = false;
        break;
      }
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_UNAVAILABLE",
        "Code Job targetRoot 不可读取",
        cause,
      );
    }
    await this.#assertDirectoryBoundary(
      boundary,
      "CONTROLLED_GIT_TARGET_UNAVAILABLE",
      "Code Job targetRoot 在空目录检查期间发生变化",
    );
    if (!empty) {
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_UNAVAILABLE",
        "Code Job targetRoot 必须是新的空目录",
      );
    }
    return boundary;
  }

  async #captureDirectoryBoundary(directory, code, message) {
    let initial;
    let canonical;
    let final;
    try {
      initial = await lstat(directory);
      canonical = await realpath(directory);
      final = await lstat(directory);
    } catch (cause) {
      throw controlledGitError(code, message, cause);
    }
    if (
      initial.isSymbolicLink() ||
      !initial.isDirectory() ||
      !samePath(canonical, directory) ||
      !sameStableIdentity(initial, final)
    ) {
      throw controlledGitError(code, message);
    }
    return { path: directory, stats: final };
  }

  async #assertDirectoryBoundary(boundary, code, message) {
    let current;
    let canonical;
    try {
      current = await lstat(boundary.path);
      canonical = await realpath(boundary.path);
    } catch (cause) {
      throw controlledGitError(code, message, cause);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !samePath(canonical, boundary.path) ||
      !sameStableIdentity(boundary.stats, current)
    ) {
      throw controlledGitError(code, message);
    }
  }

  async #assertLeaseBoundary(lease, code, message) {
    let current;
    let canonical;
    try {
      current = await lstat(lease.path);
      canonical = await realpath(lease.path);
    } catch (cause) {
      throw controlledGitError(code, message, cause);
    }
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      !samePath(canonical, lease.path) ||
      !sameFileIdentity(lease.stats, current)
    ) {
      throw controlledGitError(code, message);
    }
  }

  async #assertMaterializationFence(
    targetBoundary,
    lease,
    directoryBoundaries = [],
  ) {
    await this.#assertDirectoryBoundary(
      targetBoundary,
      "CONTROLLED_GIT_TARGET_CHANGED",
      "Code Job target root 在 materialization 期间发生变化",
    );
    if (lease !== undefined) {
      await this.#assertLeaseBoundary(
        lease,
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job materialization lease 发生变化",
      );
    }
    for (const boundary of directoryBoundaries) {
      await this.#assertDirectoryBoundary(
        boundary,
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job target parent 在 materialization 期间发生变化",
      );
    }
  }

  async #createMaterializationLease(targetBoundary, preparationId) {
    await this.#assertDirectoryBoundary(
      targetBoundary,
      "CONTROLLED_GIT_TARGET_CHANGED",
      "Code Job target root 在 lease 创建前发生变化",
    );
    const leasePath = path.join(
      targetBoundary.path,
      `.code-broker-tmp-${preparationId}`,
    );
    let handle;
    let lease;
    try {
      handle = await open(leasePath, "wx", 0o600);
      const initialStats = await handle.stat();
      if (!initialStats.isFile() || initialStats.nlink !== 1) {
        throw controlledGitError(
          "CONTROLLED_GIT_TARGET_CHANGED",
          "Code Job materialization lease 身份不安全",
        );
      }
      lease = { path: leasePath, stats: initialStats, handle };
      await handle.writeFile(preparationId, "utf8");
      await handle.sync();
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size !== Buffer.byteLength(preparationId, "utf8") ||
        !sameStableIdentity(initialStats, stats)
      ) {
        throw controlledGitError(
          "CONTROLLED_GIT_TARGET_CHANGED",
          "Code Job materialization lease 在写入期间发生变化",
        );
      }
      lease.stats = stats;
      await this.#assertMaterializationFence(targetBoundary, lease);
      return lease;
    } catch (cause) {
      await handle?.close().catch(() => {});
      if (handle !== undefined) {
        try {
          await this.#assertDirectoryBoundary(
            targetBoundary,
            "CONTROLLED_GIT_CLEANUP_FAILED",
            "Code Job target root 在 lease 清理前发生变化",
          );
          if (lease !== undefined) {
            await this.#assertLeaseBoundary(
              lease,
              "CONTROLLED_GIT_CLEANUP_FAILED",
              "Code Job materialization lease 无法安全清理",
            );
          }
          await unlink(leasePath);
        } catch (cleanupCause) {
          if (cleanupCause?.code !== "ENOENT") {
            throw controlledGitError(
              "CONTROLLED_GIT_CLEANUP_FAILED",
              "失败的 materialization lease 无法完整清理",
              cleanupCause,
            );
          }
        }
      }
      if (cause instanceof ControlledGitServiceError) throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job materialization lease 无法创建",
        cause,
      );
    }
  }

  async #createParentDirectories(
    targetRoot,
    relativePath,
    createdDirectories,
    targetBoundary,
    lease,
  ) {
    let current = targetRoot;
    const parents = [];
    for (const segment of relativePath.split("/").slice(0, -1)) {
      current = path.join(current, segment);
      const key = process.platform === "win32"
        ? path.resolve(current).toLowerCase()
        : path.resolve(current);
      const existing = createdDirectories.byPath.get(key);
      if (existing !== undefined) {
        await this.#assertDirectoryBoundary(
          existing,
          "CONTROLLED_GIT_TARGET_CHANGED",
          "Code Job target parent 发生变化",
        );
        parents.push(existing);
        continue;
      }
      await this.#assertMaterializationFence(targetBoundary, lease, parents);
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (cause) {
        if (cause?.code === "EEXIST") {
          throw controlledGitError(
            "CONTROLLED_GIT_TARGET_CHANGED",
            "Code Job target 在 materialization 期间发生变化",
            cause,
          );
        }
        throw cause;
      }
      const boundary = await this.#captureDirectoryBoundary(
        current,
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job target directory 身份不安全",
      );
      createdDirectories.byPath.set(key, boundary);
      createdDirectories.ordered.push(boundary);
      parents.push(boundary);
      await this.#assertMaterializationFence(targetBoundary, lease, parents);
    }
    return parents;
  }

  async #assertMaterializedFile(file) {
    let initial;
    let canonical;
    let bytes;
    let final;
    try {
      initial = await lstat(file.path);
      canonical = await realpath(file.path);
      bytes = await readFile(file.path);
      final = await lstat(file.path);
    } catch (cause) {
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job target file 无法复核",
        cause,
      );
    }
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      initial.nlink !== 1 ||
      !samePath(canonical, file.path) ||
      !sameStableIdentity(file.stats, initial) ||
      !sameFileIdentity(initial, final) ||
      !bytes.equals(file.content)
    ) {
      throw controlledGitError(
        "CONTROLLED_GIT_TARGET_CHANGED",
        "Code Job target file 在 materialization 期间发生变化",
      );
    }
    file.stats = final;
  }

  async #releaseMaterializationLease(targetBoundary, lease) {
    await this.#assertMaterializationFence(targetBoundary, lease);
    await lease.handle.close();
    lease.handle = undefined;
    await this.#assertDirectoryBoundary(
      targetBoundary,
      "CONTROLLED_GIT_TARGET_CHANGED",
      "Code Job target root 在 lease 释放期间发生变化",
    );
    await this.#assertLeaseBoundary(
      lease,
      "CONTROLLED_GIT_TARGET_CHANGED",
      "Code Job materialization lease 在释放期间发生变化",
    );
    await unlink(lease.path);
    await this.#assertDirectoryBoundary(
      targetBoundary,
      "CONTROLLED_GIT_TARGET_CHANGED",
      "Code Job target root 在 lease 释放后发生变化",
    );
  }

  async #cleanupMaterialization({
    targetBoundary,
    lease,
    files,
    directories,
  }) {
    try {
      await lease?.handle?.close();
      if (lease !== undefined) lease.handle = undefined;
      await this.#assertDirectoryBoundary(
        targetBoundary,
        "CONTROLLED_GIT_CLEANUP_FAILED",
        "Code Job target root 无法安全清理",
      );
      for (const file of [...files].reverse()) {
        const stats = await lstat(file.path);
        if (
          stats.isSymbolicLink() ||
          !stats.isFile() ||
          !samePath(await realpath(file.path), file.path) ||
          !sameStableIdentity(file.stats, stats)
        ) {
          throw controlledGitError(
            "CONTROLLED_GIT_CLEANUP_FAILED",
            "失败的 materialization file 无法安全清理",
          );
        }
        await unlink(file.path);
      }
      for (const directory of [...directories].reverse()) {
        await this.#assertDirectoryBoundary(
          directory,
          "CONTROLLED_GIT_CLEANUP_FAILED",
          "失败的 materialization directory 无法安全清理",
        );
        await rmdir(directory.path);
      }
      if (lease !== undefined) {
        await this.#assertLeaseBoundary(
          lease,
          "CONTROLLED_GIT_CLEANUP_FAILED",
          "失败的 materialization lease 无法安全清理",
        );
        await unlink(lease.path);
      }
      await this.#assertDirectoryBoundary(
        targetBoundary,
        "CONTROLLED_GIT_CLEANUP_FAILED",
        "Code Job target root 无法安全清理",
      );
      let empty = true;
      const entries = await opendir(targetBoundary.path);
      for await (const _entry of entries) {
        empty = false;
        break;
      }
      if (!empty) {
        throw controlledGitError(
          "CONTROLLED_GIT_CLEANUP_FAILED",
          "失败的 materialization 无法完整清理",
        );
      }
    } catch (cause) {
      if (cause?.code === "CONTROLLED_GIT_CLEANUP_FAILED") throw cause;
      throw controlledGitError(
        "CONTROLLED_GIT_CLEANUP_FAILED",
        "失败的 materialization 无法完整清理",
        cause,
      );
    }
  }
}
