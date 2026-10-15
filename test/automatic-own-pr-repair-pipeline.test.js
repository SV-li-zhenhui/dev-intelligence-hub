import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { CODE_JOB_ACTIONS_BY_OPERATION, codeJobIdForGrant, createCodeJobGrant } from "../src/domain/code-job-contract.js";
import { createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { createControlledCommitEvidence, createControlledCommitMessage } from "../src/domain/controlled-commit-evidence.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { AutomaticOwnPrRepair } from "../src/services/automatic-own-pr-repair.js";
import { CodeActionProposalHandler } from "../src/services/code-action-proposal-handler.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { OwnerWorkRequestService } from "../src/services/owner-work-request-service.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { StateStore } from "../src/lib/state-store.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { internalReviewEvidence } from "../src/domain/internal-repair-review.js";
import { ownReviewFeedbackDigest } from "../src/adapters/github-own-review-feedback.js";
import { OriginalRepairFeedbackReader } from "../src/services/original-repair-feedback-reader.js";
import { createOriginalRepairFeedbackSnapshot, createOriginalRepairFeedbackArchiveRecord,
  originalRepairFeedbackArchiveKey, originalRepairFeedbackArchiveReference } from "../src/domain/original-repair-feedback.js";
import { currentWorkItemExecutionBinding } from "../src/services/work-ledger-pr-source.js";
import { pullRequestExternalActionBinding } from "./support/pull-request-external-action-fixture.js";

const CREATED_AT = "2026-10-10T03:00:00.000Z";
const ORIGINAL_FEEDBACK = { changeRequests: [{ id: "review-123", author: "reviewer", body: "Fix the reviewed race",
  submittedAt: "2026-10-10T01:00:00Z", reviewedHeadRefOid: "2".repeat(40) }], threads: [] };
const FEEDBACK_DIGEST = ownReviewFeedbackDigest(ORIGINAL_FEEDBACK);
const STATE_KEY = "automatic-own-pr-repair-state";
const clone = (value) => structuredClone(value);

class MemoryStore {
  values = new Map();
  async read(key, fallback) { return clone(this.values.has(key) ? this.values.get(key) : fallback); }
  async write(key, value) { this.values.set(key, clone(value)); }
}

function codeProposal(binding) {
  return normalizeBoundWorkProposal({
    proposalId: "own-pr-repair-code-proposal", policyVersion: 7, kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: binding.rootItemId },
    source: { assignmentId: "assignment-own-pr-repair", eventId: binding.eventId },
    binding: {
      eventId: binding.eventId,
      subject: { id: binding.rootItemId, repository: binding.repository, number: binding.pullRequestNumber },
      repository: binding.repository, workspaceId: "repair-workspace", inputBinding: binding,
      executionSource: createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src", "test"] }),
    },
    payload: {
      operation: "modify", objective: "Fix the reviewed race and add a regression test",
      acceptanceCriteria: ["Configured regression profile passes"], evidence: ["review:123"],
      summary: "Repair my PR", reason: "An external reviewer identified a reproducible bug",
    },
  });
}

