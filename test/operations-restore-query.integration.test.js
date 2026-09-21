import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StateStore } from "../src/lib/state-store.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";
import { createOperationsRuntime } from "../src/operations-runtime.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import {
  DataDirectoryCheckpointService,
} from "../src/services/data-directory-checkpoint-service.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";

class ExclusiveLease {
  #tail = Promise.resolve();

  run(operation) {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}

function memoryGuard() {
  const lease = new ExclusiveLease();
  return {
    async acquire() {},
    run: lease.run.bind(lease),
    async close() {},
  };
}

function assignmentSource(records) {
  return {
    async readAssignmentBatch({ afterSequence, limit }) {
      const items = records
        .filter(({ sequence }) => sequence > afterSequence)
        .slice(0, limit);
      return {
        items: structuredClone(items),
        nextSequence: items.at(-1)?.sequence ?? afterSequence,
        highWatermark: records.at(-1)?.sequence ?? 0,
        oldestAvailableSequence: records.at(0)?.sequence ?? 1,
      };
    },
  };
}

function issueAssignment() {
  return {
    sequence: 1,
    assignment: {
      assignmentId: "workflow-assignment-restore-1",
      eventId: "workflow-event-restore-1",
      target: { type: "role", id: "requirements-analyst" },
      reason: "issue-events-to-requirements",
      createdAt: "2026-08-07T01:00:00.000Z",
    },
    event: {
      schemaVersion: 1,
      eventId: "workflow-event-restore-1",
      eventType: "issue.created",
      occurredAt: "2026-08-07T01:00:00.000Z",
      subject: { id: "github:issue:acme/command-center#17" },
      payload: { number: 17, title: "Restore the command center" },
    },
  };
}

function confirmationPlan() {
  const actor = { provider: "github", accountId: "local-owner" };
  const target = {
    provider: "github",
    resourceId: "acme/command-center#17",
    version: "a".repeat(40),
  };
  const action = {
    type: "pull_request_comment",
    body: "The restored evidence is ready for owner review.",
  };
  return {
    id: "confirmation-restore-query-1",
    kind: "github.pull-request-comment",
    requestedBy: {
      roleId: "pr-engineer",
      workItemId: "work-restore-query-1",
    },
    actor,
    target,
    action,
    display: {
      title: "Publish the verified result",
      summary: "The external comment remains pending after restore.",
      actionLabel: "Confirm and publish",
      evidence: ["backup-restored"],
      payload: { actor, target, action },
    },
  };
}

function memoryRecord() {
  return {
    schemaVersion: 1,
    source: { kind: "local-session", id: "restore-query-session-1" },
    occurredAt: "2026-08-07T01:01:00.000Z",
    roleId: "requirements-analyst",
    repository: "acme/command-center",
    eventType: "memory.restore_verified",
    title: "Command-center backup verified",
    summary: "Work, confirmation, and memory remained searchable after restore.",
    content: "Representative restored query evidence.",
    evidence: ["backup-restored"],
    tags: ["backup", "restore"],
    sourceUrl: null,
    subjectNumber: 17,
  };
}

function confirmationExecutor() {
  return {
    async execute() {
      throw new Error("a restored pending confirmation must not execute while queried");
    },
    async reconcile() {
      return { status: "absent" };
    },
  };
}

function checkpointWithoutHostCapacityWarning(options) {
  const checkpoint = new DataDirectoryCheckpointService(options);
  return {
    enter: checkpoint.enter.bind(checkpoint),
    leave: checkpoint.leave.bind(checkpoint),
    capture: checkpoint.capture.bind(checkpoint),
    reconcile: checkpoint.reconcile.bind(checkpoint),
    recovery: checkpoint.recovery.bind(checkpoint),
    async capacity() {
      return { warnings: [] };
    },
  };
}

async function createLedger(store, records) {
  let nextId = 0;
  const ledger = new WorkLedgerService({
    store,
    assignmentSource: assignmentSource(records),
    exclusiveLease: new ExclusiveLease(),
    idFactory: () => `restore-lease-${++nextId}`,
    clock: () => "2026-08-07T01:02:00.000Z",
  });
  await ledger.recover();
  return ledger;
}

async function createConfirmationQueue(store) {
  const queue = new ConfirmationQueue({
    store,
    executor: confirmationExecutor(),
    exclusiveLease: new ExclusiveLease(),
    clock: () => new Date("2026-08-07T01:03:00.000Z"),
  });
  await queue.recover();
  return queue;
}

test("a copied backup restores into a clean data directory with representative queryability", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-restore-query-"));
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  const copiedBackupDirectory = path.join(root, "copied-backups");
  const restoredDirectory = path.join(root, "restored-data");
  const restoredBackupDirectory = path.join(root, "restored-backups");
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new StateStore(dataDirectory);
  const ledger = await createLedger(store, [issueAssignment()]);
  await ledger.intake();
  const confirmationQueue = await createConfirmationQueue(store);
  await confirmationQueue.enqueue(confirmationPlan());
  const memory = await createMemoryRuntime({
    store,
    createGuard: memoryGuard,
  });
  await memory.producer.append(memoryRecord());
  await memory.close();

  const operations = createOperationsRuntime({ dataDirectory, backupDirectory });
  const backup = await operations.backup.createBackup();
  await mkdir(copiedBackupDirectory);
  await cp(
    backup.path,
    path.join(copiedBackupDirectory, backup.manifest.backupId),
    { recursive: true },
  );
  await rm(backupDirectory, { recursive: true, force: true });
  await rm(dataDirectory, { recursive: true, force: true });
  await assert.rejects(lstat(dataDirectory), { code: "ENOENT" });
  const copiedOperations = createOperationsRuntime({
    dataDirectory,
    backupDirectory: copiedBackupDirectory,
  });
  const verifiedCopiedBackup = await copiedOperations.backup.verifyBackup(
    backup.manifest.backupId,
  );
  const restored = await copiedOperations.backup.restore({
    backupId: verifiedCopiedBackup.manifest.backupId,
    destinationDirectory: restoredDirectory,
  });
  assert.equal(restored.ready, true);

  const restoredStore = new StateStore(restoredDirectory);
  const restoredLedger = await createLedger(restoredStore, []);
  const work = await restoredLedger.listItems();
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].assignmentId, "workflow-assignment-restore-1");
  assert.deepEqual(work.items[0].currentTarget, {
    type: "role",
    id: "requirements-analyst",
  });
  assert.match(work.items[0].inputDigest, /^[a-f0-9]{64}$/u);

  const restoredConfirmations = await createConfirmationQueue(restoredStore);
  const nextConfirmation = await restoredConfirmations.next();
  assert.equal(nextConfirmation.pendingCount, 1);
  assert.equal(nextConfirmation.item.id, "confirmation-restore-query-1");
  assert.equal(nextConfirmation.item.status, "pending");

  const restoredMemory = await createMemoryRuntime({
    store: restoredStore,
    createGuard: memoryGuard,
  });
  const memorySearch = await restoredMemory.search.search({
    q: "Representative restored query evidence",
  });
  assert.equal(memorySearch.items.length, 1);
  assert.equal(memorySearch.items[0].source.id, "restore-query-session-1");
  await restoredMemory.close();

  const restoredOperations = createOperationsRuntime({
    dataDirectory: restoredDirectory,
    backupDirectory: restoredBackupDirectory,
  }, {
    checkpointServiceFactory: checkpointWithoutHostCapacityWarning,
  });
  const readiness = await restoredOperations.readiness();
  assert.equal(readiness.ready, true, JSON.stringify(readiness));
  assert.deepEqual(readiness.recoveryBlockers, []);
  assert.deepEqual(readiness.unknownExternalActions, []);
});
