import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  BackupManifestError,
  createBackupManifest,
  normalizeBackupManifest,
} from "../domain/backup-manifest.js";
import { OperationQueue } from "../lib/operation-queue.js";

const BACKUP_ID = /^backup-[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_PAYLOAD_FILES = 100_000;
const MAX_PAYLOAD_DIRECTORIES = 100_000;
const MAX_PAYLOAD_DEPTH = 128;
const MAX_PAYLOAD_PATH_BYTES = 4_096;
const MAX_PAYLOAD_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 1_000;
const CATALOG_NAME = ".backup-catalog-v1.json";
const CATALOG_TEMPORARY = /^\.backup-catalog-v1\.json\.(\d{1,10})\.[a-f0-9-]{36}\.tmp$/u;
const MAX_CATALOG_BYTES = 1024 * 1024;
const BACKUP_OPTION_KEYS = new Set([
  "sourceDirectory",
  "backupDirectory",
  "quiescence",
  "migration",
  "canonicalization",
  "reconciliation",
  "now",
  "operationQueue",
  "directorySync",
]);

export class BackupServiceError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackupServiceError";
    this.code = code;
    this.statusCode = code === "BACKUP_CORRUPTED" ? 409 : 503;
    if (details !== undefined) this.details = details;
  }
}

function failure(code, message, options) {
  return new BackupServiceError(code, message, options);
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

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function assertSeparateRoots(left, right) {
  if (
    comparable(left) === comparable(right) ||
    isWithin(left, right) ||
    isWithin(right, left)
  ) {
    throw new TypeError("sourceDirectory and backupDirectory must not overlap");
  }
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
  return Object.freeze(
    Object.fromEntries(methods.map((method, index) => [
      method,
      Function.prototype.bind.call(implementations[index], value),
    ])),
  );
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
    throw new TypeError("BackupService options must be a plain data record");
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !BACKUP_OPTION_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("BackupService options must be a plain data record");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function restoreRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("restore request must be a plain data record");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("backupId") ||
    !keys.includes("destinationDirectory")
  ) {
    throw new TypeError("restore request must be a plain data record");
  }
  const result = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("restore request must be a plain data record");
    }
    result.set(key, descriptor.value);
  }
  return result;
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

function validIsoTimestamp(value) {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function catalogItem({
  backupId,
  createdAt,
  checkpointId,
  fileCount,
  totalBytes,
  status,
  verifiedAt,
}) {
  return Object.freeze({
    backupId,
    createdAt,
    checkpointId,
    fileCount,
    totalBytes,
    status,
    verifiedAt,
  });
}

function itemFromManifest(manifest, status, verifiedAt) {
  return catalogItem({
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    checkpointId: manifest.checkpoint.checkpointId,
    fileCount: manifest.totals.fileCount,
    totalBytes: manifest.totals.totalBytes,
    status,
    verifiedAt,
  });
}

function corruptedItem(backupId, prior, verifiedAt) {
  return catalogItem({
    backupId,
    createdAt: prior?.createdAt ?? null,
    checkpointId: prior?.checkpointId ?? null,
    fileCount: prior?.fileCount ?? null,
    totalBytes: prior?.totalBytes ?? null,
    status: "corrupted",
    verifiedAt,
  });
}

function normalizeCatalogItem(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("invalid backup catalog item");
  }
  const expected = [
    "backupId",
    "createdAt",
    "checkpointId",
    "fileCount",
    "totalBytes",
    "status",
    "verifiedAt",
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError("invalid backup catalog item");
  }
  const item = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("invalid backup catalog item");
    }
    item[key] = descriptor.value;
  }
  const nullableTimestamp = item.createdAt === null || validIsoTimestamp(item.createdAt);
  const nullableCheckpoint = item.checkpointId === null ||
    (typeof item.checkpointId === "string" && TOKEN.test(item.checkpointId));
  const nullableCount = (candidate) => candidate === null ||
    (Number.isSafeInteger(candidate) && candidate >= 0);
  if (
    typeof item.backupId !== "string" ||
    !BACKUP_ID.test(item.backupId) ||
    !nullableTimestamp ||
    !nullableCheckpoint ||
    !nullableCount(item.fileCount) ||
    !nullableCount(item.totalBytes) ||
    !["verified", "corrupted"].includes(item.status) ||
    !validIsoTimestamp(item.verifiedAt) ||
    (
      item.status === "verified" &&
      (
        item.createdAt === null ||
        item.checkpointId === null ||
        item.fileCount === null ||
        item.totalBytes === null
      )
    )
  ) {
    throw new TypeError("invalid backup catalog item");
  }
  return catalogItem(item);
}

function createCatalog({ revision, updatedAt, items }) {
  const payload = {
    schemaVersion: 1,
    revision,
    updatedAt,
    items,
  };
  return Object.freeze({
    ...payload,
    catalogDigest: sha256(JSON.stringify(payload)),
  });
}