function grantFor(proposal) {
  return createCodeJobGrant({
    schemaVersion: 3, proposalId: proposal.proposalId, contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion, requestedBy: proposal.requestedBy, source: proposal.source,
    subject: proposal.binding.subject, repository: proposal.binding.repository,
    workspaceId: proposal.binding.workspaceId, inputBinding: proposal.binding.inputBinding,
    executionSource: proposal.binding.executionSource,
    workspaceAuthorityDigest: "9".repeat(64), ...proposal.payload,
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ["src", "test"],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
}

function queuedJob(grant) {
  return {
    jobId: codeJobIdForGrant(grant), status: "queued", revision: 1,
    proposalId: grant.proposalId, proposalContentDigest: grant.contentDigest, grantDigest: grant.grantDigest,
    requestedBy: grant.requestedBy, subject: grant.subject, repository: grant.repository,
    workspaceId: grant.workspaceId, inputBinding: grant.inputBinding, executionSource: grant.executionSource,
    operation: grant.operation, objective: grant.objective, acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence, summary: grant.summary, reason: grant.reason, allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths, requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
    turn: 0, pendingActionType: null, observationCount: 0, latestObservation: null,
    terminalResult: null, memoryProjection: null, pause: null, uncertainty: null,
    createdAt: CREATED_AT, updatedAt: CREATED_AT,
  };
}

function controlledCommit(grant, overrides = {}) {
  const workspace = { id: grant.workspaceId, sourceRevision: "a".repeat(64), workspaceRevision: "b".repeat(64) };
  const artifact = (kind, marker) => ({ path: `repair/node-tests/${kind}.json`, sha256: marker.repeat(64), bytes: 12 });
  const manifest = createChangePackage({
    job: { id: codeJobIdForGrant(grant), revision: 7, recordDigest: "9".repeat(64) },
    proposal: { id: grant.proposalId, contentDigest: grant.contentDigest },
    grant: { digest: grant.grantDigest }, workspace,
    passedProfiles: [{
      id: "node-tests", configDigest: "b".repeat(64), workspaceRevision: workspace.workspaceRevision,
      actionId: "action-node-tests", attemptNumber: 1, imageId: "sha256:image-node-tests",
      artifacts: { output: artifact("output", "c"), stdout: artifact("stdout", "d"), stderr: artifact("stderr", "e") },
    }],
    created: [], modified: [{ path: "src/value.js", beforeSha256: "f".repeat(64), content: Buffer.from("fixed\n") }], deleted: [],
    ...overrides,
  }).manifest;
  const identity = { name: "MyDashboard Developer", email: "developer@mydashboard.local", timestamp: Date.parse(CREATED_AT) / 1_000, timezone: "+0000" };
  const finalTreeOid = "5".repeat(40);
  return createControlledCommitEvidence({
    executionSource: grant.executionSource, manifest,
    resolution: { resolvedPaths: ["src/value.js"], finalTreeOid },
    commit: {
      objectFormat: "sha1", oid: "6".repeat(40), treeOid: finalTreeOid,
      parents: [grant.inputBinding.headRefOid], author: identity, committer: identity,
      messageDigest: createHash("sha256").update(createControlledCommitMessage({ executionSource: grant.executionSource, manifest })).digest("hex"),
      objectSetDigest: "e".repeat(64),
    }, createdAt: CREATED_AT,
  });
}

async function fixture({ enabled = true, pushOutcome = "applied", store = new MemoryStore(), clock = () => new Date(CREATED_AT) } = {}) {
  const binding = pullRequestExternalActionBinding({
    gitTarget: { headRepository: "acme/repo", headRefName: "fix/review-feedback" },
  });
  const proposal = codeProposal(binding);
  const grant = grantFor(proposal);
  const config = {
    trackedRepositories: [binding.repository],
    githubActions: { enabled: true, automaticOwnPrRepair: enabled, actorAccountId: "runtime-user" },
    workCoordination: { policy: { workspaceByRepository: { [binding.repository]: grant.workspaceId } } },
    codeExecutor: { workspaces: [{ id: grant.workspaceId, gitHeadSnapshot: true, writablePaths: grant.writablePaths }] },
  };
  const item = { itemId: binding.rootItemId, event: {
    subject: { repository: binding.repository, number: binding.pullRequestNumber },
    payload: { relation: "authored", nextAction: "address_review", reviewFeedbackDigest: FEEDBACK_DIGEST },
  } };
  const facts = { state: "open", author: "runtime-user", headRefOid: binding.headRefOid,
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: FEEDBACK_DIGEST, feedback: clone(ORIGINAL_FEEDBACK) };
  const context = { inputBinding: binding, author: "runtime-user" };
  const jobs = new Map();
  const details = new Map();
  const verified = new Map();
  const pushes = [];
  let codeJobApprovalCount = 0;
  const guardFactory = () => ({ async acquire() {}, run: (operation) => operation(), async close() {} });
  const routing = await createWorkflowRoutingRuntime({ workflowRouting: { schemaVersion: 1, enabled: true, maxHops: 8, rules: [] } },
    { store, createGuard: guardFactory, clock });
  const reviewLedger = await createWorkLedgerRuntime({ store, assignmentSource: routing, createGuard: guardFactory,
    clock, idFactory: () => "review-delivery-lease" });
  const ownerWorkRequests = new OwnerWorkRequestService({ store, workflowRouting: routing, ledger: reviewLedger,
    roleReadiness: { async read(roleId) { return { roleId, enabled: true, paused: false }; } },
    pullRequestResolver: { async resolvePullRequestTarget() { return { repository: binding.repository,
      number: binding.pullRequestNumber, title: "Review repaired PR", state: facts.state,
      gitTarget: { ...binding.gitTarget, headRefOid: facts.headRefOid } }; } },
    exclusiveLease: { run: (operation) => operation() }, clock });
  await ownerWorkRequests.recover();
  let loseReviewAcknowledgement = false;
  let deliveryPaused = false;
  const internalReviewPort = { async submitInternalReview(request) {
    if (deliveryPaused) throw new Error("internal review dispatch temporarily unavailable");
    const result = await ownerWorkRequests.submitInternalReview(request);
    if (loseReviewAcknowledgement) { loseReviewAcknowledgement = false; throw new Error("lost internal review acknowledgement"); }
    return result;
  } };
  let service;
  let queue;
  let failNextPushEnqueue = false;
  let grantCurrent = true;
  const executor = {
    async execute(envelope) {
      if (envelope.kind === "local.code-job-create") {
        const repair = (await store.read(STATE_KEY)).repairs.find((row) => row.jobId === codeJobIdForGrant(envelope.action.grant));
        assert.ok((await store.read(originalRepairFeedbackArchiveKey(repair.feedbackSnapshotId))).snapshot,
          "complete feedback must be durable before approving the modify job");
        codeJobApprovalCount += 1;
        const job = queuedJob(envelope.action.grant);
        jobs.set(job.jobId, job);
        return { status: "applied", receipt: { id: job.jobId, createdAt: CREATED_AT } };
      }
      assert.equal(envelope.kind, "github.pull-request-push");
      assert.equal(await service.verifyPush(envelope), true, "push must have current automatic repair authority");
      pushes.push(clone(envelope));
      if (pushOutcome === "unknown") return { status: "unknown", code: "TEST_PUSH_UNKNOWN" };
      facts.headRefOid = envelope.action.controlledCommitEvidence.commit.oid;
      return { status: "applied", receipt: { id: envelope.action.controlledCommitEvidence.commit.oid, createdAt: CREATED_AT } };
    },
    async reconcile() { return { status: "unknown", code: "TEST_PUSH_UNKNOWN" }; },
  };
  const confirmationPort = {
    async enqueue(plan) {
      if (failNextPushEnqueue && plan.kind === "github.pull-request-push") {
        failNextPushEnqueue = false;
        throw Object.assign(new Error("simulated crash before queue write"), { code: "TEST_ENQUEUE_CRASH" });
      }
      return queue.enqueue(plan);
    },
    get: (...args) => queue.get(...args), approve: (...args) => queue.approve(...args),
    invalidate: (...args) => queue.invalidate(...args),
  };
  function makeQueue() {
    return new ConfirmationQueue({ store, executor, exclusiveLease: { run: (operation) => operation() }, clock });
  }
  function makeService() {
    return new AutomaticOwnPrRepair({
      configurationReader: { async readActive() { return { configuration: config }; } }, store,
      ledger: { async readPullRequestExecutionContext() { return clone(context); }, async readItemForReconciliation() { return clone(item); } },
      github: { async readOwnPullRequestFeedback() { return clone(facts); } }, confirmations: confirmationPort,
      codeJobReader: { async getDetail({ jobId }) { return clone(details.get(jobId) ?? null); } },
      controlledCommitReader: { async verify({ evidenceId }) { return clone(verified.get(evidenceId)); } },
      grantVerifier: { async verify(value) {
        if (!grantCurrent) throw Object.assign(new Error("revoked grant"), { code: "INVALID_CODE_JOB_AUTHORITY" });
        return clone(value);
      } },
      ownerWorkRequests: internalReviewPort,
      clock,
      historicalRepairFeedbackReader: { async read({ inputBinding, feedbackDigest }) {
        return { context: { schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest, feedback: clone(ORIGINAL_FEEDBACK) },
          provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: facts.headRefOid, observedAt: CREATED_AT } };
      } },
    });
  }
  queue = makeQueue(); await queue.recover();
  service = makeService(); await service.recover();
  function handler() {
    return new CodeActionProposalHandler({
      confirmationProducer: confirmationPort, codeJobReader: { async get(id) { return clone(jobs.get(id) ?? null); } },
      grantFactory: { async create() { return { grant, allowedOperationsByRole: { developer: ["inspect", "modify", "verify"] } }; } },
      automaticOwnPrRepair: service, clock: () => new Date(CREATED_AT),
    });
  }
  return {
    store, binding, proposal, grant, config, item, facts, context, jobs, pushes, ownerWorkRequests, reviewLedger,
    get service() { return service; }, get queue() { return queue; },
    get codeJobApprovalCount() { return codeJobApprovalCount; },
    async deliver() { return handler().handle({ proposal, status: "pending_delivery", attempt: 1, downstreamRef: null }); },
    async resume(transition) { return handler().handle({ proposal, status: transition.status, attempt: 2, downstreamRef: transition.downstreamRef }); },
    completeJob(overrides) {
      const evidence = controlledCommit(grant, overrides);
      verified.set(evidence.evidenceId, evidence);
      details.set(codeJobIdForGrant(grant), {
        job: { ...queuedJob(grant), status: "completed" },
        changePackage: { receipt: { controlledCommit: { evidenceId: evidence.evidenceId, evidenceDigest: evidence.evidenceDigest, commitOid: evidence.commit.oid } } },
      });
      return evidence;
    },
    crashBeforePushQueueWrite() { failNextPushEnqueue = true; },
    revokeGrant() { grantCurrent = false; },
    loseReviewAcknowledgement() { loseReviewAcknowledgement = true; },
    pauseReviewDelivery(value = true) { deliveryPaused = value; },
    async restart() {
      queue = makeQueue(); await queue.recover();
      service = makeService(); await service.recover();
    },
  };
}

test("own PR feedback creates and publishes an approved repair through the real confirmation and proposal pipeline", async () => {
  const f = await fixture();
  const transition = await f.deliver();
  assert.equal(transition.status, "running");
  assert.equal(f.jobs.size, 1, "code job is automatically approved without user input");
  assert.equal((await f.queue.get(transition.downstreamRef)).status, "completed");
  const evidence = f.completeJob();
  assert.equal(await f.service.shouldRun(f.item), false, "running repair suppresses duplicate decisions");
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].action.controlledCommitEvidence.evidenceId, evidence.evidenceId);
  assert.equal(f.pushes[0].action.inputBinding.gitTarget.headRefName, "fix/review-feedback");
  assert.deepEqual(f.pushes[0].action.controlledCommitEvidence.commit.parents, [f.binding.headRefOid]);
  assert.equal((await f.service.runCycle()).published, 1);
  const history = await f.queue.list();
  assert.deepEqual(history.items.map(({ automaticOwnPrRepair }) => automaticOwnPrRepair.stage).sort(), ["code_task", "push"]);
  assert.equal(await f.service.shouldRun(f.item), false);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "published");
  assert.equal(f.store.values.get(STATE_KEY).published.length, 1);
});

