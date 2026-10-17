import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackupManifest } from "../src/domain/backup-manifest.js";
import { DataDirectoryCheckpointService, dataVolumeCapacitySeverity } from "../src/services/data-directory-checkpoint-service.js";
import { OperationalQuiescenceGate } from "../src/services/operational-quiescence-gate.js";

test("a mostly used large volume stays ready with ample space while a nearly full volume remains critical", () => {
  assert.equal(dataVolumeCapacitySeverity(95.4, 42 * 1024 ** 3), "warning");
  assert.equal(dataVolumeCapacitySeverity(99, 10 * 1024 ** 3), "warning");
  assert.equal(dataVolumeCapacitySeverity(99, 9 * 1024 ** 3), "critical");
  assert.equal(dataVolumeCapacitySeverity(80, 200 * 1024 ** 3), "warning");
  assert.equal(dataVolumeCapacitySeverity(79, 200 * 1024 ** 3), null);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-checkpoint-"));
  const data = path.join(root, "data");
  await mkdir(path.join(data, "code-executor", "artifacts"), { recursive: true });
  await writeFile(
    path.join(data, "work-ledger.json"),
    `${JSON.stringify({ schemaVersion: 1, revision: 7, items: [] })}\n`,
  );
  await writeFile(
    path.join(data, "code-executor", "artifacts", "evidence.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data };
}

test("a drained checkpoint binds store revisions and every durable file", async (t) => {
  const { data } = await fixture(t);
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  const checkpoint = await service.enter();
  assert.match(checkpoint.token, /^quiescence-[a-f0-9]{64}$/u);
  assert.equal(gate.readStatus().mode, "closed");
  assert.deepEqual(checkpoint.stores, [{
    name: "work-ledger",
    revision: 7,
    digest: checkpoint.files.find(({ path: filePath }) =>
      filePath === "work-ledger.json").sha256,
  }]);
  assert.deepEqual(
    checkpoint.files.map(({ path: filePath, kind }) => [filePath, kind]),
    [
      ["code-executor/artifacts/evidence.bin", "immutable"],
      ["work-ledger.json", "mutable"],
    ],
  );
  await service.leave(checkpoint.token);
  assert.equal(gate.readStatus().mode, "open");
});

test("array-valued StateStore files remain revision-zero checkpoint stores", async (t) => {
  const { data } = await fixture(t);
  await writeFile(
    path.join(data, "pr-employee-memory.json"),
    `${JSON.stringify([{ id: "memory-1" }])}\n`,
  );
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  const checkpoint = await service.enter();
  const memoryFile = checkpoint.files.find(({ path: filePath }) =>
    filePath === "pr-employee-memory.json");
  assert.ok(memoryFile);
  assert.deepEqual(
    checkpoint.stores.find(({ name }) => name === "pr-employee-memory"),
    {
      name: "pr-employee-memory",
      revision: 0,
      digest: memoryFile.sha256,
    },
  );
  await service.leave(checkpoint.token);
});

test("checkpoint excludes declared regenerable validation caches", async (t) => {
  const { data } = await fixture(t);
  await mkdir(path.join(data, "playwright-browsers", ".links"), {
    recursive: true,
  });
  await writeFile(
    path.join(data, "playwright-browsers", ".links", "browser-cache.json"),
    "{}\n",
  );
  await mkdir(path.join(data, "validation-profile-probe", "runtime"), {
    recursive: true,
  });
  await writeFile(
    path.join(data, "validation-profile-probe", "runtime", "probe.json"),
    "{}\n",
  );
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  const checkpoint = await service.enter();
  assert.equal(
    checkpoint.files.some(({ path: filePath }) =>
      filePath.startsWith("playwright-browsers/") ||
      filePath.startsWith("validation-profile-probe/")),
    false,
  );
  assert.deepEqual(
    checkpoint.files.map(({ path: filePath }) => filePath),
    ["code-executor/artifacts/evidence.bin", "work-ledger.json"],
  );
  await service.leave(checkpoint.token);
});

test("scan failure automatically reopens admission and publishes no checkpoint", async (t) => {
  const { data } = await fixture(t);
  await writeFile(path.join(data, ".transient.tmp"), "unsafe");
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  await assert.rejects(() => service.enter(), { code: "CHECKPOINT_PATH_INVALID" });
  assert.equal(gate.readStatus().mode, "open");
});

test("checkpoint preserves dotfiles in declared executor workspace namespaces", async (t) => {
  const { data } = await fixture(t);
  const paths = [
    "code-executor/workspaces/oct-software/attempt-1/.clang-tidy",
    "code-executor/workspaces/oct-software/attempt-1/Scripts/Test/.gitattributes",
    `code-executor/workspaces/.test-library/${"a".repeat(64)}/test.mjs`,
    `code-executor/windows-tests/${"b".repeat(64)}/data/workspace/.github/workflows/test.yml`,
    `code-executor/windows-tests/${"b".repeat(64)}/data/resources/test-assets/.config/settings.json`,
  ];
  for (const relative of paths) {
    const target = path.join(data, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `contents of ${relative}\n`);
  }
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  const checkpoint = await service.enter();
  const manifest = createBackupManifest({
    createdAt: "2026-08-08T01:02:03.004Z",
    stores: checkpoint.stores,
    files: checkpoint.files,
  });

  for (const relative of paths) assert.ok(manifest.files.some((file) => file.path === relative));
  assert.deepEqual(await service.reconcile({ directory: data, manifest, mode: "read-only" }), {
    ready: true, blockers: [],
  });
  await service.leave(checkpoint.token);
});

test("executor namespaces do not permit hidden siblings or noncanonical paths", async (t) => {
  const { data } = await fixture(t);
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });
  const paths = [
    "code-executor/.unknown/file.txt",
    "code-executor/workspaces/.unknown/file.txt",
    "code-executor/workspaces/oct-software/.unknown/file.txt",
    `code-executor/workspaces/.test-library/${"a".repeat(64)}/unknown.mjs`,
    `code-executor/windows-tests/${"b".repeat(64)}/data/control/.unknown`,
    "code-executor/windows-tests/not-a-fingerprint/data/workspace/.gitignore",
    "code-executor/workspaces/oct-software/attempt-1/.cache/cafe\u0301.txt",
  ];
  for (const relative of paths) {
    const target = path.join(data, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "unsafe");
    await assert.rejects(() => service.enter(), { code: "CHECKPOINT_PATH_INVALID" });
    assert.equal(gate.readStatus().mode, "open");
    await rm(path.join(data, "code-executor"), { recursive: true });
  }
});

test("read-only restore reconciliation accepts exact payload and rejects drift", async (t) => {
  const { root, data } = await fixture(t);
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });
  const checkpoint = await service.enter();
  await service.leave(checkpoint.token);
  const manifest = createBackupManifest({
    createdAt: "2026-08-08T01:02:03.004Z",
    stores: checkpoint.stores,
    files: checkpoint.files,
  });
  assert.deepEqual(await service.reconcile({
    directory: data,
    manifest,
    mode: "read-only",
  }), { ready: true, blockers: [] });

  await writeFile(path.join(data, "work-ledger.json"), "{\"revision\":8}\n");
  assert.deepEqual(await service.reconcile({
    directory: data,
    manifest,
    mode: "read-only",
  }), {
    ready: false,
    blockers: ["CHECKPOINT_FILE_MISMATCH", "CHECKPOINT_STORE_MISMATCH"],
  });
  assert.ok(await readFile(path.join(root, "data", "work-ledger.json")));
});

