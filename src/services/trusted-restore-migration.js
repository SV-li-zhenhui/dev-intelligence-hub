import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  allPersistedSchemaOwners,
} from "./persisted-schema-owner-catalog.js";

const MAX_CANDIDATE_ENTRIES = 100_512;
const MAX_CANDIDATE_DEPTH = 64;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const HASH_BUFFER_BYTES = 64 * 1_024;
const EXTENSION_WRITABLE_FILES = new Set(
  allPersistedSchemaOwners()
    .filter(({ key, mode }) => key !== undefined && mode === "migrate-replace")
    .map(({ key }) => `${key}.json`),
);

export class TrustedRestoreMigrationError extends Error {
  constructor(message = "Candidate migration extension crossed its boundary", {
    cause,
  } = {}) {
    super(message, cause === undefined ? {} : { cause });
    this.name = "TrustedRestoreMigrationError";
    this.code = "RESTORE_MIGRATION_EXTENSION_BOUNDARY";
  }
}

function boundary(cause) {
  return cause instanceof TrustedRestoreMigrationError
    ? cause
    : new TrustedRestoreMigrationError(undefined, { cause });
}

function exactRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("restore migration request is invalid");
  }
  const entries = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("restore migration request is invalid");
    }
    entries.set(key, descriptor.value);
  }
  if (
    entries.size !== 2 ||
    !entries.has("directory") ||
    !entries.has("manifest") ||
    typeof entries.get("directory") !== "string" ||
    !path.isAbsolute(entries.get("directory"))
  ) {
    throw new TypeError("restore migration request is invalid");
  }
  return Object.freeze({
    directory: path.resolve(entries.get("directory")),
    manifest: entries.get("manifest"),
  });
}

function boundMethod(value, name) {
  if (!value || utilTypes.isProxy(value)) return null;
  let current = value;
  while (current !== null && !utilTypes.isProxy(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return "value" in descriptor &&
          typeof descriptor.value === "function" &&
          !utilTypes.isProxy(descriptor.value)
        ? descriptor.value.bind(value)
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function frozenIdentity(value) {
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

async function hashRegularFile(filePath, expectedInfo) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.nlink !== 1 ||
      !sameIdentity(expectedInfo, openedInfo)
    ) {
      throw boundary();
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalInfo = await handle.stat();
    if (
      !sameIdentity(openedInfo, finalInfo) ||
      openedInfo.size !== finalInfo.size ||
      position !== finalInfo.size
    ) {
      throw boundary();
    }
    return Object.freeze({
      bytes: finalInfo.size,
      sha256: digest.digest("hex"),
    });
  } finally {
    await handle?.close();
  }
}

function recordPath(seen, relativePath) {
  if (
    Buffer.byteLength(relativePath, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    relativePath.split("/").length > MAX_CANDIDATE_DEPTH
  ) {
    throw boundary();
  }
  const identity = relativePath.normalize("NFC").toLowerCase();
  if (seen.has(identity)) throw boundary();
  seen.add(identity);
}

async function candidateInventory(root) {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw boundary();
    const directories = new Map([["", frozenIdentity(rootInfo)]]);
    const files = new Map();
    const seen = new Set();
    const pending = [{ absolute: root, relative: "" }];
    let entryCount = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      const entries = await readdir(current.absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_CANDIDATE_ENTRIES) throw boundary();
        const relative = current.relative === ""
          ? entry.name
          : `${current.relative}/${entry.name}`;
        recordPath(seen, relative);
        const absolute = path.join(current.absolute, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw boundary();
        if (info.isDirectory()) {
          directories.set(relative, frozenIdentity(info));
          pending.push({ absolute, relative });
          continue;
        }
        if (!info.isFile() || info.nlink !== 1) throw boundary();
        files.set(relative, await hashRegularFile(absolute, info));
      }
    }
    const finalRootInfo = await lstat(root);
    if (
      finalRootInfo.isSymbolicLink() ||
      !finalRootInfo.isDirectory() ||
      !sameIdentity(rootInfo, finalRootInfo)
    ) {
      throw boundary();
    }
    return Object.freeze({ directories, files });
  } catch (cause) {
    throw boundary(cause);
  }
}

function sameKeys(left, right) {
  return left.size === right.size &&
    [...left.keys()].every((key) => right.has(key));
}

function assertExtensionBoundary(before, after) {
  if (
    !sameKeys(before.directories, after.directories) ||
    !sameKeys(before.files, after.files)
  ) {
    throw boundary();
  }
  for (const [relativePath, expected] of before.directories) {
    if (!sameIdentity(expected, after.directories.get(relativePath))) {
      throw boundary();
    }
  }
  for (const [relativePath, expected] of before.files) {
    if (EXTENSION_WRITABLE_FILES.has(relativePath)) continue;
    const actual = after.files.get(relativePath);
    if (
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw boundary();
    }
  }
}

export function createTrustedRestoreMigration({
  trustedRegistry,
  candidateExtension = null,
} = {}) {
  const trustedMigrate = boundMethod(trustedRegistry, "migrate");
  const extensionMigrate = candidateExtension === null
    ? null
    : boundMethod(candidateExtension, "migrate");
  if (trustedMigrate === null) {
    throw new TypeError("trusted restore migration registry is invalid");
  }
  if (candidateExtension !== null && extensionMigrate === null) {
    throw new TypeError("candidate migration extension is invalid");
  }
  return Object.freeze({
    migrate: async (value) => {
      const request = exactRequest(value);
      await trustedMigrate(request);
      if (extensionMigrate !== null) {
        const before = await candidateInventory(request.directory);
        await extensionMigrate(exactRequest(request));
        const after = await candidateInventory(request.directory);
        assertExtensionBoundary(before, after);
      }
      await trustedMigrate(exactRequest(request));
    },
  });
}
