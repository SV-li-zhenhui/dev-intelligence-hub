import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  readdir,
  rename as renamePath,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  RestoreActivationRecordError,
  createRestoreActivationJournal,
  createRestoreActivationReceipt,
  normalizeRestoreActivationJournal,
  normalizeRestoreActivationReceipt,
} from "../domain/restore-activation-record.js";
import { OperationQueue } from "../lib/operation-queue.js";

const BACKUP_ID = /^backup-[a-f0-9]{64}$/;
const LOCK_NONCE = /^[a-f0-9-]{36}$/;
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const MAX_CONTROL_ENTRIES = 128;
const MAX_TREE_FILES = 100_000;
const MAX_TREE_DIRECTORIES = 100_000;
const MAX_TREE_DEPTH = 128;
const MAX_TREE_PATH_BYTES = 4_096;
const MAX_TREE_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const JOURNAL_NAME = "restore-activation-journal.json";
const RECEIPT_NAME = "restore-activation-receipt.json";
const LOCK_NAME = "restore-activation.lock";
const CANDIDATE_NAME = "candidate";
const ROLLBACK_NAME = "rollback";
const RESTORE_STAGING_PREFIX = ".restore-candidate-";
const CONTROL_TEMPORARY = /^\.(?:restore-activation-(?:journal|receipt)\.json|restore-activation-lock-owner)\.(\d{1,10})\.[a-f0-9-]{36}\.tmp$/;
const OPTION_KEYS = new Set([
  "activeDirectory",
  "backupDirectory",
  "controlDirectory",
  "backupService",
  "atomicDirectoryMover",
  "transitionObserver",
  "processProbe",
  "writerLease",
  "now",
  "idFactory",
  "operationQueue",
]);
const ACTIVE_LOCK_DIGESTS = new Set();

export class RestoreActivationError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RestoreActivationError";
    this.code = code;
    this.statusCode = code === "RESTORE_ACTIVATION_BUSY" ? 409 : 503;
    if (details !== undefined) this.details = details;
  }
}

function failure(code, message, options) {
  return new RestoreActivationError(code, message, options);
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlaps(left, right) {
  return (
    comparable(left) === comparable(right) ||
    isWithin(left, right) ||
    isWithin(right, left)
  );
}

function requireAbsoluteDirectory(value, name) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${name} must be an absolute directory`);
  }
  return path.resolve(value);
}

function dataMethod(value, method) {
  let current = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        return null;
      }
      return utilTypes.isProxy(descriptor.value) ? null : descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function requirePort(value, methods, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  const implementations = methods.map((method) => dataMethod(value, method));
  if (implementations.some((implementation) => implementation === null)) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  return Object.freeze(Object.fromEntries(methods.map((method, index) => [
    method,
    Function.prototype.bind.call(implementations[index], value),
  ])));
}

function optionalPort(value, methods, name) {
  return value === undefined || value === null ? null : requirePort(value, methods, name);
}

function serviceOptions(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("OfflineRestoreActivationService options must be a plain data record");
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !OPTION_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("OfflineRestoreActivationService options must be a plain data record");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function activationRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 1
  ) {
    throw new TypeError("activation request must contain only backupId");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "backupId");
  if (
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !BACKUP_ID.test(descriptor.value)
  ) {
    throw new TypeError("activation request backupId is invalid");
  }
  return descriptor.value;
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now returned an invalid date");
  return date.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintsEqual(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.digest === right.digest &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.totalBytes === right.totalBytes
  );
}

function sameFileIdentity(opened, named) {
  return (
    opened.isFile() &&
    named.isFile() &&
    !named.isSymbolicLink() &&
    (opened.ino === 0 || named.ino === 0 || opened.ino === named.ino) &&
    (opened.dev === 0 || named.dev === 0 || opened.dev === named.dev)
  );
}

function sameFileSnapshot(before, after) {
  return (
    before.isFile() &&
    after.isFile() &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    (before.ino === 0 || after.ino === 0 || before.ino === after.ino) &&
    (before.dev === 0 || after.dev === 0 || before.dev === after.dev)
  );
}

async function existingCanonicalDirectory(target, code, message) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw failure(code, message, { cause: error });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(code, message);
  const resolved = await realpath(target);
  if (comparable(resolved) !== comparable(target)) throw failure(code, message);
  return resolved;
}

async function requireCanonicalDirectory(target, code, message) {
  const resolved = await existingCanonicalDirectory(target, code, message);
  if (resolved === null) throw failure(code, message);
  return resolved;
}

async function readStableFile(target, code, message, { maximumLinks = 1 } = {}) {
  let handle;
  try {
    handle = await open(target, "r");
    const before = await handle.stat();
    const namedBefore = await lstat(target);
    if (
      !sameFileIdentity(before, namedBefore) ||
      before.nlink < 1 ||
      before.nlink > maximumLinks ||
      before.size > MAX_CONTROL_FILE_BYTES
    ) {
      throw failure(code, message);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, MAX_CONTROL_FILE_BYTES));
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_CONTROL_FILE_BYTES) throw failure(code, message);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    const namedAfter = await lstat(target);
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileIdentity(after, namedAfter) ||
      !sameFileSnapshot(namedBefore, namedAfter) ||
      bytes !== after.size
    ) {
      throw failure(code, message);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof RestoreActivationError) throw error;
    if (error?.code === "ENOENT") return null;
    throw failure(code, message, { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonRecord(target, normalizer, code, message, options) {
  const bytes = await readStableFile(target, code, message, options);
  if (bytes === null) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return normalizer(JSON.parse(text));
  } catch (error) {
    if (error instanceof RestoreActivationError) throw error;
    throw failure(code, message, { cause: error });
  }
}

async function writeTemporaryJson(controlRoot, baseName, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_CONTROL_FILE_BYTES) {
    throw failure("RESTORE_ACTIVATION_IO_FAILED", "恢复事务记录超出容量限制");
  }
  const temporary = path.join(
    controlRoot,
    `.${baseName}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    const named = await lstat(temporary);
    if (!sameFileIdentity(opened, named) || opened.size !== bytes.length) {
      throw failure("RESTORE_ACTIVATION_IO_FAILED", "恢复事务记录写入标识不一致");
    }
    await handle.close();
    handle = null;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof RestoreActivationError) throw error;
    throw failure("RESTORE_ACTIVATION_IO_FAILED", "无法持久化恢复事务记录", {
      cause: error,
    });
  }
}