function normalizeCatalog(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("invalid backup catalog");
  }
  const expected = ["schemaVersion", "revision", "updatedAt", "items", "catalogDigest"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError("invalid backup catalog");
  }
  const record = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("invalid backup catalog");
    }
    record[key] = descriptor.value;
  }
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !validIsoTimestamp(record.updatedAt) ||
    !Array.isArray(record.items) ||
    Object.getPrototypeOf(record.items) !== Array.prototype ||
    record.items.length > MAX_BACKUP_ENTRIES ||
    Reflect.ownKeys(record.items).length !== record.items.length + 1 ||
    typeof record.catalogDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.catalogDigest)
  ) {
    throw new TypeError("invalid backup catalog");
  }
  const items = record.items.map(normalizeCatalogItem);
  if (new Set(items.map(({ backupId }) => backupId)).size !== items.length) {
    throw new TypeError("invalid backup catalog");
  }
  const normalized = createCatalog({
    revision: record.revision,
    updatedAt: record.updatedAt,
    items,
  });
  if (normalized.catalogDigest !== record.catalogDigest) {
    throw new TypeError("invalid backup catalog");
  }
  return normalized;
}

function checkpointEnvelope(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure("BACKUP_QUIESCENCE_INVALID", "全局 checkpoint 返回无效");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("token") ||
    !keys.includes("stores") ||
    !keys.includes("files")
  ) {
    throw failure("BACKUP_QUIESCENCE_INVALID", "全局 checkpoint 返回无效");
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw failure("BACKUP_QUIESCENCE_INVALID", "全局 checkpoint 返回无效");
    }
    result[key] = descriptor.value;
  }
  if (typeof result.token !== "string" || !TOKEN.test(result.token)) {
    throw failure("BACKUP_QUIESCENCE_INVALID", "全局 checkpoint token 无效");
  }
  return result;
}

function reconciliationAccepted(value) {
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
    keys.length !== 2 ||
    !keys.includes("ready") ||
    !keys.includes("blockers")
  ) {
    return false;
  }
  const ready = Object.getOwnPropertyDescriptor(value, "ready");
  const blockers = Object.getOwnPropertyDescriptor(value, "blockers");
  if (
    !ready?.enumerable ||
    !("value" in ready) ||
    ready.value !== true ||
    !blockers?.enumerable ||
    !("value" in blockers) ||
    utilTypes.isProxy(blockers.value) ||
    !Array.isArray(blockers.value) ||
    Object.getPrototypeOf(blockers.value) !== Array.prototype ||
    blockers.value.length !== 0 ||
    Reflect.ownKeys(blockers.value).length !== 1
  ) {
    return false;
  }
  return true;
}

async function verifiedDirectoryRoot(configured, {
  code,
  create = false,
  message,
}) {
  try {
    let info;
    try {
      info = await lstat(configured);
    } catch (error) {
      if (!create || error?.code !== "ENOENT") throw error;
      await verifiedDirectoryRoot(path.dirname(configured), { code, message });
      await mkdir(configured, { recursive: false });
      info = await lstat(configured);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw failure(code, message);
    }
    const resolved = await realpath(configured);
    if (comparable(resolved) !== comparable(configured)) {
      throw failure(code, message);
    }
    return resolved;
  } catch (error) {
    if (error instanceof BackupServiceError) throw error;
    throw failure(code, message, { cause: error });
  }
}

async function verifiedDirectoryBoundary(configured, options) {
  try {
    return await verifiedDirectoryRoot(configured, options);
  } catch (error) {
    if (!(error instanceof BackupServiceError) || error.cause?.code !== "ENOENT") {
      throw error;
    }
    const parent = path.dirname(configured);
    const realParent = await verifiedDirectoryRoot(parent, options);
    const prospective = path.join(realParent, path.basename(configured));
    if (comparable(prospective) !== comparable(configured)) {
      throw failure(options.code, options.message);
    }
    return prospective;
  }
}

async function verifiedOperationalRoots(sourceDirectory, backupDirectory) {
  const sourceRoot = await verifiedDirectoryBoundary(sourceDirectory, {
    code: "BACKUP_SOURCE_INVALID",
    message: "备份来源目录无效或包含路径别名",
  });
  const backupRoot = await verifiedDirectoryRoot(backupDirectory, {
    code: "BACKUP_STORAGE_INVALID",
    message: "备份存储目录无效或包含路径别名",
  });
  try {
    assertSeparateRoots(sourceRoot, backupRoot);
  } catch (error) {
    throw failure("BACKUP_STORAGE_INVALID", "备份来源与存储真实路径重叠", {
      cause: error,
    });
  }
  return Object.freeze({ sourceRoot, backupRoot });
}

function sourcePath(root, relativePath) {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, candidate)) {
    throw failure("BACKUP_SOURCE_INVALID", "备份来源越出数据目录");
  }
  return candidate;
}

async function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw failure("BACKUP_SOURCE_INVALID", "备份来源包含符号链接");
    }
  }
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

function sameFileIdentity(opened, named) {
  return (
    opened.isFile() &&
    named.isFile() &&
    !named.isSymbolicLink() &&
    (opened.ino === 0 || named.ino === 0 || opened.ino === named.ino) &&
    (opened.dev === 0 || named.dev === 0 || opened.dev === named.dev)
  );
}

async function assertCanonicalRealPath(root, candidate, code, message) {
  const resolvedRoot = await realpath(root);
  const resolvedCandidate = await realpath(candidate);
  if (
    comparable(resolvedRoot) !== comparable(root) ||
    comparable(resolvedCandidate) !== comparable(candidate) ||
    (
      comparable(resolvedRoot) !== comparable(resolvedCandidate) &&
      !isWithin(resolvedRoot, resolvedCandidate)
    )
  ) {
    throw failure(code, message);
  }
}

