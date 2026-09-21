import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { ProcessExclusiveGuard } from "../lib/process-exclusive-guard.js";
import {
  createChangePackage,
  normalizeChangePackageId,
  normalizeChangePackageLimits,
  normalizeChangePackageManifest,
  normalizeChangePackagePath,
} from "../domain/change-package-contract.js";

const BLOB_FILE = /^([a-f0-9]{64})\.blob$/;
const PACKAGE_FILE = /^(change-package-[a-f0-9]{64})\.json$/;
const TEMPORARY_FILE = /^write-[a-f0-9-]{36}\.tmp$/;

function guardName(root) {
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  return `mydashboard-change-packages-${sha256(identity).slice(0, 32)}`;
}

function guardFactory(value) {
  if (value === undefined) {
    return (options) => new ProcessExclusiveGuard(options);
  }
  if (typeof value !== "function") {
    throw storeError(
      "INVALID_CHANGE_PACKAGE_STORE_CONFIG",
      "change package 存储配置无效",
    );
  }
  return value;
}

function sameResolvedPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export class ChangePackageStoreError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "ChangePackageStoreError";
    this.code = code;
  }
}

function storeError(code, message, options) {
  return new ChangePackageStoreError(code, message, options);
}

function corrupted(cause) {
  return storeError("CHANGE_PACKAGE_CORRUPTED", "change package 存储损坏", {
    cause,
  });
}

function findChange(entries, relativePath) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries[middle];
    if (candidate.path === relativePath) return candidate;
    if (candidate.path < relativePath) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function optionalReadSignal(value) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 1
  ) {
    throw storeError(
      "INVALID_CHANGE_PACKAGE_REQUEST",
      "change package 读取请求无效",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "signal");
  const signal = descriptor?.enumerable && "value" in descriptor
    ? descriptor.value
    : null;
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.throwIfAborted !== "function"
  ) {
    throw storeError(
      "INVALID_CHANGE_PACKAGE_REQUEST",
      "change package 读取请求无效",
    );
  }
  return signal;
}

function exactReadRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(",") !== "packageId,path"
  ) {
    throw storeError("INVALID_CHANGE_PACKAGE_REQUEST", "change package 读取请求无效");
  }
  for (const key of ["packageId", "path"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw storeError("INVALID_CHANGE_PACKAGE_REQUEST", "change package 读取请求无效");
    }
  }
  try {
    return {
      packageId: normalizeChangePackageId(value.packageId),
      path: normalizeChangePackagePath(value.path),
    };
  } catch (cause) {
    throw storeError("INVALID_CHANGE_PACKAGE_REQUEST", "change package 读取请求无效", {
      cause,
    });
  }
}

export class ChangePackageStore {
  #root;
  #packagesRoot;
  #blobsRoot;
  #temporaryRoot;
  #limits;
  #createGuard;
  #guardName;
  #ready = false;
  #manifests = new Map();
  #tail = Promise.resolve();

