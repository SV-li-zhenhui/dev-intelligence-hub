import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const KINDS = new Set(["input", "output", "manifest", "stdout", "stderr"]);
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export class CodeExecutionJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeExecutionJournalError";
    this.code = code;
  }
}

function journalError(code, message) {
  return new CodeExecutionJournalError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertId(value, code, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw journalError(code, `${label} 不安全`);
  }
  return value;
}

function assertKind(kind) {
  if (!KINDS.has(kind)) {
    throw journalError("INVALID_ARTIFACT_KIND", "审计产物类型无效");
  }
  return kind;
}

function artifactPath(sessionId, actionId, kind) {
  return `${sessionId}/${actionId}/${kind}.json`;
}

function validateReference(ref) {
  if (
    ref === null ||
    typeof ref !== "object" ||
    Array.isArray(ref) ||
    Object.getPrototypeOf(ref) !== Object.prototype
  ) {
    throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
  }
  const keys = Reflect.ownKeys(ref);
  if (
    keys.length !== 3 ||
    !["bytes", "path", "sha256"].every((key) => keys.includes(key)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
  }
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(ref, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
    }
    fields.set(key, descriptor.value);
  }
  const relativePath = fields.get("path");
  const digest = fields.get("sha256");
  const bytes = fields.get("bytes");
  if (
    typeof relativePath !== "string" ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1
  ) {
    throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
  }
  const segments = relativePath.split("/");
  if (segments.length !== 3 || !segments[2].endsWith(".json")) {
    throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
  }
  const [sessionId, actionId] = segments;
  const kind = segments[2].slice(0, -".json".length);
  if (
    !SAFE_ID.test(sessionId) ||
    !SAFE_ID.test(actionId) ||
    !KINDS.has(kind) ||
    artifactPath(sessionId, actionId, kind) !== relativePath
  ) {
    throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
  }
  return { sessionId, actionId, kind, sha256: digest, bytes };
}