async function copyVerified(sourceRoot, destinationRoot, expected) {
  const source = sourcePath(sourceRoot, expected.path);
  const destination = sourcePath(destinationRoot, expected.path);
  await assertNoSymlinkComponents(sourceRoot, expected.path);
  await assertCanonicalRealPath(
    sourceRoot,
    source,
    "BACKUP_SOURCE_INVALID",
    "备份来源真实路径越界或包含路径别名",
  );

  await mkdir(path.dirname(destination), { recursive: true });
  await assertCanonicalRealPath(
    destinationRoot,
    path.dirname(destination),
    "BACKUP_IO_FAILED",
    "备份目标真实路径越界或包含路径别名",
  );
  const sourceHandle = await open(source, "r");
  let destinationHandle;
  let copied = false;
  try {
    const before = await sourceHandle.stat();
    const namedBefore = await lstat(source);
    if (
      !sameFileIdentity(before, namedBefore) ||
      before.size !== expected.bytes
    ) {
      throw failure("BACKUP_SOURCE_CHANGED", "checkpoint 后备份来源已变化");
    }
    destinationHandle = await open(destination, "wx");
    const destinationBefore = await destinationHandle.stat();
    const namedDestinationBefore = await lstat(destination);
    if (!sameFileIdentity(destinationBefore, namedDestinationBefore)) {
      throw failure("BACKUP_IO_FAILED", "备份目标文件标识不一致");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const result = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      digest.update(buffer.subarray(0, result.bytesRead));
      let offset = 0;
      while (offset < result.bytesRead) {
        const written = await destinationHandle.write(
          buffer,
          offset,
          result.bytesRead - offset,
          null,
        );
        if (written.bytesWritten < 1) {
          throw failure("BACKUP_IO_FAILED", "备份目标写入未前进");
        }
        offset += written.bytesWritten;
      }
      bytes += result.bytesRead;
      if (bytes > expected.bytes) {
        throw failure("BACKUP_SOURCE_CHANGED", "checkpoint 后备份来源已增长");
      }
    }
    const after = await sourceHandle.stat();
    const namedAfter = await lstat(source);
    await assertCanonicalRealPath(
      sourceRoot,
      source,
      "BACKUP_SOURCE_CHANGED",
      "checkpoint 后备份来源路径已变化",
    );
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileIdentity(after, namedAfter) ||
      !sameFileSnapshot(namedBefore, namedAfter) ||
      bytes !== expected.bytes ||
      digest.digest("hex") !== expected.sha256
    ) {
      throw failure("BACKUP_SOURCE_CHANGED", "checkpoint 后备份来源已变化");
    }
    await destinationHandle.sync();
    const destinationAfter = await destinationHandle.stat();
    const namedDestinationAfter = await lstat(destination);
    if (
      !sameFileIdentity(destinationAfter, namedDestinationAfter) ||
      destinationAfter.nlink !== 1 ||
      destinationAfter.size !== expected.bytes
    ) {
      throw failure("BACKUP_IO_FAILED", "备份目标文件标识已变化");
    }
    copied = true;
  } finally {
    await Promise.allSettled([
      sourceHandle.close(),
      destinationHandle?.close(),
    ]);
    if (!copied) await rm(destination, { force: true }).catch(() => {});
  }
}

async function readBounded(handle, maximum) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > maximum) {
      throw failure("BACKUP_CORRUPTED", "备份清单超出容量限制");
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, bytes);
}

async function readManifest(backupPath, expectedBackupId) {
  const manifestPath = path.join(backupPath, "manifest.json");
  let text;
  let handle;
  try {
    await assertNoSymlinkComponents(backupPath, "manifest.json");
    await assertCanonicalRealPath(
      backupPath,
      manifestPath,
      "BACKUP_CORRUPTED",
      "备份清单真实路径无效",
    );
    handle = await open(manifestPath, "r");
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(manifestPath);
    if (
      !sameFileIdentity(openedBefore, namedBefore) ||
      openedBefore.nlink !== 1 ||
      openedBefore.size > MAX_MANIFEST_BYTES
    ) {
      throw failure("BACKUP_CORRUPTED", "备份清单文件无效");
    }
    const bytes = await readBounded(handle, MAX_MANIFEST_BYTES);
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(manifestPath);
    if (
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, namedAfter) ||
      !sameFileSnapshot(namedBefore, namedAfter) ||
      bytes.length !== openedAfter.size
    ) {
      throw failure("BACKUP_CORRUPTED", "读取期间备份清单发生变化");
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof BackupServiceError) throw error;
    throw failure("BACKUP_CORRUPTED", "无法读取备份清单", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw failure("BACKUP_CORRUPTED", "备份清单不是有效 JSON", { cause: error });
  }
  let manifest;
  try {
    manifest = normalizeBackupManifest(parsed);
  } catch (error) {
    if (!(error instanceof BackupManifestError)) throw error;
    throw failure("BACKUP_CORRUPTED", "备份清单校验失败", { cause: error });
  }
  if (manifest.backupId !== expectedBackupId) {
    throw failure("BACKUP_CORRUPTED", "备份目录与清单标识不一致");
  }
  return manifest;
}

