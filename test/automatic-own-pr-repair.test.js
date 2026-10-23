import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticOwnPrRepair } from "../src/services/automatic-own-pr-repair.js";
import { ciRepairSource } from './support/ci-repair-fixture.js';

const binding = {
  schemaVersion: 2, kind: "pull_request", repository: "acme/repo", pullRequestNumber: 42,
  rootItemId: "work-42", workKey: "pull-request-acme-repo-42", inputRevision: 1,
  headRevision: 1, headRefOid: "1".repeat(40), eventId: "event-42",
  eventDigest: "d".repeat(64), inputDigest: "e".repeat(64),
  gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "me",
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "2".repeat(40),
    headRepository: "acme/repo", headRefName: "fix/review", headRefOid: "1".repeat(40) },
};

function setup({ objectSync = null, ciRepairContextReader = null } = {}) {
  const configuration = {
    githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: "me" },
    trackedRepositories: ["acme/repo"],
    workCoordination: { policy: { workspaceByRepository: { "acme/repo": "repo" } } },
    codeExecutor: { workspaces: [{ id: "repo", gitHeadSnapshot: true, writablePaths: ["src", "test"] }] },
  };
  const event = { eventType: "pull_request.updated", subject: { repository: "acme/repo", number: 42 }, payload: {
    relation: "authored", author: "me", state: "open", nextAction: "address_review",
    reviewFeedbackDigest: "f".repeat(64), reviewFeedbackAvailable: true,
  } };
  const facts = { state: "open", author: "me", headRefOid: binding.headRefOid,
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: "f".repeat(64) };
  const saved = new Map();
  const calls = [];
  const service = new AutomaticOwnPrRepair({
    configurationReader: { readActive: async () => ({ configuration }) },
    store: { read: async (key, fallback) => structuredClone(saved.get(key) ?? fallback),
      write: async (key, value) => { saved.set(key, structuredClone(value)); } },
    ledger: { readPullRequestExecutionContext: async () => ({ inputBinding: binding, author: "me" }),
      readItemForReconciliation: async () => ({ event }) },
    github: { readOwnPullRequestFeedback: async () => structuredClone(facts) },
    objectSync,
    ciRepairContextReader,
    grantVerifier: { async verify(grant) { return grant; } },
    confirmations: { approve: async (id, request) => { calls.push({ id, request }); return { ...item(), status: "completed" }; } },
  });
  function item() {
    return { id: "confirmation-code-42", kind: "local.code-job-create", status: "pending",
      queueRevision: 3, itemRevision: 1, approvalBindingDigest: "a".repeat(64), displayedPayloadDigest: "b".repeat(64),
      requestedBy: { roleId: "developer", workItemId: "work-42" },
      display: { payload: { action: { type: "create_code_job", grant: {
        inputBinding: binding, operation: "inspect", requestedBy: { roleId: "developer" },
      } } } },
    };
  }
  return { service, configuration, facts, event, calls, item, saved };
}

test("own review feedback prepares configured Head source and automatically starts its code task", async () => {
  const s = setup();
  await s.service.recover();
  const source = await s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: "propose_code_action", operation: "modify" }, roleId: "developer" });
  assert.equal(source.kind, "review_repair");
  assert.deepEqual(source.writeScope.paths, ["src", "test"]);
  assert.equal((await s.service.approveCodeJob(s.item())).status, "completed");
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].request.requestId, /^auto-own-pr-repair-v1-/);
});

test('owned fix_ci prepares explicit controlled CI provenance instead of an ordinary unpublishable modify', async () => {
  const source = ciRepairSource(binding, ['src', 'test']); let reads = 0;
  const s = setup({ ciRepairContextReader: { async read({ inputBinding, event }) {
    reads++; assert.deepEqual(inputBinding, binding); assert.equal(event.payload.nextAction, 'fix_ci');
    return { facts: { state: 'open', author: 'me', headRefOid: binding.headRefOid, baseRefOid: binding.gitTarget.baseRefOid }, ciEvidence: source.ciEvidence };
  } } });
  s.event.payload.nextAction = 'fix_ci';
  await s.service.recover();
  const prepared = await s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
  assert.deepEqual(prepared, source);
  assert.equal(reads, 1);
});

