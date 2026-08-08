import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackupService } from "../src/services/backup-service.js";
import {
  OfflineRestoreActivationService,
  RestoreActivationError,
} from "../src/services/offline-restore-activation-service.js";

const NOW = "2026-08-08T02:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t, { migration, reconciliation } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-restore-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active-data");
  const backups = path.join(root, "backups");
  const control = path.join(root, ".offline-restore");
  const original = Buffer.from('{"revision":1}\n');
  await mkdir(path.join(active, "state"), { recursive: true });
  await writeFile(path.join(active, "state", "work-ledger.json"), original);
  const checkpoint = {
    token: "offline-checkpoint-0001",
    stores: [{ name: "work-ledger", revision: 1, digest: digest(original) }],
    files: [{
      path: "state/work-ledger.json",
      kind: "mutable",
      bytes: original.length,
      sha256: digest(original),
    }],
  };
  const quiescence = {
    async enter() {
      return structuredClone(checkpoint);
    },
    async leave() {},
  };
  const creator = new BackupService({
    sourceDirectory: active,
    backupDirectory: backups,
    quiescence,
    now: () => new Date(NOW),
  });
  const created = await creator.createBackup();
  await writeFile(
    path.join(active, "state", "work-ledger.json"),
    '{"revision":99}\n',
  );
  const restorer = new BackupService({
    sourceDirectory: active,
    backupDirectory: backups,
    quiescence,
    migration,
    canonicalization: migration ? {
      async capture() {
        return {
          stores: structuredClone(checkpoint.stores),
          files: structuredClone(checkpoint.files),
        };
      },
    } : undefined,
    reconciliation: reconciliation ?? (migration ? {
      async reconcile() {
        return { ready: true, blockers: [] };
      },
    } : undefined),
    now: () => new Date(NOW),
  });
  const createActivation = (options = {}) => new OfflineRestoreActivationService({
    activeDirectory: active,
    backupDirectory: backups,
    controlDirectory: control,
    backupService: options.backupService ?? restorer,
    atomicDirectoryMover: options.atomicDirectoryMover,
    transitionObserver: options.transitionObserver,
    ...(options.processProbe ? { processProbe: options.processProbe } : {}),
    ...(options.writerLease ? { writerLease: options.writerLease } : {}),
    now: () => new Date(NOW),
  });
  return {
    root,
    active,
    backups,
    control,
    backupId: created.manifest.backupId,
    restorer,
    createActivation,
  };
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hasCode(code) {
  return (error) => error instanceof RestoreActivationError && error.code === code;
}

async function crashAt(current, stage) {
  const child = spawnWorker(current, stage);
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(
    exit,
    { code: 86, signal: null },
    Buffer.concat(output).toString("utf8"),
  );
}

