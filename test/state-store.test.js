import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/lib/state-store.js";

const realFileSystem = { mkdir, readFile, readdir, rename, rm, writeFile };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "state-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fileError(code) {
  return Object.assign(new Error(`simulated ${code}`), {
    code,
    errno: -4048,
    syscall: "rename",
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("write retries a transient atomic replace without exposing temporary files", async (t) => {
  const root = await fixture(t);
  const delays = [];
  let renameAttempts = 0;
  const store = new StateStore(root, {
    fileSystem: {
      ...realFileSystem,
      async rename(source, target) {
        renameAttempts += 1;
        if (renameAttempts < 3) throw fileError("EPERM");
        return rename(source, target);
      },
    },
    wait: async (milliseconds) => delays.push(milliseconds),
  });

  await store.write("runtime", { revision: 1 });

  assert.equal(renameAttempts, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(await store.read("runtime"), { revision: 1 });
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("write preserves the original rename error and removes an abandoned temporary file", async (t) => {
  const root = await fixture(t);
  const original = new StateStore(root);
  await original.write("runtime", { revision: 1 });
  const failure = fileError("EPERM");
  const delays = [];
  let renameAttempts = 0;
  const store = new StateStore(root, {
    fileSystem: {
      ...realFileSystem,
      async rename() {
        renameAttempts += 1;
        throw failure;
      },
    },
    wait: async (milliseconds) => delays.push(milliseconds),
  });

  await assert.rejects(store.write("runtime", { revision: 2 }), (error) => {
    assert.equal(error, failure);
    return true;
  });

  assert.equal(renameAttempts, 6);
  assert.deepEqual(delays, [5, 10, 20, 40, 80]);
  assert.deepEqual(await original.read("runtime"), { revision: 1 });
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("a same-key write waits for an active read before replacing its state", async (t) => {
  const root = await fixture(t);
  await new StateStore(root).write("runtime", { revision: 1 });
  const readStarted = deferred();
  const releaseRead = deferred();
  let blockNextRead = true;
  let writeStarted = false;
  let renameAttempts = 0;
  const store = new StateStore(root, {
    fileSystem: {
      ...realFileSystem,
      async mkdir(...arguments_) {
        writeStarted = true;
        return mkdir(...arguments_);
      },
      async readFile(...arguments_) {
        if (blockNextRead) {
          blockNextRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return readFile(...arguments_);
      },
      async rename(...arguments_) {
        renameAttempts += 1;
        return rename(...arguments_);
      },
    },
  });

  const reading = store.read("runtime");
  await readStarted.promise;
  const writing = store.write("runtime", { revision: 2 });
  try {
    assert.equal(writeStarted, false);
    assert.equal(renameAttempts, 0);
  } finally {
    releaseRead.resolve();
  }

  assert.deepEqual(await reading, { revision: 1 });
  await writing;
  assert.equal(writeStarted, true);
  assert.equal(renameAttempts, 1);
  assert.deepEqual(await store.read("runtime"), { revision: 2 });
});

test("versioned reads report exact content changes without reparsing unchanged state", async (t) => {
  const root = await fixture(t);
  let readCalls = 0;
  const store = new StateStore(root, {
    fileSystem: {
      ...realFileSystem,
      async readFile(...arguments_) {
        readCalls += 1;
        return readFile(...arguments_);
      },
    },
  });

  const missing = await store.readVersioned("runtime");
  const writtenVersion = await store.write("runtime", { revision: 1 });
  const first = await store.readVersioned("runtime");
  const unchanged = await store.readVersioned("runtime", null, {
    ifVersion: first.version,
  });

  assert.equal(first.changed, true);
  assert.notEqual(writtenVersion, missing.version);
  assert.equal(first.version, writtenVersion);
  assert.deepEqual(first.value, { revision: 1 });
  assert.deepEqual(unchanged, {
    changed: false,
    version: first.version,
  });
  assert.equal(readCalls, 3);

  await writeFile(
    path.join(root, "runtime.json"),
    '{"revision":1,"source":"external"}\n',
    "utf8",
  );
  const changed = await store.readVersioned("runtime", null, {
    ifVersion: first.version,
  });

  assert.equal(changed.changed, true);
  assert.notEqual(changed.version, first.version);
  assert.deepEqual(changed.value, { revision: 1, source: "external" });
});

test("versioned reads never hide invalid replacement content", async (t) => {
  const root = await fixture(t);
  const store = new StateStore(root);
  await store.write("runtime", { revision: 1 });
  const first = await store.readVersioned("runtime");
  await writeFile(path.join(root, "runtime.json"), "{invalid\n", "utf8");

  await assert.rejects(
    store.readVersioned("runtime", null, { ifVersion: first.version }),
    SyntaxError,
  );
});
