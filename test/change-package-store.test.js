import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import {
  ChangePackageStore,
  ChangePackageStoreError,
} from "../src/services/change-package-store.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function draft(content = "export const answer = 42;\n") {
  const evidence = (kind) => ({
    path: `session-1/test-action/${kind}.json`,
    sha256: SHA_C,
    bytes: 12,
  });
  return {
    job: { id: "code-job-1", revision: 7, recordDigest: SHA_A },
    proposal: { id: "proposal-1", contentDigest: SHA_B },
    grant: { digest: SHA_C },
    workspace: {
      id: "workspace-1",
      sourceRevision: SHA_A,
      workspaceRevision: SHA_B,
    },
    passedProfiles: [
      {
        id: "node-tests",
        configDigest: SHA_C,
        workspaceRevision: SHA_B,
        actionId: "test-action",
        attemptNumber: 1,
        imageId: "sha256:node-test-image",
        artifacts: {
          output: evidence("output"),
          stdout: evidence("stdout"),
          stderr: evidence("stderr"),
        },
      },
    ],
    created: [{ path: "src/answer.js", content: Buffer.from(content) }],
    modified: [],
    deleted: [],
  };
}

function hasCode(code) {
  return (error) => error instanceof ChangePackageStoreError && error.code === code;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function controllableGuardFactory() {
  let held = false;
  let pause = null;
  return {
    pauseNext() {
      const entered = deferred();
      const release = deferred();
      pause = { entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    createGuard() {
      let acquired = false;
      return {
        async acquire() {
          if (held) throw Object.assign(new Error("held"), { code: "HELD" });
          held = true;
          acquired = true;
          const current = pause;
          pause = null;
          if (current) {
            current.entered.resolve();
            await current.release.promise;
          }
        },
        async close() {
          if (!acquired) return;
          acquired = false;
          held = false;
        },
      };
    },
  };
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-package-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return path.join(temporary, "packages");
}

test("producer and reader ports stay separate across restart", async (t) => {
  const root = await fixture(t);
  const first = new ChangePackageStore({ root });
  await first.recover();
  const producer = first.producer();
  const reader = first.reader();
  assert.deepEqual(Object.keys(producer), ["create"]);
  assert.deepEqual(Object.keys(reader), ["get", "readFile"]);
  assert.ok(Object.isFrozen(producer));
  assert.ok(Object.isFrozen(reader));

  const created = await producer.create(draft());
  assert.equal("root" in created, false);
  assert.deepEqual(await reader.get(created.packageId), created);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reader.get(created.packageId, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(await reader.get(created.packageId), created);
  assert.equal(
    (await reader.readFile({ packageId: created.packageId, path: "src/answer.js" })).toString(),
    "export const answer = 42;\n",
  );

  const restarted = new ChangePackageStore({ root });
  assert.deepEqual(await restarted.recover(), { packages: 1, blobs: 1 });
  assert.deepEqual(await restarted.reader().get(created.packageId), created);
});

test("same content is idempotent and different content never overwrites it", async (t) => {
  const root = await fixture(t);
  const store = new ChangePackageStore({ root });
  await store.recover();

  const first = await store.producer().create(draft());
  const repeated = await store.producer().create(draft());
  const changed = await store.producer().create(draft("export const answer = 43;\n"));

  assert.deepEqual(repeated, first);
  assert.notEqual(changed.packageId, first.packageId);
  assert.equal(
    (await store.reader().readFile({ packageId: first.packageId, path: "src/answer.js" })).toString(),
    "export const answer = 42;\n",
  );
});

test("recovery validates manifest, blob hashes, and cross references", async (t) => {
  await t.test("changed blob", async () => {
    const root = await fixture(t);
    const store = new ChangePackageStore({ root });
    await store.recover();
    const manifest = await store.producer().create(draft());
    const blob = manifest.changes.created[0].blob;
    await writeFile(path.join(root, "blobs", `${blob.sha256}.blob`), "tampered");
    await assert.rejects(
      new ChangePackageStore({ root }).recover(),
      hasCode("CHANGE_PACKAGE_CORRUPTED"),
    );
  });

  await t.test("changed manifest", async () => {
    const root = await fixture(t);
    const store = new ChangePackageStore({ root });
    await store.recover();
    const manifest = await store.producer().create(draft());
    const target = path.join(root, "packages", `${manifest.packageId}.json`);
    const value = JSON.parse(await readFile(target, "utf8"));
    value.workspace.workspaceRevision = SHA_A;
    await writeFile(target, JSON.stringify(value));
    await assert.rejects(
      new ChangePackageStore({ root }).recover(),
      hasCode("CHANGE_PACKAGE_CORRUPTED"),
    );
  });

  await t.test("missing referenced blob", async () => {
    const root = await fixture(t);
    const store = new ChangePackageStore({ root });
    await store.recover();
    const manifest = await store.producer().create(draft());
    const blob = manifest.changes.created[0].blob;
    await rm(path.join(root, "blobs", `${blob.sha256}.blob`));
    await assert.rejects(
      new ChangePackageStore({ root }).recover(),
      hasCode("CHANGE_PACKAGE_CORRUPTED"),
    );
  });

  await t.test("orphaned blob from an interrupted create", async () => {
    const root = await fixture(t);
    const store = new ChangePackageStore({ root });
    await store.recover();
    const manifest = await store.producer().create(draft());
    const blob = manifest.changes.created[0].blob;
    await rm(path.join(root, "packages", `${manifest.packageId}.json`));

    const restarted = new ChangePackageStore({ root });
    assert.deepEqual(await restarted.recover(), { packages: 0, blobs: 0 });
    await assert.rejects(
      readFile(path.join(root, "blobs", `${blob.sha256}.blob`)),
      (error) => error?.code === "ENOENT",
    );
  });

  await t.test("linked blob", async (subtest) => {
    const root = await fixture(subtest);
    const store = new ChangePackageStore({ root });
    await store.recover();
    const manifest = await store.producer().create(draft());
    const blob = manifest.changes.created[0].blob;
    const target = path.join(root, "blobs", `${blob.sha256}.blob`);
    const outside = path.join(path.dirname(root), "outside.blob");
    await writeFile(outside, Buffer.from("outside"));
    await rm(target);
    try {
      await symlink(outside, target, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        subtest.skip("symlink creation is unavailable on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(
      new ChangePackageStore({ root }).recover(),
      hasCode("CHANGE_PACKAGE_CORRUPTED"),
    );
  });
});

test("the store stays closed until successful recovery and hides storage paths", async (t) => {
  const root = await fixture(t);
  const store = new ChangePackageStore({ root });
  const expected = createChangePackage(draft()).manifest;
  await assert.rejects(store.producer().create(draft()), hasCode("CHANGE_PACKAGE_STORE_NOT_READY"));
  await assert.rejects(store.reader().get(expected.packageId), hasCode("CHANGE_PACKAGE_STORE_NOT_READY"));
  await store.recover();
  const created = await store.producer().create(draft());
  assert.equal(JSON.stringify(created).includes(root), false);
});

test("create snapshots caller input before asynchronous persistence", async (t) => {
  const root = await fixture(t);
  const store = new ChangePackageStore({ root });
  await store.recover();
  const input = draft("original\n");
  const pending = store.producer().create(input);
  input.created[0].content.fill("x".charCodeAt(0));

  const created = await pending;
  assert.equal(
    (await store.reader().readFile({
      packageId: created.packageId,
      path: "src/answer.js",
    })).toString(),
    "original\n",
  );
});

test("empty blobs and boundary-sized manifests survive restart", async (t) => {
  const root = await fixture(t);
  const input = draft("");
  const expected = createChangePackage(input).manifest;
  const limits = {
    maxManifestBytes: Buffer.byteLength(
      `${JSON.stringify(expected)}\n`,
      "utf8",
    ),
  };
  const store = new ChangePackageStore({ root, limits });
  await store.recover();
  const created = await store.producer().create(input);
  assert.equal((await store.reader().readFile({
    packageId: created.packageId,
    path: "src/answer.js",
  })).length, 0);

  const restarted = new ChangePackageStore({ root, limits });
  assert.deepEqual(await restarted.recover(), { packages: 1, blobs: 1 });
  assert.deepEqual(await restarted.reader().get(created.packageId), created);
});

test("a second process cannot recover through an in-flight create", async (t) => {
  const root = await fixture(t);
  const guards = controllableGuardFactory();
  const options = { root, createGuard: guards.createGuard };
  const writer = new ChangePackageStore(options);
  const recovering = new ChangePackageStore(options);
  await writer.recover();
  await recovering.recover();

  const paused = guards.pauseNext();
  const creating = writer.producer().create(draft());
  await paused.entered;
  await assert.rejects(
    recovering.recover(),
    hasCode("CHANGE_PACKAGE_STORE_BUSY"),
  );
  paused.release();
  const created = await creating;

  assert.deepEqual(await recovering.recover(), { packages: 1, blobs: 1 });
  assert.deepEqual(await recovering.reader().get(created.packageId), created);
});
