import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_PATH_ENTRIES = 128;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 1024n * 1024n * 1024n;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const TARGETS = Object.freeze({
  "win32:x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    codexPackage: "@openai/codex-win32-x64",
    codexVersionSuffix: "win32-x64",
    codexTriple: "x86_64-pc-windows-msvc",
    codexExecutable: "codex.exe",
    claudePackage: "@anthropic-ai/claude-code-win32-x64",
    claudeExecutable: "claude.exe",
  }),
});

const CLI_IDENTITIES = new Set(["codex-cli", "claude-cli"]);
const SUPPORTED_VERSION_RANGES = Object.freeze({
  "codex-cli": Object.freeze({
    minimum: Object.freeze([0, 147, 0]),
    maximumExclusive: Object.freeze([0, 152, 0]),
  }),
  "claude-cli": Object.freeze({
    minimum: Object.freeze([2, 1, 222]),
    maximumExclusive: Object.freeze([2, 2, 0]),
  }),
});
const VERIFIED_DESCRIPTORS = new WeakMap();
const TEST_CONSTRUCTION_TOKEN = Object.freeze({});

export class KnownCliLocatorError extends Error {
  constructor() {
    super("Requested structured CLI provider is unavailable");
    this.name = "KnownCliLocatorError";
    this.code = "STRUCTURED_PROVIDER_UNAVAILABLE";
    this.statusCode = 503;
  }
}

function unavailableError() {
  return new KnownCliLocatorError();
}

function canonicalPath(value, platform) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function plainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function packageSegments(packageName) {
  return packageName.split("/");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function trustedDirectory(directory, platform, signal = null) {
  try {
    throwIfAborted(signal);
    const details = await lstat(directory);
    throwIfAborted(signal);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
    const resolved = await realpath(directory);
    throwIfAborted(signal);
    return canonicalPath(resolved, platform) === canonicalPath(directory, platform);
  } catch {
    return false;
  }
}

function sameStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("CLI descriptor verification was cancelled");
  }
}

async function readBoundedRegularFile(
  file,
  platform,
  maximumBytes,
  signal = null,
) {
  let handle;
  try {
    throwIfAborted(signal);
    const before = await lstat(file, { bigint: true });
    throwIfAborted(signal);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > BigInt(maximumBytes)
    ) {
      return null;
    }
    const resolvedBefore = await realpath(file);
    throwIfAborted(signal);
    if (canonicalPath(resolvedBefore, platform) !== canonicalPath(file, platform)) {
      return null;
    }
    handle = await open(file, "r");
    throwIfAborted(signal);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStatIdentity(before, opened)) return null;

    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      throwIfAborted(signal);
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    throwIfAborted(signal);
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(file, { bigint: true });
    const resolvedAfter = await realpath(file);
    throwIfAborted(signal);
    if (
      bytesRead > maximumBytes ||
      afterHandle.size !== BigInt(bytesRead) ||
      !sameStatIdentity(before, afterHandle) ||
      !sameStatIdentity(before, afterPath) ||
      canonicalPath(resolvedAfter, platform) !== canonicalPath(file, platform)
    ) {
      return null;
    }
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function trustedFileIdentity(
  file,
  platform,
  {
    executable = false,
    digest = true,
    signal = null,
    singleLink = false,
  } = {},
) {
  try {
    throwIfAborted(signal);
    const before = await lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (singleLink && before.nlink !== 1n)
    ) return null;
    if (before.size > MAX_EXECUTABLE_BYTES) return null;
    if (executable && platform !== "win32" && (before.mode & 0o111n) === 0n) {
      return null;
    }
    const resolved = await realpath(file);
    if (canonicalPath(resolved, platform) !== canonicalPath(file, platform)) {
      return null;
    }
    let sha256 = null;
    if (digest) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file, {
        ...(signal === null ? {} : { signal }),
      })) {
        hash.update(chunk);
      }
      sha256 = hash.digest("hex");
    }
    throwIfAborted(signal);
    const after = await lstat(file, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      (singleLink && after.nlink !== 1n) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return null;
    }
    return Object.freeze({
      command: path.resolve(file),
      canonicalCommand: canonicalPath(file, platform),
      device: after.dev.toString(),
      inode: after.ino.toString(),
      size: after.size.toString(),
      modifiedNanoseconds: after.mtimeNs.toString(),
      sha256,
    });
  } catch {
    return null;
  }
}

