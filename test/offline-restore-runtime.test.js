import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackupManifest } from "../src/domain/backup-manifest.js";
import { createOfflineRestoreRuntime } from "../src/offline-restore-runtime.js";

const root = path.resolve("test-offline-restore-root");

function factories(calls) {
  const gate = {
    async run(operation) { return operation(); },
    async enter() {},
    async leave() {},
    readStatus() { return { mode: "open", activeOperations: 0 }; },
  };
  return {
    quiescenceGateFactory() {
      calls.gate += 1;
      return gate;
    },
    checkpointServiceFactory(options) {
      calls.checkpoint = options;
      return {
        async enter() {},
        async leave() {},
        async capture() { return { stores: [], files: [] }; },
        async reconcile() { return { ready: true, blockers: [] }; },
      };
    },
    operationQueueFactory() {
      return { enqueue: (operation) => Promise.resolve().then(operation) };
    },
    backupServiceFactory(options) {
      calls.backup = options;
      return {
        async restore() {},
        async listBackups() { return { items: [], incompleteCount: 0 }; },
      };
    },
    activationServiceFactory(options) {
      calls.activation = options;
      return {
        async recover() {
          calls.order.push("recover");
          return null;
        },
        async activate(request) {
          calls.order.push("activate");
          return { status: "activated", backupId: request.backupId };
        },
      };
    },
  };
}

test("offline runtime brackets its candidate extension with the trusted registry", async (t) => {
  const calls = { gate: 0, order: [], migrationOrder: [] };
  const candidate = await mkdtemp(
    path.join(os.tmpdir(), "mydashboard-offline-runtime-"),
  );
  t.after(() => rm(candidate, { recursive: true, force: true }));
  const ownerName = "code-executor-state.json";
  const legacyBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
    "utf8",
  );
  await writeFile(path.join(candidate, ownerName), legacyBytes);
  const manifest = createBackupManifest({
    createdAt: "2026-08-08T08:00:00.000Z",
    stores: [{ name: "fixture", revision: 0, digest: "0".repeat(64) }],
    files: [{
      path: ownerName,
      kind: "mutable",
      bytes: legacyBytes.length,
      sha256: createHash("sha256").update(legacyBytes).digest("hex"),
    }],
  });
  const migration = {
    async migrate({ directory }) {
      calls.migrationOrder.push(JSON.parse(
        await readFile(path.join(directory, ownerName), "utf8"),
      ).schemaVersion);
      await writeFile(path.join(directory, ownerName), legacyBytes);
    },
  };
  const runtime = createOfflineRestoreRuntime(
    {
      activeDirectory: path.join(root, "data"),
      backupDirectory: path.join(root, "backups"),
      controlDirectory: path.join(root, "restore-control"),
      migration,
    },
    {
      ...factories(calls),
    },
  );

  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "activate",
    "listBackups",
    "recover",
  ]);
  assert.equal(calls.gate, 1);
  assert.equal(calls.checkpoint.sourceDirectory, path.join(root, "data"));
  assert.deepEqual(Object.keys(calls.checkpoint.gate).sort(), [
    "enter",
    "leave",
    "readStatus",
    "run",
  ]);
  assert.equal(typeof calls.backup.migration.migrate, "function");
  assert.equal(Object.isFrozen(calls.backup.migration), true);
  assert.deepEqual(Object.keys(calls.activation.backupService).sort(), [
    "listBackups",
    "restore",
  ]);

  await calls.backup.migration.migrate({
    directory: candidate,
    manifest,
  });
  assert.deepEqual(calls.migrationOrder, [2]);
  assert.equal(
    JSON.parse(await readFile(path.join(candidate, ownerName), "utf8"))
      .schemaVersion,
    2,
  );

  const result = await runtime.activate({ backupId: `backup-${"a".repeat(64)}` });
  assert.deepEqual(calls.order, ["recover", "activate"]);
  assert.deepEqual(result, {
    status: "activated",
    backupId: `backup-${"a".repeat(64)}`,
  });
});

test("offline runtime rejects active options and invalid factory ports", () => {
  const active = {};
  Object.defineProperty(active, "activeDirectory", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => createOfflineRestoreRuntime(active),
    /plain data record/u,
  );
  assert.throws(
    () => createOfflineRestoreRuntime({
      activeDirectory: path.join(root, "data"),
      backupDirectory: path.join(root, "backups"),
      controlDirectory: path.join(root, "restore-control"),
    }, {
      operationQueueFactory: () => ({}),
    }),
    /offline backup operation queue is invalid/u,
  );
  assert.throws(
    () => createOfflineRestoreRuntime({
      activeDirectory: path.join(root, "data"),
      backupDirectory: path.join(root, "backups"),
      controlDirectory: path.join(root, "restore-control"),
    }, {
      testRestoreMigrationRegistryFactory: () => ({
        async migrate() {},
      }),
    }),
    /plain data record/u,
  );
});