function spawnWorker(current, stage) {
  const worker = path.join(
    process.cwd(),
    "test-support",
    "offline-restore-crash-worker.mjs",
  );
  return spawn(process.execPath, [
    worker,
    current.active,
    current.backups,
    current.control,
    current.backupId,
    stage,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("offline activation swaps only after validation and returns a bounded path-free receipt", async (t) => {
  const current = await fixture(t);
  const receipt = await current.createActivation().activate({
    backupId: current.backupId,
  });

  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion",
    "activationId",
    "backupId",
    "status",
    "activatedAt",
  ]);
  assert.equal(receipt.status, "activated");
  assert.equal(JSON.stringify(receipt).includes(current.root), false);
  assert.equal(
    await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
    '{"revision":1}\n',
  );
  assert.deepEqual((await readdir(current.control)).sort(), [
    "restore-activation-receipt.json",
  ]);

  const restarted = await current.createActivation().activate({
    backupId: current.backupId,
  });
  assert.deepEqual(restarted, receipt);
});

test("offline activation can recover a completely missing active directory", async (t) => {
  const current = await fixture(t);
  await rm(current.active, { recursive: true });

  const receipt = await current.createActivation().activate({
    backupId: current.backupId,
  });

  assert.equal(receipt.status, "activated");
  assert.equal(
    await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
    '{"revision":1}\n',
  );
  assert.equal(await exists(path.join(current.control, "rollback")), false);
});

test("candidate migration or reconciliation failure leaves the old active data unchanged", async (t) => {
  for (const options of [
    { migration: { async migrate() { throw new Error("migration secret"); } } },
    {
      reconciliation: {
        async reconcile() {
          return { ready: false, blockers: ["unresolved"] };
        },
      },
    },
  ]) {
    await t.test(Object.keys(options)[0], async (child) => {
      const current = await fixture(child, options);
      await assert.rejects(
        current.createActivation().activate({ backupId: current.backupId }),
        hasCode("RESTORE_ACTIVATION_CANDIDATE_FAILED"),
      );
      assert.equal(
        await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
        '{"revision":99}\n',
      );
      assert.equal(await exists(path.join(current.control, "rollback")), false);
      assert.equal(await exists(path.join(current.control, "candidate")), false);
    });
  }
});

test("the filesystem lock rejects a competing process before it can restore", async (t) => {
  const current = await fixture(t);
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const blockingRestore = {
    async restore(request) {
      entered();
      await blocked;
      return current.restorer.restore(request);
    },
  };
  const first = current.createActivation({ backupService: blockingRestore }).activate({
    backupId: current.backupId,
  });
  await started;

  await assert.rejects(
    current.createActivation().activate({ backupId: current.backupId }),
    hasCode("RESTORE_ACTIVATION_BUSY"),
  );
  release();
  assert.equal((await first).status, "activated");
});

test("an exclusive writer lease reclaims a stale lock whose PID was reused", async (t) => {
  const current = await fixture(t);
  await mkdir(current.control, { recursive: true });
  const payload = {
    schemaVersion: 1,
    pid: 4242,
    nonce: "00000000-0000-4000-8000-000000000042",
    acquiredAt: NOW,
  };
  await writeFile(
    path.join(current.control, "restore-activation.lock"),
    `${JSON.stringify({
      ...payload,
      lockDigest: digest(JSON.stringify(payload)),
    })}\n`,
  );
  let assertions = 0;

  const receipt = await current.createActivation({
    processProbe: async (pid) => {
      assert.equal(pid, 4242);
      return true;
    },
    writerLease: {
      assertHeld() {
        assertions += 1;
      },
    },
  }).activate({ backupId: current.backupId });

  assert.equal(receipt.status, "activated");
  assert.equal(assertions, 1);
});

test("writer-lease stale recovery never removes a concurrently owned in-process lock", async (t) => {
  const current = await fixture(t);
  const lease = { assertHeld() {} };
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = current.createActivation({
    writerLease: lease,
    backupService: {
      async restore(request) {
        entered();
        await blocked;
        return current.restorer.restore(request);
      },
    },
  }).activate({ backupId: current.backupId });
  await started;

  await assert.rejects(
    current.createActivation({ writerLease: lease }).activate({
      backupId: current.backupId,
    }),
    hasCode("RESTORE_ACTIVATION_BUSY"),
  );
  release();
  assert.equal((await first).status, "activated");
});

test("a live child process owns the cross-process lock until it exits", async (t) => {
  const current = await fixture(t);
  const child = spawnWorker(current, "hold-lock");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("LOCK_READY")) resolve();
    });
  });
  await ready;

  await assert.rejects(
    current.createActivation().activate({ backupId: current.backupId }),
    hasCode("RESTORE_ACTIVATION_BUSY"),
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;

  const receipt = await current.createActivation().activate({
    backupId: current.backupId,
  });
  assert.equal(receipt.status, "activated");
});

test("the durable journal describes each swap before any active-directory rename", async (t) => {
  const current = await fixture(t);
  const observedPhases = [];
  const mover = {
    async rename(source, destination) {
      const journal = JSON.parse(await readFile(
        path.join(current.control, "restore-activation-journal.json"),
        "utf8",
      ));
      observedPhases.push([
        path.basename(source),
        path.basename(destination),
        journal.phase,
      ]);
      return rename(source, destination);
    },
  };

  await current.createActivation({ atomicDirectoryMover: mover }).activate({
    backupId: current.backupId,
  });

  assert.deepEqual(observedPhases, [
    ["active-data", "rollback", "candidate-ready"],
    ["candidate", "active-data", "active-moved"],
  ]);
});

