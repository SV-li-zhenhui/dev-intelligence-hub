import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

export async function captureRepositoryState(root) {
  const [headOutput, treeOutput, statusOutput] = await Promise.all([
    runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(root, ["rev-parse", "--verify", "HEAD^{tree}"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
      binary: true,
    }),
  ]);
  const status = Buffer.from(statusOutput);
  const statusText = status.toString("utf8");
  const changeCount = statusText === ""
    ? 0
    : statusText.split(/\r?\n/u).filter(Boolean).length;
  return {
    schemaVersion: 1,
    headOid: parseOid(headOutput, "HEAD"),
    treeOid: parseOid(treeOutput, "tree"),
    clean: changeCount === 0,
    changeCount,
    statusDigest: createHash("sha256").update(status).digest("hex"),
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
}
