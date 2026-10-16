import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { readOwnReviewFeedback, summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";

const ACCOUNT = "local-owner";
const HEAD = "a".repeat(40);
const AT = "2026-10-10T01:00:00Z";

function review(overrides = {}) {
  return { id: "review-1", author: { login: "reviewer" }, state: "CHANGES_REQUESTED", submittedAt: AT, commit: { oid: HEAD }, body: "Fix the null dereference", ...overrides };
}

function comment(overrides = {}) {
  return { id: "comment-1", author: { login: "reviewer" }, body: "Handle the empty value", createdAt: AT, updatedAt: AT, pullRequestReview: { id: "review-2", state: "COMMENTED", submittedAt: AT, commit: { oid: HEAD } }, ...overrides };
}

function thread(overrides = {}) {
  return { id: "thread-1", path: "src/example.js", line: 2, isResolved: false, isOutdated: false, comments: [comment()], ...overrides };
}

test("own feedback includes requests for changes and unresolved inline comments, never generic review discussion", () => {
  const result = summarizeOwnReviewFeedback({ reviews: [review(), review({ id: "review-comment", state: "COMMENTED", body: "Thanks!" })], threads: [thread()] }, ACCOUNT);
  assert.equal(result.reviewFeedbackAvailable, true);
  assert.equal(result.reviewFeedbackCount, 2);
  assert.equal(result.reviewPendingThreadCount, 1);
  assert.equal(result.reviewChangeRequestCount, 1);
  assert.deepEqual(result.reviewFeedbackIds, ["review:review-1", "thread:thread-1"]);
  assert.equal(result.feedback.threads[0].comments[0].body, "Handle the empty value");
});

test("resolved, outdated, dismissed, pending, and author-only thread comments cannot start repair", () => {
  const threads = [
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "outdated", isOutdated: true }),
    thread({ id: "self", comments: [comment({ author: { login: ACCOUNT.toUpperCase() } })] }),
    thread({ id: "dismissed", comments: [comment({ pullRequestReview: { state: "DISMISSED" } })] }),
    thread({ id: "pending", comments: [comment({ pullRequestReview: { state: "PENDING" } })] }),
  ];
  assert.equal(summarizeOwnReviewFeedback({ reviews: [], threads }, ACCOUNT).reviewFeedbackCount, 0);
});

test("feedback identity changes on same-head new or edited feedback and does not assume a new head resolves it", () => {
  const initial = summarizeOwnReviewFeedback({ reviews: [review()], threads: [thread()] }, ACCOUNT);
  const same = summarizeOwnReviewFeedback({ reviews: [review()], threads: [thread()] }, ACCOUNT);
  assert.equal(initial.reviewFeedbackDigest, same.reviewFeedbackDigest);
  const moved = summarizeOwnReviewFeedback({ reviews: [review()], threads: [thread({ line: 55, comments: [comment(), comment({ id: "self-reply", author: { login: ACCOUNT }, body: "Fixed in a new commit" })] })] }, ACCOUNT);
  assert.equal(initial.reviewFeedbackDigest, moved.reviewFeedbackDigest);
  assert.deepEqual(moved.reviewFeedbackFingerprints, initial.reviewFeedbackFingerprints);
  assert.equal(moved.feedback.threads[0].discussion.length, 2);
  assert.equal(moved.feedback.threads[0].discussion[1].author, ACCOUNT);
  assert.equal(moved.feedback.threads[0].discussion[1].body, "Fixed in a new commit");
  const edited = summarizeOwnReviewFeedback({ reviews: [review()], threads: [thread({ comments: [comment({ body: "Also handle missing keys" })] })] }, ACCOUNT);
  assert.notEqual(initial.reviewFeedbackDigest, edited.reviewFeedbackDigest);
  const newFeedback = summarizeOwnReviewFeedback({ reviews: [review()], threads: [thread(), thread({ id: "thread-2" })] }, ACCOUNT);
  assert.notEqual(initial.reviewFeedbackDigest, newFeedback.reviewFeedbackDigest);
  const approved = summarizeOwnReviewFeedback({ reviews: [review(), review({ id: "approved", state: "APPROVED", submittedAt: "2026-10-10T02:00:00Z", commit: { oid: "b".repeat(40) } })], threads: [] }, ACCOUNT);
  assert.equal(approved.reviewFeedbackCount, 0);
  const dismissed = summarizeOwnReviewFeedback({ reviews: [review({ state: "DISMISSED" })], threads: [] }, ACCOUNT);
  assert.equal(dismissed.reviewFeedbackCount, 0);
});

