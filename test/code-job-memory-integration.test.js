import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeJobMemoryProjector } from "../src/services/code-job-memory-projector.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";

const lease = Object.freeze({
  run(operation) {
    return operation();
  },
});

function grant() {
  return createCodeJobGrant({
    proposalId: "work-intent-proposal-memory-integration",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-memory-integration" },
    source: {
      assignmentId: "assignment-memory-integration",
      eventId: "event-memory-integration",
    },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Persist a searchable failed Code Job result.",
    acceptanceCriteria: ["The result is durably searchable."],
    evidence: ["The owner approved this local inspection."],
    summary: "Verify Code Job memory recovery",
    reason: "Exercise the durable cross-store acknowledgement seam.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }],
    brainDigest: "c".repeat(64),
  });
}

async function recoverServices(directory) {
  const store = new StateStore(directory);
  const memory = new LocalMemoryJournal({
    store,
    exclusiveLease: lease,
    operationQueue: new OperationQueue(),
  });
  await memory.recover();
  const jobs = new CodeJobStore({
    store,
    exclusiveLease: lease,
    operationQueue: new OperationQueue(),
    memoryReceiptVerifier: {
      verify: memory.verifyReceipt.bind(memory),
    },
  });
  await jobs.recover();
  return { jobs, memory };
}

function projectorFor(jobs, memory, ack = (value) =>
  jobs.acknowledgeMemoryProjection(value)) {
  return new CodeJobMemoryProjector({
    projectionSource: {
      readBatch: (value) => jobs.readMemoryProjectionBatch(value),
      ack,
    },
    memoryProducer: memory,
  });
}

test("real Code Job outbox survives a lost ack response and remains searchable after restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "code-job-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await recoverServices(directory);
  const sealedGrant = grant();
  const created = await first.jobs.createApprovedJob({
    confirmationId: "confirmation-code-job-memory-integration",
    requestId: "approval-request-memory-integration",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant: sealedGrant,
  });
  await first.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "MEMORY_INTEGRATION_FAILURE" },
  });

  const lostResponse = new Error("memory acknowledgement response lost");
  let loseResponse = true;
  const firstProjector = projectorFor(first.jobs, first.memory, async (value) => {
    const result = await first.jobs.acknowledgeMemoryProjection(value);
    if (loseResponse) {
      loseResponse = false;
      throw lostResponse;
    }
    return result;
  });
  await assert.rejects(
    firstProjector.runCycle(),
    (error) => error === lostResponse,
  );

  const recovered = await recoverServices(directory);
  const replay = await projectorFor(recovered.jobs, recovered.memory).runCycle();
  assert.deepEqual(replay, {
    observed: 0,
    appended: 0,
    acknowledged: 0,
    cursor: 1,
    highWatermark: 1,
    pending: 0,
  });
  const search = recovered.memory.search({
    repository: "acme/widgets",
    eventType: "code_job.failed",
  });
  assert.equal(search.totalMatched, 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].source.kind, "code_job");
  assert.match(search.items[0].source.id, new RegExp(created.job.jobId));
  assert.equal(search.items[0].event, "code_job.failed");

  const job = await recovered.jobs.get(created.job.jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.memoryProjection.recordId, search.items[0].id);
  assert.deepEqual(await recovered.jobs.readMemoryProjectionBatch(), {
    cursor: 1,
    highWatermark: 1,
    items: [],
  });
});