test("automatic modification captures original complete feedback before approval and exposes its immutable binding after publication", async () => {
  const f = await fixture(); await f.deliver();
  const before = await f.store.read(STATE_KEY);
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.feedbackSnapshots.length, 0);
  const captured = (await f.store.read(originalRepairFeedbackArchiveKey(before.repairs[0].feedbackSnapshotId))).snapshot;
  assert.equal(captured.originalHeadRefOid, f.binding.headRefOid);
  assert.equal(captured.feedbackDigest, FEEDBACK_DIGEST);
  assert.equal(captured.provenance.kind, "captured_before_repair");
  f.completeJob(); await f.service.runCycle(); await f.service.runCycle();
  const published = (await f.store.read(STATE_KEY)).published[0];
  const original = await f.service.readOriginalFeedbackSnapshot({ snapshotId: published.feedbackSnapshotId,
    repository: f.binding.repository, number: f.binding.pullRequestNumber, feedbackDigest: FEEDBACK_DIGEST,
    originalHeadRefOid: f.binding.headRefOid });
  assert.equal(original.feedback.changeRequests[0].body, "Fix the reviewed race");
  f.facts.feedback.changeRequests[0].body = "a later live change";
  assert.equal((await f.service.readOriginalFeedbackSnapshot({ snapshotId: original.snapshotId,
    repository: f.binding.repository, number: f.binding.pullRequestNumber, feedbackDigest: FEEDBACK_DIGEST,
    originalHeadRefOid: f.binding.headRefOid })).feedback.changeRequests[0].body, "Fix the reviewed race");
  f.config.githubActions.automaticOwnPrRepair = false;
  const request = (await f.ownerWorkRequests.list()).items[0];
  const current = await f.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
  const reader = new OriginalRepairFeedbackReader({ store: f.store, executionContextReader: f.reviewLedger });
  const beforeRead = JSON.stringify(await f.store.read(STATE_KEY));
  const descriptor = await reader.readBinding({ inputBinding: currentWorkItemExecutionBinding(current), internalReview: request.request.internalReview });
  assert.equal(descriptor.snapshotId, original.snapshotId, "disabling new repairs cannot erase captured review evidence");
  assert.equal((await reader.read({ snapshotId: descriptor.snapshotId, repository: f.binding.repository,
    number: f.binding.pullRequestNumber, feedbackDigest: descriptor.feedbackDigest, originalHeadRefOid: descriptor.originalHeadRefOid })).feedbackDigest, FEEDBACK_DIGEST);
  assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), beforeRead, "independent review reader cannot write state");
});

