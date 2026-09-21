import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeExecutionJournal } from "../src/services/code-execution-journal.js";
import { CodeJobMemoryProjector } from "../src/services/code-job-memory-projector.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobWorkerService } from "../src/services/code-job-worker-service.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "../src/services/controlled-code-executor.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";

const WORKSPACE_ID = "dashboard";
const PROFILE_ID = "node-tests";
const PROFILE_DEFINITION = Object.freeze({ kind: "integration-test" });
const PROFILE_DIGEST = digestValue(PROFILE_DEFINITION);
const SOURCE_CONTENT = "export const value = 1;\n";
const UNCERTAIN_CONTENT = "export const value = 2;\n";

const exclusiveLease = Object.freeze({
  run(operation) {
    return operation();
  },
});

function monotonicClock(initial = "2026-08-03T04:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    jobs: () => new Date(now++),
    executor: () => new Date(now++).toISOString(),
  };
}

function attemptExecutionId(sessionId, number) {
  return `attempt-${digestValue({ number, sessionId }).slice(0, 24)}`;
}

function approval() {
  const grant = createCodeJobGrant({
    proposalId: "proposal-recovery-integration",
    contentDigest: "a".repeat(64),
    policyVersion: 1,
    requestedBy: {
      roleId: "developer",
      workItemId: "work-recovery-integration",
    },
    source: {
      assignmentId: "assignment-recovery-integration",
      eventId: "event-recovery-integration",
    },
    subject: {
      id: "github:acme/dashboard:pull-request:18",
      repository: "acme/dashboard",
      number: 18,
    },
    repository: "acme/dashboard",
    workspaceId: WORKSPACE_ID,
    workspaceAuthorityDigest: "b".repeat(64),
    operation: "modify",
    objective: "Prove restart-safe cleanup of every isolated attempt.",
    acceptanceCriteria: ["Cancellation removes every isolated attempt."],
    evidence: ["No uncertain write reaches the source checkout."],
    summary: "Recover a partially cleaned cancellation.",
    reason: "A cleanup crash must not replay controlled work.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src"],
    requiredProfiles: [{ id: PROFILE_ID, configDigest: PROFILE_DIGEST }],
    brainDigest: "c".repeat(64),
  });
  return {
    confirmationId: "confirmation-recovery-integration",
    requestId: "request-recovery-integration",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant,
  };
}

class NoopSandbox {
  getProfileFingerprint(profileId) {
    return profileId === PROFILE_ID ? PROFILE_DIGEST : null;
  }

  async run() {
    throw new Error("The recovery scenario must not run a profile");
  }

  async cleanup() {}
}