test("checkpoint release detects crossing filesystem writes and safely reopens", async (t) => {
  const { data } = await fixture(t);
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });
  const checkpoint = await service.enter();

  await writeFile(
    path.join(data, "work-ledger.json"),
    `${JSON.stringify({ revision: 8, items: [{ id: "crossed" }] })}\n`,
  );

  await assert.rejects(() => service.leave(checkpoint.token), {
    code: "CHECKPOINT_SOURCE_CHANGED",
  });
  assert.deepEqual(gate.readStatus(), { mode: "open", activeOperations: 0 });
});

test("symlink and hardlink payload aliases fail closed", async (t) => {
  const { root, data } = await fixture(t);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside");
  const gate = new OperationalQuiescenceGate();
  const service = new DataDirectoryCheckpointService({ sourceDirectory: data, gate });

  const alias = path.join(data, "alias.txt");
  try {
    await symlink(outside, alias, "file");
    await assert.rejects(() => service.enter(), { code: "CHECKPOINT_PATH_INVALID" });
    await rm(alias, { force: true });
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
  }

  const hardlink = path.join(data, "hardlink.txt");
  await link(outside, hardlink);
  await assert.rejects(() => service.enter(), { code: "CHECKPOINT_FILE_INVALID" });
  assert.equal(gate.readStatus().mode, "open");
});
