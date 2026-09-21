import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackupManifest } from "../src/domain/backup-manifest.js";
import {
  createTrustedRestoreMigration,
} from "../src/services/trusted-restore-migration.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function candidate(t, files) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "mydashboard-trusted-restore-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(directory, name), value, "utf8");
  }
  const facts = [];
  for (const name of (await readdir(directory)).sort()) {
    const bytes = await readFile(path.join(directory, name));
    facts.push({
      path: name,
      kind: "mutable",
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return {
    directory,
    manifest: createBackupManifest({
      createdAt: "2026-08-08T08:00:00.000Z",
      stores: [{ name: "fixture", revision: 0, digest: "0".repeat(64) }],
      files: facts,
    }),
  };
}

function trustedChain(candidateExtension, calls = []) {
  return createTrustedRestoreMigration({
    trustedRegistry: {
      async migrate() {
        calls.push("trusted");
      },
    },
    candidateExtension,
  });
}

test("a candidate extension may rewrite only an existing migratable owner", async (t) => {
  const fixture = await candidate(t, {
    "code-executor-state.json": "before\n",
    "schema-less-cache.json": "preserved\n",
  });
  const calls = [];
  const migration = trustedChain({
    async migrate({ directory }) {
      calls.push("extension");
      await writeFile(
        path.join(directory, "code-executor-state.json"),
        "after\n",
        "utf8",
      );
    },
  }, calls);

  await migration.migrate(fixture);

  assert.deepEqual(calls, ["trusted", "extension", "trusted"]);
  assert.equal(
    await readFile(
      path.join(fixture.directory, "code-executor-state.json"),
      "utf8",
    ),
    "after\n",
  );
  assert.equal(
    await readFile(
      path.join(fixture.directory, "schema-less-cache.json"),
      "utf8",
    ),
    "preserved\n",
  );
});

for (const [label, fileName] of [
  ["known owner", "code-executor-state.json"],
  ["unknown or retired state", "configured-role-retired-state.json"],
]) {
  test(`a candidate extension cannot delete ${label}`, async (t) => {
    const fixture = await candidate(t, {
      [fileName]: "preserved\n",
    });
    const calls = [];
    const migration = trustedChain({
      async migrate({ directory }) {
        calls.push("extension");
        await unlink(path.join(directory, fileName));
      },
    }, calls);

    await assert.rejects(
      migration.migrate(fixture),
      (error) => error?.code === "RESTORE_MIGRATION_EXTENSION_BOUNDARY",
    );
    assert.deepEqual(calls, ["trusted", "extension"]);
  });
}

test("a candidate extension cannot add an unowned future state", async (t) => {
  const fixture = await candidate(t, {
    "code-executor-state.json": "preserved\n",
  });
  const migration = trustedChain({
    async migrate({ directory }) {
      await writeFile(
        path.join(directory, "future-owner.json"),
        `${JSON.stringify({ schemaVersion: 999 })}\n`,
        "utf8",
      );
    },
  });

  await assert.rejects(
    migration.migrate(fixture),
    (error) => error?.code === "RESTORE_MIGRATION_EXTENSION_BOUNDARY",
  );
});

test("a candidate extension cannot rewrite immutable Code Job archive bytes", async (t) => {
  const archiveName = `code-job-tombstone-record-${"a".repeat(64)}.json`;
  const fixture = await candidate(t, {
    [archiveName]: "immutable-before\n",
  });
  const migration = trustedChain({
    async migrate({ directory }) {
      await writeFile(
        path.join(directory, archiveName),
        "self-consistent-but-different\n",
        "utf8",
      );
    },
  });

  await assert.rejects(
    migration.migrate(fixture),
    (error) => error?.code === "RESTORE_MIGRATION_EXTENSION_BOUNDARY",
  );
});

test("a candidate extension cannot replace the candidate directory identity", async (t) => {
  const fixture = await candidate(t, {
    "schema-less-cache.json": "preserved\n",
  });
  const displaced = `${fixture.directory}-displaced`;
  t.after(() => rm(displaced, { recursive: true, force: true }));
  const migration = trustedChain({
    async migrate({ directory }) {
      await rename(directory, displaced);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "schema-less-cache.json"),
        "preserved\n",
        "utf8",
      );
    },
  });

  await assert.rejects(
    migration.migrate(fixture),
    (error) => error?.code === "RESTORE_MIGRATION_EXTENSION_BOUNDARY",
  );
});
