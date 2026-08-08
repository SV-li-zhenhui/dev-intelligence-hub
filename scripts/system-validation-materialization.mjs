import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitObjectSnapshotter } from "../src/adapters/git-object-snapshotter.js";

const execFileAsync = promisify(execFile);
const OBJECT_IDENTITY = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_FILES = 25_000;
const MAXIMUM_TOTAL_BYTES = 300 * 1024 * 1024;
const VALIDATION_DEPENDENCIES = Object.freeze([
  "playwright",
  "playwright-core",
]);

function updateFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

async function commandCandidates() {
  let output;
  try {
    const located = process.platform === "win32"
      ? await execFileAsync("where.exe", ["git"], {
          encoding: "utf8",
          windowsHide: true,
        })
      : await execFileAsync("which", ["git"], { encoding: "utf8" });
    output = located.stdout;
  } catch {
    throw new Error("trusted Git is unavailable for validation materialization");
  }
  const candidates = [];
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    if (!path.isAbsolute(line)) continue;
    candidates.push(path.resolve(line));
    if (process.platform === "win32") {
      const installationRoot = path.dirname(path.dirname(line));
      candidates.push(path.join(installationRoot, "mingw64", "bin", "git.exe"));
    }
  }
  return [...new Set(candidates.map((candidate) => candidate.toLowerCase()))]
    .map((normalized) =>
      candidates.find((candidate) => candidate.toLowerCase() === normalized)
    );
}

async function trustedSnapshotter(root) {
  for (const candidate of await commandCandidates()) {
    try {
      const canonical = await realpath(candidate);
      const snapshotter = new GitObjectSnapshotter({ gitCommand: canonical });
      const boundary = await snapshotter.preflight({ sourceRoot: root });
      return { boundary, snapshotter };
    } catch {
      // Try the next discovered implementation; every accepted one is revalidated.
    }
  }
  throw new Error("trusted Git is unavailable for validation materialization");
}

async function readStableFile(file, relativePath) {
  const before = await lstat(file, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 0n ||
    before.size > BigInt(MAXIMUM_TOTAL_BYTES)
  ) {
    throw new Error(`immutable validation source contains an unsafe file: ${relativePath}`);
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
    }
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        Math.min(64 * 1024, contents.length - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
      }
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extra } = await handle.read(
      probe,
      0,
      1,
      contents.length,
    );
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(file, { bigint: true });
    if (
      extra !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      finalPath.dev !== before.dev ||
      finalPath.ino !== before.ino ||
      finalPath.mode !== before.mode ||
      finalPath.size !== before.size ||
      finalPath.mtimeNs !== before.mtimeNs ||
      finalPath.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
    }
    return { contents, mode: Number(before.mode) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function scan(directory, { requireSealed = false } = {}) {
  const files = [];
  async function visit(current, relativeDirectory = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`immutable validation source contains a link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        if (requireSealed && (metadata.mode & 0o222) !== 0) {
          throw new Error("immutable validation source changed");
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`immutable validation source contains an unsafe entry: ${relativePath}`);
      }
      const file = await readStableFile(absolutePath, relativePath);
      if (requireSealed && (file.mode & 0o222) !== 0) {
        throw new Error("immutable validation source changed");
      }
      files.push({ path: relativePath, contents: file.contents });
      if (files.length > MAXIMUM_FILES) {
        throw new Error("immutable validation source contains too many files");
      }
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  hash.update("mydashboard-validation-materialization-v1\0");
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.contents.length;
    if (totalBytes > MAXIMUM_TOTAL_BYTES) {
      throw new Error("immutable validation source is too large");
    }
    updateFrame(hash, file.path);
    updateFrame(hash, file.contents);
  }
  return Object.freeze({
    contentDigest: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  });
}

async function copyValidationDependencies(root, target) {
  const sourceModules = path.join(root, "node_modules");
  for (const dependency of VALIDATION_DEPENDENCIES) {
    const source = path.join(sourceModules, dependency);
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("validation dependency is unavailable or unsafe");
    }
    const destination = path.join(target, "node_modules", dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

async function seal(directory) {
  const directories = [];
  async function visit(current) {
    directories.push(current);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error("immutable validation source contains a link");
      }
      if (metadata.isDirectory()) {
        await visit(entryPath);
      } else if (metadata.isFile()) {
        await chmod(entryPath, 0o444);
      } else {
        throw new Error("immutable validation source contains an unsafe entry");
      }
    }
  }
  await visit(directory);
  directories.sort((left, right) => right.length - left.length);
  for (const candidate of directories) await chmod(candidate, 0o555);
}

async function unsealAndRemove(directory) {
  async function visit(current) {
    await chmod(current, 0o755).catch(() => {});
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        await chmod(entryPath, 0o644).catch(() => {});
      }
    }
  }
  await visit(directory);
  await rm(directory, { force: true, recursive: true });
}

export async function createValidationSourceMaterialization({
  root,
  headOid,
  treeOid,
}) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    !OBJECT_IDENTITY.test(headOid) ||
    !OBJECT_IDENTITY.test(treeOid) ||
    headOid.length !== treeOid.length
  ) {
    throw new Error("validation materialization request is invalid");
  }
  const canonicalRoot = await realpath(root);
  const target = await mkdtemp(
    path.join(os.tmpdir(), "mydashboard-validation-source-"),
  );
  let completed = false;
  try {
    const { boundary, snapshotter } = await trustedSnapshotter(canonicalRoot);
    await snapshotter.materialize({
      sourceRoot: canonicalRoot,
      targetRoot: target,
      headOid,
      excludePaths: [],
      expectedBoundaryDigest: boundary.boundaryDigest,
      expectedGitCommand: boundary.gitCommand,
      expectedGitExecutableSha256: boundary.gitExecutableSha256,
      expectedGitExecutableBytes: boundary.gitExecutableBytes,
      expectedGitExecutableMode: boundary.gitExecutableMode,
      expectedGitExecutableUid: boundary.gitExecutableUid,
      expectedGitExecutableGid: boundary.gitExecutableGid,
    });
    await copyValidationDependencies(canonicalRoot, target);
    await seal(target);
    const scanned = await scan(target, { requireSealed: true });
    const identity = Object.freeze({
      schemaVersion: 1,
      headOid,
      treeOid,
      sealed: true,
      ...scanned,
    });
    let cleaned = false;
    completed = true;
    return Object.freeze({
      directory: target,
      identity,
      async verify() {
        let current;
        try {
          current = await scan(target, { requireSealed: true });
        } catch {
          throw new Error("immutable validation source changed");
        }
        if (
          current.contentDigest !== identity.contentDigest ||
          current.fileCount !== identity.fileCount ||
          current.totalBytes !== identity.totalBytes
        ) {
          throw new Error("immutable validation source changed");
        }
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await unsealAndRemove(target);
      },
    });
  } finally {
    if (!completed) await unsealAndRemove(target).catch(() => {});
  }
}
