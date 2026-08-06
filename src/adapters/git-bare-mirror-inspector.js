import { createHash } from "node:crypto";
import {
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { ManagedProcessRunner } from "../lib/managed-process.js";

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_OBJECT_STORE_ENTRIES = 100_000;
const LOOSE_OBJECT_DIRECTORY = /^[a-f0-9]{2}$/u;
const SAFE_ENV = Object.freeze({
  GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});
const SAFE_GIT_PREFIX = Object.freeze([
  "--no-lazy-fetch",
  "--no-pager",
  "--no-replace-objects",
  "--git-dir=.",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.commitGraph=false",
]);

export class GitBareMirrorInspectorError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitBareMirrorInspectorError";
    this.code = code;
  }
}

function mirrorError(code, message, cause) {
  return new GitBareMirrorInspectorError(code, message, { cause });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDescendant(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isNetworkPath(value) {
  return process.platform === "win32" && /^(?:\\\\|\/\/)/u.test(value);
}

function exactRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_REQUEST",
      "Git bare mirror 请求无效",
    );
  }
  const expected = ["repository", "mirrorRoot", "expectedCommitOid"];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !expected.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_REQUEST",
      "Git bare mirror 请求无效",
    );
  }
  return value;
}

function repository(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 140 ||
    UNSAFE_TEXT.test(value) ||
    !REPOSITORY.test(value)
  ) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_REQUEST",
      "Git bare mirror repository 无效",
    );
  }
  const [owner, name] = value.split("/");
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_REQUEST",
      "Git bare mirror repository 无效",
    );
  }
  return value;
}

function configFields(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_CONFIG",
      "Git bare mirror config 无效",
    );
  }
  const allowed = new Set([
    "gitCommand",
    "processRunner",
    "timeoutMs",
    "maxObjectStoreEntries",
  ]);
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_CONFIG",
        "Git bare mirror config 无效",
      );
    }
    fields.set(key, descriptor.value);
  }
  if (!fields.has("gitCommand")) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_CONFIG",
      "Git bare mirror config 无效",
    );
  }
  return fields;
}

function requireRunner(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw mirrorError(
      "INVALID_GIT_BARE_MIRROR_CONFIG",
      "processRunner 无效",
    );
  }
  let current = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_CONFIG",
        "processRunner 无效",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, "run");
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw mirrorError(
          "INVALID_GIT_BARE_MIRROR_CONFIG",
          "processRunner.run 无效",
        );
      }
      return descriptor.value.bind(value);
    }
    current = Object.getPrototypeOf(current);
  }
  throw mirrorError(
    "INVALID_GIT_BARE_MIRROR_CONFIG",
    "processRunner.run 缺失",
  );
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function statsIdentity(value) {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mode: value.mode,
    nlink: value.nlink,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    uid: value.uid,
    gid: value.gid,
  });
}

function decodeUtf8(value, code, message) {
  if (typeof value === "string") {
    if (value.includes("\ufffd") || /\p{Cs}/u.test(value)) {
      throw mirrorError(code, message);
    }
    return value;
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw mirrorError(code, message);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw mirrorError(code, message, cause);
  }
}

function textOutput(
  result,
  {
    optional = false,
    code = "GIT_MIRROR_PROTOCOL_ERROR",
  } = {},
) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.signal !== null ||
    result.truncated !== false ||
    !(typeof result.stderr === "string" || Buffer.isBuffer(result.stderr)) ||
    !(
      typeof result.stdout === "string" ||
      Buffer.isBuffer(result.stdout) ||
      result.stdout instanceof Uint8Array
    )
  ) {
    throw mirrorError(
      code,
      "Git bare mirror 命令结果无效",
    );
  }
  if (result.exitCode !== 0) {
    if (optional) return null;
    throw mirrorError(
      "GIT_MIRROR_COMMAND_FAILED",
      "Git bare mirror 命令失败",
    );
  }
  return decodeUtf8(result.stdout, code, "Git bare mirror 输出不是 UTF-8");
}

function singleLine(value, code = "GIT_MIRROR_PROTOCOL_ERROR") {
  if (typeof value !== "string") {
    throw mirrorError(code, "Git bare mirror 输出无效");
  }
  const line = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  if (/[\r\n\0]/u.test(line)) {
    throw mirrorError(code, "Git bare mirror 输出无效");
  }
  return line;
}