function historicalFeedbackState(count, bodyBytes = 32) {
  const feedbackSnapshots = Array.from({ length: count }, (_, index) => {
    const feedback = { changeRequests: [{ id: `historical-review-${index}`, author: "reviewer", body: `${index}:` + "x".repeat(bodyBytes) }], threads: [] };
    return createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 1_000 + index,
      context: { schemaVersion: 1, headRefOid: "a".repeat(40), reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
      provenance: { kind: "captured_before_repair", observedHeadRefOid: "a".repeat(40), observedAt: CREATED_AT } });
  });
  return { schemaVersion: 1, repairs: [], feedbackSnapshots, published: feedbackSnapshots.map((snapshot, index) => ({
    repository: snapshot.repository, number: snapshot.number, feedbackDigest: snapshot.feedbackDigest,
    feedbackSnapshotId: snapshot.snapshotId, feedbackFingerprints: [createHash("sha256").update(`historical-${index}`).digest("hex")],
    commitOid: "b".repeat(40), confirmationId: `historical-push-${index}`,
  })) };
}

for (const [name, count, bodyBytes] of [["round 129", 128, 32], ["16 MiB aggregate rollover", 15, 1024 * 1024]]) {
  test(`automatic modification admits ${name} while preserving every archived and active snapshot`, async () => {
    const f = await fixture();
    const legacy = historicalFeedbackState(count, bodyBytes);
    await f.store.write(STATE_KEY, legacy);
    await f.service.recover();
    const reader = new OriginalRepairFeedbackReader({ store: f.store });
    const before = JSON.stringify(await f.store.read(STATE_KEY));
    assert.deepEqual(await reader.read(legacy.feedbackSnapshots[0]), legacy.feedbackSnapshots[0]);
    assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), before, "legacy reads preserve inline state");
    if (bodyBytes > 32) {
      f.facts.feedback.changeRequests[0].body = "new round " + "n".repeat(bodyBytes);
      f.facts.reviewFeedbackDigest = ownReviewFeedbackDigest(f.facts.feedback);
      f.item.event.payload.reviewFeedbackDigest = f.facts.reviewFeedbackDigest;
      assert.ok(Buffer.byteLength(JSON.stringify(legacy.feedbackSnapshots)) + Buffer.byteLength(JSON.stringify(f.facts.feedback)) > 16 * 1024 * 1024);
    }
    assert.equal((await f.deliver()).status, "running");
    const state = await f.store.read(STATE_KEY);
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.feedbackSnapshots, []);
    assert.deepEqual(state.published.map(({ feedbackSnapshotArchive: _archive, ...row }) => row), legacy.published);
    assert.equal(state.repairs.length, 1);
    assert.equal(state.repairs[0].status, "working");
    f.config.githubActions.automaticOwnPrRepair = false;
    await f.restart();
    for (const snapshot of legacy.feedbackSnapshots) {
      assert.deepEqual(await reader.read(snapshot), snapshot);
      assert.deepEqual(await f.service.readOriginalFeedbackSnapshot(snapshot), snapshot);
    }
    const active = state.repairs[0].feedbackSnapshotArchive;
    assert.deepEqual((await reader.read(active)).feedback, f.facts.feedback);
    assert.equal([...f.store.values.keys()].filter((key) => key.startsWith("original-repair-feedback-record-")).length, count + 1);
  });
}

for (const failure of ["archive-before-write", "archive-lost-ack", "archive-readback", "state-before-write", "state-lost-ack"]) {
  test(`snapshot archival recovers ${failure} without a lost body or duplicate approval`, async () => {
    const store = new MemoryStore();
    const f = await fixture({ store });
    const originalRead = store.read.bind(store), originalWrite = store.write.bind(store);
    let armed = true, archiveWasWritten = false;
    store.write = async (key, value) => {
      const archive = key.startsWith("original-repair-feedback-record-");
      if (armed && ((failure === "archive-before-write" && archive) || (failure === "state-before-write" && key === STATE_KEY))) {
        armed = false; throw new Error(failure);
      }
      await originalWrite(key, value);
      if (archive) archiveWasWritten = true;
      if (armed && ((failure === "archive-lost-ack" && archive) || (failure === "state-lost-ack" && key === STATE_KEY))) {
        armed = false; throw new Error(failure);
      }
    };
    store.read = async (key, fallback) => {
      if (armed && failure === "archive-readback" && archiveWasWritten && key.startsWith("original-repair-feedback-record-")) {
        armed = false; throw new Error(failure);
      }
      return originalRead(key, fallback);
    };
    await assert.rejects(f.deliver(), new RegExp(failure));
    assert.equal(f.jobs.size, 0, "feedback must be verified before approval");
    const partial = await store.read(STATE_KEY, { repairs: [] });
    assert.equal(partial.repairs.length, failure === "state-lost-ack" ? 1 : 0);
    await f.restart();
    const resumed = await f.deliver();
    assert.equal(resumed.status, "running");
    assert.deepEqual(await f.deliver(), resumed);
    await f.restart();
    assert.equal((await store.read(STATE_KEY)).repairs.length, 1);
    assert.equal([...store.values.keys()].filter((key) => key.startsWith("original-repair-feedback-record-")).length, 1);
    assert.equal(f.jobs.size, 1);
    const reference = (await store.read(STATE_KEY)).repairs[0].feedbackSnapshotArchive;
    assert.deepEqual((await f.service.readOriginalFeedbackSnapshot(reference)).feedback, ORIGINAL_FEEDBACK);
  });
}

