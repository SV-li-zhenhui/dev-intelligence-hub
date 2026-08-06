import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { workspaceRevisionFromFileHashes } from "../src/domain/workspace-revision.js";
import { ChangePackageApplicationService } from "../src/services/change-package-application-service.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "f".repeat(40);
const AUTHORITY = "e".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryStore {
  constructor(value = undefined) {
    this.value = clone(value);
    this.writes = [];
    this.failure = null;
    this.onWrite = null;
  }

  async read(_name, fallback) {
    return clone(this.value ?? fallback);
  }

  async write(_name, value) {
    const next = clone(value);
    const status = next.applications.at(-1)?.status;
    const failure = this.failure?.status === status ? this.failure : null;
    if (!failure || failure.commitBeforeThrow) this.value = next;
    this.writes.push(next);
    if (this.onWrite) await this.onWrite(next);
    if (failure) {
      this.failure = null;
      throw Object.assign(new Error("simulated state acknowledgement loss"), {
        code: "SIMULATED_STATE_ACK_LOSS",
      });
    }
    this.value = next;
  }
}

function queueEnvelope(plan, execution = {}) {
  const queued = normalizeConfirmationPlan(plan);
  return {
    schemaVersion: 1,
    id: queued.id,
    idempotencyKey: `confirmation-${queued.approvalBindingDigest}`,
    kind: queued.kind,
    requestedBy: queued.requestedBy,
    actor: queued.actor,
    target: queued.target,
    action: queued.action,
    displayedPayloadDigest: queued.displayedPayloadDigest,
    approvalBindingDigest: queued.approvalBindingDigest,
    execution: {
      requestId: "application-request-0001",
      attempt: 1,
      startedAt: "2026-08-02T03:00:00.000Z",
      ...execution,
    },
  };
}

