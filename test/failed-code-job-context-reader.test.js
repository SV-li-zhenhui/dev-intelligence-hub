import assert from "node:assert/strict";
import test from "node:test";
import { createCodeJobGrant, createQueuedCodeJob, CODE_JOB_ACTIONS_BY_OPERATION } from "../src/domain/code-job-contract.js";
import { projectNormalizedCodeJobForBrowser } from "../src/domain/code-job-browser-projection.js";
import { FailedCodeJobContextReader } from "../src/services/failed-code-job-context-reader.js";
import { AutomaticOwnPrInspectionRecovery } from "../src/services/automatic-own-pr-inspection-recovery.js";

function fixture({ operation = "modify", failureCode = "GIT_SNAPSHOT_TIMEOUT", actions = ["read_text", "search_text", "read_text"] } = {}) {
  const itemId = "work-item-repair";
  const inputBinding = {
    schemaVersion: 1, kind: "pull_request", repository: "acme/widgets", pullRequestNumber: 17,
    rootItemId: itemId, workKey: "pr-work-repair", inputRevision: 3, headRevision: 2,
    headRefOid: "1".repeat(40), eventId: "event-repair", eventDigest: "2".repeat(64), inputDigest: "3".repeat(64),
  };
  const grant = createCodeJobGrant({
    schemaVersion: 2, proposalId: "work-intent-repair", contentDigest: "a".repeat(64), policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: itemId },
    source: { assignmentId: "assignment-repair", eventId: "event-repair" },
    subject: { id: "github:pr:acme/widgets#17", repository: "acme/widgets", number: 17 },
    repository: "acme/widgets", workspaceId: "widgets-local", inputBinding,
    workspaceAuthorityDigest: "9".repeat(64), operation, objective: "Repair the review feedback",
    acceptanceCriteria: ["Cover each outstanding defect"], evidence: ["review-feedback"],
    summary: "Repair feedback", reason: "Requested changes", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[operation]],
    writablePaths: operation === "modify" ? ["src"] : [], requiredProfiles: [{ id: "tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
  const raw = structuredClone(createQueuedCodeJob({
    confirmationId: "confirmation-repair", requestId: "request-repair-0001", grant,
    displayedPayloadDigest: "d".repeat(64), approvalBindingDigest: "e".repeat(64),
  }, { sequence: 1, revision: 1, createdAt: "2026-08-02T06:00:00.000Z" }));
  raw.status = "failed";
  raw.updatedAt = "2026-08-02T06:01:00.000Z";
  raw.execution.turn = actions.length;
  raw.execution.observations = actions.map((actionType) => ({
    actionType, status: "succeeded", recordedAt: "2026-08-02T06:00:30.000Z",
  }));
  raw.execution.result = { kind: "failed", detail: { code: failureCode, message: "DO-NOT-EXPOSE-RAW-ERROR" }, recordedAt: raw.updatedAt };
  raw.execution.memoryProjection = { memoryRecordId: `memory-${"f".repeat(64)}`, projectedAt: raw.updatedAt };
  const job = projectNormalizedCodeJobForBrowser(raw);
  const decisionContext = {
    source: "proposal", outcome: "failed", observedAt: raw.updatedAt,
    value: { kind: "code_action_proposal", evidence: [`code-job:${job.jobId}`, `memory:${job.memoryProjection.recordId}`] },
  };
  const detail = { job, terminalDetail: raw.execution.result.detail,
    observations: raw.execution.observations, nextCursor: null, historyAvailable: true };
  const retry = { itemId, type: "transitioned", actorId: "owner:local", at: "2026-08-02T06:02:00.000Z",
    details: { toStatus: "queued", reason: "snapshot_timeout_fixed_retry",
      context: { downstreamRef: job.jobId, note: "Fixed-Head snapshot verified; retry original task." } } };
  const page = { items: [retry], nextCursor: null };
  const calls = [];
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail(request) { calls.push(request); return structuredClone(detail); } },
    ledger: { async listTimeline(request) { calls.push(request); return structuredClone(page); } },
  });
  return { reader, input: { itemId, inputBinding, decisionContext }, detail, page, retry, calls };
}

