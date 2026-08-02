import assert from "node:assert/strict";
import test from "node:test";

import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  ChangePackageApplicationProjectionStore,
  ChangePackageApplicationProjectionStoreError,
} from "../src/services/change-package-application-projection-store.js";

const STATE_KEY = "change-package-application-projections";
const JOB_ID = `code-job-${"a".repeat(55)}`;
const PACKAGE_DIGEST = "b".repeat(64);
const PACKAGE_ID = `change-package-${PACKAGE_DIGEST}`;
const APPROVAL_DIGEST = "c".repeat(64);
const SOURCE_DIGEST = "d".repeat(64);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryStore {
  constructor(value) {
    this.value = clone(value);
    this.writes = [];
    this.failure = null;
  }

  async read(name, fallback) {
    assert.equal(name, STATE_KEY);
    return clone(this.value ?? fallback);
  }

  async write(name, value) {
    assert.equal(name, STATE_KEY);
    const next = clone(value);
    this.writes.push(next);
    if (this.failure?.commitBeforeThrow) this.value = next;
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw Object.assign(new Error("simulated projection write failure"), {
        code: failure.code,
      });
    }
    this.value = next;
  }
}

function exclusiveLease() {
  return { async run(operation) { return operation(); } };
}

function receiptFor(confirmationId, approvalBindingDigest, createdAt) {
  return {
    id: `change-package-application-${digestValue({
      confirmationId,
      approvalBindingDigest,
    })}`,
    createdAt,
  };
}

function entry(overrides = {}) {
  const confirmationId =
    overrides.confirmationId ??
    `confirmation-change-package-apply-${"1".repeat(64)}`;
  const approvalBindingDigest =
    overrides.approvalBindingDigest ?? APPROVAL_DIGEST;
  const createdAt = overrides.createdAt ?? "2026-08-03T01:00:00.000Z";
  const status = overrides.status ?? "pending";
  const defaultReceipt = ["applied", "already"].includes(status)
    ? receiptFor(
        confirmationId,
        approvalBindingDigest,
        "2026-08-03T01:01:00.000Z",
      )
    : null;
  const defaultFailure = status === "failed"
    ? {
        code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
        outcome: "absent",
        retryable: true,
        at: "2026-08-03T01:02:00.000Z",
      }
    : null;
  return {
    confirmationId,
    approvalBindingDigest,
    requestedBy: {
      roleId: "developer",
      workItemId: "work-item-1",
    },
    job: {
      id: JOB_ID,
      revision: 8,
      recordDigest: "e".repeat(64),
    },
    packageId: PACKAGE_ID,
    packageDigest: PACKAGE_DIGEST,
    workspaceId: "dashboard",
    itemRevision: 1,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    status,
    receipt: overrides.receipt === undefined
      ? defaultReceipt
      : overrides.receipt,
    failure: overrides.failure === undefined
      ? defaultFailure
      : overrides.failure,
    rejectedAt: overrides.rejectedAt === undefined
      ? status === "rejected"
        ? overrides.updatedAt ?? createdAt
        : null
      : overrides.rejectedAt,
    ...overrides,
  };
}

async function readyStore(memory = new MemoryStore()) {
  const projections = new ChangePackageApplicationProjectionStore({
    store: memory,
    exclusiveLease: exclusiveLease(),
  });
  await projections.recover();
  return { projections, memory };
}

function hasCode(code) {
  return (error) =>
    error instanceof ChangePackageApplicationProjectionStoreError &&
    error.code === code;
}

test("projection store recovers an empty safe reader with not_requested defaults", async () => {
  const { projections } = await readyStore();

  assert.deepEqual(await projections.getSummary(), {
    revision: 0,
    sourceRevision: 0,
    sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
    entryCount: 0,
  });
  assert.deepEqual(await projections.getCheckpoint(), {
    sourceRevision: 0,
    sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
  });
  assert.deepEqual(await projections.getForJob(JOB_ID), {
    status: "not_requested",
  });
  assert.deepEqual(await projections.getForPackage(PACKAGE_ID), {
    status: "not_requested",
  });
  const reader = projections.reader();
  assert.equal(Object.isFrozen(reader), true);
  assert.deepEqual(Object.keys(reader).sort(), [
    "getForJob",
    "getForPackage",
    "getSummary",
  ]);
});