async function fileValue(root, relativePath) {
  try {
    return await readFile(path.join(root, ...relativePath.split("/")), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readerFor(prepared) {
  const blobs = new Map(
    prepared.blobs.map((blob) => [blob.sha256, Buffer.from(blob.content)]),
  );
  const reader = {
    readFileCalls: [],
    async get(packageId) {
      if (packageId !== prepared.manifest.packageId) {
        throw Object.assign(new Error("not found"), {
          code: "CHANGE_PACKAGE_NOT_FOUND",
        });
      }
      return clone(prepared.manifest);
    },
    async readFile({ packageId, path: relativePath }) {
      reader.readFileCalls.push({ packageId, path: relativePath });
      assert.equal(packageId, prepared.manifest.packageId);
      const entry = [
        ...prepared.manifest.changes.created,
        ...prepared.manifest.changes.modified,
      ].find((candidate) => candidate.path === relativePath);
      return Buffer.from(blobs.get(entry.blob.sha256));
    },
  };
  return reader;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "change-package-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  const beforeApp = Buffer.from("before\n");
  const afterApp = Buffer.from("after\n");
  const oldFile = Buffer.from("old\n");
  const newFile = Buffer.from("new\n");
  const readme = Buffer.from("readme\n");
  await writeFile(path.join(root, "src", "app.js"), beforeApp);
  await writeFile(path.join(root, "src", "old.js"), oldFile);
  await writeFile(path.join(root, "README.md"), readme);

  const sourceRevision = workspaceRevisionFromFileHashes([
    ["README.md", sha256(readme)],
    ["src/app.js", sha256(beforeApp)],
    ["src/old.js", sha256(oldFile)],
  ]);
  const workspaceRevision = workspaceRevisionFromFileHashes([
    ["README.md", sha256(readme)],
    ["src/app.js", sha256(afterApp)],
    ["src/new.js", sha256(newFile)],
  ]);
  const prepared = createChangePackage({
    job: { id: "code-job-1", revision: 7, recordDigest: "a".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "b".repeat(64) },
    grant: { digest: "c".repeat(64) },
    workspace: { id: "workspace-1", sourceRevision, workspaceRevision },
    passedProfiles: [
      {
        id: "node-tests",
        configDigest: "d".repeat(64),
        workspaceRevision,
        actionId: "test-action",
        attemptNumber: 1,
        imageId: "sha256:test-image",
        artifacts: {
          output: { path: "evidence/output.json", sha256: "d".repeat(64), bytes: 1 },
          stdout: { path: "evidence/stdout.txt", sha256: "d".repeat(64), bytes: 1 },
          stderr: { path: "evidence/stderr.txt", sha256: "d".repeat(64), bytes: 1 },
        },
      },
    ],
    created: [{ path: "src/new.js", content: newFile }],
    modified: [
      {
        path: "src/app.js",
        beforeSha256: sha256(beforeApp),
        content: afterApp,
      },
    ],
    deleted: [{ path: "src/old.js", beforeSha256: sha256(oldFile) }],
  });
  const packageReader = readerFor(prepared);
  const git = { headOid: HEAD, clean: true };
  const gitInspector = {
    async inspect({ sourceRoot }) {
      assert.equal(sourceRoot, path.resolve(root));
      return { headOid: git.headOid, clean: git.clean };
    },
  };
  const store = new MemoryStore();
  const target = {
    workspaceId: "workspace-1",
    sourceRoot: root,
    targetAuthorityDigest: AUTHORITY,
    writablePaths: ["src"],
    excludePaths: [],
  };
  const authorityCalls = [];
  const applicationAuthorityVerifier = {
    async verify(manifest) {
      authorityCalls.push(clone(manifest));
      return true;
    },
  };
  const createService = (overrides = {}) =>
    new ChangePackageApplicationService({
      packageReader,
      trustedTargets: [target],
      gitInspector,
      store,
      exclusiveLease: { run: (operation) => operation() },
      applicationAuthorityVerifier,
      clock: () => new Date("2026-08-02T03:00:00.000Z"),
      ...overrides,
    });
  const requestedBy = { roleId: "developer", workItemId: "work-1" };
  return {
    root,
    prepared,
    packageReader,
    git,
    gitInspector,
    store,
    target,
    authorityCalls,
    createService,
    requestedBy,
    beforeApp,
    afterApp,
    oldFile,
    newFile,
    readme,
  };
}

function alternatePackage(setup, { created, modified = [], deleted = [], postFiles }) {
  const workspaceRevision = workspaceRevisionFromFileHashes(
    postFiles.map(([relativePath, content]) => [relativePath, sha256(content)]),
  );
  return createChangePackage({
    job: setup.prepared.manifest.job,
    proposal: setup.prepared.manifest.proposal,
    grant: setup.prepared.manifest.grant,
    workspace: {
      id: "workspace-1",
      sourceRevision: setup.prepared.manifest.workspace.sourceRevision,
      workspaceRevision,
    },
    passedProfiles: [
      {
        ...setup.prepared.manifest.passedProfiles[0],
        workspaceRevision,
      },
    ],
    created,
    modified,
    deleted,
  });
}

test("persists intent before applying a package and recovers one stable receipt", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const envelope = queueEnvelope(plan);
  const snapshots = [];
  setup.store.onWrite = async (state) => {
    snapshots.push({
      status: state.applications.at(-1)?.status,
      app: await fileValue(setup.root, "src/app.js"),
      old: await fileValue(setup.root, "src/old.js"),
      created: await fileValue(setup.root, "src/new.js"),
    });
  };

  const applied = await service.execute(envelope);
  assert.equal(applied.status, "applied");
  assert.match(applied.receipt.id, /^change-package-application-[a-f0-9]{64}$/);
  assert.equal(applied.receipt.createdAt, "2026-08-02T03:00:00.000Z");
  assert.deepEqual(snapshots[0], {
    status: "intent",
    app: "before\n",
    old: "old\n",
    created: null,
  });
  assert.equal(await fileValue(setup.root, "src/app.js"), "after\n");
  assert.equal(await fileValue(setup.root, "src/old.js"), null);
  assert.equal(await fileValue(setup.root, "src/new.js"), "new\n");

  const readsBeforeRetry = setup.packageReader.readFileCalls.length;
  assert.deepEqual(await service.execute(envelope), {
    status: "already",
    receipt: applied.receipt,
  });
  assert.equal(setup.packageReader.readFileCalls.length, readsBeforeRetry);
  const restarted = setup.createService();
  await restarted.recover();
  assert.deepEqual(await restarted.reconcile(envelope), {
    status: "already",
    receipt: applied.receipt,
  });
  assert.deepEqual(await restarted.getResult(envelope.id), {
    confirmationId: envelope.id,
    status: "applied",
    packageId: setup.prepared.manifest.packageId,
    workspaceId: "workspace-1",
    receipt: applied.receipt,
  });
});

test("stale source authority blocks confirmation and execution before intent", async (t) => {
  const setup = await fixture(t);
  const producer = setup.createService();
  await producer.recover();
  const plan = await producer.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const authorityCalls = [];
  const stale = setup.createService({
    applicationAuthorityVerifier: {
      async verify(manifest) {
        authorityCalls.push(clone(manifest));
        throw new Error("legacy PR source authority");
      },
    },
  });
  await stale.recover();

  await assert.rejects(
    stale.prepareConfirmation({
      packageId: setup.prepared.manifest.packageId,
      requestedBy: setup.requestedBy,
    }),
    (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STALE",
  );
  const writesBeforeExecute = setup.store.writes.length;
  assert.deepEqual(await stale.execute(queueEnvelope(plan)), { status: "stale" });
  assert.equal(setup.store.writes.length, writesBeforeExecute);
  assert.equal(await fileValue(setup.root, "src/app.js"), "before\n");
  assert.equal(authorityCalls.length, 2);
});

test("exposes separate least-authority producer, executor, and result ports", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  assert.deepEqual(Object.keys(service.producer()), ["prepareConfirmation"]);
  assert.deepEqual(Object.keys(service.executor()), ["execute", "reconcile"]);
  assert.deepEqual(Object.keys(service.reader()), ["getResult"]);
  assert.equal(Object.isFrozen(service.producer()), true);
  assert.equal(Object.isFrozen(service.executor()), true);
  assert.equal(Object.isFrozen(service.reader()), true);
});

test("changed Head, dirty state, and file conflicts are stale before intent", async (t) => {
  for (const conflict of ["head", "dirty", "modified", "created", "directory"]) {
    await t.test(conflict, async (child) => {
      const setup = await fixture(child);
      const service = setup.createService();
      await service.recover();
      const plan = await service.prepareConfirmation({
        packageId: setup.prepared.manifest.packageId,
        requestedBy: setup.requestedBy,
      });
      if (conflict === "head") setup.git.headOid = OTHER_HEAD;
      if (conflict === "dirty") setup.git.clean = false;
      if (conflict === "modified") {
        await writeFile(path.join(setup.root, "src", "app.js"), "external\n");
      }
      if (conflict === "created") {
        await writeFile(path.join(setup.root, "src", "new.js"), "external\n");
      }
      if (conflict === "directory") {
        await mkdir(path.join(setup.root, "src", "new.js"));
      }

      assert.deepEqual(await service.execute(queueEnvelope(plan)), {
        status: "stale",
      });
      assert.equal(setup.store.writes.length, 0);
      assert.equal(await fileValue(setup.root, "src/old.js"), "old\n");
    });
  }
});

test("rejects unsafe post-image capacity and file topology before intent", async (t) => {
  await t.test("post-image capacity", async (child) => {
    const setup = await fixture(child);
    const large = Buffer.alloc(32, 0x78);
    const prepared = alternatePackage(setup, {
      created: [{ path: "src/large.bin", content: large }],
      modified: [],
      deleted: [],
      postFiles: [
        ["README.md", setup.readme],
        ["src/app.js", setup.beforeApp],
        ["src/old.js", setup.oldFile],
        ["src/large.bin", large],
      ],
    });
    const service = setup.createService({
      packageReader: readerFor(prepared),
      limits: { maxFiles: 10, maxFileBytes: 64, maxTotalBytes: 32 },
    });
    await service.recover();

    await assert.rejects(
      service.prepareConfirmation({
        packageId: prepared.manifest.packageId,
        requestedBy: setup.requestedBy,
      }),
      (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STALE",
    );
    assert.equal(setup.store.writes.length, 0);
    assert.equal(await fileValue(setup.root, "src/large.bin"), null);
  });

  await t.test("ancestor output collision", async (child) => {
    const setup = await fixture(child);
    const parent = Buffer.from("parent\n");
    const childFile = Buffer.from("child\n");
    const prepared = alternatePackage(setup, {
      created: [
        { path: "src/tree", content: parent },
        { path: "src/tree/child.js", content: childFile },
      ],
      postFiles: [
        ["README.md", setup.readme],
        ["src/app.js", setup.beforeApp],
        ["src/old.js", setup.oldFile],
        ["src/tree", parent],
        ["src/tree/child.js", childFile],
      ],
    });
    const service = setup.createService({ packageReader: readerFor(prepared) });
    await service.recover();

    await assert.rejects(
      service.prepareConfirmation({
        packageId: prepared.manifest.packageId,
        requestedBy: setup.requestedBy,
      }),
      (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STALE",
    );
    assert.equal(setup.store.writes.length, 0);
    assert.equal(await fileValue(setup.root, "src/tree"), null);
  });
});

test("pre-intent dependency outages remain proven absent and retryable", async (t) => {
  const setup = await fixture(t);
  const producer = setup.createService();
  await producer.recover();
  const plan = await producer.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const unavailable = setup.createService({
    packageReader: {
      async get() {
        throw Object.assign(new Error("temporary outage"), {
          code: "PACKAGE_READER_UNAVAILABLE",
        });
      },
      async readFile() {
        throw new Error("must not be called");
      },
    },
  });
  await unavailable.recover();

  assert.deepEqual(await unavailable.execute(queueEnvelope(plan)), {
    status: "absent",
    code: "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE",
  });
  assert.equal(setup.store.writes.length, 0);
  assert.equal(await fileValue(setup.root, "src/app.js"), "before\n");
});

test("an acknowledged intent with no mutation is safely retryable", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const first = queueEnvelope(plan);
  setup.store.failure = { status: "intent", commitBeforeThrow: true };

  assert.deepEqual(await service.execute(first), {
    status: "absent",
    code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
  });
  assert.equal(await fileValue(setup.root, "src/app.js"), "before\n");

  const retry = queueEnvelope(plan, {
    requestId: "application-request-0002",
    attempt: 2,
    startedAt: "2026-08-02T03:01:00.000Z",
  });
  const applied = await service.execute(retry);
  assert.equal(applied.status, "applied");
  assert.equal(await fileValue(setup.root, "src/app.js"), "after\n");
});

test("an applied-state write failure reconciles without a second apply", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const envelope = queueEnvelope(plan);
  setup.store.failure = { status: "applied", commitBeforeThrow: false };

  assert.deepEqual(await service.execute(envelope), {
    status: "error",
    error: {
      trust: "unknown",
      code: "CHANGE_PACKAGE_APPLICATION_OUTCOME_UNKNOWN",
    },
  });
  assert.equal(await fileValue(setup.root, "src/app.js"), "after\n");

  let authorityCalls = 0;
  const restarted = setup.createService({
    applicationAuthorityVerifier: {
      async verify() {
        authorityCalls += 1;
        throw new Error("legacy PR source authority");
      },
    },
  });
  await restarted.recover();
  const reconciled = await restarted.reconcile(envelope);
  assert.equal(reconciled.status, "already");
  assert.equal(authorityCalls, 0);
  assert.equal(await fileValue(setup.root, "src/app.js"), "after\n");
});

test("committed applied-state acknowledgement loss returns the durable receipt", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const envelope = queueEnvelope(plan);
  setup.store.failure = { status: "applied", commitBeforeThrow: true };

  const applied = await service.execute(envelope);
  assert.equal(applied.status, "applied");
  assert.match(applied.receipt.id, /^change-package-application-[a-f0-9]{64}$/);
  assert.equal(setup.store.value.applications[0].status, "applied");

  const restarted = setup.createService();
  await restarted.recover();
  assert.deepEqual(await restarted.reconcile(envelope), {
    status: "already",
    receipt: applied.receipt,
  });
});

test("intent reconciliation outages do not create a permanent fence", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const envelope = queueEnvelope(plan);
  setup.store.failure = { status: "intent", commitBeforeThrow: true };
  await service.execute(envelope);

  const unavailable = setup.createService({
    packageReader: {
      async get() {
        throw new Error("temporary package outage");
      },
      async readFile() {
        throw new Error("must not be called");
      },
    },
  });
  await unavailable.recover();
  assert.equal((await unavailable.reconcile(envelope)).status, "error");
  assert.equal(setup.store.value.applications[0].status, "intent");

  assert.deepEqual(await service.reconcile(envelope), {
    status: "absent",
    code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
  });
  assert.equal(setup.store.value.applications[0].status, "intent");
});