test("failed repair context includes the actual failure and matching owner recovery request", async () => {
  const f = fixture();
  const result = await f.reader.read(f.input);
  assert.equal(result.failureCode, "GIT_SNAPSHOT_TIMEOUT");
  assert.equal(result.historyComplete, true);
  assert.equal(result.observedActions.length, 3);
  assert.equal(result.ownerRetry.note, f.retry.details.context.note);
  assert.equal(JSON.stringify(result).includes("DO-NOT-EXPOSE-RAW-ERROR"), false);
  assert.deepEqual(f.calls, [{ jobId: f.detail.job.jobId, limit: 20 }, { itemId: f.input.itemId, limit: 100, order: "newest" }]);
});

function automaticRetry(f) {
  f.retry.actorId = "automatic-own-pr-inspection-recovery";
  f.retry.details.reason = "automatic_inspection_objects_ready";
  f.retry.details.context = { downstreamRef: f.detail.job.jobId, code: "GIT_HEAD_UNAVAILABLE" };
}

test("developer context identifies the system recovery of its exact zero-action inspection", async () => {
  const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [] });
  automaticRetry(f);
  const result = await f.reader.read(f.input);
  assert.equal(result.ownerRetry, null);
  assert.deepEqual(result.automaticRecovery, { at: f.retry.at, reason: "automatic_inspection_objects_ready",
    failureCode: "GIT_HEAD_UNAVAILABLE", jobId: f.detail.job.jobId });
});

test("snapshot timeout recovery context preserves its actual failure classification", async () => {
  const f = fixture({ operation: "inspect", failureCode: "GIT_SNAPSHOT_TIMEOUT", actions: [] });
  automaticRetry(f);
  f.retry.details.context.code = "GIT_SNAPSHOT_TIMEOUT";
  assert.equal((await f.reader.read(f.input)).automaticRecovery.failureCode, "GIT_SNAPSHOT_TIMEOUT");
  f.retry.details.context.code = "GIT_HEAD_UNAVAILABLE";
  assert.equal((await f.reader.read(f.input)).automaticRecovery, null);
});

test("automatic recovery context rejects mismatched, incomplete and non-inspection recovery evidence", async (t) => {
  for (const options of [
    { operation: "modify" }, { failureCode: "GIT_SNAPSHOT_PROCESS_FAILED" }, { actions: ["read_text"] },
    { mutate: f => { f.retry.actorId = "other-system"; } },
    { mutate: f => { f.retry.details.reason = "other-recovery"; } },
    { mutate: f => { f.retry.details.context.code = "OTHER_FAILURE"; } },
    { mutate: f => { f.retry.details.context.downstreamRef = "other-job"; } },
    { mutate: f => { f.retry.at = f.input.decisionContext.observedAt; } },
    { mutate: f => { f.detail.historyAvailable = false; } },
  ]) await t.test(JSON.stringify(options), async () => {
    const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [], ...options });
    automaticRetry(f); options.mutate?.(f);
    assert.equal((await f.reader.read(f.input)).automaticRecovery, null);
  });
});

async function recoveryFixture(options = {}) {
  const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [], ...options });
  const state = new Map();
  const calls = [];
  const item = { itemId: f.input.itemId, revision: 5, status: "blocked", statusReason: "proposal_failed",
    currentTarget: { type: "role", id: "developer" }, activeIntentId: null, leaseId: null,
    graph: { deliveries: [] }, decisionContext: structuredClone(f.input.decisionContext) };
  const dependencies = {
    store: { async read(key, fallback) { return structuredClone(state.get(key) ?? fallback); },
      async write(key, value) { state.set(key, structuredClone(value)); } },
    ledger: { async listItems() { return { items: [structuredClone(item)] }; },
      async readItemForReconciliation() { return structuredClone(item); },
      async transition(request) { calls.push(request); item.status = request.toStatus; item.revision += 1; } },
    codeJobReader: { async get() { return f.detail.job; } }, failedContextReader: f.reader,
    current: async () => ({}), objectSync: { async prepare() { calls.push("objects-ready"); } },
  };
  const makeService = async () => { const service = new AutomaticOwnPrInspectionRecovery(dependencies); await service.recover(); return service; };
  return { ...f, item, state, calls, dependencies, makeService, service: await makeService() };
}