async function walkFiles(root) {
  const files = [];
  const pending = [{ depth: 0, relative: "" }];
  let directories = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_PAYLOAD_DEPTH) {
      throw failure("BACKUP_CORRUPTED", "备份载荷目录深度超出限制");
    }
    directories += 1;
    if (directories > MAX_PAYLOAD_DIRECTORIES) {
      throw failure("BACKUP_CORRUPTED", "备份载荷目录数量超出限制");
    }
    const directoryPath = current.relative
      ? sourcePath(root, current.relative)
      : root;
    const directoryInfo = await lstat(directoryPath);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw failure("BACKUP_CORRUPTED", "备份载荷目录无效");
    }
    const resolvedDirectory = await realpath(directoryPath);
    if (
      comparable(resolvedDirectory) !== comparable(directoryPath) ||
      (current.relative !== "" && !isWithin(root, resolvedDirectory))
    ) {
      throw failure("BACKUP_CORRUPTED", "备份载荷目录包含路径别名");
    }
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) {
        throw failure("BACKUP_CORRUPTED", "备份载荷包含符号链接");
      }
      const child = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      if (Buffer.byteLength(child, "utf8") > MAX_PAYLOAD_PATH_BYTES) {
        throw failure("BACKUP_CORRUPTED", "备份载荷路径超出限制");
      }
      const childInfo = await lstat(sourcePath(root, child));
      if (childInfo.isSymbolicLink()) {
        throw failure("BACKUP_CORRUPTED", "备份载荷包含符号链接");
      }
      if (entry.isDirectory() && childInfo.isDirectory()) {
        pending.push({ depth: current.depth + 1, relative: child });
      } else if (entry.isFile() && childInfo.isFile()) {
        if (childInfo.nlink !== 1) {
          throw failure("BACKUP_CORRUPTED", "备份载荷包含硬链接");
        }
        files.push(child);
        if (files.length > MAX_PAYLOAD_FILES) {
          throw failure("BACKUP_CORRUPTED", "备份载荷文件数量超出限制");
        }
        totalBytes += childInfo.size;
        if (
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_PAYLOAD_TOTAL_BYTES
        ) {
          throw failure("BACKUP_CORRUPTED", "备份载荷总大小超出限制");
        }
      } else {
        throw failure("BACKUP_CORRUPTED", "备份载荷包含不支持的节点");
      }
    }
  }
  return files;
}

async function verifyPayload(backupPath, manifest, destinationRoot = null) {
  const payload = path.join(backupPath, "payload");
  const actual = (await walkFiles(payload)).sort();
  const expectedPaths = manifest.files.map(({ path }) => path);
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
    throw failure("BACKUP_CORRUPTED", "备份载荷文件集合与清单不一致");
  }
  for (const expected of manifest.files) {
    const targetRoot = destinationRoot ?? path.join(backupPath, ".verify-never-used");
    if (destinationRoot === null) {
      const file = sourcePath(payload, expected.path);
      await assertNoSymlinkComponents(payload, expected.path);
      await assertCanonicalRealPath(
        payload,
        file,
        "BACKUP_CORRUPTED",
        "备份载荷真实路径无效",
      );
      const handle = await open(file, "r");
      try {
        const openedBefore = await handle.stat();
        const namedBefore = await lstat(file);
        if (
          !sameFileIdentity(openedBefore, namedBefore) ||
          openedBefore.size !== expected.bytes
        ) {
          throw failure("BACKUP_CORRUPTED", "备份载荷大小或标识不一致");
        }
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        let bytes = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          digest.update(buffer.subarray(0, bytesRead));
          bytes += bytesRead;
          if (bytes > expected.bytes) {
            throw failure("BACKUP_CORRUPTED", "备份载荷读取超出清单大小");
          }
        }
        const openedAfter = await handle.stat();
        const namedAfter = await lstat(file);
        await assertCanonicalRealPath(
          payload,
          file,
          "BACKUP_CORRUPTED",
          "读取期间备份载荷路径发生变化",
        );
        if (
          !sameFileSnapshot(openedBefore, openedAfter) ||
          !sameFileIdentity(openedAfter, namedAfter) ||
          !sameFileSnapshot(namedBefore, namedAfter) ||
          bytes !== expected.bytes ||
          digest.digest("hex") !== expected.sha256
        ) {
          throw failure("BACKUP_CORRUPTED", "备份载荷摘要不一致");
        }
      } finally {
        await handle.close();
      }
    } else {
      try {
        await copyVerified(payload, targetRoot, expected);
      } catch (error) {
        if (
          error instanceof BackupServiceError &&
          (error.code === "BACKUP_SOURCE_INVALID" ||
            error.code === "BACKUP_SOURCE_CHANGED")
        ) {
          throw failure("BACKUP_CORRUPTED", "备份载荷复制校验失败", { cause: error });
        }
        throw error;
      }
    }
  }
}

