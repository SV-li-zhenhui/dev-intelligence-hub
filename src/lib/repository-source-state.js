import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

async function runGit(root, arguments_, { binary = false } = {}) {
  const options = {
    cwd: path.resolve(root),
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
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

async function readHeadLogDigest(root) {
  const output = await runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "logs/HEAD",
  ]);
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

export async function captureRepositoryState(root) {
  const headOid = parseOid(
    await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD",
  );
  const treeOid = parseOid(
    await runGit(root, ["rev-parse", "--verify", `${headOid}^{tree}`]),
    "tree",
  );
  const headLogDigest = await readHeadLogDigest(root);
  const statusOutput = await runGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { binary: true },
  );
  const finishedHeadOid = parseOid(
    await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD",
  );
  const finishedHeadLogDigest = await readHeadLogDigest(root);
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