test("projection store persists safe entries and selects the latest created attempt", async () => {
  const { projections, memory } = await readyStore();
  const earlierButRecentlyUpdated = entry({
    confirmationId: `confirmation-change-package-apply-${"1".repeat(64)}`,
    itemRevision: 4,
    createdAt: "2026-08-03T01:00:00.000Z",
    updatedAt: "2026-08-03T04:00:00.000Z",
    status: "stale",
  });
  const laterAttempt = entry({
    confirmationId: `confirmation-change-package-apply-${"2".repeat(64)}`,
    approvalBindingDigest: "f".repeat(64),
    itemRevision: 2,
    createdAt: "2026-08-03T02:00:00.000Z",
    updatedAt: "2026-08-03T03:00:00.000Z",
    status: "pending",
  });

  const applied = await projections.applySnapshot({
    sourceRevision: 7,
    sourceSnapshotDigest: SOURCE_DIGEST,
    entries: [earlierButRecentlyUpdated, laterAttempt],
  });

  assert.deepEqual(applied, {
    revision: 1,
    sourceRevision: 7,
    sourceSnapshotDigest: SOURCE_DIGEST,
    entryCount: 2,
  });
  assert.equal(memory.writes.length, 1);
  assert.equal(memory.value.schemaVersion, 1);
  assert.deepEqual(
    memory.value.entries.map(({ confirmationId }) => confirmationId),
    [earlierButRecentlyUpdated.confirmationId, laterAttempt.confirmationId],
  );

  const byJob = await projections.getForJob(JOB_ID);
  const byPackage = await projections.getForPackage(PACKAGE_ID);
  assert.equal(byJob.confirmationId, laterAttempt.confirmationId);
  assert.equal(byJob.status, "pending");
  assert.deepEqual(byPackage, byJob);
  assert.equal("approvalBindingDigest" in byJob, false);
  assert.equal(Object.isFrozen(byJob), true);
  assert.equal(Object.isFrozen(byJob.job), true);
  assert.equal(Object.isFrozen(byJob.requestedBy), true);

  const recovered = new ChangePackageApplicationProjectionStore({
    store: memory,
    exclusiveLease: exclusiveLease(),
  });
  await recovered.recover();
  assert.deepEqual(await recovered.getForJob(JOB_ID), byJob);
});

test("projection store enforces monotonic source and immutable item bindings", async () => {
  const { projections, memory } = await readyStore();
  const initial = entry({ itemRevision: 2, status: "applying" });
  await projections.applySnapshot({
    sourceRevision: 3,
    sourceSnapshotDigest: "3".repeat(64),
    entries: [initial],
  });

  const same = await projections.applySnapshot({
    sourceRevision: 3,
    sourceSnapshotDigest: "3".repeat(64),
    entries: [initial],
  });
  assert.equal(same.revision, 1);
  assert.equal(memory.writes.length, 1);

  const conflicts = [
    {
      sourceRevision: 2,
      sourceSnapshotDigest: "2".repeat(64),
      entries: [initial],
    },
    {
      sourceRevision: 3,
      sourceSnapshotDigest: "4".repeat(64),
      entries: [initial],
    },
    {
      sourceRevision: 4,
      sourceSnapshotDigest: "4".repeat(64),
      entries: [],
    },
    {
      sourceRevision: 4,
      sourceSnapshotDigest: "4".repeat(64),
      entries: [{ ...initial, packageDigest: "5".repeat(64) }],
    },
    {
      sourceRevision: 4,
      sourceSnapshotDigest: "4".repeat(64),
      entries: [{ ...initial, itemRevision: 1 }],
    },
    {
      sourceRevision: 4,
      sourceSnapshotDigest: "4".repeat(64),
      entries: [{ ...initial, status: "failed" }],
    },
  ];
  for (const candidate of conflicts) {
    await assert.rejects(
      projections.applySnapshot(candidate),
      hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_SOURCE_CONFLICT"),
    );
  }
  assert.equal(memory.writes.length, 1);

  const advanced = {
    ...initial,
    itemRevision: 3,
    updatedAt: "2026-08-03T01:03:00.000Z",
    status: "failed",
    failure: {
      code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
      outcome: "absent",
      retryable: true,
      at: "2026-08-03T01:03:00.000Z",
    },
  };
  const summary = await projections.applySnapshot({
    sourceRevision: 4,
    sourceSnapshotDigest: "6".repeat(64),
    entries: [advanced],
  });
  assert.equal(summary.revision, 2);
  assert.equal((await projections.getForJob(JOB_ID)).status, "failed");
});