test('missing automatic CI provenance retries instead of falling back to an ordinary modify job', async () => {
  const s = setup({ ciRepairContextReader: { async read() { return null; } } }); s.event.payload.nextAction = 'fix_ci';
  await s.service.recover();
  await assert.rejects(s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' }), { code: 'OWN_PR_CI_SOURCE_NOT_READY' });
});

test("disabled, someone else's PR, no feedback, changed Head or different role cannot auto execute", async () => {
  for (const mutate of [
    (s) => { s.configuration.githubActions.automaticOwnPrRepair = false; },
    (s) => { s.facts.author = "other"; },
    (s) => { s.facts.reviewFeedbackCount = 0; },
    (s) => { s.facts.headRefOid = "9".repeat(40); },
    (s) => { s.event.payload.reviewFeedbackDigest = "9".repeat(64); },
  ]) {
    const s = setup(); await s.service.recover(); mutate(s);
    const result = await s.service.approveCodeJob(s.item());
    assert.equal(result.status, "pending"); assert.equal(s.calls.length, 0);
  }
  const s = setup(); await s.service.recover();
  const item = s.item(); item.requestedBy.roleId = "tester";
  assert.equal((await s.service.approveCodeJob(item)).status, "pending");
  assert.equal(s.calls.length, 0);
});

test("the same feedback is not repaired again after a successful push, including after restart", async () => {
  const s = setup(); await s.service.recover();
  await s.service.recordPublished({ repository: "acme/repo", number: 42,
    feedbackDigest: s.facts.reviewFeedbackDigest, commitOid: "3".repeat(40), confirmationId: "push-42" });
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  await s.service.recover();
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.event.payload.reviewFeedbackDigest = "7".repeat(64);
  s.facts.reviewFeedbackDigest = s.event.payload.reviewFeedbackDigest;
  assert.equal(await s.service.shouldRun({ event: s.event }), true);
});

test("resolving some previously repaired feedback does not repair the remaining old comments again", async () => {
  const s = setup(); await s.service.recover();
  await s.service.recordPublished({ repository: "acme/repo", number: 42,
    feedbackDigest: s.facts.reviewFeedbackDigest, feedbackFingerprints: ["1".repeat(64), "2".repeat(64)],
    commitOid: "3".repeat(40), confirmationId: "push-42" });
  s.event.payload.reviewFeedbackDigest = "7".repeat(64);
  s.facts.reviewFeedbackDigest = s.event.payload.reviewFeedbackDigest;
  s.facts.reviewFeedbackFingerprints = ["2".repeat(64)];
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.facts.reviewFeedbackFingerprints = ["4".repeat(64)];
  assert.equal(await s.service.shouldRun({ event: s.event }), true, "edited or new feedback is eligible");
});

test("automatic code approval prepares current Head objects then checks live authority again", async () => {
  let s;
  let prepared = 0;
  s = setup({ objectSync: { async prepare({ inputBinding }) {
    assert.deepEqual(inputBinding, binding);
    prepared += 1;
    s.facts.headRefOid = "9".repeat(40);
  } } });
  await s.service.recover();
  assert.equal((await s.service.approveCodeJob(s.item())).status, "pending");
  assert.equal(prepared, 1);
  assert.equal(s.calls.length, 0, "new remote Head during fetch cannot approve the obsolete task");
});

test("waiting repair tasks do not starve later tasks in bounded cycles", async () => {
  const visited = [];
  const repairs = [1, 2, 3].map((id) => ({ jobId: `job-${id}`, confirmationId: `confirmation-${id}`,
    inputBinding: binding, feedbackDigest: "f".repeat(64), status: "working", pushConfirmationId: null }));
  const service = new AutomaticOwnPrRepair({
    store: { async read() { return { schemaVersion: 1, repairs, published: [] }; } },
    confirmations: { async get() { return { status: "failed", failure: { outcome: "unknown" } }; } },
    codeJobReader: { async getDetail({ jobId }) { visited.push(jobId); return null; } },
    controlledCommitReader: {},
    grantVerifier: { async verify(grant) { return grant; } },
  });
  await service.recover();
  for (let cycle = 0; cycle < 3; cycle += 1) await service.runCycle({ limit: 1 });
  assert.deepEqual(visited, ["job-1", "job-2", "job-3"]);
});

test("new feedback cannot start a competing repair while the same PR push is unresolved", async () => {
  const s = setup();
  s.saved.set("automatic-own-pr-repair-state", { schemaVersion: 1, published: [], repairs: [{
    jobId: "previous-job", confirmationId: "previous-code", inputBinding: binding,
    feedbackDigest: "8".repeat(64), status: "pushing", pushConfirmationId: "previous-push",
  }] });
  await s.service.recover();
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.event.subject.number = 43;
  assert.equal(await s.service.shouldRun({ event: s.event }), true, "unrelated PRs remain independent");
});