async function publishJson(controlRoot, target, value, { replace }) {
  const temporary = await writeTemporaryJson(controlRoot, path.basename(target), value);
  let published = false;
  try {
    if (replace) {
      await renamePath(temporary, target);
    } else {
      await link(temporary, target);
      await unlink(temporary);
    }
    published = true;
    await syncDirectory(controlRoot);
  } catch (error) {
    throw failure("RESTORE_ACTIVATION_IO_FAILED", "无法发布恢复事务记录", {
      cause: error,
    });
  } finally {
    if (!published || replace) await rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)
    ) {
      return;
    }
    throw failure("RESTORE_ACTIVATION_IO_FAILED", "无法同步离线恢复目录", {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashStableFile(target, root) {
  let handle;
  try {
    const resolved = await realpath(target);
    if (comparable(resolved) !== comparable(target) || !isWithin(root, resolved)) {
      throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录文件路径无效");
    }
    handle = await open(target, "r");
    const before = await handle.stat();
    const namedBefore = await lstat(target);
    if (!sameFileIdentity(before, namedBefore) || before.nlink !== 1) {
      throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录包含链接或无效文件");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_TREE_TOTAL_BYTES) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录文件超出容量限制");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const namedAfter = await lstat(target);
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileIdentity(after, namedAfter) ||
      !sameFileSnapshot(namedBefore, namedAfter) ||
      bytes !== after.size
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录文件在读取期间变化");
    }
    return Object.freeze({ bytes, sha256: digest.digest("hex") });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function fingerprintDirectory(root) {
  const canonicalRoot = await requireCanonicalDirectory(
    root,
    "RESTORE_ACTIVATION_STATE_UNSAFE",
    "恢复目录无效或包含路径别名",
  );
  const records = [];
  const pending = [{ directory: canonicalRoot, relative: "", depth: 0 }];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_TREE_DEPTH) {
      throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录深度超出限制");
    }
    directoryCount += 1;
    if (directoryCount > MAX_TREE_DIRECTORIES) {
      throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录数量超出限制");
    }
    records.push(`D\0${current.relative}`);
    const directory = await opendir(current.directory);
    for await (const entry of directory) {
      const relative = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      if (Buffer.byteLength(relative, "utf8") > MAX_TREE_PATH_BYTES) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录路径超出限制");
      }
      const target = path.join(current.directory, entry.name);
      const info = await lstat(target);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录包含符号链接");
      }
      if (entry.isDirectory() && info.isDirectory()) {
        const resolved = await realpath(target);
        if (comparable(resolved) !== comparable(target) || !isWithin(root, resolved)) {
          throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录包含路径别名");
        }
        pending.push({
          directory: target,
          relative,
          depth: current.depth + 1,
        });
      } else if (entry.isFile() && info.isFile()) {
        fileCount += 1;
        if (fileCount > MAX_TREE_FILES) {
          throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录文件数量超出限制");
        }
        const hashed = await hashStableFile(target, root);
        totalBytes += hashed.bytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TREE_TOTAL_BYTES) {
          throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录总大小超出限制");
        }
        records.push(`F\0${relative}\0${hashed.bytes}\0${hashed.sha256}`);
      } else {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复目录包含不支持的节点");
      }
    }
  }
  records.sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({
    digest: sha256(records.join("\n")),
    fileCount,
    directoryCount,
    totalBytes,
  });
}