for (const failure of ["partial-archive-write", "partial-archive-readback", "migration-state-lost-ack"]) {
  test(`legacy multi-snapshot migration recovers ${failure} across a later-clock restart`, async () => {
    let now = CREATED_AT;
    const f = await fixture({ clock: () => new Date(now) });
    const legacy = historicalFeedbackState(3);
    await f.store.write(STATE_KEY, legacy);
    await f.service.recover();
    const inlineBytes = JSON.stringify(await f.store.read(STATE_KEY));
    const historicalKeys = legacy.feedbackSnapshots.map(({ snapshotId }) => originalRepairFeedbackArchiveKey(snapshotId));
    const firstKey = historicalKeys[0], interruptedKey = historicalKeys[1];
    const originalRead = f.store.read.bind(f.store), originalWrite = f.store.write.bind(f.store);
    const verifiedArchives = new Set(), archiveWrites = new Map();
    let armed = true, migrationPending = true;
    f.store.write = async (key, value) => {
      if (key.startsWith("original-repair-feedback-record-")) {
        if (migrationPending) assert.equal(JSON.stringify(await originalRead(STATE_KEY)), inlineBytes,
          "archive writes cannot release any historical inline body");
        if (armed && failure === "partial-archive-write" && key === interruptedKey) {
          assert.ok(verifiedArchives.has(firstKey), "interruption follows a durable, verified earlier archive");
          armed = false;
          throw new Error(failure);
        }
        await originalWrite(key, value);
        archiveWrites.set(key, (archiveWrites.get(key) ?? 0) + 1);
        return;
      }
      if (key === STATE_KEY && migrationPending) {
        assert.equal(JSON.stringify(await originalRead(STATE_KEY)), inlineBytes,
          "the old inline state remains byte-for-byte intact until migration commits");
        for (const row of [...value.repairs, ...value.published]) {
          assert.ok(verifiedArchives.has(originalRepairFeedbackArchiveKey(row.feedbackSnapshotId)),
            "every referenced archive must pass readback before committing the hot state");
        }
        assert.equal(value.published.length, legacy.published.length);
        assert.equal(value.repairs.length, 1);
        assert.deepEqual(value.feedbackSnapshots, []);
        migrationPending = false;
        await originalWrite(key, value);
        if (armed && failure === "migration-state-lost-ack") {
          armed = false;
          throw new Error(failure);
        }
        return;
      }
      return originalWrite(key, value);
    };
    f.store.read = async (key, fallback) => {
      const value = await originalRead(key, fallback);
      if (key.startsWith("original-repair-feedback-record-") && value) {
        if (armed && failure === "partial-archive-readback" && key === interruptedKey) {
          assert.ok(verifiedArchives.has(firstKey), "interruption follows a durable, verified earlier archive");
          armed = false;
          throw new Error(failure);
        }
        verifiedArchives.add(key);
      }
      return value;
    };
    await assert.rejects(f.deliver(), new RegExp(failure));
    assert.equal(armed, false, "the intended migration fault was reached");
    assert.equal(f.codeJobApprovalCount, 0, "partial migration cannot authorize a code job");
    assert.equal(f.jobs.size, 0);
    if (failure !== "migration-state-lost-ack") {
      assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), inlineBytes);
    } else {
      assert.equal((await f.store.read(STATE_KEY)).schemaVersion, 2, "a lost acknowledgement retains the committed state");
    }
    const committedArchives = new Map([...f.store.values]
      .filter(([key]) => key.startsWith("original-repair-feedback-record-"))
      .map(([key, value]) => [key, JSON.stringify(value)]));
    assert.ok(committedArchives.has(firstKey));
    now = "2026-10-11T03:00:00.000Z";
    await f.restart();
    const resumed = await f.deliver();
    assert.equal(resumed.status, "running");
    assert.deepEqual(await f.deliver(), resumed);
    await f.restart();
    const migrated = await f.store.read(STATE_KEY);
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.feedbackSnapshots, []);
    assert.deepEqual(migrated.published.map(({ feedbackSnapshotArchive: _archive, ...row }) => row), legacy.published);
    const reader = new OriginalRepairFeedbackReader({ store: f.store });
    for (const [index, snapshot] of legacy.feedbackSnapshots.entries()) {
      assert.deepEqual(migrated.published[index].feedbackSnapshotArchive, originalRepairFeedbackArchiveReference(snapshot));
      assert.deepEqual(await reader.read(migrated.published[index].feedbackSnapshotArchive), snapshot);
      assert.deepEqual(await f.service.readOriginalFeedbackSnapshot(snapshot), snapshot);
    }
    const active = await reader.read(migrated.repairs[0].feedbackSnapshotArchive);
    assert.deepEqual(active.feedback, ORIGINAL_FEEDBACK);
    assert.equal(active.originalHeadRefOid, f.binding.headRefOid);
    assert.equal(active.provenance.observedAt, failure === "migration-state-lost-ack" ? CREATED_AT : now);
    assert.equal(migrated.repairs.length, 1);
    assert.equal(f.codeJobApprovalCount, 1, "restart and repeated delivery approve the new repair exactly once");
    assert.equal(f.jobs.size, 1);
    assert.equal(f.pushes.length, 0);
    for (const [key, bytes] of committedArchives) {
      assert.equal(JSON.stringify(await f.store.read(key)), bytes, "retry preserves each committed immutable archive byte-for-byte");
    }
    assert.ok([...archiveWrites.values()].every((count) => count === 1), "retry cannot rewrite an existing archive");
    assert.equal(archiveWrites.size, legacy.feedbackSnapshots.length + 1);
  });
}