async function assertBackupShape(backupPath) {
  const entries = await readdir(backupPath, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  if (
    JSON.stringify(names) !== JSON.stringify(["manifest.json", "payload"]) ||
    entries.some((entry) => entry.isSymbolicLink())
  ) {
    throw failure("BACKUP_CORRUPTED", "备份目录包含未声明内容");
  }
}

async function writeManifest(backupPath, manifest) {
  const manifestPath = path.join(backupPath, "manifest.json");
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw failure("BACKUP_IO_FAILED", "备份清单超出容量限制");
  }
  const handle = await open(manifestPath, "wx");
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    const named = await lstat(manifestPath);
    if (
      !sameFileIdentity(opened, named) ||
      opened.size !== bytes.length
    ) {
      throw failure("BACKUP_IO_FAILED", "备份清单写入标识不一致");
    }
    complete = true;
  } finally {
    await handle.close().catch(() => {});
    if (!complete) await rm(manifestPath, { force: true }).catch(() => {});
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
    throw failure("BACKUP_IO_FAILED", "无法同步备份目录", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectoryTree(root, directorySync) {
  const pending = [root];
  const directories = [];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path.join(current, entry.name));
      }
    }
  }
  directories.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
  for (const directory of directories) await directorySync(directory);
}

async function readCatalog(backupRoot) {
  const target = path.join(backupRoot, CATALOG_NAME);
  let handle;
  try {
    handle = await open(target, "r");
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(target);
    if (
      !sameFileIdentity(openedBefore, namedBefore) ||
      openedBefore.nlink !== 1 ||
      openedBefore.size > MAX_CATALOG_BYTES
    ) {
      throw failure("BACKUP_STORAGE_INVALID", "备份目录索引文件无效");
    }
    await assertCanonicalRealPath(
      backupRoot,
      target,
      "BACKUP_STORAGE_INVALID",
      "备份目录索引路径无效",
    );
    const chunks = [];
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > MAX_CATALOG_BYTES) {
        throw failure("BACKUP_STORAGE_INVALID", "备份目录索引超出容量限制");
      }
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(target);
    if (
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, namedAfter) ||
      !sameFileSnapshot(namedBefore, namedAfter) ||
      bytes !== openedAfter.size
    ) {
      throw failure("BACKUP_STORAGE_INVALID", "读取期间备份目录索引发生变化");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, bytes),
    );
    return normalizeCatalog(JSON.parse(text));
  } catch (error) {
    if (error?.code === "ENOENT" && handle === undefined) return null;
    if (error instanceof BackupServiceError) throw error;
    throw failure("BACKUP_STORAGE_INVALID", "备份目录索引损坏", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeCatalog(backupRoot, catalog, directorySync) {
  const target = path.join(backupRoot, CATALOG_NAME);
  const temporary = path.join(
    backupRoot,
    `${CATALOG_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(catalog)}\n`, "utf8");
  if (bytes.length > MAX_CATALOG_BYTES) {
    throw failure("BACKUP_STORAGE_INVALID", "备份目录索引超出容量限制");
  }
  let handle;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    const named = await lstat(temporary);
    if (!sameFileIdentity(opened, named) || opened.nlink !== 1 || opened.size !== bytes.length) {
      throw failure("BACKUP_STORAGE_INVALID", "备份目录索引写入标识不一致");
    }
    await handle.close();
    handle = null;
    await rename(temporary, target);
    published = true;
    await directorySync(backupRoot);
  } catch (error) {
    if (error instanceof BackupServiceError) throw error;
    throw failure("BACKUP_STORAGE_INVALID", "无法原子发布备份目录索引", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
    if (!published) await rm(temporary, { force: true }).catch(() => {});
  }
}

function destinationAvailableError(error) {
  return error?.code === "EEXIST" || error?.code === "ENOTEMPTY";
}

async function destinationExistsAfterFailure(error, destination) {
  if (destinationAvailableError(error)) return true;
  if (error?.code !== "EPERM" && error?.code !== "EACCES") return false;
  try {
    await lstat(destination);
    return true;
  } catch {
    return false;
  }
}

export class BackupService {
  #sourceDirectory;
  #backupDirectory;
  #quiescence;
  #migration;
  #canonicalization;
  #reconciliation;
  #now;
  #queue;
  #directorySync;

  constructor(options = {}) {
    const entries = serviceOptions(options);
    const sourceDirectory = entries.get("sourceDirectory");
    const backupDirectory = entries.get("backupDirectory");
    const quiescence = entries.get("quiescence");
    const migration = entries.get("migration");
    const canonicalization = entries.get("canonicalization");
    const reconciliation = entries.get("reconciliation");
    const now = entries.has("now") ? entries.get("now") : () => new Date();
    const operationQueue = entries.has("operationQueue")
      ? entries.get("operationQueue")
      : new OperationQueue();
    const directorySync = entries.has("directorySync")
      ? entries.get("directorySync")
      : syncDirectory;
    if (typeof directorySync !== "function" || utilTypes.isProxy(directorySync)) {
      throw new TypeError("directorySync must be a function");
    }
    this.#sourceDirectory = requireAbsoluteDirectory(sourceDirectory, "sourceDirectory");
    this.#backupDirectory = requireAbsoluteDirectory(backupDirectory, "backupDirectory");
    assertSeparateRoots(this.#sourceDirectory, this.#backupDirectory);
    this.#quiescence = requirePort(quiescence, ["enter", "leave"], "quiescence");
    this.#migration = optionalPort(migration, ["migrate"], "migration");
    this.#canonicalization = optionalPort(
      canonicalization,
      ["capture"],
      "canonicalization",
    );
    this.#reconciliation = optionalPort(
      reconciliation,
      ["reconcile"],
      "reconciliation",
    );
    if (
      this.#migration !== null &&
      (this.#canonicalization === null || this.#reconciliation === null)
    ) {
      throw new TypeError(
        "migration requires canonicalization and reconciliation ports",
      );
    }
    if (typeof now !== "function" || utilTypes.isProxy(now)) {
      throw new TypeError("now must be a function");
    }
    this.#now = now;
    this.#queue = requirePort(operationQueue, ["enqueue"], "operationQueue");
    this.#directorySync = directorySync;
    Object.freeze(this);
  }

  createBackup() {
    return this.#queue.enqueue(() => this.#createBackup());
  }

  verifyBackup(backupId) {
    return this.#queue.enqueue(() => this.#verifyAndRecord(backupId));
  }

  listBackups() {
    return this.#listBackups();
  }

  restore(options = {}) {
    const entries = restoreRequest(options);
    return this.#queue.enqueue(() => this.#restore(
      entries.get("backupId"),
      entries.get("destinationDirectory"),
    ));
  }

  async #createBackup() {
    let checkpoint;
    let partial = null;
    let releaseAttempted = false;
    try {
      const sourceRoot = await verifiedDirectoryRoot(this.#sourceDirectory, {
        code: "BACKUP_SOURCE_INVALID",
        message: "备份来源目录无效或包含路径别名",
      });
      try {
        checkpoint = checkpointEnvelope(await this.#quiescence.enter());
      } catch (error) {
        if (error instanceof BackupServiceError) throw error;
        throw failure("BACKUP_QUIESCENCE_FAILED", "系统未能进入全局 checkpoint", {
          cause: error,
        });
      }
      const backupRoot = await verifiedDirectoryRoot(this.#backupDirectory, {
        code: "BACKUP_STORAGE_INVALID",
        create: true,
        message: "备份存储目录无效或包含路径别名",
      });
      try {
        assertSeparateRoots(sourceRoot, backupRoot);
      } catch (error) {
        throw failure("BACKUP_STORAGE_INVALID", "备份来源与存储真实路径重叠", {
          cause: error,
        });
      }
      let manifest;
      try {
        manifest = createBackupManifest({
          createdAt: isoNow(this.#now),
          stores: checkpoint.stores,
          files: checkpoint.files,
        });
      } catch (error) {
        if (!(error instanceof BackupManifestError)) throw error;
        throw failure("BACKUP_QUIESCENCE_INVALID", "全局 checkpoint 内容无效", {
          cause: error,
        });
      }
      partial = path.join(
        backupRoot,
        `.partial-${process.pid}-${randomUUID()}`,
      );
      await mkdir(partial, { recursive: false });
      await mkdir(path.join(partial, "payload"), { recursive: false });
      for (const file of manifest.files) {
        await copyVerified(
          sourceRoot,
          path.join(partial, "payload"),
          file,
        );
      }
      await writeManifest(partial, manifest);
      await assertBackupShape(partial);
      const localManifest = await readManifest(partial, manifest.backupId);
      await verifyPayload(partial, localManifest);

      releaseAttempted = true;
      try {
        await this.#quiescence.leave(checkpoint.token);
      } catch (error) {
        throw failure("BACKUP_RELEASE_FAILED", "系统未能离开全局 checkpoint", {
          cause: error,
        });
      }
      checkpoint = null;

      const currentBackupRoot = await verifiedDirectoryRoot(
        this.#backupDirectory,
        {
          code: "BACKUP_STORAGE_INVALID",
          message: "备份存储目录在发布前发生变化",
        },
      );
      if (comparable(currentBackupRoot) !== comparable(backupRoot)) {
        throw failure("BACKUP_STORAGE_INVALID", "备份存储目录在发布前发生变化");
      }
      await assertBackupShape(partial);
      const publishManifest = await readManifest(partial, manifest.backupId);
      await verifyPayload(partial, publishManifest);
      await syncDirectoryTree(partial, this.#directorySync);

      const finalPath = path.join(backupRoot, manifest.backupId);
      try {
        await rename(partial, finalPath);
      } catch (error) {
        if (!await destinationExistsAfterFailure(error, finalPath)) throw error;
        const existing = await this.#verifyAndRecord(manifest.backupId);
        await rm(partial, { recursive: true, force: true });
        partial = null;
        return existing;
      }
      await this.#directorySync(backupRoot);
      partial = null;
      await this.#recordCatalog(
        backupRoot,
        itemFromManifest(manifest, "verified", isoNow(this.#now)),
      );
      return Object.freeze({ manifest, path: finalPath });
    } catch (error) {
      if (partial !== null) {
        await rm(partial, { recursive: true, force: true }).catch(() => {});
        partial = null;
      }
      if (checkpoint && !releaseAttempted) {
        releaseAttempted = true;
        try {
          await this.#quiescence.leave(checkpoint.token);
        } catch (releaseError) {
          throw failure("BACKUP_RELEASE_FAILED", "备份失败且系统未能离开 checkpoint", {
            cause: releaseError,
            details: {
              priorCode: typeof error?.code === "string" ? error.code : "BACKUP_IO_FAILED",
            },
          });
        }
      }
      if (error instanceof BackupServiceError || error instanceof BackupManifestError) {
        throw error;
      }
      throw failure("BACKUP_IO_FAILED", "备份创建失败", { cause: error });
    }
  }

  async #verifyBackup(backupId) {
    if (typeof backupId !== "string" || !BACKUP_ID.test(backupId)) {
      throw failure("BACKUP_CORRUPTED", "备份标识无效");
    }
    try {
      const backupRoot = await verifiedDirectoryRoot(this.#backupDirectory, {
        code: "BACKUP_CORRUPTED",
        message: "备份存储目录无效或包含路径别名",
      });
      const backupPath = path.join(backupRoot, backupId);
      const info = await lstat(backupPath);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw failure("BACKUP_CORRUPTED", "备份目录无效");
      }
      const resolvedBackup = await realpath(backupPath);
      if (
        comparable(resolvedBackup) !== comparable(backupPath) ||
        !isWithin(backupRoot, resolvedBackup)
      ) {
        throw failure("BACKUP_CORRUPTED", "备份目录真实路径无效");
      }
      await assertBackupShape(backupPath);
      const manifest = await readManifest(backupPath, backupId);
      await verifyPayload(backupPath, manifest);
      return Object.freeze({ manifest, path: backupPath });
    } catch (error) {
      if (error instanceof BackupServiceError) throw error;
      throw failure("BACKUP_CORRUPTED", "备份验证失败", { cause: error });
    }
  }

  async #recordCatalog(backupRoot, item) {
    const current = await readCatalog(backupRoot);
    const items = new Map((current?.items ?? []).map((entry) => [entry.backupId, entry]));
    items.set(item.backupId, item);
    if (
      items.size > MAX_BACKUP_ENTRIES ||
      (current?.revision ?? 0) >= Number.MAX_SAFE_INTEGER
    ) {
      throw failure("BACKUP_STORAGE_INVALID", "备份目录索引超出容量限制");
    }
    const sorted = [...items.values()].sort((left, right) =>
      (right.createdAt || "").localeCompare(left.createdAt || "", "en") ||
      left.backupId.localeCompare(right.backupId, "en"),
    );
    await writeCatalog(
      backupRoot,
      createCatalog({
        revision: (current?.revision ?? 0) + 1,
        updatedAt: isoNow(this.#now),
        items: sorted,
      }),
      this.#directorySync,
    );
  }

  async #verifyAndRecord(backupId) {
    try {
      const verified = await this.#verifyBackup(backupId);
      await this.#recordCatalog(
        path.dirname(verified.path),
        itemFromManifest(verified.manifest, "verified", isoNow(this.#now)),
      );
      return verified;
    } catch (error) {
      if (!(error instanceof BackupServiceError) || error.code !== "BACKUP_CORRUPTED") {
        throw error;
      }
      if (typeof backupId !== "string" || !BACKUP_ID.test(backupId)) throw error;
      try {
        const backupRoot = await verifiedDirectoryRoot(this.#backupDirectory, {
          code: "BACKUP_STORAGE_INVALID",
          message: "备份存储目录无效或包含路径别名",
        });
        const current = await readCatalog(backupRoot);
        const prior = current?.items.find((item) => item.backupId === backupId) ?? null;
        await this.#recordCatalog(
          backupRoot,
          corruptedItem(backupId, prior, isoNow(this.#now)),
        );
      } catch {
        // The deep-verification failure remains authoritative if status persistence also fails.
      }
      throw error;
    }
  }

  async #listBackups() {
    let backupRoot;
    try {
      backupRoot = await verifiedDirectoryRoot(this.#backupDirectory, {
        code: "BACKUP_STORAGE_INVALID",
        message: "备份存储目录无效或包含路径别名",
      });
    } catch (error) {
      if (
        error instanceof BackupServiceError &&
        error.cause?.code === "ENOENT"
      ) {
        return Object.freeze({
          items: Object.freeze([]),
          incompleteCount: 0,
          unrecognizedCount: 0,
        });
      }
      throw error;
    }
    const [entries, catalog] = await Promise.all([
      readdir(backupRoot, { withFileTypes: true }),
      readCatalog(backupRoot),
    ]);
    if (entries.length > MAX_BACKUP_ENTRIES + 2) {
      throw failure("BACKUP_STORAGE_INVALID", "备份存储条目超出限制");
    }
    const items = [];
    const indexed = new Map((catalog?.items ?? []).map((item) => [item.backupId, item]));
    const present = new Set();
    let incompleteCount = 0;
    let unrecognizedCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".partial-")) {
        incompleteCount += 1;
        continue;
      }
      if (entry.name === CATALOG_NAME) continue;
      if (CATALOG_TEMPORARY.test(entry.name)) {
        incompleteCount += 1;
        continue;
      }
      if (!BACKUP_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        unrecognizedCount += 1;
        continue;
      }
      present.add(entry.name);
      const item = indexed.get(entry.name);
      items.push(Object.freeze({
        backupId: entry.name,
        createdAt: item?.createdAt ?? null,
        checkpointId: item?.checkpointId ?? null,
        fileCount: item?.fileCount ?? null,
        totalBytes: item?.totalBytes ?? null,
        status: item?.status ?? "unindexed",
      }));
    }
    for (const item of indexed.values()) {
      if (present.has(item.backupId)) continue;
      items.push(Object.freeze({
        backupId: item.backupId,
        createdAt: item.createdAt,
        checkpointId: item.checkpointId,
        fileCount: item.fileCount,
        totalBytes: item.totalBytes,
        status: "corrupted",
      }));
    }
    items.sort((left, right) =>
      (right.createdAt || "").localeCompare(left.createdAt || "", "en") ||
      left.backupId.localeCompare(right.backupId, "en"),
    );
    return Object.freeze({
      items: Object.freeze(items),
      incompleteCount,
      unrecognizedCount,
    });
  }

  async #restore(backupId, destinationDirectory) {
    const destination = requireAbsoluteDirectory(
      destinationDirectory,
      "destinationDirectory",
    );
    const { sourceRoot, backupRoot } = await verifiedOperationalRoots(
      this.#sourceDirectory,
      this.#backupDirectory,
    );
    const parent = path.dirname(destination);
    const realParent = await verifiedDirectoryRoot(parent, {
      code: "BACKUP_DESTINATION_INVALID",
      message: "恢复目标父目录无效或包含路径别名",
    });
    const realDestination = path.join(realParent, path.basename(destination));
    if (comparable(realDestination) !== comparable(destination)) {
      throw failure("BACKUP_DESTINATION_INVALID", "恢复目标包含路径别名");
    }
    if (
      comparable(realDestination) === comparable(sourceRoot) ||
      isWithin(sourceRoot, realDestination) ||
      isWithin(realDestination, sourceRoot) ||
      comparable(realDestination) === comparable(backupRoot) ||
      isWithin(backupRoot, realDestination) ||
      isWithin(realDestination, backupRoot)
    ) {
      throw new TypeError("restore destination must not overlap active or backup data");
    }
    const verified = await this.#verifyAndRecord(backupId);
    const staging = path.join(
      realParent,
      `.restore-${path.basename(destination)}-${process.pid}-${randomUUID()}`,
    );
    try {
      try {
        await lstat(destination);
        throw failure("BACKUP_DESTINATION_EXISTS", "恢复目标已经存在");
      } catch (error) {
        if (error instanceof BackupServiceError) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(staging, { recursive: false });
      await verifiedDirectoryRoot(staging, {
        code: "BACKUP_DESTINATION_INVALID",
        message: "恢复临时目录无效或包含路径别名",
      });
      await verifyPayload(verified.path, verified.manifest, staging);
      let reconciliationManifest = verified.manifest;
      if (this.#migration) {
        try {
          await this.#migration.migrate({
            directory: staging,
            manifest: verified.manifest,
          });
          const migrated = await this.#canonicalization.capture({
            directory: staging,
          });
          reconciliationManifest = createBackupManifest({
            createdAt: verified.manifest.createdAt,
            stores: migrated.stores,
            files: migrated.files,
          });
        } catch (error) {
          throw failure("BACKUP_MIGRATION_FAILED", "恢复迁移失败", { cause: error });
        }
      }
      if (this.#reconciliation) {
        let result;
        try {
          result = await this.#reconciliation.reconcile({
            directory: staging,
            manifest: reconciliationManifest,
            mode: "read-only",
          });
        } catch (error) {
          throw failure("BACKUP_RECONCILIATION_BLOCKED", "恢复只读核对失败", {
            cause: error,
          });
        }
        if (!reconciliationAccepted(result)) {
          throw failure("BACKUP_RECONCILIATION_BLOCKED", "恢复存在未解决阻断");
        }
      }
      await walkFiles(staging);
      await syncDirectoryTree(staging, this.#directorySync);
      const [currentSourceRoot, currentBackupRoot, currentParent] = await Promise.all([
        verifiedDirectoryBoundary(this.#sourceDirectory, {
          code: "BACKUP_SOURCE_INVALID",
          message: "活动数据目录在恢复发布前发生变化",
        }),
        verifiedDirectoryRoot(this.#backupDirectory, {
          code: "BACKUP_STORAGE_INVALID",
          message: "备份存储目录在恢复发布前发生变化",
        }),
        verifiedDirectoryRoot(parent, {
          code: "BACKUP_DESTINATION_INVALID",
          message: "恢复目标父目录在发布前发生变化",
        }),
      ]);
      if (
        comparable(currentSourceRoot) !== comparable(sourceRoot) ||
        comparable(currentBackupRoot) !== comparable(backupRoot) ||
        comparable(currentParent) !== comparable(realParent)
      ) {
        throw failure("BACKUP_DESTINATION_INVALID", "恢复路径边界在发布前发生变化");
      }
      try {
        await lstat(destination);
        throw failure("BACKUP_DESTINATION_EXISTS", "恢复目标已经存在");
      } catch (error) {
        if (error instanceof BackupServiceError) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(staging, destination);
      await this.#directorySync(realParent);
      return Object.freeze({
        manifest: verified.manifest,
        path: destination,
        ready: true,
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (error instanceof BackupServiceError) throw error;
      if (await destinationExistsAfterFailure(error, destination)) {
        throw failure("BACKUP_DESTINATION_EXISTS", "恢复目标已经存在", {
          cause: error,
        });
      }
      throw failure("BACKUP_IO_FAILED", "备份恢复失败", { cause: error });
    }
  }
}
