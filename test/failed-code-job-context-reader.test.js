import assert from "node:assert/strict";
import test from "node:test";
import { createCodeJobGrant, createQueuedCodeJob, CODE_JOB_ACTIONS_BY_OPERATION } from "../src/domain/code-job-contract.js";
import { projectNormalizedCodeJobForBrowser } from "../src/domain/code-job-browser-projection.js";
import { FailedCodeJobContextReader } from "../src/services/failed-code-job-context-reader.js";

function fixture() {
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
    workspaceAuthorityDigest: "9".repeat(64), operation: "modify", objective: "Repair the review feedback",
    acceptanceCriteria: ["Cover each outstanding defect"], evidence: ["review-feedback"],
    summary: "Repair feedback", reason: "Requested changes", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src"], requiredProfiles: [{ id: "tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
  const raw = structuredClone(createQueuedCodeJob({
    confirmationId: "confirmation-repair", requestId: "request-repair-0001", grant,
    displayedPayloadDigest: "d".repeat(64), approvalBindingDigest: "e".repeat(64),
  }, { sequence: 1, revision: 1, createdAt: "2026-08-02T06:00:00.000Z" }));
  raw.status = "failed";
  raw.updatedAt = "2026-08-02T06:01:00.000Z";
  raw.execution.turn = 3;
  raw.execution.observations = ["read_text", "search_text", "read_text"].map((actionType) => ({
    actionType, status: "succeeded", recordedAt: "2026-08-02T06:00:30.000Z",
  }));
  raw.execution.result = { kind: "failed", detail: { code: "GIT_SNAPSHOT_TIMEOUT", message: "DO-NOT-EXPOSE-RAW-ERROR" }, recordedAt: raw.updatedAt };
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