async function fingerprintIfPresent(target) {
  const directory = await existingCanonicalDirectory(
    target,
    "RESTORE_ACTIVATION_STATE_UNSAFE",
    "恢复事务目录无效或包含路径别名",
  );
  return directory === null ? null : fingerprintDirectory(directory);
}

function publicReceipt(receipt) {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    activationId: receipt.activationId,
    backupId: receipt.backupId,
    status: receipt.status,
    activatedAt: receipt.activatedAt,
  });
}

function rolledBackReceipt(journal, recoveredAt) {
  return Object.freeze({
    schemaVersion: 1,
    activationId: journal.activationId,
    backupId: journal.backupId,
    status: "rolled-back",
    recoveredAt,
  });
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function lockRecord({ pid, nonce, acquiredAt }) {
  const payload = { schemaVersion: 1, pid, nonce, acquiredAt };
  return Object.freeze({ ...payload, lockDigest: sha256(JSON.stringify(payload)) });
}

function normalizeLockRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("invalid lock record");
  }
  const keys = Reflect.ownKeys(value);
  const expected = ["schemaVersion", "pid", "nonce", "acquiredAt", "lockDigest"];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError("invalid lock record");
  }
  const record = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("invalid lock record");
    }
    record[key] = descriptor.value;
  }
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !LOCK_NONCE.test(record.nonce) ||
    typeof record.acquiredAt !== "string" ||
    new Date(record.acquiredAt).toISOString() !== record.acquiredAt ||
    !/^[a-f0-9]{64}$/.test(record.lockDigest)
  ) {
    throw new TypeError("invalid lock record");
  }
  const normalized = lockRecord(record);
  if (normalized.lockDigest !== record.lockDigest) throw new TypeError("invalid lock record");
  return normalized;
}

function restoredResultAccepted(value, backupId, candidate) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("manifest") ||
    !keys.includes("path") ||
    !keys.includes("ready")
  ) {
    return false;
  }
  const ready = Object.getOwnPropertyDescriptor(value, "ready");
  const restoredPath = Object.getOwnPropertyDescriptor(value, "path");
  const manifestDescriptor = Object.getOwnPropertyDescriptor(value, "manifest");
  if (
    !ready?.enumerable || !("value" in ready) || ready.value !== true ||
    !restoredPath?.enumerable || !("value" in restoredPath) ||
    typeof restoredPath.value !== "string" ||
    comparable(restoredPath.value) !== comparable(candidate) ||
    !manifestDescriptor?.enumerable || !("value" in manifestDescriptor)
  ) {
    return false;
  }
  const manifest = manifestDescriptor.value;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    utilTypes.isProxy(manifest) ||
    Array.isArray(manifest)
  ) {
    return false;
  }
  const id = Object.getOwnPropertyDescriptor(manifest, "backupId");
  return id?.enumerable && "value" in id && id.value === backupId;
}

export class OfflineRestoreActivationService {
  #activeDirectory;
  #backupDirectory;
  #controlDirectory;
  #backupService;
  #mover;
  #observer;
  #processProbe;
  #writerLease;
  #now;
  #idFactory;
  #queue;