function configurationNames(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.endsWith("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_CONFIG_BYTES
  ) {
    throw mirrorError(
      "GIT_MIRROR_UNTRUSTED_CONFIG",
      "Git bare mirror 配置 framing 无效或超过限制",
    );
  }
  const fields = value.split("\0");
  fields.pop();
  if (
    fields.some(
      (entry) =>
        !entry ||
        UNSAFE_TEXT.test(entry) ||
        entry.includes("\ufffd"),
    )
  ) {
    throw mirrorError(
      "GIT_MIRROR_UNTRUSTED_CONFIG",
      "Git bare mirror 配置无效",
    );
  }
  return fields.map((entry) => entry.toLowerCase());
}

async function fileIdentity(file, { maximumBytes, executable = false } = {}) {
  const initial = await lstat(file);
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    (executable ? initial.nlink < 1 : initial.nlink !== 1) ||
    initial.size < 1 ||
    initial.size > maximumBytes
  ) {
    throw mirrorError(
      executable
        ? "GIT_MIRROR_EXECUTABLE_UNTRUSTED"
        : "GIT_MIRROR_CONTROL_FILE_UNTRUSTED",
      executable
        ? "Git executable 身份不安全"
        : "Git bare mirror 控制文件不安全",
    );
  }
  if (
    executable &&
    process.platform !== "win32" &&
    (((initial.mode & 0o111) === 0) || (initial.mode & 0o7000) !== 0)
  ) {
    throw mirrorError(
      "GIT_MIRROR_EXECUTABLE_UNTRUSTED",
      "Git executable 权限不安全",
    );
  }
  const canonical = await realpath(file);
  if (!samePath(canonical, file)) {
    throw mirrorError(
      executable
        ? "GIT_MIRROR_EXECUTABLE_UNTRUSTED"
        : "GIT_MIRROR_CONTROL_FILE_UNTRUSTED",
      executable
        ? "Git executable 身份不安全"
        : "Git bare mirror 控制文件不安全",
    );
  }
  const handle = await open(canonical, "r");
  let opened;
  let content;
  try {
    opened = await handle.stat();
    content = await handle.readFile();
    const finalOpened = await handle.stat();
    if (
      !sameFileIdentity(opened, finalOpened) ||
      content.length !== opened.size
    ) {
      throw mirrorError(
        "GIT_MIRROR_BOUNDARY_CHANGED",
        "Git bare mirror 边界在检查期间发生变化",
      );
    }
  } finally {
    await handle.close();
  }
  const final = await lstat(file);
  if (!sameFileIdentity(initial, final) || !sameFileIdentity(opened, final)) {
    throw mirrorError(
      "GIT_MIRROR_BOUNDARY_CHANGED",
      "Git bare mirror 边界在检查期间发生变化",
    );
  }
  return Object.freeze({
    path: canonical,
    sha256: sha256(content),
    bytes: content.length,
    mode: opened.mode,
    uid: opened.uid,
    gid: opened.gid,
    stats: opened,
    identity: statsIdentity(opened),
  });
}

async function canonicalDirectory(value, code, message) {
  const initial = await lstat(value);
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw mirrorError(code, message);
  }
  const canonical = await realpath(value);
  if (!samePath(canonical, value)) throw mirrorError(code, message);
  const final = await lstat(value);
  if (
    final.isSymbolicLink() ||
    !final.isDirectory() ||
    !sameFileIdentity(initial, final)
  ) {
    throw mirrorError(
      "GIT_MIRROR_BOUNDARY_CHANGED",
      "Git bare mirror 边界在检查期间发生变化",
    );
  }
  return Object.freeze({
    path: canonical,
    stats: final,
    identity: statsIdentity(final),
  });
}

async function assertMissingControlFile(file) {
  try {
    await lstat(file);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    throw cause;
  }
  throw mirrorError(
    "GIT_MIRROR_UNTRUSTED_CONFIG",
    "Git bare mirror 不允许 config.worktree 或 commondir",
  );
}

function safeObjectEntryName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value.normalize("NFC") === value &&
    !UNSAFE_TEXT.test(value)
  );
}