export class CodeExecutionJournal {
  constructor({ root, maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES } = {}) {
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      root.includes("\0") ||
      !Number.isSafeInteger(maxArtifactBytes) ||
      maxArtifactBytes < 1
    ) {
      throw journalError("INVALID_JOURNAL_CONFIG", "审计存储配置无效");
    }
    this.root = path.resolve(root);
    this.maxArtifactBytes = maxArtifactBytes;
    this.writeTails = new Map();
  }

  async writeJson({ sessionId, actionId, kind, value } = {}) {
    assertId(sessionId, "INVALID_SESSION_ID", "sessionId");
    assertId(actionId, "INVALID_ACTION_ID", "actionId");
    assertKind(kind);

    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw journalError("INVALID_ARTIFACT_VALUE", "审计产物不是有效 JSON");
    }
    if (serialized === undefined) {
      throw journalError("INVALID_ARTIFACT_VALUE", "审计产物不是有效 JSON");
    }
    const content = Buffer.from(`${serialized}\n`, "utf8");
    if (content.length > this.maxArtifactBytes) {
      throw journalError("ARTIFACT_TOO_LARGE", "审计产物超过大小限制");
    }

    const relativePath = artifactPath(sessionId, actionId, kind);
    const ref = {
      path: relativePath,
      sha256: sha256(content),
      bytes: content.length,
    };
    return this.#enqueue(relativePath, () =>
      this.#writeArtifact({ sessionId, actionId, kind, content, ref }),
    );
  }

  async readJson(ref) {
    const content = await this.#readVerifiedBytes(ref);
    try {
      return JSON.parse(content.toString("utf8"));
    } catch {
      throw journalError("ARTIFACT_CORRUPTED", "审计产物完整性校验失败");
    }
  }

  async readBytes(ref) {
    return this.#readVerifiedBytes(ref);
  }

  async #readVerifiedBytes(ref) {
    const location = validateReference(ref);
    if (location.bytes > this.maxArtifactBytes) {
      throw journalError("INVALID_ARTIFACT_REF", "审计产物引用无效");
    }
    const target = path.join(
      this.root,
      location.sessionId,
      location.actionId,
      `${location.kind}.json`,
    );
    await this.#assertReadDirectories(location);

    let stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw journalError("ARTIFACT_NOT_FOUND", "审计产物不存在");
      }
      throw journalError("ARTIFACT_READ_FAILED", "无法读取审计产物");
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw journalError("ARTIFACT_CORRUPTED", "审计产物完整性校验失败");
    }
    if (stats.size !== location.bytes || stats.size > this.maxArtifactBytes) {
      throw journalError("ARTIFACT_CORRUPTED", "审计产物完整性校验失败");
    }

    let content;
    try {
      content = await readFile(target);
    } catch {
      throw journalError("ARTIFACT_READ_FAILED", "无法读取审计产物");
    }
    if (
      content.length !== location.bytes ||
      sha256(content) !== location.sha256
    ) {
      throw journalError("ARTIFACT_CORRUPTED", "审计产物完整性校验失败");
    }
    return content;
  }

  #enqueue(key, operation) {
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    this.writeTails.set(key, tail);
    return result.finally(() => {
      if (this.writeTails.get(key) === tail) this.writeTails.delete(key);
    });
  }

  async #writeArtifact({ sessionId, actionId, kind, content, ref }) {
    const actionDirectory = await this.#ensureWriteDirectories({
      sessionId,
      actionId,
    });
    const target = path.join(actionDirectory, `${kind}.json`);
    const existing = await this.#readExisting(target);
    if (existing) {
      if (existing.length === content.length && sha256(existing) === ref.sha256) {
        return ref;
      }
      throw journalError("ARTIFACT_CONFLICT", "审计产物已存在且内容不同");
    }

    const temporary = path.join(
      actionDirectory,
      `.journal-tmp-${randomUUID()}`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof CodeExecutionJournalError) throw error;
      throw journalError("ARTIFACT_WRITE_FAILED", "无法写入审计产物");
    }
    return ref;
  }

  async #readExisting(target) {
    let stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw journalError("ARTIFACT_WRITE_FAILED", "无法检查审计产物");
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw journalError("ARTIFACT_STORAGE_UNSAFE", "审计存储不安全");
    }
    if (stats.size > this.maxArtifactBytes) {
      throw journalError("ARTIFACT_CONFLICT", "审计产物已存在且内容不同");
    }
    try {
      return await readFile(target);
    } catch {
      throw journalError("ARTIFACT_WRITE_FAILED", "无法检查审计产物");
    }
  }

  async #ensureWriteDirectories({ sessionId, actionId }) {
    try {
      await mkdir(this.root, { recursive: true });
    } catch {
      throw journalError("ARTIFACT_WRITE_FAILED", "无法创建审计存储");
    }
    await this.#assertDirectory(this.root, "ARTIFACT_STORAGE_UNSAFE");

    const sessionDirectory = path.join(this.root, sessionId);
    const actionDirectory = path.join(sessionDirectory, actionId);
    for (const directory of [sessionDirectory, actionDirectory]) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw journalError("ARTIFACT_WRITE_FAILED", "无法创建审计存储");
        }
      }
      await this.#assertDirectory(directory, "ARTIFACT_STORAGE_UNSAFE");
    }
    return actionDirectory;
  }

  async #assertReadDirectories({ sessionId, actionId }) {
    for (const directory of [
      this.root,
      path.join(this.root, sessionId),
      path.join(this.root, sessionId, actionId),
    ]) {
      try {
        await this.#assertDirectory(directory, "ARTIFACT_CORRUPTED");
      } catch (error) {
        if (
          error?.code === "ARTIFACT_CORRUPTED" ||
          error?.code === "ARTIFACT_NOT_FOUND"
        ) {
          throw error;
        }
        throw journalError("ARTIFACT_READ_FAILED", "无法读取审计产物");
      }
    }
  }

  async #assertDirectory(directory, errorCode) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw journalError("ARTIFACT_NOT_FOUND", "审计产物不存在");
      }
      throw journalError(errorCode, "审计存储不安全");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw journalError(errorCode, "审计存储不安全");
    }
  }
}
