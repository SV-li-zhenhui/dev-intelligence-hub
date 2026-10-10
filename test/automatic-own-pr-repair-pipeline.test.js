import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { CODE_JOB_ACTIONS_BY_OPERATION, codeJobIdForGrant, createCodeJobGrant } from "../src/domain/code-job-contract.js";
import { createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { createControlledCommitEvidence, createControlledCommitMessage } from "../src/domain/controlled-commit-evidence.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { AutomaticOwnPrRepair } from "../src/services/automatic-own-pr-repair.js";
import { CodeActionProposalHandler } from "../src/services/code-action-proposal-handler.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { pullRequestExternalActionBinding } from "./support/pull-request-external-action-fixture.js";

const CREATED_AT = "2026-10-10T03:00:00.000Z";
const FEEDBACK_DIGEST = "f".repeat(64);
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

async function fixture({ enabled = true, pushOutcome = "applied" } = {}) {
  const store = new MemoryStore();
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
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: FEEDBACK_DIGEST };
  const context = { inputBinding: binding, author: "runtime-user" };
  const jobs = new Map();
  const details = new Map();
  const verified = new Map();
  const pushes = [];
  let service;
  let queue;
  let failNextPushEnqueue = false;
  let grantCurrent = true;
  const executor = {
    async execute(envelope) {
      if (envelope.kind === "local.code-job-create") {
        const job = queuedJob(envelope.action.grant);
        jobs.set(job.jobId, job);
        return { status: "applied", receipt: { id: job.jobId, createdAt: CREATED_AT } };
      }
      assert.equal(envelope.kind, "github.pull-request-push");
      assert.equal(await service.verifyPush(envelope), true, "push must have current automatic repair authority");
      pushes.push(clone(envelope));
      if (pushOutcome === "unknown") return { status: "unknown", code: "TEST_PUSH_UNKNOWN" };
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
    return new ConfirmationQueue({ store, executor, exclusiveLease: { run: (operation) => operation() }, clock: () => new Date(CREATED_AT) });
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
    store, binding, proposal, grant, config, item, facts, context, jobs, pushes,
    get service() { return service; }, get queue() { return queue; },
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