async function boundedDirectoryListing(directory, budget) {
  const before = await canonicalDirectory(
    directory,
    "GIT_MIRROR_OBJECT_STORE_UNSAFE",
    "Git bare mirror object store 目录不安全",
  );
  const names = [];
  const handle = await opendir(before.path);
  for await (const entry of handle) {
    budget.count += 1;
    if (budget.count > budget.maximum) {
      throw mirrorError(
        "GIT_MIRROR_OBJECT_STORE_LIMIT",
        "Git bare mirror object store 条目超过检查上限",
      );
    }
    if (!safeObjectEntryName(entry.name)) {
      throw mirrorError(
        "GIT_MIRROR_OBJECT_STORE_UNSAFE",
        "Git bare mirror object store 包含不安全名称",
      );
    }
    names.push(entry.name);
  }
  const after = await canonicalDirectory(
    before.path,
    "GIT_MIRROR_OBJECT_STORE_UNSAFE",
    "Git bare mirror object store 目录不安全",
  );
  if (!sameFileIdentity(before.stats, after.stats)) {
    throw mirrorError(
      "GIT_MIRROR_BOUNDARY_CHANGED",
      "Git bare mirror object store 在扫描期间发生变化",
    );
  }
  names.sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({
    path: after.path,
    stats: after.stats,
    identity: after.identity,
    names: Object.freeze(names),
  });
}

async function regularObjectFile(file, relativePath) {
  const initial = await lstat(file);
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.nlink !== 1
  ) {
    throw mirrorError(
      "GIT_MIRROR_OBJECT_STORE_UNSAFE",
      "Git bare mirror object store 条目必须是独占 regular file",
    );
  }
  const canonical = await realpath(file);
  const final = await lstat(file);
  if (
    !samePath(canonical, file) ||
    final.isSymbolicLink() ||
    !final.isFile() ||
    !sameFileIdentity(initial, final)
  ) {
    throw mirrorError(
      "GIT_MIRROR_BOUNDARY_CHANGED",
      "Git bare mirror object store 条目在扫描期间发生变化",
    );
  }
  return Object.freeze({
    kind: "file",
    path: relativePath,
    identity: statsIdentity(final),
  });
}

function directoryRecord(relativePath, listing) {
  return Object.freeze({
    kind: "directory",
    path: relativePath,
    identity: listing.identity,
  });
}

async function scanRegularFiles({
  directory,
  relativeDirectory,
  budget,
  records,
  validateName = () => true,
}) {
  const listing = await boundedDirectoryListing(directory, budget);
  records.push(directoryRecord(relativeDirectory, listing));
  for (const name of listing.names) {
    if (!validateName(name)) {
      throw mirrorError(
        "GIT_MIRROR_OBJECT_STORE_UNSAFE",
        "Git bare mirror object store 条目名称无效",
      );
    }
    records.push(
      await regularObjectFile(
        path.join(listing.path, name),
        `${relativeDirectory}/${name}`,
      ),
    );
  }
}

async function scanInfoDirectory({ directory, budget, records }) {
  const listing = await boundedDirectoryListing(directory, budget);
  records.push(directoryRecord("info", listing));
  for (const name of listing.names) {
    const normalized = name.toLowerCase();
    if (normalized === "alternates" || normalized === "http-alternates") {
      throw mirrorError(
        "GIT_MIRROR_ALTERNATE_OBJECT_STORE",
        "Git bare mirror 不允许 alternate object store",
      );
    }
    if (name === "commit-graphs") {
      await scanRegularFiles({
        directory: path.join(listing.path, name),
        relativeDirectory: "info/commit-graphs",
        budget,
        records,
      });
      continue;
    }
    records.push(
      await regularObjectFile(
        path.join(listing.path, name),
        `info/${name}`,
      ),
    );
  }
}