  constructor(options = {}) {
    const entries = serviceOptions(options);
    this.#activeDirectory = requireAbsoluteDirectory(
      entries.get("activeDirectory"),
      "activeDirectory",
    );
    this.#backupDirectory = requireAbsoluteDirectory(
      entries.get("backupDirectory"),
      "backupDirectory",
    );
    this.#controlDirectory = requireAbsoluteDirectory(
      entries.get("controlDirectory"),
      "controlDirectory",
    );
    if (
      comparable(path.dirname(this.#activeDirectory)) !==
        comparable(path.dirname(this.#controlDirectory)) ||
      overlaps(this.#activeDirectory, this.#backupDirectory) ||
      overlaps(this.#activeDirectory, this.#controlDirectory) ||
      overlaps(this.#backupDirectory, this.#controlDirectory)
    ) {
      throw new TypeError("restore activation directories must be separate fixed siblings");
    }
    this.#backupService = requirePort(entries.get("backupService"), ["restore"], "backupService");
    this.#mover = entries.has("atomicDirectoryMover") && entries.get("atomicDirectoryMover") !== undefined
      ? requirePort(entries.get("atomicDirectoryMover"), ["rename"], "atomicDirectoryMover")
      : Object.freeze({ rename: renamePath });
    this.#observer = optionalPort(
      entries.get("transitionObserver"),
      ["observe"],
      "transitionObserver",
    );
    const processProbe = entries.has("processProbe")
      ? entries.get("processProbe")
      : defaultProcessProbe;
    const now = entries.has("now") ? entries.get("now") : () => new Date();
    const idFactory = entries.has("idFactory") ? entries.get("idFactory") : randomUUID;
    if (
      typeof processProbe !== "function" || utilTypes.isProxy(processProbe) ||
      typeof now !== "function" || utilTypes.isProxy(now) ||
      typeof idFactory !== "function" || utilTypes.isProxy(idFactory)
    ) {
      throw new TypeError("restore activation function dependencies are invalid");
    }
    this.#processProbe = processProbe;
    this.#writerLease = optionalPort(
      entries.get("writerLease"),
      ["assertHeld"],
      "writerLease",
    );
    this.#now = now;
    this.#idFactory = idFactory;
    const operationQueue = entries.has("operationQueue")
      ? entries.get("operationQueue")
      : new OperationQueue();
    this.#queue = requirePort(operationQueue, ["enqueue"], "operationQueue");
    Object.freeze(this);
  }

  activate(options = {}) {
    const backupId = activationRequest(options);
    return this.#queue.enqueue(() => this.#withLock(() => this.#activateLocked(backupId)));
  }

  recover() {
    return this.#queue.enqueue(() => this.#withLock(() => this.#recoverLocked()));
  }

  get #journalPath() {
    return path.join(this.#controlDirectory, JOURNAL_NAME);
  }

  get #receiptPath() {
    return path.join(this.#controlDirectory, RECEIPT_NAME);
  }

  get #lockPath() {
    return path.join(this.#controlDirectory, LOCK_NAME);
  }

  get #candidatePath() {
    return path.join(this.#controlDirectory, CANDIDATE_NAME);
  }

  get #rollbackPath() {
    return path.join(this.#controlDirectory, ROLLBACK_NAME);
  }

  async #verifyBoundaries() {
    const parent = path.dirname(this.#activeDirectory);
    const parentRoot = await requireCanonicalDirectory(
      parent,
      "RESTORE_ACTIVATION_BOUNDARY_INVALID",
      "活动数据父目录无效或包含路径别名",
    );
    if (
      comparable(path.join(parentRoot, path.basename(this.#activeDirectory))) !==
        comparable(this.#activeDirectory) ||
      comparable(path.join(parentRoot, path.basename(this.#controlDirectory))) !==
        comparable(this.#controlDirectory)
    ) {
      throw failure("RESTORE_ACTIVATION_BOUNDARY_INVALID", "恢复路径包含路径别名");
    }
    await requireCanonicalDirectory(
      this.#backupDirectory,
      "RESTORE_ACTIVATION_BOUNDARY_INVALID",
      "备份目录无效或包含路径别名",
    );
    await existingCanonicalDirectory(
      this.#activeDirectory,
      "RESTORE_ACTIVATION_BOUNDARY_INVALID",
      "活动数据目录无效或包含路径别名",
    );
    try {
      await mkdir(this.#controlDirectory, { recursive: false });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw failure("RESTORE_ACTIVATION_BOUNDARY_INVALID", "无法创建离线恢复控制目录", {
          cause: error,
        });
      }
    }
    await requireCanonicalDirectory(
      this.#controlDirectory,
      "RESTORE_ACTIVATION_BOUNDARY_INVALID",
      "离线恢复控制目录无效或包含路径别名",
    );
    const entries = await readdir(this.#controlDirectory);
    if (entries.length > MAX_CONTROL_ENTRIES) {
      throw failure("RESTORE_ACTIVATION_BOUNDARY_INVALID", "离线恢复控制目录条目超出限制");
    }
  }

  async #withLock(operation) {
    await this.#verifyBoundaries();
    const owner = await this.#acquireLock();
    let operationError;
    try {
      await this.#discardAbandonedControlTemporaries();
      await this.#observe("lock-acquired");
      return await operation();
    } catch (error) {
      operationError = error;
      if (error instanceof RestoreActivationError) throw error;
      throw failure("RESTORE_ACTIVATION_IO_FAILED", "离线恢复事务失败", { cause: error });
    } finally {
      try {
        await this.#releaseLock(owner);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
      }
    }
  }

  async #acquireLock() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const owner = lockRecord({
        pid: process.pid,
        nonce: randomUUID(),
        acquiredAt: isoNow(this.#now),
      });
      const temporary = await writeTemporaryJson(
        this.#controlDirectory,
        "restore-activation-lock-owner",
        owner,
      );
      try {
        await link(temporary, this.#lockPath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        if (error?.code !== "EEXIST") {
          throw failure("RESTORE_ACTIVATION_LOCK_FAILED", "无法取得离线恢复独占锁", {
            cause: error,
          });
        }
        const existing = await readJsonRecord(
          this.#lockPath,
          normalizeLockRecord,
          "RESTORE_ACTIVATION_LOCK_CORRUPTED",
          "离线恢复锁记录损坏",
          { maximumLinks: 2 },
        );
        if (existing === null) continue;
        let alive;
        try {
          alive = await this.#processProbe(existing.pid);
        } catch (probeError) {
          throw failure("RESTORE_ACTIVATION_LOCK_FAILED", "无法核对离线恢复锁所有者", {
            cause: probeError,
          });
        }
        if (
          alive !== false &&
          (
            this.#writerLease === null ||
            ACTIVE_LOCK_DIGESTS.has(existing.lockDigest)
          )
        ) {
          throw failure("RESTORE_ACTIVATION_BUSY", "另一个离线恢复进程正在执行");
        }
        if (alive !== false) {
          try {
            await this.#writerLease.assertHeld();
          } catch (leaseError) {
            throw failure("RESTORE_ACTIVATION_LOCK_FAILED", "无法证明离线恢复独占写租约", {
              cause: leaseError,
            });
          }
        }
        const current = await readJsonRecord(
          this.#lockPath,
          normalizeLockRecord,
          "RESTORE_ACTIVATION_LOCK_CORRUPTED",
          "离线恢复锁记录损坏",
          { maximumLinks: 2 },
        );
        if (current?.lockDigest !== existing.lockDigest) continue;
        await unlink(this.#lockPath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      let linkedTemporary = null;
      try {
        await unlink(temporary);
      } catch {
        linkedTemporary = temporary;
      }
      ACTIVE_LOCK_DIGESTS.add(owner.lockDigest);
      return Object.freeze({ record: owner, linkedTemporary });
    }
    throw failure("RESTORE_ACTIVATION_BUSY", "无法取得离线恢复独占锁");
  }

  async #releaseLock(owner) {
    const current = await readJsonRecord(
      this.#lockPath,
      normalizeLockRecord,
      "RESTORE_ACTIVATION_LOCK_CORRUPTED",
      "离线恢复锁记录损坏",
      { maximumLinks: 2 },
    );
    if (current === null || current.lockDigest !== owner.record.lockDigest) {
      throw failure("RESTORE_ACTIVATION_LOCK_CORRUPTED", "离线恢复锁所有权发生变化");
    }
    await unlink(this.#lockPath);
    if (owner.linkedTemporary !== null) {
      await rm(owner.linkedTemporary, { force: true });
    }
    await syncDirectory(this.#controlDirectory);
    ACTIVE_LOCK_DIGESTS.delete(owner.record.lockDigest);
  }

  async #discardAbandonedControlTemporaries() {
    const entries = await readdir(this.#controlDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const match = CONTROL_TEMPORARY.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue;
      let alive;
      try {
        alive = await this.#processProbe(pid);
      } catch {
        continue;
      }
      if (alive !== false) continue;
      const target = path.join(this.#controlDirectory, entry.name);
      const info = await lstat(target);
      if (
        !entry.isFile() ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink < 1 ||
        info.nlink > 2
      ) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复控制目录包含不安全临时文件");
      }
      if (info.nlink === 2) {
        const authoritative = entry.name.startsWith(`.${JOURNAL_NAME}.`)
          ? this.#journalPath
          : entry.name.startsWith(`.${RECEIPT_NAME}.`)
            ? this.#receiptPath
            : this.#lockPath;
        const published = await lstat(authoritative).catch(() => null);
        if (
          published === null ||
          !published.isFile() ||
          published.isSymbolicLink() ||
          (info.ino !== 0 && published.ino !== 0 && info.ino !== published.ino) ||
          (info.dev !== 0 && published.dev !== 0 && info.dev !== published.dev)
        ) {
          throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复控制临时文件链接关系无效");
        }
      }
      await rm(target, { force: true });
    }
  }

  async #readJournal() {
    return readJsonRecord(
      this.#journalPath,
      normalizeRestoreActivationJournal,
      "RESTORE_ACTIVATION_JOURNAL_CORRUPTED",
      "离线恢复事务日志损坏",
    );
  }

  async #readReceipt() {
    return readJsonRecord(
      this.#receiptPath,
      normalizeRestoreActivationReceipt,
      "RESTORE_ACTIVATION_RECEIPT_CORRUPTED",
      "离线恢复回执损坏",
    );
  }

  async #writeJournal(journal, replace = true) {
    await publishJson(this.#controlDirectory, this.#journalPath, journal, { replace });
    return journal;
  }

  async #transition(journal, phase, { failureCode = null } = {}) {
    const next = createRestoreActivationJournal({
      activationId: journal.activationId,
      backupId: journal.backupId,
      requestedAt: journal.requestedAt,
      phase,
      hadActive: journal.hadActive,
      previousFingerprint: journal.previousFingerprint,
      candidateFingerprint: journal.candidateFingerprint,
      failureCode,
    });
    await this.#writeJournal(next);
    return next;
  }

  async #observe(stage) {
    if (!this.#observer) return;
    try {
      await this.#observer.observe(Object.freeze({ stage }));
    } catch {
      // The observer has no authority over the transaction; it is diagnostic only.
    }
  }

  async #activateLocked(backupId) {
    const journal = await this.#readJournal();
    if (journal !== null) {
      if (journal.backupId !== backupId) {
        throw failure(
          "RESTORE_ACTIVATION_RECOVERY_REQUIRED",
          "存在另一备份的未完成离线恢复事务",
        );
      }
      const recovered = await this.#advance(journal);
      if (recovered.status === "rolled-back") {
        throw failure("RESTORE_ACTIVATION_ROLLED_BACK", "上一次离线恢复已安全回滚", {
          details: recovered,
        });
      }
      return recovered;
    }
    const receipt = await this.#readReceipt();
    if (receipt?.backupId === backupId) {
      const active = await fingerprintIfPresent(this.#activeDirectory);
      if (!fingerprintsEqual(active, receipt.activeFingerprint)) {
        throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "活动数据与离线恢复回执不一致");
      }
      await this.#assertNoOrphanedSwapState();
      return publicReceipt(receipt);
    }
    await this.#assertNoOrphanedSwapState();
    const previousFingerprint = await fingerprintIfPresent(this.#activeDirectory);
    const activationId = `restore-activation-${sha256(
      `${backupId}\0${this.#idFactory()}`,
    )}`;
    const prepared = createRestoreActivationJournal({
      activationId,
      backupId,
      requestedAt: isoNow(this.#now),
      phase: "prepared",
      hadActive: previousFingerprint !== null,
      previousFingerprint,
      candidateFingerprint: null,
      failureCode: null,
    });
    await this.#writeJournal(prepared, false);
    await this.#observe("journal-prepared");
    return this.#advance(prepared);
  }

  async #recoverLocked() {
    const journal = await this.#readJournal();
    if (journal !== null) return this.#advance(journal);
    await this.#assertNoOrphanedSwapState();
    const receipt = await this.#readReceipt();
    if (receipt === null) return null;
    const active = await fingerprintIfPresent(this.#activeDirectory);
    if (!fingerprintsEqual(active, receipt.activeFingerprint)) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "活动数据与离线恢复回执不一致");
    }
    return publicReceipt(receipt);
  }

  async #assertNoOrphanedSwapState() {
    const [candidate, rollback] = await Promise.all([
      existingCanonicalDirectory(
        this.#candidatePath,
        "RESTORE_ACTIVATION_ORPHANED_STATE",
        "存在无事务日志的恢复候选目录",
      ),
      existingCanonicalDirectory(
        this.#rollbackPath,
        "RESTORE_ACTIVATION_ORPHANED_STATE",
        "存在无事务日志的恢复回滚目录",
      ),
    ]);
    if (candidate !== null || rollback !== null) {
      throw failure("RESTORE_ACTIVATION_ORPHANED_STATE", "存在无事务日志的离线恢复状态");
    }
    const entries = await readdir(this.#controlDirectory);
    if (entries.some((name) => name.startsWith(RESTORE_STAGING_PREFIX))) {
      throw failure("RESTORE_ACTIVATION_ORPHANED_STATE", "存在无事务日志的恢复临时目录");
    }
  }

  async #advance(initialJournal) {
    let journal = initialJournal;
    for (;;) {
      if (journal.phase === "prepared") {
        journal = await this.#prepareCandidate(journal);
        continue;
      }
      if (journal.phase === "candidate-ready") {
        journal = await this.#moveActiveAside(journal);
        continue;
      }
      if (journal.phase === "active-moved") {
        journal = await this.#activateCandidate(journal);
        continue;
      }
      if (journal.phase === "rollback-required") {
        return this.#completeRollback(journal);
      }
      if (journal.phase === "candidate-activated") {
        return this.#commitActivation(journal);
      }
      throw failure("RESTORE_ACTIVATION_JOURNAL_CORRUPTED", "离线恢复事务阶段无效");
    }
  }

  async #state() {
    const [active, candidate, rollback] = await Promise.all([
      fingerprintIfPresent(this.#activeDirectory),
      fingerprintIfPresent(this.#candidatePath),
      fingerprintIfPresent(this.#rollbackPath),
    ]);
    return Object.freeze({ active, candidate, rollback });
  }

  #previousStateMatches(journal, fingerprint) {
    return journal.hadActive
      ? fingerprintsEqual(fingerprint, journal.previousFingerprint)
      : fingerprint === null;
  }

  #rollbackStateMatches(journal, fingerprint) {
    return journal.hadActive
      ? fingerprintsEqual(fingerprint, journal.previousFingerprint)
      : fingerprint === null;
  }

  async #prepareCandidate(journal) {
    const state = await this.#state();
    if (!this.#previousStateMatches(journal, state.active) || state.rollback !== null) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "候选恢复前活动数据状态不一致");
    }
    if (state.candidate !== null) {
      await rm(this.#candidatePath, { recursive: true, force: true });
    }
    await this.#discardAuthorizedRestoreStaging();
    let restored;
    try {
      restored = await this.#backupService.restore({
        backupId: journal.backupId,
        destinationDirectory: this.#candidatePath,
      });
      if (!restoredResultAccepted(restored, journal.backupId, this.#candidatePath)) {
        throw new TypeError("backup service returned an invalid restore result");
      }
    } catch (error) {
      const cleaned = await this.#discardCandidateAndStaging();
      if (cleaned) await rm(this.#journalPath, { force: true }).catch(() => {});
      if (!cleaned) {
        throw failure(
          "RESTORE_ACTIVATION_RECOVERY_REQUIRED",
          "候选恢复失败且临时状态需要离线恢复",
          { cause: error },
        );
      }
      throw failure("RESTORE_ACTIVATION_CANDIDATE_FAILED", "候选恢复校验、迁移或核对失败", {
        cause: error,
      });
    }
    await this.#observe("candidate-published");
    const candidateFingerprint = await fingerprintDirectory(this.#candidatePath);
    const after = await this.#state();
    if (
      !this.#previousStateMatches(journal, after.active) ||
      !fingerprintsEqual(after.candidate, candidateFingerprint) ||
      after.rollback !== null
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "候选恢复后活动数据状态发生变化");
    }
    journal = createRestoreActivationJournal({
      activationId: journal.activationId,
      backupId: journal.backupId,
      requestedAt: journal.requestedAt,
      phase: "candidate-ready",
      hadActive: journal.hadActive,
      previousFingerprint: journal.previousFingerprint,
      candidateFingerprint,
      failureCode: null,
    });
    await this.#writeJournal(journal);
    await this.#observe("candidate-ready");
    return journal;
  }

  async #moveActiveAside(journal) {
    const state = await this.#state();
    if (
      fingerprintsEqual(state.active, journal.candidateFingerprint) &&
      state.candidate === null &&
      this.#rollbackStateMatches(journal, state.rollback)
    ) {
      return this.#transition(journal, "candidate-activated");
    }
    if (
      state.active === null &&
      fingerprintsEqual(state.candidate, journal.candidateFingerprint) &&
      this.#rollbackStateMatches(journal, state.rollback)
    ) {
      return this.#transition(journal, "active-moved");
    }
    if (
      !this.#previousStateMatches(journal, state.active) ||
      !fingerprintsEqual(state.candidate, journal.candidateFingerprint) ||
      state.rollback !== null
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "活动数据移交前事务状态不一致");
    }
    if (journal.hadActive) {
      await this.#mover.rename(this.#activeDirectory, this.#rollbackPath);
      await this.#syncSwapRoots();
      await this.#observe("active-renamed");
    }
    journal = await this.#transition(journal, "active-moved");
    await this.#observe("active-moved");
    return journal;
  }

  async #activateCandidate(journal) {
    const state = await this.#state();
    if (
      fingerprintsEqual(state.active, journal.candidateFingerprint) &&
      state.candidate === null &&
      this.#rollbackStateMatches(journal, state.rollback)
    ) {
      return this.#transition(journal, "candidate-activated");
    }
    if (
      state.active !== null ||
      !fingerprintsEqual(state.candidate, journal.candidateFingerprint) ||
      !this.#rollbackStateMatches(journal, state.rollback)
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "候选激活前事务状态不一致");
    }
    try {
      await this.#mover.rename(this.#candidatePath, this.#activeDirectory);
      await this.#syncSwapRoots();
    } catch (error) {
      let rollbackJournal;
      try {
        rollbackJournal = await this.#transition(journal, "rollback-required", {
          failureCode: "RESTORE_ACTIVATION_SWAP_FAILED",
        });
      } catch (journalError) {
        throw failure(
          "RESTORE_ACTIVATION_RECOVERY_REQUIRED",
          "候选激活失败且无法持久化回滚意图",
          { cause: journalError },
        );
      }
      try {
        await this.#completeRollback(rollbackJournal);
      } catch (rollbackError) {
        throw failure(
          "RESTORE_ACTIVATION_RECOVERY_REQUIRED",
          "候选激活失败且旧数据尚未恢复",
          { cause: rollbackError },
        );
      }
      throw failure("RESTORE_ACTIVATION_SWAP_FAILED", "候选数据未能原子激活，旧数据已恢复", {
        cause: error,
      });
    }
    await this.#observe("candidate-renamed");
    journal = await this.#transition(journal, "candidate-activated");
    await this.#observe("candidate-activated");
    return journal;
  }

  async #completeRollback(journal) {
    const state = await this.#state();
    if (journal.hadActive) {
      if (
        state.active === null &&
        fingerprintsEqual(state.rollback, journal.previousFingerprint) &&
        fingerprintsEqual(state.candidate, journal.candidateFingerprint)
      ) {
        try {
          await this.#mover.rename(this.#rollbackPath, this.#activeDirectory);
          await this.#syncSwapRoots();
        } catch (error) {
          throw failure("RESTORE_ACTIVATION_RECOVERY_REQUIRED", "旧活动数据回滚失败", {
            cause: error,
          });
        }
        await this.#observe("rollback-restored");
      } else if (
        !fingerprintsEqual(state.active, journal.previousFingerprint) ||
        state.rollback !== null ||
        !fingerprintsEqual(state.candidate, journal.candidateFingerprint)
      ) {
        throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "回滚事务状态无法安全推断");
      }
    } else if (
      state.active !== null ||
      state.rollback !== null ||
      !fingerprintsEqual(state.candidate, journal.candidateFingerprint)
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "无旧数据回滚事务状态无法安全推断");
    }
    await rm(this.#candidatePath, { recursive: true, force: true });
    await rm(this.#journalPath, { force: true });
    await syncDirectory(this.#controlDirectory);
    await this.#discardAuthorizedRestoreStaging();
    return rolledBackReceipt(journal, isoNow(this.#now));
  }

  async #commitActivation(journal) {
    const state = await this.#state();
    let receipt = await this.#readReceipt();
    const receiptMatches =
      receipt !== null &&
      receipt.activationId === journal.activationId &&
      receipt.backupId === journal.backupId &&
      fingerprintsEqual(receipt.activeFingerprint, journal.candidateFingerprint);
    const rollbackIsCommitted =
      this.#rollbackStateMatches(journal, state.rollback) ||
      (journal.hadActive && state.rollback === null && receiptMatches);
    if (
      !fingerprintsEqual(state.active, journal.candidateFingerprint) ||
      state.candidate !== null ||
      !rollbackIsCommitted
    ) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "提交恢复事务前目录状态不一致");
    }
    if (!receiptMatches) {
      receipt = createRestoreActivationReceipt({
        activationId: journal.activationId,
        backupId: journal.backupId,
        activatedAt: isoNow(this.#now),
        activeFingerprint: journal.candidateFingerprint,
      });
      await publishJson(this.#controlDirectory, this.#receiptPath, receipt, {
        replace: receipt !== null,
      });
    }
    await this.#observe("receipt-persisted");
    if (state.rollback !== null) {
      await rm(this.#rollbackPath, { recursive: true, force: true });
      await syncDirectory(this.#controlDirectory);
    }
    await this.#observe("rollback-cleaned");
    await rm(this.#journalPath, { force: true });
    await syncDirectory(this.#controlDirectory);
    await this.#discardAuthorizedRestoreStaging();
    return publicReceipt(receipt);
  }

  async #discardAuthorizedRestoreStaging() {
    const entries = await readdir(this.#controlDirectory, { withFileTypes: true });
    const staging = entries.filter(({ name }) => name.startsWith(RESTORE_STAGING_PREFIX));
    if (staging.length > 8) {
      throw failure("RESTORE_ACTIVATION_STATE_UNCERTAIN", "恢复临时目录数量超出限制");
    }
    for (const entry of staging) {
      const target = path.join(this.#controlDirectory, entry.name);
      const info = await lstat(target);
      if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink()) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复临时目录包含不安全节点");
      }
      const resolved = await realpath(target);
      if (comparable(resolved) !== comparable(target) || !isWithin(this.#controlDirectory, resolved)) {
        throw failure("RESTORE_ACTIVATION_STATE_UNSAFE", "恢复临时目录路径无效");
      }
      await rm(target, { recursive: true, force: true });
    }
  }

  async #syncSwapRoots() {
    await syncDirectory(path.dirname(this.#activeDirectory));
    await syncDirectory(this.#controlDirectory);
  }

  async #discardCandidateAndStaging() {
    try {
      const candidate = await existingCanonicalDirectory(
        this.#candidatePath,
        "RESTORE_ACTIVATION_STATE_UNSAFE",
        "候选恢复目录不安全",
      );
      if (candidate !== null) await rm(candidate, { recursive: true, force: true });
      await this.#discardAuthorizedRestoreStaging();
      return true;
    } catch {
      return false;
    }
  }
}