async function manifest(packageRoot, platform, signal = null) {
  if (!(await trustedDirectory(packageRoot, platform, signal))) return null;
  throwIfAborted(signal);
  const manifestFile = path.join(packageRoot, "package.json");
  try {
    const bytes = await readBoundedRegularFile(
      manifestFile,
      platform,
      MAX_MANIFEST_BYTES,
      signal,
    );
    throwIfAborted(signal);
    if (bytes === null) return null;
    const value = JSON.parse(bytes.toString("utf8"));
    return plainRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validVersion(value) {
  return typeof value === "string" && SAFE_VERSION.test(value);
}

function supportedVersion(kind, value) {
  if (!validVersion(value)) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  const range = SUPPORTED_VERSION_RANGES[kind];
  if (!range) return false;
  const compare = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] > right[index]) return 1;
      if (left[index] < right[index]) return -1;
    }
    return 0;
  };
  return (
    compare(version, range.minimum) >= 0 &&
    compare(version, range.maximumExclusive) < 0
  );
}

function sameFileIdentity(left, right, { includeDigest = true } = {}) {
  if (!left || !right) return false;
  for (const key of [
    "canonicalCommand",
    "device",
    "inode",
    "size",
    "modifiedNanoseconds",
  ]) {
    if (left[key] !== right[key]) return false;
  }
  if (includeDigest && left.sha256 !== right.sha256) return false;
  return true;
}

function supportsTarget(value, target) {
  return (
    Array.isArray(value.os) &&
    value.os.length === 1 &&
    value.os[0] === target.platform &&
    Array.isArray(value.cpu) &&
    value.cpu.length === 1 &&
    value.cpu[0] === target.arch
  );
}

function frozenDescriptor(identity, platform, { singleLink = false } = {}) {
  const descriptor = Object.freeze({
    command: identity.command,
    prefixArgs: Object.freeze([]),
  });
  VERIFIED_DESCRIPTORS.set(descriptor, Object.freeze({
    identity,
    platform,
    command: identity.command,
    prefixArgs: Object.freeze([]),
    singleLink,
  }));
  return descriptor;
}

export async function materializeVerifiedCliDescriptor(
  descriptor,
  { signal = null } = {},
) {
  const verified = descriptor !== null && typeof descriptor === "object"
    ? VERIFIED_DESCRIPTORS.get(descriptor)
    : null;
  if (!verified) throw unavailableError();
  const current = await trustedFileIdentity(
    verified.command,
    verified.platform,
    {
      executable: true,
      digest: true,
      signal,
      singleLink: verified.singleLink,
    },
  );
  if (!sameFileIdentity(verified.identity, current, { includeDigest: true })) {
    throw unavailableError();
  }
  return Object.freeze({
    command: verified.command,
    prefixArgs: Object.freeze([...verified.prefixArgs]),
    sha256: verified.identity.sha256,
  });
}

export async function pinGitHubCliDescriptor(
  command,
  { signal = null } = {},
) {
  const platform = process.platform;
  const expectedName = platform === "win32" ? "gh.exe" : "gh";
  if (
    typeof command !== "string" ||
    !path.isAbsolute(command) ||
    command.includes("\0") ||
    path.basename(command).toLowerCase() !== expectedName
  ) {
    throw unavailableError();
  }
  const normalizedCommand = path.resolve(command);
  const identity = await trustedFileIdentity(normalizedCommand, platform, {
    executable: true,
    digest: true,
    signal,
    singleLink: true,
  });
  if (!identity) throw unavailableError();
  return frozenDescriptor(identity, platform, { singleLink: true });
}

export class KnownCliLocator {
  #platform;
  #target;
  #searchRoots;

