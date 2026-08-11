import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { captureRepositoryState } from "./repository-source-state.js";

const MAXIMUM_PACKAGE_BYTES = 1024 * 1024;
const MAXIMUM_SOURCE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_SOURCE_FILES = 20_000;
const AUTOMATIC_PACKAGE_FILES = Object.freeze([
  "README",
  "README.md",
  "README.txt",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "COPYING",
]);

function unsafeEntry() {
  throw new Error("runtime package file entry is unsafe");
}

function packageEntry(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    /[*?[\]{}!]/u.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    return unsafeEntry();
  }
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  const segments = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash
  ) {
    return unsafeEntry();
  }
  return withoutTrailingSlash;
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function optionalRegularFile(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("runtime source entry must be a regular file or directory");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function collectEntry(root, relativePath, files) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new Error("runtime source entry must be a regular file or directory");
  }
  if (metadata.isFile()) {
    files.add(relativePath);
    if (files.size > MAXIMUM_SOURCE_FILES) {
      throw new Error("runtime source contains too many files");
    }
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("runtime source entry must be a regular file or directory");
  }
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => comparePath(left.name, right.name));
  for (const entry of entries) {
    await collectEntry(root, `${relativePath}/${entry.name}`, files);
  }
}

function updateFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

async function hasLocalRepositoryMetadata(root) {
  try {
    await lstat(path.join(path.resolve(root), ".git"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function packagedObjectIdentity(kind, runtime) {
  const hash = createHash("sha256");
  hash.update(`mydashboard-packaged-runtime-${kind}-v1\0`);
  updateFrame(hash, runtime.digest);
  updateFrame(hash, String(runtime.fileCount));
  updateFrame(hash, String(runtime.byteCount));
  return hash.digest("hex");
}

function packagedRuntimeSourceIdentity(runtime) {
  return Object.freeze({
    schemaVersion: 1,
    headOid: packagedObjectIdentity("head", runtime),
    treeOid: packagedObjectIdentity("tree", runtime),
    clean: true,
    runtimeDigest: runtime.digest,
    runtimeFileCount: runtime.fileCount,
    runtimeByteCount: runtime.byteCount,
  });
}

export async function computeRuntimeSourceIdentity(root) {
  const canonicalRoot = path.resolve(root);
  const packagePath = path.join(canonicalRoot, "package.json");
  const packageContents = await readFile(packagePath);
  if (packageContents.length > MAXIMUM_PACKAGE_BYTES) {
    throw new Error("runtime package manifest is too large");
  }
  let manifest;
  try {
    manifest = JSON.parse(packageContents.toString("utf8"));
  } catch {
    throw new Error("runtime package manifest is invalid");
  }
  if (!Array.isArray(manifest?.files)) {
    throw new Error("runtime package manifest must declare files");
  }
  const roots = ["package.json", ...manifest.files.map(packageEntry)];
  for (const relativePath of AUTOMATIC_PACKAGE_FILES) {
    if (await optionalRegularFile(canonicalRoot, relativePath)) {
      roots.push(relativePath);
    }
  }
  const files = new Set();
  for (const relativePath of [...new Set(roots)].sort(comparePath)) {
    await collectEntry(canonicalRoot, relativePath, files);
  }
  const orderedFiles = [...files].sort(comparePath);
  const hash = createHash("sha256");
  hash.update("mydashboard-runtime-source-v1\0");
  let byteCount = 0;
  for (const relativePath of orderedFiles) {
    const contents = await readFile(
      path.join(canonicalRoot, ...relativePath.split("/")),
    );
    byteCount += contents.length;
    if (!Number.isSafeInteger(byteCount) || byteCount > MAXIMUM_SOURCE_BYTES) {
      throw new Error("runtime source is too large");
    }
    updateFrame(hash, relativePath);
    updateFrame(hash, contents);
  }
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256",
    digest: hash.digest("hex"),
    fileCount: orderedFiles.length,
    byteCount,
  });
}

function runtimeSourceCheckpoint(runtimeSource, historyDigest) {
  return Object.freeze({
    historyDigest,
    runtimeSource,
  });
}

export async function captureVersionedRuntimeSourceCheckpoint(root) {
  const runtime = await computeRuntimeSourceIdentity(root);
  const hadLocalRepositoryMetadata = await hasLocalRepositoryMetadata(root);
  let source;
  try {
    source = await captureRepositoryState(root);
  } catch {
    if (
      hadLocalRepositoryMetadata ||
      await hasLocalRepositoryMetadata(root)
    ) {
      return null;
    }
    return runtimeSourceCheckpoint(
      packagedRuntimeSourceIdentity(runtime),
      packagedObjectIdentity("history", runtime),
    );
  }
  if (!source.clean) return null;
  return runtimeSourceCheckpoint(
    Object.freeze({
      schemaVersion: 1,
      headOid: source.headOid,
      treeOid: source.treeOid,
      clean: true,
      runtimeDigest: runtime.digest,
      runtimeFileCount: runtime.fileCount,
      runtimeByteCount: runtime.byteCount,
    }),
    source.headLogDigest,
  );
}

export async function computeVersionedRuntimeSourceIdentity(root) {
  const checkpoint = await captureVersionedRuntimeSourceCheckpoint(root);
  return checkpoint?.runtimeSource ?? null;
}