test("a corrupt immutable feedback archive is never overwritten or approved", async () => {
  const f = await fixture();
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: f.binding.repository, number: f.binding.pullRequestNumber,
    context: { schemaVersion: 1, headRefOid: f.binding.headRefOid, reviewFeedbackDigest: FEEDBACK_DIGEST, feedback: ORIGINAL_FEEDBACK },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: f.binding.headRefOid, observedAt: CREATED_AT } });
  const key = originalRepairFeedbackArchiveKey(snapshot.snapshotId);
  const corrupt = clone(createOriginalRepairFeedbackArchiveRecord(snapshot));
  corrupt.snapshot.feedback.changeRequests[0].body = "different body with the old hash";
  await f.store.write(key, corrupt);
  const before = JSON.stringify(await f.store.read(key));
  await assert.rejects(f.deliver(), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  assert.equal(JSON.stringify(await f.store.read(key)), before);
  assert.equal(await f.store.read(STATE_KEY, null), null);
  assert.equal(f.jobs.size, 0);
});

test("new publication references require a verified archive and snapshots retain the 2 MiB body boundary", async () => {
  const f = await fixture();
  const snapshot = historicalFeedbackState(1).feedbackSnapshots[0];
  await assert.rejects(f.service.recordPublished({ repository: snapshot.repository, number: snapshot.number,
    feedbackDigest: snapshot.feedbackDigest, commitOid: "b".repeat(40), confirmationId: "missing-archive-publication",
    feedbackSnapshotId: snapshot.snapshotId, feedbackSnapshotArchive: originalRepairFeedbackArchiveReference(snapshot) }),
  { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  assert.equal(await f.store.read(STATE_KEY, null), null);
  const feedback = { changeRequests: [{ id: "oversized", author: "reviewer", body: "x".repeat(2 * 1024 * 1024) }], threads: [] };
  assert.throws(() => createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 42,
    context: { schemaVersion: 1, headRefOid: "a".repeat(40), reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: "a".repeat(40), observedAt: CREATED_AT } }),
  { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
});

for (const matched of [true, false]) {
  test(`legacy original feedback recovery ${matched ? "preserves exact digest and separate observed Head" : "fails closed on changed original requests"}`, async () => {
    const f = await fixture(); f.pauseReviewDelivery(); await f.deliver(); f.completeJob();
    await f.service.runCycle(); await f.service.runCycle();
    const state = await f.store.read(STATE_KEY); state.feedbackSnapshots = [];
    for (const entry of [...state.repairs, ...state.published]) { delete entry.feedbackSnapshotId; delete entry.feedbackSnapshotArchive; }
    await f.store.write(STATE_KEY, state); await f.restart();
    if (!matched) f.service.historicalRepairFeedbackReader = { async read({ inputBinding, feedbackDigest }) {
      return { context: { schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest,
        feedback: { changeRequests: [{ ...ORIGINAL_FEEDBACK.changeRequests[0], body: "a different defect" }], threads: [] } },
        provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: f.facts.headRefOid, observedAt: CREATED_AT } };
    } };
    f.pauseReviewDelivery(false); const result = await f.service.runCycle(); const recovered = await f.store.read(STATE_KEY);
    if (matched) {
      assert.equal(result.reviewDelivered, 1, "the first recovery cycle records its successful internal intake");
      assert.equal(result.reviewPending, undefined);
      assert.equal(result.lastReviewFailure, undefined);
      assert.equal(recovered.published[0].reviewDelivery.status, "completed");
      const snapshot = (await f.store.read(originalRepairFeedbackArchiveKey(recovered.published[0].feedbackSnapshotId))).snapshot;
      assert.equal(snapshot.originalHeadRefOid, f.binding.headRefOid);
      assert.equal(snapshot.provenance.observedHeadRefOid, f.facts.headRefOid);
      assert.notEqual(snapshot.originalHeadRefOid, snapshot.provenance.observedHeadRefOid);
      assert.equal(snapshot.feedbackDigest, FEEDBACK_DIGEST);
      const requests = (await f.ownerWorkRequests.list()).items;
      assert.equal(requests.length, 1);
      await f.restart();
      await f.service.runCycle();
      assert.equal((await f.store.read(STATE_KEY)).published[0].reviewDelivery.status, "completed");
      assert.deepEqual((await f.ownerWorkRequests.list()).items, requests, "restart cannot repeat an already completed intake");
    } else {
      assert.equal(result.lastReviewFailure, "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID");
      assert.equal(recovered.feedbackSnapshots.length, 0); assert.equal((await f.ownerWorkRequests.list()).items.length, 0);
    }
    assert.equal(f.pushes.length, 1);
  });
}

test("a repeated delivery and restart reuse the same repair and never publish twice", async () => {
  const f = await fixture();
  const first = await f.deliver();
  assert.deepEqual(await f.deliver(), first);
  f.completeJob();
  await f.service.runCycle();
  await f.restart();
  await f.service.runCycle();
  await f.service.runCycle();
  assert.equal(f.jobs.size, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.store.values.get(STATE_KEY).published.length, 1);
  assert.equal(await f.service.shouldRun(f.item), false);
});

test("published repair enters the real internal PR engineer intake exactly once across restart and lost acknowledgement", async () => {
  const f = await fixture(); await f.deliver(); const evidence = f.completeJob();
  await f.service.runCycle(); f.loseReviewAcknowledgement();
  const reconciliation = await f.service.runCycle();
  assert.equal(f.store.values.get(STATE_KEY).published[0].reviewDelivery.status, "pending");
  const before = await f.ownerWorkRequests.list();
  assert.equal(before.items.length, 1, JSON.stringify(reconciliation));
  assert.equal(before.items[0].assignment.target.id, "pr-engineer");
  assert.equal(before.items[0].request.internalReview.headRefOid, evidence.commit.oid);
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  const after = await f.ownerWorkRequests.list();
  assert.equal(after.items.length, 1, "normal owner request idempotency owns dispatch recovery");
  assert.equal(after.items[0].workItemId, before.items[0].workItemId);
  assert.equal(f.store.values.get(STATE_KEY).published[0].reviewDelivery.status, "completed");
  const item = await f.reviewLedger.readItemForReconciliation({ itemId: after.items[0].workItemId });
  assert.equal(item.source.current.event.source.provider, "internal-review-repair");
  assert.equal(item.source.current.event.eventType, "pull_request.internal_review_requested");
  assert.equal(f.pushes.length, 1);
  await assert.rejects(f.ownerWorkRequests.submit(after.items[0].request), { code: "OWNER_WORK_REQUEST_INTERNAL_ONLY" });
});

for (const [name, drift, reason] of [
  ["policy disabled", (f) => { f.config.githubActions.automaticOwnPrRepair = false; }, "automation_disabled"],
  ["Head replaced", (f) => { f.facts.headRefOid = "9".repeat(40); }, "head_changed"],
  ["PR closed", (f) => { f.facts.state = "closed"; }, "pull_request_closed"],
  ["PR Draft", (f) => { f.facts.isDraft = true; }, "pull_request_draft"],
]) {
  test(`pending internal repair review settles when ${name} without repushing`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(); await f.service.runCycle();
    f.loseReviewAcknowledgement(); await f.service.runCycle(); drift(f);
    await f.restart(); await f.service.runCycle();
    const delivery = f.store.values.get(STATE_KEY).published[0].reviewDelivery;
    assert.equal(delivery.status, "stale"); assert.equal(delivery.reason, reason);
    assert.equal(f.pushes.length, 1);
  });
}

