import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID, PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
  PULL_REQUEST_SCOPE_LIFECYCLE_REASON, PULL_REQUEST_SCOPE_LIFECYCLE_TARGET } from "../src/domain/pull-request-scope-lifecycle.js";
import { normalizeBoundWorkProposal, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { ConfirmationQueue, ConfirmationExecutionError } from "../src/services/confirmation-queue.js";
import { createCompletedReviewConfirmationSettlement, hasReviewConfirmationSettlement,
  reviewConfirmationSettlementIds } from "../src/services/work-ledger-review-confirmation-settlement.js";

const HEAD = "a".repeat(40);
const NOW = "2026-10-15T02:00:00.000Z";
const clone = (value) => structuredClone(value);
class MemoryStore {
  values = new Map();
  async read(key, fallback) { return clone(this.values.get(key) ?? fallback); }
  async write(key, value) { this.values.set(key, clone(value)); }
}
const lease = () => ({ run: (operation) => operation() });

function assignment(sequence, scope = "initial", head = HEAD) {
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated",
    occurredAt: `2026-10-15T01:0${sequence}:00.000Z`, source: { provider: "github", scopeId: scope },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { headRefOid: head, title: "Repair review", state: "open", gitTargetAvailable: true,
      gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "review-account",
        baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo", headRefName: "fix/review", headRefOid: head } } });
  return { sequence, event, assignment: { assignmentId: `assignment-${sequence}`, eventId: event.eventId,
    target: { type: "role", id: "pr-engineer" }, reason: "review", createdAt: event.occurredAt } };
}

async function fixture({ outcome = "applied", transformPlan = (plan) => plan, downstream = false,
  followupScope = "followup", leaveScope = false } = {}) {
  const store = new MemoryStore();
  const records = [assignment(1)];
  const source = { async readAssignmentBatch({ afterSequence, limit }) {
    const items = records.filter((row) => row.sequence > afterSequence).slice(0, limit);
    return clone({ items, nextSequence: items.at(-1)?.sequence ?? afterSequence,
      highWatermark: records.length, oldestAvailableSequence: 1 });
  } };
  let service, queue, proposal, executions = 0;
  const reads = [];
  let overrideRead = null;
  const reader = { async read(input) {
    reads.push(input);
    // Re-entry proves no ledger queue or lease is held across confirmation reads.
    await service.readItemForReconciliation({ itemId: proposal.requestedBy.workItemId });
    return overrideRead ? overrideRead(input) : queue.readSettlement(input);
  } };
  const makeService = () => new WorkLedgerService({ store, assignmentSource: source, exclusiveLease: lease(),
    clock: () => NOW, idFactory: () => "review-lease", confirmationSettlementReader: reader });
  const makeQueue = () => new ConfirmationQueue({ store, exclusiveLease: lease(), clock: () => new Date(NOW),
    executor: { async execute() { executions++;
      if (outcome === "absent") throw new ConfirmationExecutionError("TEST_REVIEW_ABSENT", "absent");
      return outcome === "applied" ? { status: "applied", receipt: { id: "review-42",
        url: "https://github.com/acme/repo/pull/42#pullrequestreview-42", createdAt: NOW } }
        : { status: "unknown", code: "TEST_UNKNOWN" };
    }, async reconcile() { assert.fail("settlement must never replay external Review"); } } });
  service = makeService(); await service.recover(); await service.intake();
  const root = (await service.listItems()).items[0];
  const claimed = await service.claim({ itemId: root.itemId, expectedRevision: root.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  await service.stageIntent({ itemId: claimed.itemId, expectedRevision: claimed.revision,
    leaseId: claimed.leaseId, actorId: "employee-pr-engineer", roleId: "pr-engineer",
    intent: { schemaVersion: 1, type: "propose_github_review", verdict: "request_changes", body: "Fix the race",
      summary: "Review completed", reason: "Inspected the affected paths", evidence: ["src/race.js"] } });
  const dispatcher = new WorkIntentDispatcher({ ledger: service, clock: () => new Date(NOW),
    policy: createWorkIntentPolicy({ githubReviewRoles: ["pr-engineer"] }),
    attentionProducer: { async create() { assert.fail("unexpected attention"); } },
    proposalProducer: { async create(value) { proposal = normalizeBoundWorkProposal(value);
      return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, kind: proposal.kind,
        status: "pending_delivery", revision: 1, createdAt: NOW }; } } });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  queue = makeQueue(); await queue.recover();
  const plan = createGitHubReviewProposalConfirmationPlan(proposal, { actorAccountId: "review-account" });
  const queued = await queue.enqueue(transformPlan(clone(plan)));
  await queue.approve(queued.id, { requestId: "approve-review-42", expectedQueueRevision: queued.queueRevision,
    expectedItemRevision: queued.itemRevision, displayedPayloadDigest: queued.displayedPayloadDigest,
    approvalBindingDigest: queued.approvalBindingDigest });
  if (leaveScope) {
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope",
      occurredAt: "2026-10-15T01:02:00.000Z", source: { provider: "github", scopeId: "initial" },
      subject: records[0].event.subject, payload: { headRefOid: HEAD, state: "open" } });
    records.push({ sequence: 2, event, assignment: { assignmentId: "scope-exit-2", eventId: event.eventId,
      eventType: event.eventType, subject: event.subject, configVersion: 1, configDigest: "1".repeat(64),
      ruleId: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID, target: PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
      priority: PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY, reason: PULL_REQUEST_SCOPE_LIFECYCLE_REASON, createdAt: event.occurredAt } });
    await service.intake();
  }
  const result = createWorkProposalResult({ proposal, sequence: 1, at: NOW, downstreamRef: downstream ? plan.id : null,
    transition: { status: "stale", summary: "Authority left scope before receipt recovery", evidence: downstream
      ? [`confirmation:${plan.id}`, "authorization_changed", "old_confirmation_status:completed"]
      : ["authorization_changed", `proposal:${proposal.proposalId}`] } });
  await service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const staleHistory = (await service.listOutbox()).items[0];
  records.push(assignment(records.length + 1, followupScope)); await service.intake();
  return { store, records, plan, proposal, reads, staleHistory,
    get service() { return service; }, get queue() { return queue; }, get executions() { return executions; },
    overrideRead(value) { overrideRead = value; },
    async restart() { queue = makeQueue(); await queue.recover(); service = makeService(); await service.recover(); },
    async command() {
      const items = (await service.listItems()).items;
      const pending = items.find((row) => row.itemId !== root.itemId) ?? items[0];
      return { itemId: pending.itemId, expectedRevision: pending.revision,
        expectedPendingRevision: pending.source.pendingRevision ?? pending.source.activeRevision,
        expectedGraphRevision: (await service.getSummary()).revision };
    },
  };
}

test("Review settlement proof cannot be forged, serialized, or reused at another item/outbox revision", async () => {
  const f = await fixture();
  const old = await f.service.readItemForReconciliation({ itemId: f.proposal.requestedBy.workItemId });
  const byId = new Map((await f.service.listOutbox()).items.map((row) => [row.intentId, row]));
  const snapshots = await Promise.all(reviewConfirmationSettlementIds(old, byId).map((confirmationId) => f.queue.readSettlement({ confirmationId })));
  const proof = createCompletedReviewConfirmationSettlement(old, byId, snapshots);
  assert.ok(proof); assert.equal(hasReviewConfirmationSettlement(old, byId, proof), true);
  assert.equal(hasReviewConfirmationSettlement(old, byId, {}), false);
  assert.equal(hasReviewConfirmationSettlement(old, byId, JSON.parse(JSON.stringify(proof))), false);
  assert.equal(hasReviewConfirmationSettlement({ ...old, revision: old.revision + 1 }, byId, proof), false);
  const changed = new Map([...byId].map(([id, row]) => [id, { ...row, revision: row.revision + 1 }]));
  assert.equal(hasReviewConfirmationSettlement(old, changed, proof), false);
  const attestationMismatch = new Map([...byId].map(([id, row]) => [id, { ...row, outcome: { ...row.outcome,
    details: { ...row.outcome.details, resultAttestation: { ...row.outcome.details.resultAttestation,
      decisionContentDigest: "9".repeat(64) } } } }]));
  assert.equal(createCompletedReviewConfirmationSettlement(old, attestationMismatch, snapshots), null);
  const ambiguous = new Map(byId); ambiguous.set("duplicate-delivered-proposal", clone([...byId.values()][0]));
  assert.equal(createCompletedReviewConfirmationSettlement(old, ambiguous, snapshots), null);
});

test("a changed ledger while reading a completed Review cannot use its captured settlement", async () => {
  const f = await fixture(); const command = await f.command(); let changed = false;
  f.overrideRead(async (input) => {
    const snapshot = await f.queue.readSettlement(input);
    if (!changed) { changed = true; f.records.push(assignment(3, "newer")); await f.service.intake(); }
    return snapshot;
  });
  await assert.rejects(f.service.reconcilePullRequestSource(command), { code: "WORK_LEDGER_STATE_REVISION_CONFLICT" });
  assert.equal(f.executions, 1);
  assert.equal((await f.queue.get(f.plan.id)).status, "completed");
});

for (const downstream of [false, true]) {
  test(`completed historical Review releases the followup source after restart (downstream=${downstream})`, async () => {
    const f = await fixture({ downstream }); await f.restart();
    const result = await f.service.reconcilePullRequestSource(await f.command());
    assert.equal(result.applied, true, JSON.stringify(result));
    const pending = await f.service.readItemForReconciliation({ itemId: result.itemId });
    assert.equal(pending.status, "queued");
    assert.equal((await f.service.claim({ itemId: pending.itemId, expectedRevision: pending.revision,
      workerId: "employee-pr-engineer", leaseDurationMs: 30_000 })).status, "working");
    assert.deepEqual((await f.service.listOutbox()).items[0], f.staleHistory, "stale proposal history is preserved");
    assert.equal((await f.queue.get(f.plan.id)).status, "completed");
    assert.equal(f.executions, 1);
  });
}

test("completed Review settlement activates a pending revision on the same root", async () => {
  const f = await fixture({ followupScope: "initial" }); await f.restart();
  const command = await f.command(); assert.equal(command.expectedPendingRevision, 2);
  assert.equal((await f.service.reconcilePullRequestSource(command)).applied, true);
  const current = await f.service.readItemForReconciliation({ itemId: command.itemId });
  assert.equal(current.source.activeRevision, 2); assert.equal(current.source.pendingRevision, null);
  assert.equal(current.status, "queued"); assert.equal(f.executions, 1);
});

test("historical Review actor casing preserves the same GitHub identity", async () => {
  const f = await fixture({ transformPlan(plan) {
    plan.actor.accountId = "REVIEW-ACCOUNT"; plan.display.payload.actor.accountId = "REVIEW-ACCOUNT"; return plan;
  } });
  assert.equal((await f.service.reconcilePullRequestSource(await f.command())).applied, true);
  assert.equal(f.executions, 1);
});

test("completed Review proof recovers the stale proposal after automatic assignment leaves scope", async () => {
  const f = await fixture({ leaveScope: true }); await f.restart();
  const old = await f.service.readItemForReconciliation({ itemId: f.proposal.requestedBy.workItemId });
  assert.equal(old.source.scope.active, false); assert.equal(old.decisionContext.outcome, "stale");
  const outbox = new Map((await f.service.listOutbox()).items.map((row) => [row.intentId, row]));
  const snapshots = await Promise.all(reviewConfirmationSettlementIds(old, outbox).map((confirmationId) => f.queue.readSettlement({ confirmationId })));
  assert.ok(createCompletedReviewConfirmationSettlement(old, outbox, snapshots), "loss of current scope does not erase exact completed receipt evidence");
  const result = await f.service.reconcilePullRequestSource(await f.command());
  assert.deepEqual(result.blockers, []);
  assert.equal((await f.service.readItemForReconciliation({ itemId: result.itemId })).status, "queued");
  assert.equal(f.executions, 1);
});

for (const [name, options] of [
  ["unknown", { outcome: "unknown" }],
  ["failed", { outcome: "absent" }],
  ["other actor", { transformPlan(plan) { plan.actor.accountId = "other-account"; plan.display.payload.actor.accountId = "other-account"; return plan; } }],
  ["other Head", { transformPlan(plan) { plan.target.version = "9".repeat(40); plan.display.payload.target.version = "9".repeat(40); return plan; } }],
]) {
  test(`${name} Review confirmation cannot settle a stale proposal`, async () => {
    const f = await fixture(options); const result = await f.service.reconcilePullRequestSource(await f.command());
    assert.equal(result.applied, false); assert.ok(result.blockers.length > 0); assert.equal(f.executions, 1);
  });
}

test("internal review handoff context is read from the delivered developer handoff, not an event flag", async () => {
  const store = new MemoryStore();
  const records = [assignment(1)];
  const service = new WorkLedgerService({ store, exclusiveLease: lease(), clock: () => NOW,
    idFactory: () => "handoff-lease", assignmentSource: { async readAssignmentBatch({ afterSequence }) {
      return { items: records.filter((row) => row.sequence > afterSequence), nextSequence: records.length,
        highWatermark: records.length, oldestAvailableSequence: 1 };
    } } });
  await service.recover(); await service.intake();
  let item = (await service.listItems()).items[0];
  assert.equal(await service.readInternalReviewHandoff({ itemId: item.itemId }), null);
  // Enter development through a normal handed-off assignment.
  item = await service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  const dispatcher = new WorkIntentDispatcher({ ledger: service, clock: () => new Date(NOW),
    policy: createWorkIntentPolicy({ capabilityRoles: { development: "developer", "pr-review": "pr-engineer" } }),
    attentionProducer: { async create() { assert.fail(); } }, proposalProducer: { async create() { assert.fail(); } } });
  const stage = async (claimed, roleId, capability) => service.stageIntent({ itemId: claimed.itemId,
    expectedRevision: claimed.revision, leaseId: claimed.leaseId, actorId: `employee-${roleId}`, roleId,
    intent: { schemaVersion: 1, type: "handoff", capability, brief: "Verify the code and regression report against the bound Head",
      summary: "Review the reported fix", reason: "Existing repair evidence needs internal assessment",
      evidence: ["developer-code-report", "developer-test-report"] } });
  await stage(item, "pr-engineer", "development"); await dispatcher.dispatchPending();
  item = await service.readItemForReconciliation({ itemId: item.itemId });
  assert.equal(await service.readInternalReviewHandoff({ itemId: item.itemId }), null);
  item = await service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  await stage(item, "developer", "pr-review"); await dispatcher.dispatchPending();
  const report = await service.readInternalReviewHandoff({ itemId: item.itemId });
  assert.deepEqual(report, { kind: "developer_handoff", headRefOid: HEAD,
    brief: "Verify the code and regression report against the bound Head", evidence: ["developer-code-report", "developer-test-report"],
    evidenceAuthority: "developer_report" });
  const restarted = new WorkLedgerService({ store, exclusiveLease: lease(), clock: () => NOW,
    idFactory: () => "restart-lease", assignmentSource: service.assignmentSource });
  await restarted.recover();
  assert.deepEqual(await restarted.readInternalReviewHandoff({ itemId: item.itemId }), report);
  records.push(assignment(2, "initial", "9".repeat(40))); await restarted.intake();
  assert.equal(await restarted.readInternalReviewHandoff({ itemId: item.itemId }), null, "old input cannot claim current handoff authority");
});