function brokerWithFaults(broker, calls, { loseWrite = false, failDiscard = 0 } = {}) {
  return new Proxy(broker, {
    get(target, property) {
      if (property === "createExecution") {
        return async (request) => {
          calls.create += 1;
          return target.createExecution(request);
        };
      }
      if (property === "writeFile") {
        return async (request) => {
          calls.write += 1;
          const result = await target.writeFile(request);
          if (loseWrite) throw new Error("write acknowledgement was lost");
          return result;
        };
      }
      if (property === "discardExecution") {
        return async (request) => {
          calls.discard += 1;
          if (calls.discard === failDiscard) {
            throw new Error("workspace disposal interrupted");
          }
          return target.discardExecution(request);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function measuredExecutor(executor, calls) {
  return Object.freeze({
    start(request) {
      calls.start += 1;
      return executor.start(request);
    },
    view: executor.view.bind(executor),
    resume(request) {
      calls.resume += 1;
      return executor.resume(request);
    },
    perform(request, options) {
      calls.perform += 1;
      return executor.perform(request, options);
    },
    getActionResult: executor.getActionResult.bind(executor),
    reconcileAction: executor.reconcileAction.bind(executor),
    reconcileCancellation(request) {
      calls.cancel += 1;
      return executor.reconcileCancellation(request);
    },
  });
}

async function recoverDurableServices(stateRoot, clock) {
  const store = new StateStore(stateRoot);
  const memory = new LocalMemoryJournal({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
  });
  await memory.recover();
  const jobs = new CodeJobStore({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
    memoryReceiptVerifier: { verify: memory.verifyReceipt.bind(memory) },
    clock,
  });
  await jobs.recover();
  return { store, memory, jobs };
}

function createExecutor({ broker, store, journalRoot, clock }) {
  return new ControlledCodeExecutor({
    broker,
    sandbox: new NoopSandbox(),
    store,
    journal: new CodeExecutionJournal({ root: journalRoot }),
    profileDefinitions: { [PROFILE_ID]: PROFILE_DEFINITION },
    requiredProfilesByWorkspace: { [WORKSPACE_ID]: [PROFILE_ID] },
    clock,
  });
}

function worker({ jobs, executor, brainCalls, verifierCalls }) {
  return new CodeJobWorkerService({
    jobStore: jobs,
    executor,
    brainDirectory: {
      async decide() {
        brainCalls.count += 1;
        const action = brainCalls.actions.shift();
        if (!action) throw new Error("recovery must not ask the brain again");
        return { action };
      },
    },
    grantVerifier: {
      async verify(grant) {
        verifierCalls.count += 1;
        return structuredClone(grant);
      },
    },
  });
}

async function missing(file) {
  await assert.rejects(readFile(file), (error) => error?.code === "ENOENT");
}

test("restart resumes partial per-attempt cancellation cleanup without replay", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "code-job-recovery-"));
  const sourceRoot = path.join(root, "source");
  const scratchRoot = path.join(root, "scratch");
  const stateRoot = path.join(root, "state");
  const journalRoot = path.join(root, "execution-artifacts");
  const sourceFile = path.join(sourceRoot, "src", "app.js");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, SOURCE_CONTENT);
  t.after(() => rm(root, { recursive: true, force: true }));

  const clock = monotonicClock();
  const first = await recoverDurableServices(stateRoot, clock.jobs);
  const firstBrokerCalls = { create: 0, write: 0, discard: 0 };
  const firstBroker = brokerWithFaults(
    new CodeWorkspaceBroker({
      scratchRoot,
      workspaces: [{
        id: WORKSPACE_ID,
        sourceRoot,
        writablePaths: ["src"],
      }],
    }),
    firstBrokerCalls,
    { loseWrite: true, failDiscard: 2 },
  );
  const firstExecutor = createExecutor({
    broker: firstBroker,
    store: first.store,
    journalRoot,
    clock: clock.executor,
  });
  await firstExecutor.recover();
  const firstExecutorCalls = { start: 0, resume: 0, perform: 0, cancel: 0 };
  const firstBrain = {
    count: 0,
    actions: [
      { type: "read_text", path: "src/app.js" },
      { type: "write_text", path: "src/app.js", content: UNCERTAIN_CONTENT },
    ],
  };
  const firstVerifier = { count: 0 };
  const firstWorker = worker({
    jobs: first.jobs,
    executor: measuredExecutor(firstExecutor, firstExecutorCalls),
    brainCalls: firstBrain,
    verifierCalls: firstVerifier,
  });

  const created = await first.jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;
  const attemptOne = path.join(
    scratchRoot,
    WORKSPACE_ID,
    attemptExecutionId(jobId, 1),
    "src",
    "app.js",
  );
  const attemptTwo = path.join(
    scratchRoot,
    WORKSPACE_ID,
    attemptExecutionId(jobId, 2),
    "src",
    "app.js",
  );

  await firstWorker.runCycle();
  assert.equal((await firstWorker.runCycle()).outcomes[0].status, "unknown");
  assert.equal((await firstWorker.runCycle()).outcomes[0].status, "active");
  assert.equal(await readFile(attemptOne, "utf8"), UNCERTAIN_CONTENT);
  assert.equal(await readFile(attemptTwo, "utf8"), SOURCE_CONTENT);

  const active = await first.jobs.getForWorker(jobId);
  await first.jobs.cancel({
    jobId,
    expectedRevision: active.revision,
    reason: "Stop after the uncertain write",
  });
  const partial = await firstWorker.runCycle();
  assert.equal(partial.outcomes[0].status, "cancelling");
  assert.equal(partial.outcomes[0].code, "WORKSPACE_DISPOSAL_PENDING");
  await missing(attemptOne);
  assert.equal(await readFile(attemptTwo, "utf8"), SOURCE_CONTENT);
  assert.deepEqual(firstBrokerCalls, { create: 2, write: 1, discard: 2 });
  assert.deepEqual(firstExecutorCalls, {
    start: 1,
    resume: 1,
    perform: 2,
    cancel: 1,
  });
  const actionsBeforeRestart = (await firstExecutor.view({ sessionId: jobId }))
    .actions;

  const restarted = await recoverDurableServices(stateRoot, clock.jobs);
  const restartedBrokerCalls = { create: 0, write: 0, discard: 0 };
  const restartedExecutor = createExecutor({
    broker: brokerWithFaults(
      new CodeWorkspaceBroker({
        scratchRoot,
        workspaces: [{
          id: WORKSPACE_ID,
          sourceRoot,
          writablePaths: ["src"],
        }],
      }),
      restartedBrokerCalls,
    ),
    store: restarted.store,
    journalRoot,
    clock: clock.executor,
  });
  await restartedExecutor.recover();
  const restartedExecutorCalls = {
    start: 0,
    resume: 0,
    perform: 0,
    cancel: 0,
  };
  const restartedBrain = { count: 0, actions: [] };
  const restartedVerifier = { count: 0 };
  const restartedWorker = worker({
    jobs: restarted.jobs,
    executor: measuredExecutor(restartedExecutor, restartedExecutorCalls),
    brainCalls: restartedBrain,
    verifierCalls: restartedVerifier,
  });

  assert.equal((await restartedWorker.runCycle()).outcomes[0].status, "cancelled");
  const cancelled = await restarted.jobs.getForWorker(jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.execution.cancellationSettlement.proofDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(restartedExecutorCalls, {
    start: 0,
    resume: 0,
    perform: 0,
    cancel: 1,
  });
  assert.deepEqual(restartedBrokerCalls, { create: 0, write: 0, discard: 2 });
  assert.equal(restartedBrain.count, 0);
  assert.equal(restartedVerifier.count, 0);
  assert.deepEqual(
    (await restartedExecutor.view({ sessionId: jobId })).actions,
    actionsBeforeRestart,
  );
  await missing(attemptOne);
  await missing(attemptTwo);
  assert.equal(await readFile(sourceFile, "utf8"), SOURCE_CONTENT);
  assert.deepEqual(await restarted.jobs.readChangePackageDeliveryBatch(), {
    cursor: 0,
    highWatermark: 0,
    items: [],
  });

  const projector = new CodeJobMemoryProjector({
    projectionSource: {
      readBatch: (value) => restarted.jobs.readMemoryProjectionBatch(value),
      ack: (value) => restarted.jobs.acknowledgeMemoryProjection(value),
    },
    memoryProducer: restarted.memory,
  });
  const projected = await projector.runCycle();
  assert.equal(projected.pending, 0);
  assert.equal((await projector.runCycle()).observed, 0);
  const records = restarted.memory.search({
    repository: "acme/dashboard",
    eventType: "code_job.cancelled",
  });
  assert.equal(records.totalMatched, 1);
});
