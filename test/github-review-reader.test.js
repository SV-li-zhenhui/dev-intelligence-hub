import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReviewReader } from "../src/adapters/github-review-reader.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";
import { createOriginalRepairFeedbackSnapshot } from "../src/domain/original-repair-feedback.js";
import { isReviewSourceFailure } from "../src/domain/review-source-failure.js";

const TARGET = { pullRequestNumber: 42, gitTarget: {
  schemaVersion: 1, provider: "github", sourceAccountId: "reviewer",
  baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40),
  headRepository: "contributor/repo", headRefName: "feature", headRefOid: "b".repeat(40),
} };

function fixture({ changed = 117, moved = false, movedBase = false, missingFile = false, missingDiff = false, liveBase = TARGET.gitTarget.baseRefOid } = {}) {
  const calls = [];
  const files = Array.from({ length: changed }, (_, i) => ({ filename: `src/${i}.js`, status: "modified", additions: 2, deletions: 1 }));
  const diff = files.slice(0, missingDiff ? -1 : undefined).map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n-old\n+${"new ".repeat(180)}\n`).join("");
  let metadataCalls = 0;
  const run = async (command, args) => {
    assert.equal(command, "gh");
    calls.push(args);
    const endpoint = args[3];
    if (endpoint === "graphql") { metadataCalls += 1; const headOid = moved && metadataCalls > 1 ? "c".repeat(40) : TARGET.gitTarget.headRefOid; return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: {
      number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN", author: { login: "contributor" }, changedFiles: changed,
      baseRefName: "main", baseRefOid: TARGET.gitTarget.baseRefOid,
      baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: movedBase && metadataCalls > 1 ? "d".repeat(40) : liveBase } },
      headRefName: "feature", headRefOid: headOid,
      headRef: { name: "feature", repository: { nameWithOwner: "contributor/repo" }, target: { oid: headOid } },
      headRepository: { nameWithOwner: "contributor/repo" },
    } } } }; }
    if (endpoint === "user") return { login: "reviewer" };
    if (endpoint === "repos/acme/repo/pulls/42") return { number: 42, title: "Fixture PR", body: "", html_url: "https://github.com/acme/repo/pull/42",
      head: { sha: TARGET.gitTarget.headRefOid }, base: { repo: { full_name: "acme/repo" } } };
    if (endpoint === "repos/acme/repo/pulls/42/files?per_page=100") {
      assert.ok(args.includes("--paginate"));
      return [files.slice(0, 100), files.slice(100, missingFile ? -1 : undefined)];
    }
    if (endpoint.includes("/contents/")) {
      if (endpoint.includes("/contents/?")) return [{ type: "file", path: "src/related.js" }];
      return { type: "file", encoding: "base64", content: Buffer.from("related implementation\n").toString("base64") };
    }
    throw new Error("unexpected fixture request");
  };
  const runText = async (command, args) => {
    calls.push(args);
    assert.ok(args.includes("Accept: application/vnd.github.diff"));
    assert.match(args[3], new RegExp(`${TARGET.gitTarget.baseRefOid}\\.\\.\\.${TARGET.gitTarget.headRefOid}$`));
    return diff;
  };
  return { reader: new GitHubReviewReader({ run, runText }), files, diff, calls };
}

test("historical PR base SHA cannot authorize a reader against a moved live base", async () => {
  const { reader } = fixture({ changed: 1, liveBase: "d".repeat(40) });
  let session;
  try {
    await assert.rejects(async () => { session = await reader.open(TARGET); }, { code: "PR_REVIEW_READ_HEAD_CHANGED" });
  } finally { await session?.close(); }
});

test("a live base movement after the diff read rejects mixed evidence despite an unchanged historical scalar", async () => {
  await assert.rejects(fixture({ changed: 1, movedBase: true }).reader.open(TARGET), { code: "PR_REVIEW_READ_HEAD_CHANGED" });
});

test("an account change after reading the diff cannot produce a review session", async () => {
  const { reader } = fixture({ changed: 1 });
  const run = reader.run;
  let accountReads = 0;
  reader.run = async (command, args, options) => {
    if (args[3] === "user" && ++accountReads === 2) return { login: "other-account" };
    return run(command, args, options);
  };
  await assert.rejects(reader.open(TARGET), { code: "PR_REVIEW_READ_ACCOUNT_CHANGED" });
  assert.equal(accountReads, 2);
});

for (const boundary of ["files", "diff", "final-target"])
test(`raw GitHub ${boundary} I/O failures belong to the review reader`, async () => {
  const { reader } = fixture({ changed: 1 });
  const original = reader.run;
  let targetReads = 0;
  reader.run = async (...args) => {
    const endpoint = args[1][3];
    if ((boundary === "files" && endpoint.includes("/files?")) ||
        (boundary === "final-target" && endpoint === "graphql" && ++targetReads === 2)) {
      throw new Error("private raw gh response");
    }
    return original(...args);
  };
  if (boundary === "diff") reader.runText = async () => { throw new Error("private raw diff stderr"); };
  await assert.rejects(reader.open(TARGET), error => {
    assert.equal(isReviewSourceFailure(error), true);
    assert.equal(error.code, "PR_REVIEW_READ_UNAVAILABLE");
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "PR review source is unavailable");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});

test("raw source I/O during final completeness validation keeps source identity", async (t) => {
  const { reader } = fixture({ changed: 1 });
  const session = await reader.open(TARGET);
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff"]) await tool(session, "read_document", { document, offset: 0, length: 48000 });
  reader.run = async () => { throw new Error("private final gh response"); };
  await assert.rejects(session.assertComplete(), error => isReviewSourceFailure(error) && error.code === "PR_REVIEW_READ_UNAVAILABLE");
});

async function rpc(session, method, params = {}) {
  const response = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

async function tool(session, name, args) {
  const result = await rpc(session, "tools/call", { name, arguments: args });
  if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
  return JSON.parse(result.content[0].text);
}

test("internal repair review pages the immutable original defect and every thread beside the current Head", async (t) => {
  const originalHead = "c".repeat(40);
  const { feedback, reviewFeedbackDigest } = summarizeOwnReviewFeedback({ reviews: [], threads: Array.from({ length: 10 }, (_, index) => ({
    id: `thread-${index}`, path: `src/${index}.js`, line: index + 1, isResolved: false, isOutdated: false,
    comments: [
      { id: `defect-${index}`, author: { login: "external-reviewer" }, body: `Original defect ${index}: ${"details ".repeat(1_000)}`,
        createdAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-10T01:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: originalHead } } },
      { id: `reply-${index}`, author: { login: "author" }, body: `Author reply ${index}: fixed`,
        createdAt: "2026-10-10T02:00:00Z", updatedAt: "2026-10-10T02:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: originalHead } } },
    ],
  })) }, "author");
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 42,
    context: { schemaVersion: 1, headRefOid: originalHead, reviewFeedbackDigest, feedback },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: originalHead, observedAt: "2026-10-10T03:00:00.000Z" } });
  const descriptor = { snapshotId: snapshot.snapshotId, feedbackDigest: reviewFeedbackDigest,
    originalHeadRefOid: originalHead, reviewHeadRefOid: TARGET.gitTarget.headRefOid };
  const f = fixture({ changed: 1 }); let reads = 0;
  f.reader.originalRepairFeedbackReader = { async read(request) {
    reads++; assert.equal(request.snapshotId, snapshot.snapshotId); return snapshot;
  } };
  const session = await f.reader.open({ ...TARGET, repairFeedback: descriptor }); t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "repair-feedback-manifest.json"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const first = await tool(session, "read_document", { document: "repair-feedback.json", offset: 0, length: 1_000 });
  assert.ok(first.nextOffset); await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  let text = first.text, offset = first.nextOffset;
  while (offset !== null) { const next = await tool(session, "read_document", { document: "repair-feedback.json", offset, length: 8_000 }); text += next.text; offset = next.nextOffset; }
  const original = JSON.parse(text);
  assert.equal(original.feedback.threads.length, 10);
  assert.match(original.feedback.threads[9].comments[0].body, /Original defect 9/);
  assert.match(original.contextualObservations[9].discussion.at(-1).body, /Author reply 9/);
  assert.equal(original.originalHeadRefOid, originalHead);
  assert.equal(JSON.parse((await tool(session, "read_document", { document: "repair-feedback-manifest.json", offset: 0 })).text).reviewHeadRefOid,
    TARGET.gitTarget.headRefOid);
  await session.assertComplete(); assert.equal(reads, 1);
});

test("repair feedback cannot be substituted, omitted, or bound to another review Head", async () => {
  const target = { ...TARGET, repairFeedback: { snapshotId: `repair-feedback-snapshot-${"a".repeat(64)}`,
    feedbackDigest: "f".repeat(64), originalHeadRefOid: "c".repeat(40), reviewHeadRefOid: TARGET.gitTarget.headRefOid } };
  await assert.rejects(fixture({ changed: 1 }).reader.open(target), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
  const substituted = fixture({ changed: 1 }); substituted.reader.originalRepairFeedbackReader = { async read() { return {}; } };
  await assert.rejects(substituted.reader.open(target), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  await assert.rejects(fixture({ changed: 1 }).reader.open({ ...target,
    repairFeedback: { ...target.repairFeedback, reviewHeadRefOid: "9".repeat(40) } }), /feedback Head is invalid/);
});

test("native skill resources are scoped to this reader and must be read before a review completes", async (t) => {
  const skillDocuments = { "review-skill/SKILL.md": "Follow the native review procedure.", "review-skill/manifest.json": "{}", "review-skill/references/correctness.md": "Trace boundary conditions." };
  const session = await fixture({ changed: 1 }).reader.open(TARGET, { skillDocuments });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const registered = (await rpc(session, "tools/list")).tools.find((entry) => entry.name === "read_document");
  assert.ok(registered.inputSchema.properties.document.enum.includes("review-skill/SKILL.md"));
  assert.equal((await tool(session, "read_document", { document: "review-skill/SKILL.md", offset: 0 })).text, skillDocuments["review-skill/SKILL.md"]);
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  await tool(session, "read_document", { document: "review-skill/manifest.json", offset: 0 });
  await session.assertComplete();
  assert.equal((await tool(session, "read_document", { document: "review-skill/references/correctness.md", offset: 0 })).text, skillDocuments["review-skill/references/correctness.md"]);
  await assert.rejects(tool(session, "read_document", { document: "review-skill/../../auth.json", offset: 0 }), { code: "PR_REVIEW_READ_DOCUMENT_INVALID" });
});

test("CLI can page through all 117 files and a diff beyond the old prompt budget", async (t) => {
  const f = fixture();
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  assert.ok(session.diffText.length > 60_000);
  assert.equal(JSON.parse(session.manifestText).files.length, 117);
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const init = await rpc(session, "initialize", { protocolVersion: "2024-11-05" });
  assert.ok(init.capabilities.tools);
  assert.deepEqual((await rpc(session, "tools/list")).tools.map((x) => x.name), ["read_document", "read_source", "list_directory"]);
  for (const [document, expected] of [["review-manifest.json", session.manifestText], ["review.diff", f.diff]]) {
    let offset = 0;
    let text = "";
    do {
      const page = await tool(session, "read_document", { document, offset, length: 8_000 });
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(text, expected);
  }
  await session.assertComplete();
  const related = await tool(session, "read_source", { path: "src/related.js", revision: "head", offset: 0 });
  assert.equal(related.text, "related implementation\n");
  assert.ok(f.calls.some((args) => args[3] === `repos/contributor/repo/contents/src/related.js?ref=${TARGET.gitTarget.headRefOid}`));
  assert.equal((await tool(session, "list_directory", { path: "", revision: "base" })).entries[0].path, "src/related.js");
});

test("partial documents, including a skipped middle range, cannot complete a review", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  await tool(session, "read_document", { document: "review-manifest.json", offset: 0, length: 48_000 });
  await tool(session, "read_document", { document: "review.diff", offset: 0, length: 1_000 });
  for (let offset = 2_000; offset < session.diffText.length; offset += 48_000) {
    await tool(session, "read_document", { document: "review.diff", offset, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
});

test("the read endpoint rejects host paths, unpinned revisions, and write tools", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  for (const path of ["../auth.json", "C:\\private\\token", "/etc/passwd", "src//secret"]) {
    await assert.rejects(tool(session, "read_source", { path, revision: "head", offset: 0 }), { code: "PR_REVIEW_READ_PATH_INVALID" });
  }
  await assert.rejects(tool(session, "read_source", { path: "a.js", revision: "main", offset: 0 }), { code: "PR_REVIEW_READ_REVISION_INVALID" });
  await assert.rejects(tool(session, "write_file", { path: "a.js", text: "change" }), { code: "PR_REVIEW_READ_TOOL_NOT_ALLOWED" });
  assert.equal((await fetch(session.url.replace(/review\/.+$/, "review/wrong"), { method: "POST" })).status, 404);
});

test("a changed Head or incomplete GitHub response is rejected before a CLI can review it", async () => {
  for (const options of [{ moved: true }, { missingFile: true }, { missingDiff: true }]) {
    await assert.rejects(fixture(options).reader.open(TARGET), { code: options.moved ? "PR_REVIEW_READ_HEAD_CHANGED" : options.missingFile ? "PR_REVIEW_READ_FILES_INCOMPLETE" : "PR_REVIEW_READ_DIFF_INCOMPLETE" });
  }
});

test("cancellation closes the read endpoint and releases its listener", async () => {
  const controller = new AbortController();
  const session = await fixture().reader.open(TARGET, { signal: controller.signal });
  controller.abort();
  await session.close();
  await assert.rejects(fetch(session.url));
});

test("source paging reuses the decoded immutable blob and retries a failed fetch", async (t) => {
  const f = fixture({ changed: 1 });
  const original = f.reader.run;
  const source = "related implementation\n".repeat(5_000);
  let blobs = 0;
  f.reader.run = async (command, args, options) => {
    if (args[3].includes("/contents/src/large.js")) return { type: "file", encoding: "none", sha: "c".repeat(40) };
    if (args[3].includes("/git/blobs/")) {
      blobs += 1;
      if (blobs === 1) throw Object.assign(new Error("temporary upstream error"), { code: "PRIVATE_REMOTE_RESPONSE" });
      return { encoding: "base64", content: Buffer.from(source).toString("base64") };
    }
    return original(command, args, options);
  };
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  const args = { path: "src/large.js", revision: "head", offset: 0 };
  await assert.rejects(tool(session, "read_source", args), { code: "PR_REVIEW_READ_FAILED" });
  let text = "", offset = 0;
  do {
    const result = await tool(session, "read_source", { ...args, offset });
    text += result.text;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(text, source);
  assert.equal(blobs, 2);
});


async function fullFeedbackFixture(body = "Full author evidence " + "证据".repeat(10000)) {
  const { normalizeWorkflowEvent } = await import("../src/domain/workflow-events.js");
  const { createPullRequestExecutionBinding } = await import("../src/domain/pull-request-execution-binding.js");
  const { createPullRequestReadIdentity, createPullRequestReadFacts, projectPullRequestReadFactsContext } = await import("../src/domain/pull-request-read-facts.js");
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: "2026-10-28T05:00:00.000Z",
    source: { provider: "github", scopeId: "github-account:reviewer" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { gitTarget: TARGET.gitTarget, gitTargetAvailable: true, headRefOid: TARGET.gitTarget.headRefOid } });
  const executionBinding = createPullRequestExecutionBinding({ event, sourceBinding: { kind: "pull_request", rootItemId: "review-root", workKey: "review-42",
    inputRevision: 1, headRevision: 1, headRefOid: TARGET.gitTarget.headRefOid, eventId: event.eventId, eventDigest: event.contentDigest, inputDigest: "c".repeat(64) } });
  const facts = createPullRequestReadFacts({ identity: createPullRequestReadIdentity({ executionBinding, event }),
    observedAt: "2026-10-28T05:01:00.000Z", reviewDecision: "APPROVED", comments: [{ id: "IC_evidence", author: "developer", body, bodyTruncated: false,
      createdAt: "2026-10-28T05:00:00.000Z", updatedAt: "2026-10-28T05:00:00.000Z", url: "https://github.com/acme/repo/pull/42#issuecomment-1" }],
    reviews: [], reviewThreads: [], checks: [], truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } });
  const materialDigest = projectPullRequestReadFactsContext(facts).materialDigest;
  return { facts, materialDigest, body };
}

test("current author discussion is a required paged document rather than an inline preview", async (t) => {
  const { facts, materialDigest, body } = await fullFeedbackFixture();
  const { reader } = fixture({ changed: 1 }); let reads = 0;
  const run = reader.run;
  reader.run = async (command, args, options) => {
    const value = await run(command, args, options);
    return args[3] === "repos/acme/repo/pulls/42" ? { ...value, html_url: "https://github.com/Acme/Repo/pull/42" } : value;
  };
  reader.currentReviewFeedbackReader = { async read(input) { reads++; assert.equal(input.taskId, "review-child"); assert.equal(input.materialDigest, materialDigest); return facts; } };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "review-description.json"]) await tool(session, "read_document", { document, offset: 0, length: 48000 });
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  let text = "", offset = 0;
  while (offset !== null) { const next = await tool(session, "read_document", { document: "review-feedback.json", offset, length: 4000 }); text += next.text; offset = next.nextOffset; }
  assert.equal(JSON.parse(text).comments[0].body, body);
  await session.assertComplete(); assert.equal(reads, 2);
});


test("linked product issue text is mandatory and changes during review invalidate the snapshot", async (t) => {
  const root = "https://github.com/acme/product/issues/7";
  const { facts, materialDigest } = await fullFeedbackFixture(`I supplemented validation: ${root}#issuecomment-9`);
  const { reader } = fixture({ changed: 1 }); const original = reader.run;
  reader.currentReviewFeedbackReader = { async read() { return facts; } };
  let extraResult = "";
  reader.run = async (command, args, options) => {
    if (args[3] === "repos/acme/product/issues/7") return { number: 7, title: "Hardware validation", body: "Bug context", state: "open",
      user: { login: "qa" }, comments: 1, created_at: "2026-10-28T04:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: root };
    if (args[3] === "repos/acme/product/issues/7/comments?per_page=20&page=1") return [{ id: 9, node_id: "IC_9", body: "Validation procedure; actual hardware result is still pending QA" + extraResult,
      user: { login: "developer" }, created_at: "2026-10-28T05:00:00Z", updated_at: "2026-10-28T05:00:00Z",
      html_url: `${root}#issuecomment-9`, issue_url: "https://api.github.com/repos/acme/product/issues/7" }];
    return original(command, args, options);
  };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json"]) {
    let offset = 0; while (offset !== null) offset = (await tool(session, "read_document", { document, offset, length: 48000 })).nextOffset;
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const manifest = JSON.parse(session.manifestText);
  const reference = manifest.feedbackSnapshot.linkedMaterials[0];
  const linked = JSON.parse((await tool(session, "read_document", { document: reference.document, offset: 0, length: 48000 })).text);
  assert.match(linked.comments[0].body, /still pending QA/);
  await session.assertComplete();
  extraResult = "; QA has now added actual execution results";
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_MATERIAL_CHANGED" });
});

