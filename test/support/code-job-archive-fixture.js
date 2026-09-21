import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../../src/domain/code-job-contract.js";
import { createChangePackage } from "../../src/domain/change-package-contract.js";
import { memoryRecordForCodeJobEvent } from
  "../../src/domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../../src/domain/memory-record.js";
import { OperationQueue } from "../../src/lib/operation-queue.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
} from "../../src/services/code-job-store.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  get state() {
    return this.values.get(CODE_JOB_STATE_KEY);
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

function approval() {
  const grant = createCodeJobGrant({
    schemaVersion: 2,
    proposalId: "archive-fixture-proposal",
    contentDigest: "a".repeat(64),
    policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: "archive-fixture-work" },
    source: {
      assignmentId: "archive-fixture-assignment",
      eventId: "archive-fixture-event",
    },
    subject: {
      id: "github:issue:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    inputBinding: null,
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Produce one immutable archive fixture.",
    acceptanceCriteria: ["The terminal job is archived with all indexes."],
    evidence: ["registry fixture"],
    summary: "Create archive fixture",
    reason: "Exercise immutable restore validation.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }],
    brainDigest: "c".repeat(64),
  });
  return {
    confirmationId: "archive-fixture-confirmation",
    requestId: "archive-fixture-request",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant,
  };
}

function memoryAcknowledgement(event) {
  const record = normalizeMemoryRecord(memoryRecordForCodeJobEvent(event));
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    jobId: event.jobId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: record.recordId,
    memoryRecordDigest: record.contentDigest,
  };
}

function changePackageForEvent(event) {
  return createChangePackage({
    job: event.job,
    proposal: event.proposal,
    grant: event.grant,
    workspace: {
      id: "widgets-local",
      sourceRevision: "3".repeat(64),
      workspaceRevision: event.exportRequest.expectedWorkspaceRevision,
    },
    passedProfiles: [{
      id: "node-tests",
      configDigest: "b".repeat(64),
      workspaceRevision: event.exportRequest.expectedWorkspaceRevision,
      actionId: "run-node-tests",
      attemptNumber: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      artifacts: {
        output: { path: "proof/output.json", sha256: "5".repeat(64), bytes: 1 },
        stdout: { path: "proof/stdout.json", sha256: "6".repeat(64), bytes: 1 },
        stderr: { path: "proof/stderr.json", sha256: "7".repeat(64), bytes: 1 },
      },
    }],
    created: [],
    modified: [],
    deleted: [],
  }).manifest;
}

export async function createCodeJobArchiveFixture() {
  let packageManifest = null;
  const store = new MemoryStore();
  const jobs = new CodeJobStore({
    store,
    operationQueue: new OperationQueue(),
    exclusiveLease: { async run(operation) { return operation(); } },
    clock: () => new Date("2026-08-08T08:00:00.000Z"),
    memoryReceiptVerifier: {
      async verify(value) {
        return { ...structuredClone(value), persisted: true };
      },
    },
    changePackageReader: {
      async get() {
        return structuredClone(packageManifest);
      },
    },
  });
  await jobs.recover();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const workspaceRevision = "4".repeat(64);
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision,
  });
  const actionId = "complete-archive-fixture";
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId,
      expectedWorkspaceRevision: workspaceRevision,
    },
  });
  const detail = { created: [], modified: [], deleted: [] };
  const observed = await jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId,
    status: "succeeded",
    workspaceRevision,
    detail,
  });
  const completed = await jobs.complete({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
    result: { summary: "Archive fixture ready", manifest: detail },
    changePackageDelivery: true,
  });
  const memoryEvents = await jobs.readMemoryProjectionBatch({ limit: 100 });
  for (const event of memoryEvents.items) {
    await jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  }
  const [delivery] = (
    await jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  packageManifest = changePackageForEvent(delivery);
  await jobs.acknowledgeChangePackageDelivery({
    sequence: delivery.sequence,
    eventId: delivery.eventId,
    eventDigest: delivery.eventDigest,
    jobId: delivery.job.id,
    sourceRecordDigest: delivery.job.recordDigest,
    packageId: packageManifest.packageId,
    packageDigest: packageManifest.packageDigest,
  });
  await jobs.compactTerminalPrefix({
    compactionId: "restore-registry-archive-fixture",
    expectedRevision: store.state.revision,
    targetThroughSequence: completed.job.sequence,
    preArchiveDigest: store.state.archive.digest,
  });
  return new Map(
    [...store.values].map(([key, value]) => [key, structuredClone(value)]),
  );
}
