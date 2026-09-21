import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { digestValue } from "../src/domain/code-executor-contract.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import {
  createPullRequestExecutionBinding,
} from "../src/domain/pull-request-execution-binding.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import {
  planLegacyAuthorityProjectionAdoption,
} from "../src/services/legacy-authority-projection-adapter.js";
import {
  normalizeMemoryJournalState,
} from "../src/services/local-memory-journal.js";
import {
  currentWorkItemEvent,
  currentWorkItemInputBinding,
} from "../src/services/work-ledger-pr-source.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import {
  ConfirmationQueue,
} from "../src/services/confirmation-queue.js";
import {
  pullRequestExternalActionQueuePlan,
} from "./support/pull-request-external-action-fixture.js";

const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(key, fallback = null) {
    return structuredClone(
      this.values.has(key) ? this.values.get(key) : fallback,
    );
  }

  async write(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class AssignmentSource {
  constructor(records) {
    this.records = structuredClone(records);
  }

  async readAssignmentBatch({ afterSequence, limit }) {
    const items = this.records
      .filter(({ sequence }) => sequence > afterSequence)
      .slice(0, limit);
    return structuredClone({
      items,
      nextSequence: items.at(-1)?.sequence ?? afterSequence,
      highWatermark: this.records.at(-1)?.sequence ?? 0,
      oldestAvailableSequence: this.records[0]?.sequence ?? 1,
    });
  }
}

function prAssignment(sequence, headRefOid, previousHeadRefOid) {
  const occurredAt = `2026-08-08T07:0${sequence - 1}:00.000Z`;
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt,
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "PR 42",
      headRefOid,
      ciStatus: "PENDING",
      changedFields: previousHeadRefOid === undefined
        ? ["ciStatus"]
        : ["headRefOid"],
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/conflict",
        headRefOid,
      },
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
      createdAt: occurredAt,
    },
    event,
  };
}

async function ledgerFixture(records) {
  const store = new MemoryStore();
  const service = new WorkLedgerService({
    store,
    assignmentSource: new AssignmentSource(records),
    exclusiveLease: { async run(operation) { return operation(); } },
    idFactory: () => "restore-adoption-lease",
  });
  await service.recover();
  await service.intake();
  const state = await store.read("work-ledger-state", null);
  const root = state.items.find(({ kind }) => kind === "source_root");
  const binding = createPullRequestExecutionBinding({
    sourceBinding: currentWorkItemInputBinding(root),
    event: currentWorkItemEvent(root),
  });
  return { state, binding };
}

async function confirmationFixture(binding) {
  const store = new MemoryStore();
  const queue = new ConfirmationQueue({
    store,
    executor: {
      async execute() {
        throw new Error("restore fixture must not execute external actions");
      },
      async reconcile() {
        throw new Error("restore fixture must not reconcile external actions");
      },
    },
    exclusiveLease: { async run(operation) { return operation(); } },
    clock: () => new Date("2026-08-08T07:03:00.000Z"),
  });
  await queue.recover();
  await queue.enqueue(pullRequestExternalActionQueuePlan(
    { type: "comment", body: "Restore-safe PR observation" },
    { binding },
  ));
  return store.read("confirmation-queue", null);
}

function emptyJournal() {
  return normalizeMemoryJournalState({
    schemaVersion: 1,
    revision: 0,
    records: [],
  });
}

function materialEmptyLegacyProjection() {
  return {
    schemaVersion: 4,
    revision: 1,
    workLedgerRevision: 0,
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    confirmationHighWatermark: 0,
    entries: [],
  };
}

function authorityRecord(binding) {
  const authority = {
    applies: true,
    current: true,
    bindingDigest: digestValue(binding),
    inputBinding: binding,
  };
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "work-decision", id: "legacy-decision:fixture" },
    occurredAt: "2026-08-08T07:02:00.000Z",
    roleId: "pr-engineer",
    repository: binding.repository,
    eventType: "work_decision.fixture",
    title: "Legacy authority decision",
    summary: "A legacy decision bound to the current PR Head",
    content: JSON.stringify({
      memoryType: "work-decision",
      authority,
    }),
    evidence: [],
    tags: ["work-decision", "legacy"],
    sourceUrl: null,
    subjectNumber: binding.pullRequestNumber,
  });
}

function legacyV1Projection(record) {
  return {
    schemaVersion: 1,
    revision: 7,
    entries: [{
      key: "work-decision:legacy-fixture",
      fingerprint: digestValue({ recordId: record.recordId }),
      recordId: record.recordId,
    }],
  };
}

function expectAdoptionBlocked(operation) {
  return assert.rejects(operation, (error) => {
    assert.equal(error?.code, "RESTORE_AUTHORITY_ADOPTION_BLOCKED");
    return true;
  });
}

test("legacy adoption is a detached no-op when the legacy file is absent", async () => {
  const journal = emptyJournal();
  const adopted = await planLegacyAuthorityProjectionAdoption({
    journal,
    legacyProjection: null,
    workLedger: null,
  });

  assert.deepEqual(adopted, journal);
  assert.notEqual(adopted, journal);
});