test("a corrupt journal fails closed without changing active or rollback data", async (t) => {
  const current = await fixture(t);
  await mkdir(current.control);
  await writeFile(
    path.join(current.control, "restore-activation-journal.json"),
    '{"schemaVersion":1,"phase":"active-moved"}\n',
  );

  await assert.rejects(
    current.createActivation().recover(),
    hasCode("RESTORE_ACTIVATION_JOURNAL_CORRUPTED"),
  );
  assert.equal(
    await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
    '{"revision":99}\n',
  );
  assert.equal(await exists(path.join(current.control, "rollback")), false);
});

test("a failed candidate swap records rollback intent and restart restores old data", async (t) => {
  const current = await fixture(t);
  const failingMover = {
    async rename(source, destination) {
      if (
        path.basename(source) === "candidate" ||
        path.basename(source) === "rollback"
      ) {
        const error = new Error("simulated rename denial");
        error.code = "EACCES";
        throw error;
      }
      return rename(source, destination);
    },
  };
  await assert.rejects(
    current.createActivation({ atomicDirectoryMover: failingMover }).activate({
      backupId: current.backupId,
    }),
    hasCode("RESTORE_ACTIVATION_RECOVERY_REQUIRED"),
  );
  assert.equal(await exists(current.active), false);
  assert.equal(await exists(path.join(current.control, "rollback")), true);

  const recovery = await current.createActivation().recover();
  assert.equal(recovery.status, "rolled-back");
  assert.equal(JSON.stringify(recovery).includes(current.root), false);
  assert.equal(
    await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
    '{"revision":99}\n',
  );
  assert.equal(await exists(path.join(current.control, "rollback")), false);
  assert.equal(await exists(path.join(current.control, "candidate")), false);
});

test("real-path aliases and overlapping boundaries are rejected before mutation", async (t) => {
  const current = await fixture(t);
  const alias = path.join(current.root, "active-alias");
  await symlink(
    current.active,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliased = new OfflineRestoreActivationService({
    activeDirectory: alias,
    backupDirectory: current.backups,
    controlDirectory: path.join(current.root, ".alias-control"),
    backupService: current.restorer,
  });
  await assert.rejects(
    aliased.activate({ backupId: current.backupId }),
    hasCode("RESTORE_ACTIVATION_BOUNDARY_INVALID"),
  );
  const externalControl = path.join(current.root, "external-control");
  await mkdir(externalControl);
  await symlink(
    externalControl,
    current.control,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    current.createActivation().activate({ backupId: current.backupId }),
    hasCode("RESTORE_ACTIVATION_BOUNDARY_INVALID"),
  );
  assert.throws(
    () => new OfflineRestoreActivationService({
      activeDirectory: current.active,
      backupDirectory: current.backups,
      controlDirectory: path.join(current.active, ".control"),
      backupService: current.restorer,
    }),
    TypeError,
  );
});

test("every durable crash window is inferred and completed idempotently after restart", async (t) => {
  const stages = [
    "lock-acquired",
    "journal-prepared",
    "candidate-published",
    "candidate-ready",
    "active-renamed",
    "active-moved",
    "candidate-renamed",
    "candidate-activated",
    "receipt-persisted",
    "rollback-cleaned",
  ];
  for (const stage of stages) {
    await t.test(stage, async (child) => {
      const current = await fixture(child);
      await crashAt(current, stage);

      const receipt = await current.createActivation().activate({
        backupId: current.backupId,
      });
      assert.equal(receipt.status, "activated");
      assert.equal(
        await readFile(path.join(current.active, "state", "work-ledger.json"), "utf8"),
        '{"revision":1}\n',
      );
      assert.deepEqual((await readdir(current.control)).sort(), [
        "restore-activation-receipt.json",
      ]);
      assert.deepEqual(await current.createActivation().recover(), receipt);
    });
  }
});