test("legacy publication only recovers review for the exact verified live Head and preserves archived rows", async () => {
  const f = await fixture(); f.pauseReviewDelivery(); await f.deliver(); f.completeJob();
  await f.service.runCycle(); await f.service.runCycle();
  const state = await f.store.read(STATE_KEY);
  delete state.published[0].reviewDelivery;
  const archived = { repository: f.binding.repository, number: f.binding.pullRequestNumber,
    feedbackDigest: "8".repeat(64), commitOid: "9".repeat(40), confirmationId: "archived-unavailable-push" };
  state.published.unshift(archived);
  await f.store.write(STATE_KEY, state);
  f.pauseReviewDelivery(false); await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  const recovered = await f.store.read(STATE_KEY);
  assert.deepEqual(recovered.published[0], archived);
  assert.equal(recovered.published[1].reviewDelivery.status, "completed");
  assert.equal((await f.ownerWorkRequests.list()).items.length, 1);
  assert.equal(f.pushes.length, 1);
});

test("disk-backed repair delivery resumes a lost acknowledgement through durable normal request intake", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "repair-review-delivery-"));
  t.after(async () => {
    assert.equal(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep), true);
    await rm(directory, { recursive: true, force: true });
  });
  const f = await fixture({ store: new StateStore(directory) });
  await f.deliver(); f.completeJob(); await f.service.runCycle();
  f.loseReviewAcknowledgement(); await f.service.runCycle();
  const accepted = (await f.ownerWorkRequests.list()).items[0];
  await f.restart(); await f.ownerWorkRequests.recover(); await f.service.runCycle();
  const state = await new StateStore(directory).read(STATE_KEY);
  assert.equal(state.published[0].reviewDelivery.status, "completed");
  assert.equal(state.published[0].reviewDelivery.workItemId, accepted.workItemId);
  assert.equal((await f.ownerWorkRequests.list()).items.length, 1);
  assert.equal(f.pushes.length, 1);
});

for (const needsRepair of [false, true]) {
  test(`real internal PR review ${needsRepair ? "returns defects to development" : "completes locally"} without a self-review confirmation`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob();
    await f.service.runCycle(); await f.service.runCycle();
    const request = (await f.ownerWorkRequests.list()).items[0];
    const queued = await f.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
    const claimed = await f.reviewLedger.claim({ itemId: queued.itemId, expectedRevision: queued.revision,
      workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
    const packet = await new RoleContextAssembler({ graphReader: f.reviewLedger.graphReader,
      originalRepairFeedbackReader: new OriginalRepairFeedbackReader({ store: f.store, executionContextReader: f.reviewLedger }),
      pullRequestContextReader: { async read() { return { schemaVersion: 1, identityDigest: "a".repeat(64), contentDigest: "b".repeat(64),
        observedAt: CREATED_AT, summary: {}, comments: [], reviews: [], reviewThreads: [], checks: [], contextTruncated: false,
        reviewMaterial: { schemaVersion: 1, gitTarget: { ...f.binding.gitTarget, headRefOid: request.request.internalReview.headRefOid },
          additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false, patch: "", patchTruncated: false } }; } },
    }).assemble({
      roleId: "pr-engineer", item: claimed, trigger: "assigned" });
    const evidence = internalReviewEvidence(request.request.internalReview);
    const intent = { schemaVersion: 1, type: needsRepair ? "handoff" : "complete",
      summary: needsRepair ? "A remaining defect needs repair" : "Internal static review completed",
      reason: "Assessed the bound repair; recorded actual verification coverage separately", evidence,
      ...(needsRepair ? { capability: "development", brief: "The bound repair still has a concrete race; add a regression for that condition" }
        : { outcome: "done" }) };
    const engine = new RoleDecisionEngine({
      definition: { id: "pr-engineer", name: "PR engineer", mission: "Assess repair", enabled: true },
      permissions: { allowedIntents: ["complete", "handoff", "propose_github_review"] },
      brain: { provider: "synthetic", model: "fixture", remoteData: { code: false, memory: false, requirements: false } },
      brainRouter: { describe: () => ({ singleAttempt: true, supportsReviewReading: true }), async generate() {
        return JSON.stringify({ schemaVersion: 1, summary: intent.summary, confidence: 90, intent });
      } },
    });
    const decision = await engine.decide({ item: claimed, context: packet.context });
    await f.reviewLedger.stageIntent({ itemId: claimed.itemId, expectedRevision: claimed.revision,
      leaseId: claimed.leaseId, actorId: "employee-pr-engineer", roleId: "pr-engineer", intent: decision.intent });
    const dispatcher = new WorkIntentDispatcher({ ledger: f.reviewLedger,
      policy: createWorkIntentPolicy({ capabilityRoles: { development: "developer" } }),
      attentionProducer: { async create() { assert.fail("internal review must not create an attention request"); } },
      proposalProducer: { async create() { assert.fail("internal review must not create a GitHub proposal"); } },
      clock: () => new Date(CREATED_AT) });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.delivered, 1, JSON.stringify(result));
    const completed = await f.reviewLedger.readItemForReconciliation({ itemId: claimed.itemId });
    assert.equal(completed.status, needsRepair ? "queued" : "completed");
    if (needsRepair) assert.equal(completed.currentTarget.id, "developer");
    assert.equal((await f.queue.list()).items.length, 2, "only the original controlled code and push confirmations exist");
    assert.equal((await dispatcher.dispatchPending()).scanned, 0);
    assert.equal(f.pushes.length, 1);
  });
}

