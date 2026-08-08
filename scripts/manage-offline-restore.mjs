import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOfflineRestoreRuntime } from "../src/offline-restore-runtime.js";
import { createApplicationWriterLease } from "../src/lib/application-writer-lease.js";
import { projectIdentityDigest } from "../src/lib/project-identity.js";

const BACKUP_ID = /^backup-[a-f0-9]{64}$/u;
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = await realpath(path.resolve(scriptsDirectory, ".."));
const projectDigest = projectIdentityDigest({ projectRoot: projectDirectory });

function requestFromArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--recover") {
    return Object.freeze({ action: "recover" });
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "--activate" &&
    BACKUP_ID.test(arguments_[1])
  ) {
    return Object.freeze({ action: "activate", backupId: arguments_[1] });
  }
  throw new TypeError("expected --recover or --activate with one backup ID");
}

async function ensureFixedDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const [info, resolved] = await Promise.all([lstat(target), realpath(target)]);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform === "win32"
      ? resolved.toLowerCase() !== target.toLowerCase()
      : resolved !== target)
  ) {
    throw new Error("offline restore storage boundary is invalid");
  }
}

function assertManagerAuthority() {
  const suppliedDigest = process.env.MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST;
  const authority = process.env.MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY;
  delete process.env.MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST;
  delete process.env.MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY;
  if (suppliedDigest !== projectDigest || authority !== "manager-v1") {
    throw new Error("offline restore requires the project process manager");
  }
}

function safeFailure(error) {
  const candidate = typeof error?.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.code)
    ? error.code
    : "OFFLINE_RESTORE_FAILED";
  return Object.freeze({
    schemaVersion: 1,
    ok: false,
    error: Object.freeze({ code: candidate }),
  });
}

try {
  assertManagerAuthority();
  const request = requestFromArguments(process.argv.slice(2));
  const activeDirectory = path.join(projectDirectory, "data");
  const backupDirectory = path.join(projectDirectory, "backups");
  const controlDirectory = path.join(projectDirectory, "restore-control");
  const writerLease = createApplicationWriterLease({
    projectRoot: projectDirectory,
    projectDigest,
  });
  await writerLease.acquire();
  let result;
  try {
    await ensureFixedDirectory(backupDirectory);
    const runtime = createOfflineRestoreRuntime({
      activeDirectory,
      backupDirectory,
      controlDirectory,
      writerLease,
    });
    result = request.action === "recover"
      ? await runtime.recover()
      : await runtime.activate({ backupId: request.backupId });
  } finally {
    await writerLease.close();
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    action: request.action,
    result,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
  process.exitCode = 1;
}