for (const status of ["rejected", "stale", "applied", "already"]) {
  test(`projection store never rewrites terminal ${status} entries`, async () => {
    const { projections, memory } = await readyStore();
    const terminal = entry({
      itemRevision: 2,
      updatedAt: "2026-08-03T01:02:00.000Z",
      status,
    });
    await projections.applySnapshot({
      sourceRevision: 3,
      sourceSnapshotDigest: "3".repeat(64),
      entries: [terminal],
    });
    const rewritten = entry({
      ...terminal,
      itemRevision: 3,
      updatedAt: "2026-08-03T01:03:00.000Z",
      ...(status === "rejected"
        ? { rejectedAt: "2026-08-03T01:03:00.000Z" }
        : {}),
      ...(["applied", "already"].includes(status)
        ? {
            receipt: {
              ...terminal.receipt,
              createdAt: "2026-08-03T01:03:00.000Z",
            },
          }
        : {}),
    });

    await assert.rejects(
      projections.applySnapshot({
        sourceRevision: 4,
        sourceSnapshotDigest: "4".repeat(64),
        entries: [rewritten],
      }),
      hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_SOURCE_CONFLICT"),
    );
    assert.equal(memory.writes.length, 1);
    assert.deepEqual(await projections.getForJob(JOB_ID), {
      status: terminal.status,
      confirmationId: terminal.confirmationId,
      requestedBy: terminal.requestedBy,
      job: terminal.job,
      packageId: terminal.packageId,
      packageDigest: terminal.packageDigest,
      workspaceId: terminal.workspaceId,
      itemRevision: terminal.itemRevision,
      createdAt: terminal.createdAt,
      updatedAt: terminal.updatedAt,
      ...(terminal.receipt === null ? {} : { receipt: terminal.receipt }),
      ...(terminal.rejectedAt === null
        ? {}
        : { rejectedAt: terminal.rejectedAt }),
    });
  });
}

test("projection store publishes state only after an atomic write and recovers acknowledgement loss", async () => {
  const { projections, memory } = await readyStore();
  const candidate = {
    sourceRevision: 2,
    sourceSnapshotDigest: "2".repeat(64),
    entries: [entry()],
  };

  memory.failure = { code: "WRITE_FAILED", commitBeforeThrow: false };
  await assert.rejects(projections.applySnapshot(candidate), /simulated/);
  assert.deepEqual(await projections.getForJob(JOB_ID), {
    status: "not_requested",
  });

  memory.failure = { code: "ACK_LOST", commitBeforeThrow: true };
  await assert.rejects(projections.applySnapshot(candidate), /simulated/);
  assert.equal((await projections.getForJob(JOB_ID)).status, "pending");
  const writesAfterAcknowledgementLoss = memory.writes.length;
  const repeated = await projections.applySnapshot(candidate);
  assert.equal(repeated.revision, 1);
  assert.equal(memory.writes.length, writesAfterAcknowledgementLoss);
});

test("projection store rejects corrupt durable state and stays unavailable", async () => {
  const invalid = {
    schemaVersion: 1,
    revision: 1,
    sourceRevision: 1,
    sourceSnapshotDigest: "7".repeat(64),
    entries: [entry({ packageId: `change-package-${"8".repeat(64)}` })],
  };
  const projections = new ChangePackageApplicationProjectionStore({
    store: new MemoryStore(invalid),
    exclusiveLease: exclusiveLease(),
  });

  await assert.rejects(
    projections.recover(),
    hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED"),
  );
  await assert.rejects(
    projections.getForJob(JOB_ID),
    hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_NOT_READY"),
  );
});

test("projection store detects durable revision rollback and same-revision forks", async () => {
  const rollback = await readyStore();
  await rollback.projections.applySnapshot({
    sourceRevision: 2,
    sourceSnapshotDigest: "2".repeat(64),
    entries: [entry()],
  });
  rollback.memory.value = {
    schemaVersion: 1,
    revision: 0,
    sourceRevision: 0,
    sourceSnapshotDigest: digestValue({ sourceRevision: 0, items: [] }),
    entries: [],
  };
  await assert.rejects(
    rollback.projections.getSummary(),
    hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED"),
  );
  await assert.rejects(
    rollback.projections.getSummary(),
    hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_NOT_READY"),
  );

  const fork = await readyStore();
  await fork.projections.applySnapshot({
    sourceRevision: 2,
    sourceSnapshotDigest: "2".repeat(64),
    entries: [entry()],
  });
  fork.memory.value = {
    ...fork.memory.value,
    sourceSnapshotDigest: "3".repeat(64),
  };
  await assert.rejects(
    fork.projections.getSummary(),
    hasCode("CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_CORRUPTED"),
  );
});
