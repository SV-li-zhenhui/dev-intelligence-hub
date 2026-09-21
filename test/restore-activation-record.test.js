import assert from "node:assert/strict";
import test from "node:test";

import {
  RestoreActivationRecordError,
  createRestoreActivationJournal,
  createRestoreActivationReceipt,
  normalizeRestoreActivationJournal,
  normalizeRestoreActivationReceipt,
} from "../src/domain/restore-activation-record.js";

const BACKUP_ID = `backup-${"a".repeat(64)}`;
const ACTIVATION_ID = `restore-activation-${"b".repeat(64)}`;
const AT = "2026-08-08T02:00:00.000Z";
const FINGERPRINT = Object.freeze({
  digest: "c".repeat(64),
  fileCount: 3,
  directoryCount: 2,
  totalBytes: 42,
});

function prepared() {
  return {
    activationId: ACTIVATION_ID,
    backupId: BACKUP_ID,
    requestedAt: AT,
    phase: "prepared",
    hadActive: true,
    previousFingerprint: FINGERPRINT,
    candidateFingerprint: null,
    failureCode: null,
  };
}

test("restore activation records are canonical, content-bound, and frozen", () => {
  const journal = createRestoreActivationJournal(prepared());
  const receipt = createRestoreActivationReceipt({
    activationId: ACTIVATION_ID,
    backupId: BACKUP_ID,
    activatedAt: AT,
    activeFingerprint: FINGERPRINT,
  });

  assert.deepEqual(normalizeRestoreActivationJournal(structuredClone(journal)), journal);
  assert.deepEqual(normalizeRestoreActivationReceipt(structuredClone(receipt)), receipt);
  assert.equal(Object.isFrozen(journal), true);
  assert.equal(Object.isFrozen(journal.previousFingerprint), true);
  assert.equal(Object.isFrozen(receipt), true);
});

test("journal and receipt digest tampering is rejected", () => {
  const journal = structuredClone(createRestoreActivationJournal(prepared()));
  journal.requestedAt = "2026-08-08T03:00:00.000Z";
  assert.throws(
    () => normalizeRestoreActivationJournal(journal),
    RestoreActivationRecordError,
  );

  const receipt = structuredClone(createRestoreActivationReceipt({
    activationId: ACTIVATION_ID,
    backupId: BACKUP_ID,
    activatedAt: AT,
    activeFingerprint: FINGERPRINT,
  }));
  receipt.activeFingerprint.totalBytes += 1;
  assert.throws(
    () => normalizeRestoreActivationReceipt(receipt),
    RestoreActivationRecordError,
  );
});

test("phase-dependent fields and untrusted proxies fail closed", () => {
  assert.throws(
    () => createRestoreActivationJournal({
      ...prepared(),
      phase: "active-moved",
    }),
    RestoreActivationRecordError,
  );
  assert.throws(
    () => createRestoreActivationJournal({
      ...prepared(),
      failureCode: "RESTORE_ACTIVATION_SWAP_FAILED",
    }),
    RestoreActivationRecordError,
  );
  let traps = 0;
  assert.throws(
    () => normalizeRestoreActivationJournal(new Proxy({}, {
      getPrototypeOf() {
        traps += 1;
        throw new Error("must not execute proxy traps");
      },
    })),
    RestoreActivationRecordError,
  );
  assert.equal(traps, 0);
});