test("semantic feedback coverage survives CI observations and changes with the PR description", async () => {
  const { readGitHubReviewFeedbackSnapshot } = await import("../src/adapters/github-review-feedback-snapshot.js");
  const { createPullRequestReadFacts, projectPullRequestReadFactsContext } = await import("../src/domain/pull-request-read-facts.js");
  const initial = await fullFeedbackFixture("Complete author evidence");
  const { reader } = fixture({ changed: 1 });
  let facts = initial.facts, description = "";
  const capture = () => readGitHubReviewFeedbackSnapshot({
    target: { ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } },
    factsReader: { async read() { return facts; } }, run: async (...args) => {
      const value = await reader.run(...args);
      return args[1][3] === "repos/acme/repo/pulls/42" ? { ...value, body: description } : value;
    },
  });
  const first = await capture();
  const { contentDigest: _digest, schemaVersion: _schema, ...content } = facts;
  facts = createPullRequestReadFacts({ ...content, observedAt: "2026-10-28T05:02:00.000Z", checks: [{
    kind: "check_run", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci.example/run/1",
    requirement: "required", startedAt: "2026-10-28T05:00:00.000Z", completedAt: "2026-10-28T05:01:00.000Z" }] });
  const afterCI = await capture();
  assert.notEqual(afterCI.feedbackSnapshot.snapshotDigest, first.feedbackSnapshot.snapshotDigest);
  assert.equal(afterCI.feedbackSnapshot.coverageDigest, first.feedbackSnapshot.coverageDigest);
  description = "QA added execution results";
  assert.notEqual((await capture()).feedbackSnapshot.coverageDigest, first.feedbackSnapshot.coverageDigest);
});

for (const boundary of ["facts", "description", "account"])
test(`feedback snapshot owns raw ${boundary} I/O and preserves its caller abort reason`, async () => {
  const { readGitHubReviewFeedbackSnapshot } = await import("../src/adapters/github-review-feedback-snapshot.js");
  const { facts, materialDigest } = await fullFeedbackFixture("Complete evidence");
  const { reader } = fixture({ changed: 1 });
  const controller = new AbortController(), reason = new Error("snapshot cancelled");
  let cancel = false;
  const fail = () => { if (cancel) controller.abort(reason); throw new Error("private source response"); };
  const capture = () => readGitHubReviewFeedbackSnapshot({
    target: { ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } },
    factsReader: { async read() { if (boundary === "facts") fail(); return facts; } },
    run: async (...args) => {
      if (args[1][3] === (boundary === "account" ? "user" : "repos/acme/repo/pulls/42")) fail();
      return reader.run(...args);
    }, options: { signal: controller.signal },
  });
  await assert.rejects(capture(), error => isReviewSourceFailure(error) && error.code === "PR_REVIEW_READ_UNAVAILABLE");
  cancel = true;
  await assert.rejects(capture(), error => error === reason);
});