test("a mixed checkout is permanently fenced and never completed blindly", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const envelope = queueEnvelope(plan);
  setup.store.failure = { status: "intent", commitBeforeThrow: true };
  await service.execute(envelope);
  await writeFile(path.join(setup.root, "src", "app.js"), setup.afterApp);

  const restarted = setup.createService();
  await restarted.recover();
  assert.deepEqual(await restarted.reconcile(envelope), {
    status: "error",
    error: {
      trust: "unknown",
      code: "CHANGE_PACKAGE_APPLICATION_MIXED_STATE",
    },
  });
  assert.equal(await fileValue(setup.root, "src/old.js"), "old\n");
  assert.equal(await fileValue(setup.root, "src/new.js"), null);
  assert.equal((await restarted.getResult(envelope.id)).status, "unknown");

  const readsBeforeRetry = setup.packageReader.readFileCalls.length;
  assert.equal((await restarted.execute(envelope)).status, "error");
  assert.equal(setup.packageReader.readFileCalls.length, readsBeforeRetry);

  await unlink(path.join(setup.root, "src", "old.js"));
  await writeFile(path.join(setup.root, "src", "new.js"), "new\n");
  assert.equal((await restarted.reconcile(envelope)).status, "error");
});

test("a fully re-signed forged package binding is rejected before intent", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await service.recover();
  const plan = await service.prepareConfirmation({
    packageId: setup.prepared.manifest.packageId,
    requestedBy: setup.requestedBy,
  });
  const original = queueEnvelope(plan);
  const action = { ...original.action, changeSetDigest: "9".repeat(64) };
  const id = `confirmation-change-package-apply-${digestValue({
    requestedBy: original.requestedBy,
    action,
  })}`;
  const approvalBindingDigest = digestValue({
    id,
    kind: original.kind,
    requestedBy: original.requestedBy,
    actor: original.actor,
    target: original.target,
    action,
    displayedPayloadDigest: original.displayedPayloadDigest,
  });
  const forged = {
    ...original,
    id,
    action,
    approvalBindingDigest,
    idempotencyKey: `confirmation-${approvalBindingDigest}`,
  };

  assert.deepEqual(await service.execute(forged), { status: "stale" });
  assert.equal(setup.store.writes.length, 0);
  assert.equal(await fileValue(setup.root, "src/app.js"), "before\n");
});

test("recovery rejects corrupted durable application state", async (t) => {
  const setup = await fixture(t);
  setup.store.value = { schemaVersion: 1, revision: 1, applications: [{}] };
  await assert.rejects(
    setup.createService().recover(),
    (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STATE_CORRUPTED",
  );
});