test("automatic inspection recovery prepares objects then requeues the same failed task with history intact", async () => {
  const f = await recoveryFixture();
  assert.equal((await f.service.runCycle()).requeued, 1);
  assert.equal(f.calls[0], "objects-ready");
  assert.deepEqual(f.calls[1], { itemId: f.item.itemId, expectedRevision: 5, leaseId: null,
    actorId: "automatic-own-pr-inspection-recovery", toStatus: "queued", reason: "automatic_inspection_objects_ready",
    details: { code: "GIT_HEAD_UNAVAILABLE", downstreamRef: f.detail.job.jobId } });
  assert.deepEqual(f.item.decisionContext, f.input.decisionContext);
  f.item.status = "blocked";
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0, "restart cannot replay a settled recovery");
  assert.equal(f.calls.length, 2);
});

test("zero-action snapshot timeouts share the existing automatic inspection recovery budget", async () => {
  const f = await recoveryFixture({ failureCode: "GIT_SNAPSHOT_TIMEOUT" });
  assert.equal((await f.service.runCycle()).requeued, 1);
  assert.equal(f.calls[1].details.code, "GIT_SNAPSHOT_TIMEOUT");
  f.item.status = "blocked";
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0);
  const exhausted = await recoveryFixture({ failureCode: "GIT_SNAPSHOT_TIMEOUT" });
  exhausted.state.set("automatic-own-pr-inspection-recovery-state", { schemaVersion: 1,
    records: [1, 2, 3].map(attempt => ({ itemId: exhausted.item.itemId, jobId: `code-job-old-${attempt}`,
      inputBinding: exhausted.input.inputBinding, attempt, status: "requeued" })) });
  assert.equal((await (await exhausted.makeService()).runCycle()).requeued, 0);
  assert.deepEqual(exhausted.calls, []);
});

test("automatic inspection recovery preserves failed modifications, observed actions and uncertain context", async (t) => {
  for (const scenario of [
    { operation: "modify" }, { failureCode: "GIT_SNAPSHOT_PROCESS_FAILED" }, { actions: ["read_text"] },
    { change: f => { f.item.leaseId = "active-lease"; } },
    { change: f => { f.item.activeIntentId = "active-intent"; } },
    { change: f => { f.item.graph.deliveries = [{ status: "submitted" }]; } },
    { change: f => { f.item.status = "paused"; } },
    { change: f => { f.detail.historyAvailable = false; } },
    { change: f => { f.dependencies.current = async () => null; } },
    { change: f => { f.dependencies.objectSync.prepare = async () => { throw Object.assign(new Error(), { code: "OBJECTS_NOT_READY" }); }; } },
  ]) await t.test(JSON.stringify(scenario), async () => {
    const f = await recoveryFixture(scenario);
    scenario.change?.(f);
    f.service = await f.makeService();
    assert.equal((await f.service.runCycle()).requeued, 0);
    assert.equal(f.item.status === "queued", false);
    assert.equal(f.calls.some(value => typeof value === "object"), false);
  });
});

test("automatic inspection recovery retains its durable three-attempt budget", async () => {
  const f = await recoveryFixture();
  f.state.set("automatic-own-pr-inspection-recovery-state", { schemaVersion: 1,
    records: [1, 2, 3].map(attempt => ({ itemId: f.item.itemId, jobId: `code-job-old-${attempt}`,
      inputBinding: f.input.inputBinding, attempt, status: "requeued" })) });
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0);
  assert.deepEqual(f.calls, []);
});

test("inspection recovery rechecks the target and task after synchronization", async (t) => {
  for (const change of [
    f => { f.dependencies.current = async () => null; },
    f => { f.item.revision += 1; },
    f => { f.item.leaseId = "new-lease"; },
  ]) await t.test(change.toString(), async () => {
    const f = await recoveryFixture();
    f.dependencies.objectSync.prepare = async () => { change(f); };
    // Resolve the latest authority on each check, as the production callback does.
    const original = f.dependencies.current;
    f.dependencies.current = async (...args) => original(...args);
    const current = (...args) => f.dependencies.current(...args);
    f.service = new AutomaticOwnPrInspectionRecovery({ ...f.dependencies, current });
    await f.service.recover();
    assert.equal((await f.service.runCycle()).requeued, 0);
    assert.equal(f.item.status, "blocked");
  });
});