async function captureObjectStoreBoundary(
  objectDirectory,
  oidLength,
  maximumEntries,
) {
  const budget = { count: 0, maximum: maximumEntries };
  const records = [];
  const root = await boundedDirectoryListing(objectDirectory, budget);
  records.push(directoryRecord("", root));
  for (const name of root.names) {
    const directory = path.join(root.path, name);
    if (name === "info") {
      await scanInfoDirectory({ directory, budget, records });
      continue;
    }
    if (name === "pack") {
      await scanRegularFiles({
        directory,
        relativeDirectory: "pack",
        budget,
        records,
        validateName(entry) {
          if (entry.toLowerCase().endsWith(".promisor")) {
            throw mirrorError(
              "GIT_MIRROR_PARTIAL_REPOSITORY",
              "Git bare mirror 不允许 partial/promisor object store",
            );
          }
          return true;
        },
      });
      continue;
    }
    if (!LOOSE_OBJECT_DIRECTORY.test(name)) {
      throw mirrorError(
        "GIT_MIRROR_OBJECT_STORE_UNSAFE",
        "Git bare mirror object store 顶层条目无效",
      );
    }
    const looseName = new RegExp(`^[a-f0-9]{${oidLength - 2}}$`, "u");
    await scanRegularFiles({
      directory,
      relativeDirectory: name,
      budget,
      records,
      validateName: (entry) => looseName.test(entry),
    });
  }
  for (const record of records.filter((entry) => entry.kind === "directory")) {
    const directory = record.path === ""
      ? root.path
      : path.join(root.path, ...record.path.split("/"));
    const current = await canonicalDirectory(
      directory,
      "GIT_MIRROR_OBJECT_STORE_UNSAFE",
      "Git bare mirror object store 目录不安全",
    );
    if (!sameFileIdentity(current.identity, record.identity)) {
      throw mirrorError(
        "GIT_MIRROR_BOUNDARY_CHANGED",
        "Git bare mirror object store 在扫描期间发生变化",
      );
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const content = {
    objectDirectory: root.path,
    entryCount: budget.count,
    records,
  };
  return Object.freeze({
    path: root.path,
    stats: root.stats,
    identity: root.identity,
    entryCount: budget.count,
    boundaryDigest: sha256(Buffer.from(JSON.stringify(content))),
  });
}

export class GitBareMirrorInspector {
  #gitCommand;
  #maxObjectStoreEntries;
  #run;
  #timeoutMs;

  constructor(value = {}) {
    const fields = configFields(value);
    const gitCommand = fields.get("gitCommand");
    const processRunner = fields.has("processRunner")
      ? fields.get("processRunner")
      : new ManagedProcessRunner();
    const timeoutMs = fields.has("timeoutMs") ? fields.get("timeoutMs") : 15_000;
    const maxObjectStoreEntries = fields.has("maxObjectStoreEntries")
      ? fields.get("maxObjectStoreEntries")
      : MAX_OBJECT_STORE_ENTRIES;
    if (
      typeof gitCommand !== "string" ||
      !path.isAbsolute(gitCommand) ||
      gitCommand.includes("\0") ||
      isNetworkPath(gitCommand)
    ) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_CONFIG",
        "gitCommand 必须是可信的绝对本地路径",
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_CONFIG",
        "Git bare mirror timeout 无效",
      );
    }
    if (
      !Number.isSafeInteger(maxObjectStoreEntries) ||
      maxObjectStoreEntries < 1 ||
      maxObjectStoreEntries > MAX_OBJECT_STORE_ENTRIES
    ) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_CONFIG",
        "Git bare mirror object store limit 无效",
      );
    }
    this.#gitCommand = path.resolve(gitCommand);
    this.#maxObjectStoreEntries = maxObjectStoreEntries;
    this.#run = requireRunner(processRunner);
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  async preflight(value) {
    const request = exactRequest(value);
    const normalizedRepository = repository(request.repository);
    if (
      typeof request.mirrorRoot !== "string" ||
      !path.isAbsolute(request.mirrorRoot) ||
      request.mirrorRoot.includes("\0") ||
      isNetworkPath(request.mirrorRoot) ||
      typeof request.expectedCommitOid !== "string" ||
      !GIT_OID.test(request.expectedCommitOid)
    ) {
      throw mirrorError(
        "INVALID_GIT_BARE_MIRROR_REQUEST",
        "Git bare mirror 请求无效",
      );
    }
    const mirrorRoot = path.resolve(request.mirrorRoot);
    const commitOid = request.expectedCommitOid;
    try {
      const rootIdentity = await canonicalDirectory(
        mirrorRoot,
        "GIT_MIRROR_ROOT_MISMATCH",
        "Git bare mirror 根目录身份不一致",
      );
      if (
        samePath(rootIdentity.path, this.#gitCommand) ||
        isDescendant(rootIdentity.path, this.#gitCommand)
      ) {
        throw mirrorError(
          "GIT_MIRROR_EXECUTABLE_UNTRUSTED",
          "Git executable 不得位于 mirror 内",
        );
      }
      const configWorktreePath = path.join(rootIdentity.path, "config.worktree");
      const commonDirPath = path.join(rootIdentity.path, "commondir");
      await assertMissingControlFile(configWorktreePath);
      await assertMissingControlFile(commonDirPath);
      const executableBefore = await fileIdentity(this.#gitCommand, {
        maximumBytes: MAX_GIT_EXECUTABLE_BYTES,
        executable: true,
      });
      const configPath = path.join(rootIdentity.path, "config");
      const configBefore = await fileIdentity(configPath, {
        maximumBytes: MAX_CONFIG_BYTES,
      });
      const configNames = configurationNames(
        await this.#gitText([
          "config",
          "--local",
          "--no-includes",
          "-z",
          "--name-only",
          "--list",
        ], rootIdentity.path, "GIT_MIRROR_UNTRUSTED_CONFIG"),
      );
      if (
        configNames.some(
          (name) =>
            name === "extensions.worktreeconfig" ||
            name.startsWith("include.") ||
            name.startsWith("includeif."),
        )
      ) {
        throw mirrorError(
          "GIT_MIRROR_UNTRUSTED_CONFIG",
          "Git bare mirror 不允许 include 配置",
        );
      }
      if (
        configNames.some(
          (name) =>
            name === "extensions.partialclone" ||
            (name.startsWith("remote.") && name.endsWith(".promisor")),
        )
      ) {
        throw mirrorError(
          "GIT_MIRROR_PARTIAL_REPOSITORY",
          "Git bare mirror 不允许 partial/promisor 配置",
        );
      }

      const bare = singleLine(
        await this.#gitText(["rev-parse", "--is-bare-repository"], rootIdentity.path),
      );
      if (bare !== "true") {
        throw mirrorError("GIT_MIRROR_NOT_BARE", "Git mirror 必须是 bare repository");
      }
      const objectFormat = singleLine(
        await this.#gitText(["rev-parse", "--show-object-format"], rootIdentity.path),
      );
      const oidLength = objectFormat === "sha1"
        ? 40
        : objectFormat === "sha256"
          ? 64
          : 0;
      if (oidLength === 0) {
        throw mirrorError(
          "GIT_MIRROR_OBJECT_FORMAT_UNSUPPORTED",
          "Git mirror object format 不受支持",
        );
      }
      if (commitOid.length !== oidLength) {
        throw mirrorError(
          "GIT_MIRROR_COMMIT_OID_MISMATCH",
          "Git commit OID 与 mirror object format 不匹配",
        );
      }
      const absoluteGitDir = path.resolve(singleLine(
        await this.#gitText(["rev-parse", "--absolute-git-dir"], rootIdentity.path),
      ));
      const commonDir = path.resolve(singleLine(
        await this.#gitText(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          rootIdentity.path,
        ),
      ));
      const reportedObjectDirectory = path.resolve(singleLine(
        await this.#gitText(
          ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
          rootIdentity.path,
        ),
      ));
      if (
        !samePath(absoluteGitDir, rootIdentity.path) ||
        !samePath(commonDir, rootIdentity.path) ||
        !samePath(reportedObjectDirectory, path.join(rootIdentity.path, "objects"))
      ) {
        throw mirrorError(
          "GIT_MIRROR_ROOT_MISMATCH",
          "Git bare mirror repository 边界不一致",
        );
      }
      const objectsIdentity = await canonicalDirectory(
        reportedObjectDirectory,
        "GIT_MIRROR_OBJECT_STORE_UNSAFE",
        "Git bare mirror object store 不安全",
      );
      const objectStoreBefore = await captureObjectStoreBoundary(
        objectsIdentity.path,
        oidLength,
        this.#maxObjectStoreEntries,
      );

      // The pre/post fence detects cooperative mirror refreshes. The mirror
      // manager must still hold its lease: read-only filesystem inspection
      // cannot exclude a hostile writer that also restores directory metadata.

      const commitAvailable = await this.#gitOptionalText(
        ["cat-file", "-e", `${commitOid}^{commit}`],
        rootIdentity.path,
      );
      if (commitAvailable === null) {
        throw mirrorError(
          "GIT_MIRROR_COMMIT_UNAVAILABLE",
          "指定 commit 不属于该 mirror 的本地对象库",
        );
      }
      const commitType = singleLine(
        await this.#gitText(["cat-file", "-t", commitOid], rootIdentity.path),
      );
      if (commitType !== "commit") {
        throw mirrorError(
          "GIT_MIRROR_COMMIT_UNAVAILABLE",
          "指定 OID 不是 commit",
        );
      }

      await assertMissingControlFile(configWorktreePath);
      await assertMissingControlFile(commonDirPath);
      const executableAfter = await fileIdentity(this.#gitCommand, {
        maximumBytes: MAX_GIT_EXECUTABLE_BYTES,
        executable: true,
      });
      const configAfter = await fileIdentity(configPath, {
        maximumBytes: MAX_CONFIG_BYTES,
      });
      const finalRoot = await canonicalDirectory(
        mirrorRoot,
        "GIT_MIRROR_BOUNDARY_CHANGED",
        "Git bare mirror 边界在检查期间发生变化",
      );
      const objectStoreAfter = await captureObjectStoreBoundary(
        objectsIdentity.path,
        oidLength,
        this.#maxObjectStoreEntries,
      );
      if (
        executableAfter.sha256 !== executableBefore.sha256 ||
        executableAfter.bytes !== executableBefore.bytes ||
        !sameFileIdentity(
          executableAfter.identity,
          executableBefore.identity,
        ) ||
        configAfter.sha256 !== configBefore.sha256 ||
        configAfter.bytes !== configBefore.bytes ||
        !sameFileIdentity(configAfter.identity, configBefore.identity) ||
        !samePath(finalRoot.path, rootIdentity.path) ||
        !sameFileIdentity(finalRoot.stats, rootIdentity.stats) ||
        objectStoreAfter.boundaryDigest !== objectStoreBefore.boundaryDigest
      ) {
        throw mirrorError(
          "GIT_MIRROR_BOUNDARY_CHANGED",
          "Git bare mirror 边界在检查期间发生变化",
        );
      }
      const content = {
        schemaVersion: 1,
        repository: normalizedRepository,
        canonicalRoot: rootIdentity.path,
        objectDirectory: objectsIdentity.path,
        objectFormat,
        oidLength,
        commitOid,
      };
      const boundaryDigest = sha256(Buffer.from(JSON.stringify({
        ...content,
        executable: {
          path: executableAfter.path,
          sha256: executableAfter.sha256,
          bytes: executableAfter.bytes,
          mode: executableAfter.mode,
          uid: executableAfter.uid,
          gid: executableAfter.gid,
        },
        config: {
          path: configPath,
          sha256: configAfter.sha256,
          bytes: configAfter.bytes,
        },
        mirrorRoot: finalRoot.identity,
        objectStore: {
          entryCount: objectStoreAfter.entryCount,
          boundaryDigest: objectStoreAfter.boundaryDigest,
        },
      })));
      return Object.freeze({ ...content, boundaryDigest });
    } catch (cause) {
      if (cause instanceof GitBareMirrorInspectorError) throw cause;
      throw mirrorError(
        "GIT_MIRROR_PREFLIGHT_FAILED",
        "Git bare mirror 边界预检失败",
        cause,
      );
    }
  }

  async #gitText(args, cwd, code = "GIT_MIRROR_PROTOCOL_ERROR") {
    return textOutput(await this.#run({
      command: this.#gitCommand,
      args: [...SAFE_GIT_PREFIX, ...args],
      cwd,
      env: SAFE_ENV,
      timeoutMs: this.#timeoutMs,
    }), { code });
  }

  async #gitOptionalText(args, cwd) {
    return textOutput(await this.#run({
      command: this.#gitCommand,
      args: [...SAFE_GIT_PREFIX, ...args],
      cwd,
      env: SAFE_ENV,
      timeoutMs: this.#timeoutMs,
    }), { optional: true });
  }
}
