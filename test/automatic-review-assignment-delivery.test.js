import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { AutomaticReviewPublisher } from "../src/services/automatic-review-publisher.js";
import { ReviewHandoffReconciler } from "../src/services/review-handoff-reconciler.js";
import { createGitHubActionExecutor } from "../src/adapters/github-action-adapter.js";

const HEAD = "a".repeat(40), NOW = "2026-10-15T02:00:00.000Z";
const clone = (value) => structuredClone(value);
class MemoryStore {
  values = new Map();
  async read(key, fallback) { return clone(this.values.get(key) ?? fallback); }
  async write(key, value) { this.values.set(key, clone(value)); }
}
function plan(reviewEvent = "REQUEST_CHANGES") {
  const actor = { provider: "github", accountId: "review-account" };
  const target = { provider: "github", resourceId: "acme/repo#42", version: HEAD };
  const action = { type: "pull_request_review", reviewEvent, body: "Review findings" };
  return { id: "review-delivery-42", kind: "github.work-proposal-review", requestedBy: { roleId: "pr-engineer", workItemId: "work-42" },
    actor, target, action, display: { title: "Review", summary: "Review summary", actionLabel: "Publish", evidence: [], payload: { actor, target, action } } };
}

async function fixture({ reviewEvent = "REQUEST_CHANGES", automatic = true, legacyAutomatic = false } = {}) {
  const store = new MemoryStore(); let publications = 0, localRequests = 0;
  const facts = { kind: "pull_request", state: "open", isDraft: false, author: "developer", currentUser: "review-account",
    headRefOid: HEAD, incomingReviewFactsAvailable: true, reviewRecipient: "review-account",
    reviewReceivedAt: "2026-10-15T01:30:00Z", reviewReceivedVia: "assignee", reviewReceivedFrom: "developer", reviewRequestEventId: "assignment-42",
    title: "Qt regression", labels: [] };
  const assignees = new Set(["review-account"]), calls = [];
  const issue = () => ({ number: 42, state: facts.state, html_url: "https://github.com/acme/repo/pull/42",
    assignees: [...assignees].map((login) => ({ login })) });
  const adapter = createGitHubActionExecutor({ ghCommand: path.resolve("fictional-gh.exe"),
    credentialSource: Object.freeze({ async acquire() { return Object.freeze({ use: (callback) => callback("fixture-token"), release() {} }); } }),
    runner: { async run(input) {
      calls.push(clone(input)); const route = input.args.find((value) => value.startsWith("repos/"));
      const method = input.args[input.args.indexOf("--method") + 1];
      let value;
      if (!route && input.args.at(-1) === "user") value = { login: "review-account" };
      else if (route === "repos/acme/repo/pulls/42") value = { ...issue(), head: { sha: facts.headRefOid }, user: { login: facts.author } };
      else if (route === "repos/acme/repo/issues/42") value = issue();
      else if (route === "repos/acme/repo/issues/42/assignees") {
        for (const login of JSON.parse(input.input).assignees) { if (method === "POST") assignees.add(login); else assignees.delete(login); }
        value = issue();
      } else assert.fail(`Unexpected GitHub route ${route}`);
      return { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", durationMs: 1, truncated: false };
    } } });
  const makeQueue = () => new ConfirmationQueue({ store, exclusiveLease: { run: (operation) => operation() }, clock: () => new Date(NOW),
    reviewHandoffPolicy: { testingOwnersByProduct: { qt: ["tester"] } },
    executor: { async execute() { publications++; return { status: "applied", receipt: { id: "review-42" } }; }, async reconcile() { assert.fail("must not republish Review"); } } });
  let queue = makeQueue(); await queue.recover(); const queued = await queue.enqueue(plan(reviewEvent));
  if (automatic && !legacyAutomatic) {
    await new AutomaticReviewPublisher({ enabled: true, queue, clock: () => new Date(NOW),
      testingOwnersByProduct: { qt: ["tester"] }, github: { async readIncomingReviewRequest() { return facts; } } }).publish(queued);
  } else {
    await queue.approve(queued.id, { requestId: legacyAutomatic ? `auto-review-v1-${"f".repeat(48)}` : "manual-review-42", expectedQueueRevision: queued.queueRevision,
      expectedItemRevision: queued.itemRevision, displayedPayloadDigest: queued.displayedPayloadDigest,
      approvalBindingDigest: queued.approvalBindingDigest, reviewHandoff: { workType: "pull_request", responsiblePerson: null } });
  }
  const ownerWorkRequests = { async submit() { localRequests++; return { phase: "intaken", workItemId: "work-followup",
    assignment: { target: { id: reviewEvent === "APPROVE" ? "tester" : "pr-engineer" } } }; } };
  const reconciler = (confirmations = queue, options = {}) => new ReviewHandoffReconciler({ confirmations, ownerWorkRequests,
    githubAssignee: adapter, testingOwnersByProduct: { qt: ["tester"] }, ...options });
  return { facts, calls, assignees, reconciler, get queue() { return queue; },
    get publications() { return publications; }, get localRequests() { return localRequests; },
    async restart() { queue = makeQueue(); await queue.recover(); } };
}

for (const reviewEvent of ["REQUEST_CHANGES", "COMMENT"]) {
  test(`automatic ${reviewEvent} delivers only the author assignment across acknowledgement loss and restart`, async () => {
    const f = await fixture({ reviewEvent });
    const request = (await f.queue.readReviewHandoffs())[0].request;
    assert.equal(request.kind, "review_author_assignment");
    await f.reconciler({ readReviewHandoffs: (...args) => f.queue.readReviewHandoffs(...args),
      async recordReviewHandoff() { throw new Error("acknowledgement lost"); } }).runCycle();
    assert.equal(f.localRequests, 0);
    assert.deepEqual([...f.assignees], ["developer"]);
    const writeCount = f.calls.filter((call) => ["POST", "DELETE"].some((method) => call.args.includes(method))).length;
    assert.equal(writeCount, 2);
    await f.restart(); await f.reconciler().runCycle(); await f.reconciler().runCycle();
    const history = (await f.queue.list()).items[0].reviewHandoff;
    assert.equal(history.deliveryKind, "assignment_only"); assert.equal(history.status, "completed");
    assert.equal(history.assignedLogin, "developer"); assert.equal(history.workItemId, null); assert.equal(history.roleId, null);
    assert.equal(f.calls.filter((call) => call.args.includes("POST") || call.args.includes("DELETE")).length, writeCount);
    assert.equal(f.publications, 1); assert.equal(f.localRequests, 0);
  });
}

test("automatic APPROVE preserves the tester work and explicit manual Review preserves local work", async () => {
  for (const options of [{ reviewEvent: "APPROVE" }, { automatic: false }]) {
    const f = await fixture(options); assert.equal((await f.reconciler().runCycle())[0].status, "completed");
    assert.equal(f.localRequests, 1);
    assert.equal((await f.queue.list()).items[0].reviewHandoff.workItemId, "work-followup");
  }
});

test("a legacy pending automatic author handoff is recovered without creating another local Review", async () => {
  const f = await fixture({ legacyAutomatic: true }); await f.restart();
  assert.equal((await f.queue.list()).items[0].reviewHandoff.selection.workType, "pull_request");
  assert.equal((await f.reconciler().runCycle())[0].status, "completed");
  const delivery = (await f.queue.list()).items[0].reviewHandoff;
  assert.equal(delivery.deliveryKind, "assignment_only"); assert.equal(delivery.workItemId, null);
  assert.equal(delivery.assignedLogin, "developer"); assert.equal(f.localRequests, 0);
});

for (const [name, drift, options] of [
  ["Head changes", (f) => { f.facts.headRefOid = "9".repeat(40); }, {}],
  ["PR closes", (f) => { f.facts.state = "closed"; }, {}],
  ["author becomes actor", (f) => { f.facts.author = "review-account"; }, {}],
  ["policy closes", () => {}, { automaticAssignmentsEnabled: false }],
]) {
  test(`author assignment settles without local work or GitHub writes when ${name}`, async () => {
    const f = await fixture(); drift(f);
    assert.equal((await f.reconciler(f.queue, options).runCycle())[0].status, "stale");
    assert.equal(f.localRequests, 0); assert.equal(f.publications, 1);
    assert.equal(f.calls.some((call) => call.args.includes("POST") || call.args.includes("DELETE")), false);
  });
}

test("assignment-only selection cannot replace explicit manual work or an APPROVE testing handoff", async () => {
  for (const [reviewEvent, requestId] of [["COMMENT", "manual-review-42"], ["APPROVE", `auto-review-v1-${"f".repeat(48)}`]]) {
    let writes = 0;
    const queue = new ConfirmationQueue({ store: new MemoryStore(), exclusiveLease: { run: (operation) => operation() },
      executor: { async execute() { writes++; assert.fail("invalid handoff must not execute"); }, async reconcile() { assert.fail(); } } });
    await queue.recover(); const item = await queue.enqueue(plan(reviewEvent));
    await assert.rejects(queue.approve(item.id, { requestId, expectedQueueRevision: item.queueRevision,
      expectedItemRevision: item.itemRevision, displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest, reviewHandoff: { workType: "assignment", responsiblePerson: null } }),
    { code: "INVALID_REVIEW_HANDOFF" });
    assert.equal(writes, 0);
  }
});