test("material legacy adoption projects current confirmations before activation", async () => {
  const { state: workLedger, binding } = await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
  ]);
  const confirmationState = await confirmationFixture(binding);
  const journal = emptyJournal();
  const legacyProjection = materialEmptyLegacyProjection();
  const before = structuredClone({ journal, legacyProjection, workLedger, confirmationState });

  const adopted = await planLegacyAuthorityProjectionAdoption({
    journal,
    legacyProjection,
    workLedger,
    confirmationState,
  });

  assert.equal(adopted.revision, journal.revision + 1);
  assert.equal(adopted.records.length, 1);
  assert.equal(adopted.records[0].source.kind, "confirmation");
  assert.equal(
    adopted.records[0].content.includes("Restore-safe PR observation"),
    false,
  );
  assert.deepEqual(
    adopted.lifecycleAuthority.authorityProjection,
    {
      schemaVersion: 4,
      revision: 1,
      workLedgerRevision: workLedger.revision,
      authorityStateDigest:
        workLedger.graphMemoryProjection.authorityStateDigest,
      confirmationHighWatermark: confirmationState.revision,
      entries: [{
        key: `confirmation:${confirmationState.items[0].id}`,
        fingerprint:
          adopted.lifecycleAuthority.authorityProjection.entries[0].fingerprint,
        recordId: adopted.records[0].recordId,
        sourceKind: "confirmation",
        binding,
        current: true,
        occurredAt: confirmationState.items[0].updatedAt,
      }],
    },
  );
  assert.deepEqual(
    { journal, legacyProjection, workLedger, confirmationState },
    before,
  );
  assert.deepEqual(
    await planLegacyAuthorityProjectionAdoption({
      journal: adopted,
      legacyProjection,
      workLedger,
      confirmationState,
    }),
    adopted,
  );
});

test("legacy v1 entries are validated then corrected using current projection rules", async () => {
  const { state: workLedger, binding } = await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
  ]);
  const record = authorityRecord(binding);
  const journal = {
    schemaVersion: 1,
    revision: 1,
    records: [record],
  };
  const legacyProjection = legacyV1Projection(record);

  const adopted = await planLegacyAuthorityProjectionAdoption({
    journal,
    legacyProjection,
    workLedger,
  });

  assert.equal(adopted.records.length, 2);
  assert.deepEqual(adopted.lifecycleAuthority.authorityProjection.entries, []);
  const correction = adopted.records.find(
    ({ recordId }) => recordId !== record.recordId,
  );
  assert.deepEqual(correction.evidence, [`supersedes:${record.recordId}`]);
  assert.deepEqual(JSON.parse(correction.content), {
    memoryType: "work-decision",
    lifecycleOnly: true,
    priorRecordId: record.recordId,
    reason: "projection_state_migrated",
    authority: {
      applies: false,
      current: false,
      bindingDigest: null,
      inputBinding: null,
    },
  });
});

test("candidate adoption fails closed for stale bindings or missing records", async () => {
  const oldFixture = await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
  ]);
  const currentFixture = await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
    prAssignment(2, "b".repeat(40), "a".repeat(40)),
  ]);
  const staleConfirmation = await confirmationFixture(oldFixture.binding);
  const journal = emptyJournal();

  await expectAdoptionBlocked(() => planLegacyAuthorityProjectionAdoption({
    journal,
    legacyProjection: materialEmptyLegacyProjection(),
    workLedger: currentFixture.state,
    confirmationState: staleConfirmation,
  }));

  const missingRecordProjection = {
    schemaVersion: 4,
    revision: 1,
    workLedgerRevision: oldFixture.state.revision,
    authorityStateDigest:
      oldFixture.state.graphMemoryProjection.authorityStateDigest,
    confirmationHighWatermark: 0,
    entries: [{
      key: "work-decision:missing-record",
      fingerprint: "1".repeat(64),
      recordId: `memory-${"2".repeat(64)}`,
      sourceKind: "work-decision",
      binding: oldFixture.binding,
      current: true,
      occurredAt: "2026-08-08T07:02:00.000Z",
    }],
  };
  await expectAdoptionBlocked(() => planLegacyAuthorityProjectionAdoption({
    journal,
    legacyProjection: missingRecordProjection,
    workLedger: oldFixture.state,
  }));
});

test("a populated journal checkpoint wins without merging legacy authority", async () => {
  const { state: workLedger, binding } = await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
  ]);
  const record = authorityRecord(binding);
  const adopted = await planLegacyAuthorityProjectionAdoption({
    journal: {
      schemaVersion: 1,
      revision: 1,
      records: [record],
    },
    legacyProjection: legacyV1Projection(record),
    workLedger,
  });
  const staleLedger = (await ledgerFixture([
    prAssignment(1, "a".repeat(40)),
    prAssignment(2, "b".repeat(40), "a".repeat(40)),
  ])).state;

  assert.deepEqual(
    await planLegacyAuthorityProjectionAdoption({
      journal: adopted,
      legacyProjection: legacyV1Projection(record),
      workLedger: staleLedger,
    }),
    adopted,
  );
});