test("a crash after recording the code intent resumes approval without a second developer decision", async () => {
  const f = await fixture();
  const approve = f.queue.approve.bind(f.queue);
  f.queue.approve = async () => { throw new Error("simulated pre-approval crash"); };
  await assert.rejects(f.deliver(), /simulated pre-approval crash/);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "working");
  f.queue.approve = approve;
  await f.service.runCycle();
  assert.equal(f.jobs.size, 1);
});

test("disabled auto repair leaves the original explicit confirmation path intact", async () => {
  const f = await fixture({ enabled: false });
  const transition = await f.deliver();
  assert.equal(transition.status, "waiting_confirmation");
  assert.equal(f.jobs.size, 0);
  assert.equal((await f.queue.get(transition.downstreamRef)).status, "pending");
  assert.equal((await f.service.runCycle()).scanned, 0);
  assert.equal(f.pushes.length, 0);
});

for (const [name, drift] of [
  ["switch disabled", (f) => { f.config.githubActions.automaticOwnPrRepair = false; }],
  ["head replaced", (f) => { f.facts.headRefOid = "9".repeat(40); }],
  ["author replaced", (f) => { f.facts.author = "different-author"; }],
  ["feedback changed", (f) => { f.facts.reviewFeedbackDigest = "a".repeat(64); }],
  ["PR closed", (f) => { f.facts.state = "closed"; }],
]) {
  test(`completed repair is not pushed when ${name}`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(); drift(f);
    assert.equal((await f.service.runCycle()).stale, 1);
    await f.service.runCycle();
    assert.equal(f.pushes.length, 0);
  });
}

test("controlled evidence belonging to another job never produces a push", async () => {
  const f = await fixture(); await f.deliver();
  f.completeJob({ job: { id: "code-job-another", revision: 7, recordDigest: "9".repeat(64) } });
  const result = await f.service.runCycle();
  assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
  assert.equal(f.pushes.length, 0);
});

test("completed repair cannot publish after its versioned code authority was revoked", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob(); f.revokeGrant();
  assert.equal((await f.service.runCycle()).stale, 1);
  assert.equal(f.pushes.length, 0);
});

test("the push executor rechecks versioned code authority after its plan was saved", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob();
  const approve = f.queue.approve.bind(f.queue);
  f.queue.approve = async () => { throw new Error("paused before push approval"); };
  await f.service.runCycle();
  const pushId = f.store.values.get(STATE_KEY).repairs[0].pushConfirmationId;
  f.revokeGrant();
  const push = await f.queue.get(pushId);
  assert.equal(await f.service.verifyPush({ ...push, action: push.display.payload.action }), false);
  f.queue.approve = approve;
  assert.equal(f.pushes.length, 0);
});

for (const [name, wrongPackage] of [
  ["another grant", { grant: { digest: "8".repeat(64) } }],
  ["another proposal", { proposal: { id: "another-proposal", contentDigest: "8".repeat(64) } }],
]) {
  test(`controlled evidence for the same job but ${name} never produces a push`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(wrongPackage);
    const result = await f.service.runCycle();
    assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
    assert.equal(f.pushes.length, 0);
  });
}

test("passing an unrelated profile cannot satisfy the approved required profile", async () => {
  const f = await fixture(); await f.deliver();
  f.completeJob({ passedProfiles: [{
    id: "lint-only", configDigest: "8".repeat(64), workspaceRevision: "b".repeat(64),
    actionId: "action-lint-only", attemptNumber: 1, imageId: "sha256:image-lint-only",
    artifacts: Object.fromEntries(["output", "stdout", "stderr"].map((kind) => [kind, {
      path: `repair/lint-only/${kind}.json`, sha256: "8".repeat(64), bytes: 12,
    }])),
  }] });
  const result = await f.service.runCycle();
  assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
  assert.equal(f.pushes.length, 0);
});

test("an unknown push outcome is never automatically replayed across cycles or restart", async () => {
  const f = await fixture({ pushOutcome: "unknown" }); await f.deliver(); f.completeJob();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  const pushId = f.store.values.get(STATE_KEY).repairs[0].pushConfirmationId;
  const push = await f.queue.get(pushId);
  assert.equal(push.status, "failed");
  assert.equal(push.failure.outcome, "unknown");
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.store.values.get(STATE_KEY).published.length, 0);
  assert.equal(await f.service.shouldRun(f.item), false, "unknown publication keeps duplicate repair fenced");
});

test("restart reconstructs a durably saved push intent after a crash before enqueue", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob(); f.crashBeforePushQueueWrite();
  const failed = await f.service.runCycle();
  assert.equal(failed.lastFailure, "TEST_ENQUEUE_CRASH");
  const intent = clone(f.store.values.get(STATE_KEY).repairs[0]);
  assert.equal(intent.status, "pushing");
  assert.equal(typeof intent.pushConfirmationId, "string");
  assert.equal(f.pushes.length, 0);
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].id, intent.pushConfirmationId);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "published");
});