function page(nodes, hasNextPage = false, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function pullRequest(overrides = {}) {
  return { number: 42, url: "https://github.com/acme/repo/pull/42", author: { login: ACCOUNT }, state: "OPEN", headRefOid: HEAD, reviewDecision: "CHANGES_REQUESTED", ...overrides };
}

test("live own feedback queries and returns the current Draft fact", async () => {
  const queries = [];
  const result = await readOwnReviewFeedback(async (_command, args) => {
    queries.push(args.find((value) => value.startsWith("query=")));
    return { data: { repository: { pullRequest: pullRequest({ isDraft: true,
      reviews: page([]), reviewThreads: page([]) }) } } };
  }, { repository: "acme/repo", number: 42, account: ACCOUNT });
  assert.equal(result.isDraft, true);
  assert.equal(queries.every((query) => query.includes("isDraft")), true);
});

for (const driftAt of ["Reviews", "Threads", "ThreadComments", "Identity"]) {
  test(`live own feedback rejects a Draft change during ${driftAt}`, async () => {
    const run = async (_command, args) => {
      const query = args.find((value) => value.startsWith("query="));
      const isChangedPage = query.includes(`query OwnReviewFeedback${driftAt}(`);
      const pr = pullRequest({ isDraft: isChangedPage, reviews: page([]), reviewThreads: page([]) });
      if (query.includes("ThreadComments")) return { data: { node: { id: "thread-1", pullRequest: pr, comments: page([]) } } };
      if (query.includes("query OwnReviewFeedback(")) {
        pr.reviews = page([], driftAt === "Reviews", driftAt === "Reviews" ? "next" : null);
        pr.reviewThreads = page([thread({ comments: page([], driftAt === "ThreadComments", driftAt === "ThreadComments" ? "next" : null) })],
          driftAt === "Threads", driftAt === "Threads" ? "next" : null);
      }
      return { data: { repository: { pullRequest: pr } } };
    };
    await assert.rejects(readOwnReviewFeedback(run, { repository: "acme/repo", number: 42, account: ACCOUNT }), /Draft changed during read/);
  });
}

test("live own feedback follows reviews, threads and nested comments through every page", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "api" && args.at(-1) === "user") return { login: ACCOUNT };
    const query = args.find((value) => value.startsWith("query=")) || "";
    if (query.includes("OwnReviewFeedbackThreadComments")) {
      return { data: { node: { id: "thread-1", pullRequest: pullRequest(), comments: page([comment({ id: "comment-2" })]) } } };
    }
    if (query.includes("OwnReviewFeedbackReviews")) {
      return { data: { repository: { pullRequest: pullRequest({ reviews: page([review({ id: "review-2", author: { login: "reviewer-2" } })]) }) } } };
    }
    if (query.includes("OwnReviewFeedbackThreads")) {
      return { data: { repository: { pullRequest: pullRequest({ reviewThreads: page([thread({ id: "thread-2", comments: page([comment()]) })]) }) } } };
    }
    if (query.includes("OwnReviewFeedback")) {
      return { data: { repository: { pullRequest: pullRequest({ reviews: page([review()], true, "reviews-cursor"), reviewThreads: page([thread({ comments: page([comment()], true, "comments-cursor") })], true, "threads-cursor") }) } } };
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  const result = await new GitHubAdapter({ run }).readOwnPullRequestFeedback({ repository: "acme/repo", number: 42, account: ACCOUNT });
  assert.equal(result.headRefOid, HEAD);
  assert.equal(result.author, ACCOUNT);
  assert.equal(result.reviewFeedbackCount, 4);
  assert.equal(result.feedback.threads[0].comments.length, 2);
  assert.ok(calls.some((args) => args.includes("cursor=reviews-cursor")));
  assert.ok(calls.some((args) => args.includes("cursor=threads-cursor")));
  assert.ok(calls.some((args) => args.includes("cursor=comments-cursor")));
});

test("live feedback rejects changed heads, foreign authors, and incomplete pagination", async () => {
  for (const mode of ["head", "author", "cursor"]) {
    const run = async (_command, args) => {
      if (args.at(-1) === "user") return { login: ACCOUNT };
      const first = args.find((value) => value.startsWith("query="))?.includes("query OwnReviewFeedback(");
      const facts = first
        ? pullRequest({ author: { login: mode === "author" ? "other" : ACCOUNT }, reviews: page([review()], true, mode === "cursor" ? null : "next"), reviewThreads: page([]) })
        : pullRequest({ headRefOid: "b".repeat(40), reviews: page([]) });
      return { data: { repository: { pullRequest: facts } } };
    };
    await assert.rejects(new GitHubAdapter({ run }).readOwnPullRequestFeedback({ repository: "acme/repo", number: 42, account: ACCOUNT }), /feedback|author|head|pagination/i);
  }
});

test("discovery exposes own feedback identity without persisting comment bodies or lists into routing facts", async () => {
  const target = pullRequest({ changedFiles: 1, baseRefName: "main", baseRefOid: "b".repeat(40),
    headRefName: "fix/feedback", headRepository: { nameWithOwner: "acme/repo" } });
  const run = async (_command, args) => {
    if (args.at(-1) === "user") return { login: ACCOUNT };
    if (args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTargets {"))) {
      return { data: { r0: { nameWithOwner: "acme/repo", pullRequest: { ...target,
        baseRef: { name: target.baseRefName, repository: { nameWithOwner: "acme/repo" }, target: { oid: target.baseRefOid } },
        headRef: { name: target.headRefName, repository: target.headRepository, target: { oid: target.headRefOid } },
      } } } };
    }
    if (args[0] === "search") return args.includes("--author=@me") ? [{ ...pullRequest(), repository: { nameWithOwner: "acme/repo" }, state: "open", updatedAt: AT, createdAt: AT, title: "Own PR" }] : [];
    if (args[0] === "pr") return { ...target, reviews: [], assignees: [], labels: [], statusCheckRollup: [] };
    return { data: { repository: { pullRequest: pullRequest({ reviews: page([]), reviewThreads: page([thread({ comments: page([comment()]) })]) }) } } };
  };
  const [item] = await new GitHubAdapter({ run }).searchRelevantPullRequests();
  assert.equal(item.relation, "authored");
  assert.equal(item.reviewFeedbackAvailable, true);
  assert.equal(item.reviewFeedbackCount, 1);
  assert.equal(item.reviewFeedbackDigest.length, 64);
  assert.equal(Object.hasOwn(item, "feedback"), false);
  assert.equal(Object.hasOwn(item, "reviewFeedbackIds"), false);
});
