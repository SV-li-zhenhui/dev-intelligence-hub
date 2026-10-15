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
import { ledgerDigest } from "../src/services/work-ledger-values.js";
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

function assignment(sequence, scope = "initial", head = HEAD, {
  eventType = "pull_request.updated", provider = "github",
} = {}) {
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType,
    occurredAt: `2026-10-15T01:0${sequence}:00.000Z`, source: { provider, scopeId: scope },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { headRefOid: head, title: "Repair review", state: "open", gitTargetAvailable: true,
      ...(head === HEAD || eventType !== "pull_request.updated" ? {} : { changedFields: ["headRefOid"], previousHeadRefOid: HEAD }),
      gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "review-account",
        baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo", headRefName: "fix/review", headRefOid: head } } });
  return { sequence, event, assignment: { assignmentId: `assignment-${sequence}`, eventId: event.eventId,
    target: { type: "role", id: "pr-engineer" }, reason: "review", createdAt: event.occurredAt } };
}

function scopeLifecycleAssignment(sequence, event) {
  return { sequence, event, assignment: { assignmentId: `scope-lifecycle-${sequence}`, eventId: event.eventId,
    eventType: event.eventType, subject: event.subject, configVersion: 1, configDigest: "1".repeat(64),
    ruleId: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID, target: PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
    priority: PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY, reason: PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
    createdAt: event.occurredAt } };
}

async function fixture({ outcome = "applied", transformPlan = (plan) => plan, downstream = false,
  followupScope = "followup", followupHead = HEAD, leaveScope = false, leaveScopeAfterResult = false,
  ignoredReentry = false, ownerFollowup = false } = {}) {
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
  const leaveAutomaticScope = async () => {
    const sequence = records.length + 1;
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope",
      occurredAt: `2026-10-15T01:0${sequence}:00.000Z`, source: { provider: "github", scopeId: "initial" },
      subject: records[0].event.subject, payload: { ...records[0].event.payload, headRefOid: HEAD, state: "open" } });
    records.push(scopeLifecycleAssignment(sequence, event));
    await service.intake();
  };
  if (leaveScope) await leaveAutomaticScope();
  const result = createWorkProposalResult({ proposal, sequence: 1, at: NOW, downstreamRef: downstream ? plan.id : null,
    transition: { status: "stale", summary: "Authority left scope before receipt recovery", evidence: downstream
      ? [`confirmation:${plan.id}`, "authorization_changed", "old_confirmation_status:completed"]
      : ["authorization_changed", `proposal:${proposal.proposalId}`] } });
  await service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const staleHistory = (await service.listOutbox()).items[0];
  if (ignoredReentry && ownerFollowup) {
    records.push(assignment(records.length + 1, "owner-request:123e4567-e89b-42d3-a456-426614174001", HEAD,
      { eventType: "pull_request.owner_requested", provider: "local-owner" }));
    await service.intake();
  }
  if (leaveScopeAfterResult) await leaveAutomaticScope();
  if (ignoredReentry) {
    const lifecycle = assignment(records.length + 1, "initial", followupHead, { eventType: "pull_request.created" });
    const reentry = assignment(records.length + 2, "initial", followupHead, { eventType: "pull_request.created" });
    records.push(scopeLifecycleAssignment(lifecycle.sequence, lifecycle.event), reentry);
    await service.intake();
    // Older persisted ledgers label these rejected observations as audit-only.
    // Replay only that historical representation; business state and bindings stay intact.
    const stored = await store.read("work-ledger-state", null);
    const observations = stored.timeline.filter((entry) => entry.itemId === root.itemId &&
      [lifecycle.sequence, reentry.sequence].includes(entry.details.sourceSequence));
    assert.equal(observations.length, 2);
    assert.ok(observations.every((entry) => entry.details.disposition === "ignored_unproven_head"));
    for (const entry of observations) {
      entry.type = "pr_source_ignored";
      const { timelineId, contentDigest, ...content } = entry;
      entry.contentDigest = ledgerDigest(content);
      entry.timelineId = `work-timeline-${entry.contentDigest}`;
    }
    await store.write("work-ledger-state", stored);
    service = makeService(); await service.recover();
  }
  records.push(assignment(records.length + 1, followupScope, followupHead, ownerFollowup
    ? { eventType: "pull_request.owner_requested", provider: "local-owner" } : {})); await service.intake();
  return { store, records, plan, proposal, reads, staleHistory,
    get service() { return service; }, get queue() { return queue; }, get executions() { return executions; },
    overrideRead(value) { overrideRead = value; },
    async restart() { queue = makeQueue(); await queue.recover(); service = makeService(); await service.recover(); },
    async command() {
      const items = (await service.listItems()).items;
      const pending = items.filter((row) => row.itemId !== root.itemId)
        .sort((left, right) => right.source.current.sourceSequence - left.source.current.sourceSequence)[0] ?? items[0];
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

test("ignored old-scope reentry preserves completed Review proof for a fresh owner Head after restart", async () => {
  const nextHead = "9".repeat(40);
  const f = await fixture({ downstream: true, leaveScopeAfterResult: true, ignoredReentry: true,
    ownerFollowup: true, followupScope: "owner-request:123e4567-e89b-42d3-a456-426614174000", followupHead: nextHead });
  const history = (await f.service.listTimeline({ limit: 100 })).items;
  const ignored = history.filter((entry) => entry.itemId === f.proposal.requestedBy.workItemId &&
    entry.type === "pr_source_ignored" && entry.details.disposition === "ignored_unproven_head");
  assert.equal(ignored.length, 2, "both lifecycle and role reentry remain audited");
  const settledProof = history.find((entry) => entry.type === "proposal_result_applied");
  assert.ok(ignored.every((entry) => entry.sequence > settledProof.sequence));
  await f.restart();
  const command = await f.command();
  const pending = await f.service.readItemForReconciliation({ itemId: command.itemId });
  assert.equal(pending.source.scope.kind, "owner_requested");
  assert.equal(pending.source.current.headRefOid, nextHead);
  const old = await f.service.readItemForReconciliation({ itemId: f.proposal.requestedBy.workItemId });
  const byId = new Map((await f.service.listOutbox()).items.map((row) => [row.intentId, row]));
  const snapshots = await Promise.all(reviewConfirmationSettlementIds(old, byId)
    .map((confirmationId) => f.queue.readSettlement({ confirmationId })));
  assert.ok(createCompletedReviewConfirmationSettlement(old, byId, snapshots), "the exact completed Review proof remains valid");
  const result = await f.service.reconcilePullRequestSource(command);
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.deepEqual(result.blockers, []);
  const ready = await f.service.readItemForReconciliation({ itemId: result.itemId });
  const claimed = await f.service.claim({ itemId: ready.itemId, expectedRevision: ready.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  assert.equal(claimed.status, "working");
  assert.equal(claimed.source.current.headRefOid, nextHead);
  assert.deepEqual((await f.service.listOutbox()).items[0], f.staleHistory);
  const retained = (await f.service.listTimeline({ limit: 100 })).items;
  assert.deepEqual(retained.filter((row) => ignored.some((entry) => row.sequence === entry.sequence)), ignored);
  const roots = (await f.service.listItems()).items;
  const oldOwner = roots.find((row) => row.source.current.event.source.scopeId ===
    "owner-request:123e4567-e89b-42d3-a456-426614174001");
  assert.equal(oldOwner.status, "superseded", "the older owner request stays behind the newer scope exit");
  assert.equal((await f.queue.get(f.plan.id)).status, "completed");
  assert.equal(f.executions, 1, "settlement never republishes the old Review");
});

for (const downstream of [false, true]) test(`a completed Review on retained rev1 settles after same-Head scope rev2 became current (downstream=${downstream})`, async () => {
  const f = await fixture({ downstream, leaveScopeAfterResult: true, followupScope: "initial", followupHead: "9".repeat(40) }); await f.restart();
  const old = await f.service.readItemForReconciliation({ itemId: f.proposal.requestedBy.workItemId });
  const sourceBefore = clone(old.source), decisionBefore = clone(old.decisionContext);
  const byId = new Map((await f.service.listOutbox()).items.map((row) => [row.intentId, row]));
  assert.equal(old.source.activeRevision, 2);
  assert.equal(old.source.current.headRefOid, HEAD);
  assert.equal(old.source.revisions[0].headRefOid, HEAD);
  assert.notEqual(old.inputDigest, f.staleHistory.inputDigest);
  assert.equal(old.source.revisions[0].inputDigest, f.staleHistory.inputDigest);
  assert.ok(reviewConfirmationSettlementIds(old, byId).includes(f.plan.id), "retained rev1 identifies the completed confirmation");
  const snapshots = await Promise.all(reviewConfirmationSettlementIds(old, byId).map((confirmationId) => f.queue.readSettlement({ confirmationId })));
  assert.ok(createCompletedReviewConfirmationSettlement(old, byId, snapshots), "retained authority binds the exact completed receipt");
  const result = await f.service.reconcilePullRequestSource(await f.command());
  assert.equal(result.applied, true, JSON.stringify(result));
  const settled = await f.service.readItemForReconciliation({ itemId: old.itemId });
  assert.equal(settled.source.activeRevision, 3, "normal cutover activates only the newer pending input");
  assert.equal(settled.source.pendingRevision, null);
  assert.deepEqual(settled.source.current, sourceBefore.pending);
  assert.deepEqual(settled.source.revisions, sourceBefore.revisions, "historical source authority remains append-only");
  assert.deepEqual(settled.source.bindings, sourceBefore.bindings);
  assert.equal(settled.decisionContext, null, "new input receives no stale decision authority");
  const history = (await f.service.listTimeline({ itemId: old.itemId })).items;
  assert.ok(history.some((entry) => entry.type === "proposal_result_applied" &&
    entry.details.decision.contentDigest === decisionBefore.contentDigest), "terminal stale decision remains historical evidence");
  assert.deepEqual((await f.service.listOutbox()).items[0], f.staleHistory);
  assert.equal((await f.queue.get(f.plan.id)).status, "completed");
  assert.equal(f.executions, 1);
  await f.restart();
  const repeat = await f.service.reconcilePullRequestSource(await f.command());
  assert.equal(repeat.applied, false, JSON.stringify(repeat));
  assert.equal(f.executions, 1, "restart and repeated cutover never republish a Review");
});

test("historical Review settlement requires every retained source and delivered proposal binding", async (t) => {
  const f = await fixture({ leaveScopeAfterResult: true });
  const item = await f.service.readItemForReconciliation({ itemId: f.proposal.requestedBy.workItemId });
  const entries = (await f.service.listOutbox()).items;
  const byId = new Map(entries.map((row) => [row.intentId, row]));
  const snapshots = await Promise.all(reviewConfirmationSettlementIds(item, byId).map((confirmationId) => f.queue.readSettlement({ confirmationId })));
  assert.ok(createCompletedReviewConfirmationSettlement(item, byId, snapshots));
  const mismatches = [
    ["missing revision", (row) => { row.source.revisions[0] = null; }],
    ["unaccepted revision", (row) => { row.source.revisions[0].disposition = "ignored_stale"; }],
    ["revision number", (row) => { row.source.revisions[0].revision = 3; }],
    ["Head revision", (row) => { row.source.revisions[0].headRevision++; }],
    ["Head", (row) => { row.source.revisions[0].headRefOid = "9".repeat(40); }],
    ["event ID", (row) => { row.source.revisions[0].eventId = "other-event"; }],
    ["event digest", (row) => { row.source.revisions[0].eventDigest = "9".repeat(64); }],
    ["input digest", (row) => { row.source.revisions[0].inputDigest = "9".repeat(64); }],
    ["work key", (row) => { row.source.workKey = "other-work-key"; }],
    ["root ID", (row) => { row.itemId = "other-root"; }],
    ["repository", (row) => { row.source.identity.repository = "other/repo"; }],
    ["PR number", (row) => { row.source.identity.pullRequestNumber++; }],
    ["missing retained assignment", (row) => { row.source.bindings = []; }],
    ["retained assignment revision", (row) => { row.source.bindings[0].inputRevision = 3; }],
    ["retained assignment event", (row) => { row.source.bindings[0].eventId = "other-event"; }],
    ["quarantined source", (row) => { row.sourceQuarantine = { kind: "legacy_pull_request_source" }; }],
    ["active external intent", (row) => { row.activeIntentId = "other-intent"; }],
    ["waiting external", (row) => { row.status = "waiting_external"; }],
    ["current role", (row) => { row.currentTarget.id = "developer"; }],
    ["stable assignment", (row) => { row.assignmentId = "other-assignment"; }],
    ["outbox role", (_row, outboxes) => { outboxes[0].requestedBy.roleId = "developer"; }],
    ["outbox not delivered", (_row, outboxes) => { outboxes[0].status = "failed"; }],
    ["non-review intent", (_row, outboxes) => { outboxes[0].intent.type = "propose_code_action"; }],
    ["outbox input digest", (_row, outboxes) => { outboxes[0].inputDigest = "9".repeat(64); }],
    ["outbox source binding", (_row, outboxes) => { outboxes[0].sourceBinding.inputRevision = 2; }],
    ["proposal dispatch digest", (_row, outboxes) => { outboxes[0].dispatchBinding.bindingDigest = "9".repeat(64); }],
    ["proposal digest", (_row, outboxes) => { outboxes[0].outcome.details.proposalDigest = "9".repeat(64); }],
    ["result attestation", (_row, outboxes) => { outboxes[0].outcome.details.resultAttestation.decisionContentDigest = "9".repeat(64); }],
  ];
  for (const [name, mutate] of mismatches) await t.test(name, () => {
    const changed = clone(item), outboxes = clone(entries); mutate(changed, outboxes);
    const changedById = new Map(outboxes.map((row) => [row.intentId, row]));
    assert.deepEqual(reviewConfirmationSettlementIds(changed, changedById), []);
    assert.equal(createCompletedReviewConfirmationSettlement(changed, changedById, snapshots), null);
  });
});

for (const historical of [false, true]) for (const [name, options] of [
  ["unknown", { outcome: "unknown" }],
  ["failed", { outcome: "absent" }],
  ["other actor", { transformPlan(plan) { plan.actor.accountId = "other-account"; plan.display.payload.actor.accountId = "other-account"; return plan; } }],
  ["other Head", { transformPlan(plan) { plan.target.version = "9".repeat(40); plan.display.payload.target.version = "9".repeat(40); return plan; } }],
]) {
  test(`${name} Review confirmation cannot settle a stale proposal (historical=${historical})`, async () => {
    const f = await fixture({ ...options, ...(historical ? { leaveScopeAfterResult: true,
      followupScope: "initial", followupHead: "9".repeat(40) } : {}) });
    const result = await f.service.reconcilePullRequestSource(await f.command());
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