  constructor({ root, limits = {}, createGuard } = {}) {
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      root.includes("\0")
    ) {
      throw storeError("INVALID_CHANGE_PACKAGE_STORE_CONFIG", "change package 存储配置无效");
    }
    try {
      this.#limits = normalizeChangePackageLimits(limits);
    } catch (cause) {
      throw storeError("INVALID_CHANGE_PACKAGE_STORE_CONFIG", "change package 存储配置无效", {
        cause,
      });
    }
    this.#root = path.resolve(root);
    this.#createGuard = guardFactory(createGuard);
    this.#guardName = guardName(this.#root);
    this.#packagesRoot = path.join(this.#root, "packages");
    this.#blobsRoot = path.join(this.#root, "blobs");
    this.#temporaryRoot = path.join(this.#root, "temporary");
  }

  producer() {
    return Object.freeze({ create: this.create.bind(this) });
  }

  reader() {
    return Object.freeze({
      get: this.get.bind(this),
      readFile: this.readFile.bind(this),
    });
  }

  recover() {
    return this.#enqueue(async () => {
      this.#ready = false;
      this.#manifests = new Map();
      try {
        const recovered = await this.#withProcessLock(async () => {
          await this.#ensureLayout();
          await this.#cleanTemporaryFiles();
          const blobs = await this.#recoverBlobs();
          const manifests = await this.#recoverManifests(blobs);
          const referencedBlobCount = await this.#removeUnreferencedBlobs(
            blobs,
            manifests,
          );
          return { manifests, referencedBlobCount };
        });
        this.#manifests = recovered.manifests;
        this.#ready = true;
        return {
          packages: recovered.manifests.size,
          blobs: recovered.referencedBlobCount,
        };
      } catch (error) {
        if (error instanceof ChangePackageStoreError) throw error;
        throw corrupted(error);
      }
    });
  }

  async create(value) {
    this.#assertReady();
    const prepared = createChangePackage(value, { limits: this.#limits });
    return this.#enqueue(async () => {
      this.#assertReady();
      const manifest = await this.#withProcessLock(async () => {
        await this.#assertSafeLayout();
        for (const blob of prepared.blobs) {
          await this.#writeImmutable(
            path.join(this.#blobsRoot, `${blob.sha256}.blob`),
            blob.content,
          );
        }
        const serialized = Buffer.from(
          `${JSON.stringify(prepared.manifest)}\n`,
          "utf8",
        );
        await this.#writeImmutable(
          path.join(this.#packagesRoot, `${prepared.manifest.packageId}.json`),
          serialized,
        );
        return normalizeChangePackageManifest(prepared.manifest, {
          limits: this.#limits,
        });
      });
      this.#manifests.set(manifest.packageId, manifest);
      return manifest;
    });
  }

  async get(packageIdValue, options) {
    this.#assertReady();
    const signal = optionalReadSignal(options);
    signal?.throwIfAborted();
    let packageId;
    try {
      packageId = normalizeChangePackageId(packageIdValue);
    } catch (cause) {
      throw storeError("INVALID_CHANGE_PACKAGE_REQUEST", "change package 读取请求无效", {
        cause,
      });
    }
    const manifest = this.#manifests.get(packageId);
    if (manifest === undefined) {
      throw storeError("CHANGE_PACKAGE_NOT_FOUND", "change package 不存在");
    }
    const projection = normalizeChangePackageManifest(manifest, {
      limits: this.#limits,
    });
    signal?.throwIfAborted();
    return projection;
  }

  async readFile(value) {
    this.#assertReady();
    const request = exactReadRequest(value);
    const manifest = this.#manifests.get(request.packageId);
    if (manifest === undefined) {
      throw storeError("CHANGE_PACKAGE_NOT_FOUND", "change package 不存在");
    }
    const entry =
      findChange(manifest.changes.created, request.path) ??
      findChange(manifest.changes.modified, request.path);
    if (entry === undefined) {
      throw storeError("CHANGE_PACKAGE_FILE_NOT_FOUND", "change package 文件不存在");
    }
    try {
      await this.#assertSafeLayout();
      return await this.#readVerifiedBlob(entry.blob);
    } catch (error) {
      if (error instanceof ChangePackageStoreError) throw error;
      throw corrupted(error);
    }
  }

  #assertReady() {
    if (!this.#ready) {
      throw storeError(
        "CHANGE_PACKAGE_STORE_NOT_READY",
        "change package 存储尚未完成恢复",
      );
    }
  }

  #enqueue(operation) {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #withProcessLock(operation) {
    let guard;
    try {
      guard = this.#createGuard({ name: this.#guardName });
    } catch (cause) {
      throw storeError(
        "CHANGE_PACKAGE_STORE_LOCK_FAILED",
        "无法创建 change package 存储锁",
        { cause },
      );
    }
    if (
      !guard ||
      typeof guard.acquire !== "function" ||
      typeof guard.close !== "function"
    ) {
      throw storeError(
        "CHANGE_PACKAGE_STORE_LOCK_FAILED",
        "change package 存储锁无效",
      );
    }
    try {
      await guard.acquire();
    } catch (cause) {
      await guard.close().catch(() => {});
      throw storeError(
        "CHANGE_PACKAGE_STORE_BUSY",
        "另一个进程正在更新 change package 存储",
        { cause },
      );
    }
    let operationError = null;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await guard.close();
      } catch (cause) {
        if (operationError === null) {
          throw storeError(
            "CHANGE_PACKAGE_STORE_LOCK_FAILED",
            "无法释放 change package 存储锁",
            { cause },
          );
        }
      }
    }
  }

  async #ensureLayout() {
    for (const directory of this.#layoutDirectories()) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.#assertDirectory(directory);
    }
  }

  async #assertSafeLayout() {
    for (const directory of this.#layoutDirectories()) {
      await this.#assertDirectory(directory);
    }
  }

  #layoutDirectories() {
    return [
      this.#root,
      this.#packagesRoot,
      this.#blobsRoot,
      this.#temporaryRoot,
    ];
  }

  async #assertDirectory(directory) {
    let stats;
    let resolved;
    try {
      stats = await lstat(directory);
      resolved = await realpath(directory);
    } catch (cause) {
      throw corrupted(cause);
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !sameResolvedPath(resolved, directory) ||
      (process.platform !== "win32" && (stats.mode & 0o022) !== 0)
    ) {
      throw corrupted();
    }
  }

  async #cleanTemporaryFiles() {
    const entries = await readdir(this.#temporaryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !TEMPORARY_FILE.test(entry.name)) {
        throw corrupted();
      }
      await rm(path.join(this.#temporaryRoot, entry.name), { force: true });
    }
  }

  async #recoverBlobs() {
    const blobs = new Map();
    const entries = await readdir(this.#blobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      const match = BLOB_FILE.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) throw corrupted();
      const target = path.join(this.#blobsRoot, entry.name);
      const content = await this.#readRegularFile(
        target,
        this.#limits.maxBlobBytes,
        { allowEmpty: true },
      );
      if (sha256(content) !== match[1]) throw corrupted();
      blobs.set(match[1], content.length);
    }
    return blobs;
  }

  async #recoverManifests(blobs) {
    const manifests = new Map();
    const entries = await readdir(this.#packagesRoot, { withFileTypes: true });
    for (const entry of entries) {
      const match = PACKAGE_FILE.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) throw corrupted();
      const content = await this.#readRegularFile(
        path.join(this.#packagesRoot, entry.name),
        this.#limits.maxManifestBytes,
      );
      let manifest;
      try {
        manifest = normalizeChangePackageManifest(
          JSON.parse(content.toString("utf8")),
          { limits: this.#limits },
        );
      } catch (cause) {
        throw corrupted(cause);
      }
      if (manifest.packageId !== match[1] || manifests.has(manifest.packageId)) {
        throw corrupted();
      }
      for (const blob of this.#manifestBlobs(manifest)) {
        if (blobs.get(blob.sha256) !== blob.bytes) throw corrupted();
      }
      manifests.set(manifest.packageId, manifest);
    }
    return manifests;
  }

  #manifestBlobs(manifest) {
    return [
      ...manifest.changes.created.map(({ blob }) => blob),
      ...manifest.changes.modified.map(({ blob }) => blob),
    ];
  }

  async #removeUnreferencedBlobs(blobs, manifests) {
    const referenced = new Set();
    for (const manifest of manifests.values()) {
      for (const blob of this.#manifestBlobs(manifest)) {
        referenced.add(blob.sha256);
      }
    }
    for (const sha256Value of blobs.keys()) {
      if (referenced.has(sha256Value)) continue;
      await rm(path.join(this.#blobsRoot, `${sha256Value}.blob`));
    }
    return referenced.size;
  }

  async #readRegularFile(target, maximumBytes, { allowEmpty = false } = {}) {
    let initialStats;
    try {
      initialStats = await lstat(target);
    } catch (cause) {
      throw corrupted(cause);
    }
    if (
      !initialStats.isFile() ||
      initialStats.isSymbolicLink() ||
      (!allowEmpty && initialStats.size < 1) ||
      initialStats.size > maximumBytes
    ) {
      throw corrupted();
    }
    let handle;
    try {
      handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.dev !== initialStats.dev ||
        openedStats.ino !== initialStats.ino ||
        openedStats.size !== initialStats.size
      ) {
        throw corrupted();
      }
      const content = Buffer.alloc(openedStats.size);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(
          content,
          offset,
          content.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const [finalHandleStats, finalPathStats] = await Promise.all([
        handle.stat(),
        lstat(target),
      ]);
      if (
        offset !== content.length ||
        finalHandleStats.size !== openedStats.size ||
        !finalPathStats.isFile() ||
        finalPathStats.isSymbolicLink() ||
        finalPathStats.dev !== openedStats.dev ||
        finalPathStats.ino !== openedStats.ino
      ) {
        throw corrupted();
      }
      return content;
    } catch (error) {
      if (error instanceof ChangePackageStoreError) throw error;
      throw corrupted(error);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async #readVerifiedBlob(blob) {
    const content = await this.#readRegularFile(
      path.join(this.#blobsRoot, `${blob.sha256}.blob`),
      this.#limits.maxBlobBytes,
      { allowEmpty: true },
    );
    if (content.length !== blob.bytes || sha256(content) !== blob.sha256) {
      throw corrupted();
    }
    return content;
  }

  async #writeImmutable(target, content) {
    const temporary = path.join(
      this.#temporaryRoot,
      `write-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(temporary, target);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await this.#assertSafeLayout();
      const persisted = await this.#readRegularFile(
        target,
        content.length,
        { allowEmpty: true },
      );
      if (!persisted.equals(content)) {
        throw storeError(
          "CHANGE_PACKAGE_CONFLICT",
          "change package 已存在且内容不同",
        );
      }
    } catch (error) {
      if (error instanceof ChangePackageStoreError) throw error;
      throw storeError("CHANGE_PACKAGE_WRITE_FAILED", "无法持久化 change package", {
        cause: error,
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