  constructor(constructionToken, testOptions) {
    if (arguments.length > 0 && constructionToken !== TEST_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        "Production CLI locator does not accept replacement dependencies",
      );
    }
    const options = constructionToken === TEST_CONSTRUCTION_TOKEN
      ? testOptions ?? {}
      : {};
    const {
      pathValue = process.env.PATH || "",
      platform = process.platform,
      arch = process.arch,
    } = options;
    if (typeof pathValue !== "string" || pathValue.length > 64 * 1024) {
      throw new TypeError("PATH is invalid");
    }
    this.#platform = platform;
    this.#target = TARGETS[`${platform}:${arch}`] || null;
    const delimiter = platform === "win32" ? ";" : ":";
    this.#searchRoots = Object.freeze(
      [...new Set(
        pathValue
          .split(delimiter)
          .filter((entry) => entry && path.isAbsolute(entry))
          .slice(0, MAX_PATH_ENTRIES)
          .map((entry) => path.resolve(entry)),
      )],
    );
    Object.freeze(this);
  }

  async resolve(kind, { signal = null } = {}) {
    if (!CLI_IDENTITIES.has(kind) || !this.#target) throw unavailableError();
    throwIfAborted(signal);

    for (const nodeModulesRoot of this.#nodeModulesRoots()) {
      throwIfAborted(signal);
      const candidate = kind === "codex-cli"
        ? await this.#codexPackageExecutable(nodeModulesRoot, signal)
        : await this.#claudePackageExecutable(nodeModulesRoot, signal);
      throwIfAborted(signal);
      if (candidate) return frozenDescriptor(candidate, this.#platform);
    }
    throw unavailableError();
  }

  #nodeModulesRoots() {
    const roots = [];
    for (const searchRoot of this.#searchRoots) {
      if (
        path.basename(searchRoot).toLowerCase() === ".bin" &&
        path.basename(path.dirname(searchRoot)).toLowerCase() === "node_modules"
      ) {
        roots.push(path.dirname(searchRoot));
      }
      roots.push(path.join(searchRoot, "node_modules"));
      roots.push(path.resolve(searchRoot, "..", "lib", "node_modules"));
      roots.push(path.resolve(searchRoot, "..", "node_modules"));
    }
    return [...new Set(roots)];
  }

  async #codexPackageExecutable(nodeModulesRoot, signal) {
    const packageRoot = path.join(
      nodeModulesRoot,
      ...packageSegments("@openai/codex"),
    );
    const parent = await manifest(packageRoot, this.#platform, signal);
    throwIfAborted(signal);
    if (
      parent?.name !== "@openai/codex" ||
      !supportedVersion("codex-cli", parent.version) ||
      !plainRecord(parent.bin) ||
      !["bin/codex.js", "./bin/codex.js"].includes(parent.bin.codex) ||
      !plainRecord(parent.optionalDependencies)
    ) {
      return null;
    }
    const expectedDependency =
      `npm:@openai/codex@${parent.version}-${this.#target.codexVersionSuffix}`;
    if (
      parent.optionalDependencies[this.#target.codexPackage] !==
      expectedDependency
    ) {
      return null;
    }
    const nativeRoots = [
      path.join(
        packageRoot,
        "node_modules",
        ...packageSegments(this.#target.codexPackage),
      ),
      path.join(nodeModulesRoot, ...packageSegments(this.#target.codexPackage)),
    ];
    for (const nativeRoot of [...new Set(nativeRoots)]) {
      throwIfAborted(signal);
      if (
        !inside(
          nativeRoot.startsWith(`${packageRoot}${path.sep}`)
            ? packageRoot
            : nodeModulesRoot,
          nativeRoot,
        )
      ) {
        continue;
      }
      const native = await manifest(nativeRoot, this.#platform, signal);
      throwIfAborted(signal);
      if (
        native?.name !== "@openai/codex" ||
        native.version !==
          `${parent.version}-${this.#target.codexVersionSuffix}` ||
        !supportsTarget(native, this.#target)
      ) {
        continue;
      }
      const executable = path.join(
        nativeRoot,
        "vendor",
        this.#target.codexTriple,
        "bin",
        this.#target.codexExecutable,
      );
      if (!inside(nativeRoot, executable)) continue;
      const identity = await trustedFileIdentity(executable, this.#platform, {
        executable: true,
        signal,
      });
      throwIfAborted(signal);
      if (identity) return identity;
    }
    return null;
  }

  async #claudePackageExecutable(nodeModulesRoot, signal) {
    const packageRoot = path.join(
      nodeModulesRoot,
      ...packageSegments("@anthropic-ai/claude-code"),
    );
    const parent = await manifest(packageRoot, this.#platform, signal);
    throwIfAborted(signal);
    const expectedBin = this.#platform === "win32"
      ? "bin/claude.exe"
      : "bin/claude";
    if (
      parent?.name !== "@anthropic-ai/claude-code" ||
      !supportedVersion("claude-cli", parent.version) ||
      !plainRecord(parent.bin) ||
      ![expectedBin, `./${expectedBin}`].includes(parent.bin.claude) ||
      !plainRecord(parent.optionalDependencies) ||
      parent.optionalDependencies[this.#target.claudePackage] !== parent.version
    ) {
      return null;
    }
    const executable = path.join(packageRoot, expectedBin);
    if (!inside(packageRoot, executable)) return null;
    const identity = await trustedFileIdentity(executable, this.#platform, {
      executable: true,
      signal,
    });
    throwIfAborted(signal);
    return identity;
  }
}

export function createTestKnownCliLocator(options = {}) {
  return new KnownCliLocator(TEST_CONSTRUCTION_TOKEN, options);
}