test("inspection recovery resumes a prepared transition after restart without consuming another attempt", async () => {
  const f = await recoveryFixture();
  const transition = f.dependencies.ledger.transition;
  f.dependencies.ledger.transition = async () => { throw Object.assign(new Error(), { code: "WORK_LEDGER_REVISION_MISMATCH" }); };
  assert.equal((await f.service.runCycle()).requeued, 0);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records[0].attempt, 1);
  f.dependencies.ledger.transition = transition;
  assert.equal((await (await f.makeService()).runCycle()).requeued, 1);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records.length, 1);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records[0].attempt, 1);
});

test("a failed repair context rejects another job, Head, authority epoch or memory receipt", async (t) => {
  const mutations = [
    (f) => { f.input.inputBinding.headRefOid = "4".repeat(40); },
    (f) => { f.input.inputBinding.headRevision += 1; },
    (f) => { f.input.inputBinding.inputRevision += 1; },
    (f) => { f.input.itemId = "other-item"; },
    (f) => { f.input.decisionContext.value.evidence[1] = `memory:memory-${"0".repeat(64)}`; },
    (f) => { f.input.decisionContext.value.evidence.push(f.input.decisionContext.value.evidence[0]); },
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(String(index), async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.reader.read(f.input), { code: "ROLE_CONTEXT_CODE_JOB_STALE" });
  });
});

test("unrelated, stale or non-owner transitions do not become retry evidence", async (t) => {
  for (const mutate of [
    (entry) => { entry.itemId = "other-item"; },
    (entry) => { entry.actorId = "developer"; },
    (entry) => { entry.at = "2026-08-02T06:00:00.000Z"; },
    (entry) => { entry.details.context.downstreamRef = "other-job"; },
    (entry) => { entry.details.toStatus = "blocked"; },
  ]) await t.test(mutate.toString(), async () => {
    const f = fixture(); mutate(f.retry);
    assert.equal((await f.reader.read(f.input)).ownerRetry, null);
  });
});

test("partial history and invalid error text never imply a clean completed execution", async () => {
  const f = fixture();
  f.detail.observations.pop();
  f.detail.nextCursor = { offset: 2 };
  f.detail.terminalDetail.code = "unexpected secret-bearing provider text";
  f.retry.details.context.note = "x".repeat(1025);
  const result = await f.reader.read(f.input);
  assert.equal(result.historyComplete, false);
  assert.equal(result.observationCount, 3);
  assert.equal(result.failureCode, null);
  assert.equal(result.ownerRetry.note, null);
  assert.equal(result.status, "failed");
});

test("retry lookup follows task-local pages and stops at the failure boundary", async () => {
  const f = fixture();
  const requests = [];
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail() { return f.detail; } },
    ledger: { async listTimeline(request) {
      requests.push(request);
      return request.cursor === undefined
        ? { items: [{ itemId: f.input.itemId, type: "claimed", at: "2026-08-02T06:03:00.000Z" }], nextCursor: "older-events" }
        : f.page;
    } },
  });
  assert.equal((await reader.read(f.input)).ownerRetry.note, f.retry.details.context.note);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, "older-events");
  requests.length = 0;
  f.input.decisionContext.observedAt = "2026-08-02T06:04:00.000Z";
  assert.equal((await reader.read(f.input)).ownerRetry, null);
  assert.equal(requests.length, 1);
});

test("caller cancellation stops further retry-history reads", async () => {
  const f = fixture();
  const controller = new AbortController();
  let calls = 0;
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail() { return f.detail; } },
    ledger: { async listTimeline() { calls += 1; controller.abort(); return f.page; } },
  });
  await assert.rejects(reader.read({ ...f.input, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("ordinary outcomes and a failure before job creation need no execution read", async () => {
  const f = fixture();
  f.input.decisionContext.outcome = "succeeded";
  assert.equal(await f.reader.read(f.input), null);
  f.input.decisionContext.outcome = "failed";
  f.input.decisionContext.value.evidence = ["confirmation:failed-before-job"];
  assert.equal(await f.reader.read(f.input), null);
  assert.equal(f.calls.length, 0);
});

test("failed context readers reject accessor ports without invoking them", () => {
  let calls = 0;
  const port = {};
  Object.defineProperty(port, "getDetail", { get() { calls += 1; return async () => {}; } });
  assert.throws(() => new FailedCodeJobContextReader({ codeJobReader: port, ledger: {} }), TypeError);
  assert.equal(calls, 0);
});
