import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodeExecutionJournal,
  CodeExecutionJournalError,
} from "../src/services/code-execution-journal.js";

async function fixture(t, options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "code-execution-journal-"));
  const root = path.join(parent, "journal");
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    parent,
    root,
    journal: new CodeExecutionJournal({ root, ...options }),
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof CodeExecutionJournalError && error.code === code;
}

test("journal writes deterministic JSON and returns a content-addressed reference", async (t) => {
  const { root, journal } = await fixture(t);

  const ref = await journal.writeJson({
    sessionId: "session-1",
    actionId: "action-1",
    kind: "input",
    value: { task: "review", count: 2 },
  });

  assert.deepEqual(Object.keys(ref).sort(), ["bytes", "path", "sha256"]);
  assert.equal(ref.path, "session-1/action-1/input.json");
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ref.bytes, Buffer.byteLength('{"task":"review","count":2}\n'));
  assert.deepEqual(
    await journal.readBytes(ref),
    Buffer.from('{"task":"review","count":2}\n'),
  );
  const mutableRef = { ...ref };
  const pendingRead = journal.readBytes(mutableRef);
  mutableRef.bytes = 1;
  mutableRef.sha256 = "0".repeat(64);
  assert.deepEqual(
    await pendingRead,
    Buffer.from('{"task":"review","count":2}\n'),
  );
  assert.deepEqual(await journal.readJson(ref), { task: "review", count: 2 });
  assert.equal(
    await readFile(path.join(root, "session-1", "action-1", "input.json"), "utf8"),
    '{"task":"review","count":2}\n',
  );
});

test("same target is idempotent but different content conflicts", async (t) => {
  const { journal } = await fixture(t);
  const action = {
    sessionId: "session-1",
    actionId: "action-1",
    kind: "manifest",
  };

  const first = await journal.writeJson({ ...action, value: { files: [] } });
  const repeated = await journal.writeJson({ ...action, value: { files: [] } });
  assert.deepEqual(repeated, first);
  await assert.rejects(
    journal.writeJson({ ...action, value: { files: ["src/app.js"] } }),
    hasCode("ARTIFACT_CONFLICT"),
  );
  assert.deepEqual(await journal.readJson(first), { files: [] });
});

test("stdout and stderr are stored as separate immutable JSON artifacts", async (t) => {
  const { journal } = await fixture(t);

  for (const kind of ["stdout", "stderr"]) {
    const ref = await journal.writeJson({
      sessionId: "session-1",
      actionId: "test-action",
      kind,
      value: `${kind} line\n`,
    });
    assert.equal(ref.path, `session-1/test-action/${kind}.json`);
    assert.equal(await journal.readJson(ref), `${kind} line\n`);
  }
});

test("ids, kinds, serialized size, and JSON values are bounded", async (t) => {
  const { journal } = await fixture(t, { maxArtifactBytes: 16 });
  const valid = {
    sessionId: "session-1",
    actionId: "action-1",
    kind: "output",
  };

  await assert.rejects(
    journal.writeJson({ ...valid, sessionId: "../session", value: null }),
    hasCode("INVALID_SESSION_ID"),
  );
  await assert.rejects(
    journal.writeJson({ ...valid, actionId: "Action", value: null }),
    hasCode("INVALID_ACTION_ID"),
  );
  await assert.rejects(
    journal.writeJson({ ...valid, kind: "log", value: null }),
    hasCode("INVALID_ARTIFACT_KIND"),
  );
  await assert.rejects(
    journal.writeJson({ ...valid, value: undefined }),
    hasCode("INVALID_ARTIFACT_VALUE"),
  );
  await assert.rejects(
    journal.writeJson({ ...valid, value: { content: "too large" } }),
    hasCode("ARTIFACT_TOO_LARGE"),
  );
});

test("readJson requires an exact safe reference", async (t) => {
  const { journal } = await fixture(t);
  const ref = await journal.writeJson({
    sessionId: "session-1",
    actionId: "action-1",
    kind: "input",
    value: { ok: true },
  });

  for (const invalid of [
    { ...ref, extra: true },
    { ...ref, path: "../input.json" },
    { ...ref, path: "session-1/action-1/log.json" },
    { ...ref, sha256: "0".repeat(63) },
    { ...ref, bytes: -1 },
  ]) {
    await assert.rejects(journal.readJson(invalid), hasCode("INVALID_ARTIFACT_REF"));
  }

  let getterCalls = 0;
  const accessor = { ...ref };
  Object.defineProperty(accessor, "path", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return ref.path;
    },
  });
  await assert.rejects(
    journal.readBytes(accessor),
    hasCode("INVALID_ARTIFACT_REF"),
  );
  assert.equal(getterCalls, 0);
});

test("a valid reference to a missing artifact has a stable not-found error", async (t) => {
  const { journal } = await fixture(t);

  await assert.rejects(
    journal.readJson({
      path: "session-1/action-1/input.json",
      sha256: "0".repeat(64),
      bytes: 1,
    }),
    hasCode("ARTIFACT_NOT_FOUND"),
  );
});

test("readBytes and readJson detect changed bytes, hashes, and invalid JSON", async (t) => {
  const { root, journal } = await fixture(t);
  const ref = await journal.writeJson({
    sessionId: "session-1",
    actionId: "action-1",
    kind: "output",
    value: { ok: true },
  });
  const target = path.join(root, ...ref.path.split("/"));

  await writeFile(target, '{"ok":false}\n');
  await assert.rejects(journal.readBytes(ref), hasCode("ARTIFACT_CORRUPTED"));
  await assert.rejects(journal.readJson(ref), hasCode("ARTIFACT_CORRUPTED"));

  const malformed = Buffer.from("not-json\n");
  const crypto = await import("node:crypto");
  await writeFile(target, malformed);
  const malformedRef = {
    ...ref,
    bytes: malformed.length,
    sha256: crypto.createHash("sha256").update(malformed).digest("hex"),
  };
  assert.deepEqual(await journal.readBytes(malformedRef), malformed);
  await assert.rejects(
    journal.readJson(malformedRef),
    hasCode("ARTIFACT_CORRUPTED"),
  );
});

test("root and artifact symlinks fail closed without exposing absolute paths", async (t) => {
  const { parent, root, journal } = await fixture(t);
  await mkdir(root, { recursive: true });
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  const linkedRoot = path.join(parent, "linked-root");
  try {
    await symlink(root, linkedRoot, "junction");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const linked = new CodeExecutionJournal({ root: linkedRoot });
  await assert.rejects(
    linked.writeJson({
      sessionId: "session-1",
      actionId: "action-1",
      kind: "input",
      value: null,
    }),
    (error) =>
      error.code === "ARTIFACT_STORAGE_UNSAFE" &&
      !error.message.includes(parent),
  );

  const ref = await journal.writeJson({
    sessionId: "session-2",
    actionId: "action-2",
    kind: "input",
    value: null,
  });
  const target = path.join(root, ...ref.path.split("/"));
  await rm(target);
  await symlink(outside, target, "junction");
  const targetStats = await lstat(target);
  assert.equal(targetStats.isSymbolicLink(), true);
  await assert.rejects(journal.readJson(ref), hasCode("ARTIFACT_CORRUPTED"));
});

test("configuration requires an absolute root and a positive byte limit", () => {
  assert.throws(
    () => new CodeExecutionJournal({ root: "relative/journal" }),
    hasCode("INVALID_JOURNAL_CONFIG"),
  );
  assert.throws(
    () => new CodeExecutionJournal({ root: path.resolve("journal"), maxArtifactBytes: 0 }),
    hasCode("INVALID_JOURNAL_CONFIG"),
  );
});
