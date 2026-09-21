import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

async function runGit(
  root,
  arguments_,
  { binary = false, environment = undefined } = {},
) {
  const options = {
    cwd: path.resolve(root),
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...(environment === undefined ? {} : { env: environment }),
  };
  try {
    const { stdout } = await execFileAsync("git", arguments_, options);
    return stdout;
  } catch {
    throw new Error("unable to capture Git repository state");
  }
}

function parseOid(value, label) {
  const oid = value.trim();
  if (!OID_PATTERN.test(oid)) {
    throw new Error(`Git returned an invalid ${label} object identity`);
  }
  return oid;
}

async function assertRepositoryRoot(root, environment) {
  const canonicalRoot = path.resolve(root);
  const output = await runGit(
    canonicalRoot,
    ["rev-parse", "--show-toplevel"],
    { environment },
  );
  const discoveredRoot = output.trim();
  if (
    !path.isAbsolute(discoveredRoot) ||
    path.relative(canonicalRoot, path.resolve(discoveredRoot)) !== ""
  ) {
    throw new Error("supplied root is not the Git repository root");
  }
  return canonicalRoot;
}

async function readHeadLogDigest(root, environment) {
  const output = await runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "logs/HEAD",
  ], { environment });
  const logPath = output.trim();
  if (!path.isAbsolute(logPath)) {
    throw new Error("Git returned an invalid HEAD log path");
  }
  try {
    const metadata = await lstat(logPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024 * 1024
    ) {
      throw new Error("Git HEAD log is not a bounded regular file");
    }
    const contents = await readFile(logPath);
    if (contents.length !== metadata.size) {
      throw new Error("Git HEAD log changed while it was read");
    }
    return createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Git HEAD log")) {
      throw error;
    }
    throw new Error("unable to capture Git HEAD history");
  }
}

export async function captureRepositoryState(root, { environment } = {}) {
  const canonicalRoot = await assertRepositoryRoot(root, environment);
  const headOid = parseOid(
    await runGit(
      canonicalRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { environment },
    ),
    "HEAD",
  );
  const treeOid = parseOid(
    await runGit(
      canonicalRoot,
      ["rev-parse", "--verify", `${headOid}^{tree}`],
      { environment },
    ),
    "tree",
  );
  const headLogDigest = await readHeadLogDigest(canonicalRoot, environment);
  const statusOutput = await runGit(
    canonicalRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { binary: true, environment },
  );
  const finishedHeadOid = parseOid(
    await runGit(
      canonicalRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { environment },
    ),
    "HEAD",
  );
  const finishedHeadLogDigest = await readHeadLogDigest(
    canonicalRoot,
    environment,
  );
  await assertRepositoryRoot(canonicalRoot, environment);
  if (finishedHeadOid !== headOid) {
    throw new Error("repository HEAD changed while source identity was captured");
  }
  if (finishedHeadLogDigest !== headLogDigest) {
    throw new Error("repository history changed while source identity was captured");
  }
  const status = Buffer.from(statusOutput);
  const statusText = status.toString("utf8");
  const changeCount = statusText === ""
    ? 0
    : statusText.split(/\r?\n/u).filter(Boolean).length;
  return {
    schemaVersion: 1,
    headOid,
    treeOid,
    clean: changeCount === 0,
    changeCount,
    statusDigest: createHash("sha256").update(status).digest("hex"),
    headLogDigest,
  };
}

export function assertStableCleanRepository(started, finished) {
  if (!started?.clean) {
    throw new Error("repository was not clean when validation started");
  }
  if (!finished?.clean) {
    throw new Error("repository was not clean when validation finished");
  }
  if (started.headOid !== finished.headOid) {
    throw new Error("repository HEAD changed during validation");
  }
  if (started.treeOid !== finished.treeOid) {
    throw new Error("repository tree changed during validation");
  }
  if (started.headLogDigest !== finished.headLogDigest) {
    throw new Error("repository history changed during validation");
  }
}
