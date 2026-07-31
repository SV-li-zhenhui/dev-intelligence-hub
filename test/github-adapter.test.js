import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubAdapter,
  classifyPullRequestRelation,
  combinePullRequestRecords,
  summarizeCheckStatus,
  summarizeReviewFacts,
} from "../src/adapters/github-adapter.js";

test("a pull request assigned to me by another author means review", () => {
  assert.equal(
    classifyPullRequestRelation("assigned", "SV-li-zhenhui", "SV-wang-xuepeng"),
    "review_requested",
  );
});

test("my own assigned pull request remains my modification work", () => {
  assert.equal(
    classifyPullRequestRelation("assigned", "SV-li-zhenhui", "SV-li-zhenhui"),
    "authored",
  );
});

test("assigned and authored searches combine before detail lookup", () => {
  const own = {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "SV-li-zhenhui" },
  };
  const assignedByOther = {
    number: 8,
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
  };

  const combined = combinePullRequestRecords(
    [own, assignedByOther],
    [own],
    "SV-li-zhenhui",
  );

  assert.equal(combined.length, 2);
  assert.deepEqual(
    combined.find((record) => record.number === 7).relationSources,
    ["assignee", "author"],
  );
  assert.equal(
    combined.find((record) => record.number === 7).relation,
    "authored",
  );
  assert.equal(
    combined.find((record) => record.number === 8).relation,
    "review_requested",
  );
});

test("review facts retain the commit reviewed by each responsible person", () => {
  const facts = summarizeReviewFacts(
    [
      {
        author: { login: "SV-li-zhenhui" },
        state: "COMMENTED",
        submittedAt: "2026-07-20T09:00:00Z",
        commit: { oid: "head-1" },
      },
      {
        author: { login: "SV-li-zhenhui" },
        state: "APPROVED",
        submittedAt: "2026-07-21T09:00:00Z",
        commit: { oid: "head-2" },
      },
      {
        author: { login: "SV-li-zhenhui" },
        state: "COMMENTED",
        submittedAt: "2026-07-23T09:00:00Z",
        commit: { oid: "head-3" },
      },
      {
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-22T09:00:00Z",
        commit: { oid: "head-3" },
      },
    ],
    "SV-li-zhenhui",
  );

  assert.equal(facts.myReviewState, "APPROVED");
  assert.equal(facts.myReviewCommitOid, "head-2");
  assert.equal(facts.latestOtherDecisionState, "CHANGES_REQUESTED");
  assert.equal(facts.latestOtherDecisionCommitOid, "head-3");
  assert.equal(facts.latestChangeRequestCommitOid, "head-3");
  assert.deepEqual(facts.outstandingChangeRequestCommitOids, ["head-3"]);
});

test("resolved reviewer feedback is excluded from outstanding change requests", () => {
  const facts = summarizeReviewFacts(
    [
      {
        author: { login: "reviewer-a" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-20T09:00:00Z",
        commit: { oid: "head-1" },
      },
      {
        author: { login: "reviewer-a" },
        state: "APPROVED",
        submittedAt: "2026-07-22T09:00:00Z",
        commit: { oid: "head-2" },
      },
      {
        author: { login: "reviewer-b" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-21T09:00:00Z",
        commit: { oid: "head-1" },
      },
    ],
    "SV-li-zhenhui",
  );

  assert.deepEqual(facts.outstandingChangeRequestCommitOids, ["head-1"]);
});

test("check summaries never treat cancelled, pending, or unknown states as success", () => {
  assert.equal(
    summarizeCheckStatus([{ conclusion: "CANCELLED" }]),
    "FAILURE",
  );
  assert.equal(
    summarizeCheckStatus([{ status: "WAITING" }]),
    "PENDING",
  );
  assert.equal(
    summarizeCheckStatus([{ conclusion: "NEW_FUTURE_STATE" }]),
    "UNKNOWN",
  );
  assert.equal(
    summarizeCheckStatus([
      { status: "IN_PROGRESS" },
      { conclusion: "FAILURE" },
    ]),
    "FAILURE",
  );
  assert.equal(
    summarizeCheckStatus([
      { conclusion: "FAILURE" },
      { status: "IN_PROGRESS" },
    ]),
    "FAILURE",
  );
});

test("relevant PR search uses the active account, returns every result, and fetches detail once", async () => {
  const calls = [];
  const own = {
    number: 7,
    title: "Own PR",
    url: "https://github.com/acme/repo/pull/7",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "runtime-user" },
    state: "open",
  };
  const assigned = {
    number: 8,
    title: "Review PR",
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
    state: "open",
  };
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search" && args.includes("--assignee=@me")) {
      return [own, assigned];
    }
    if (args[0] === "search" && args.includes("--author=@me")) return [own];
    if (args[0] === "pr") {
      return {
        headRefOid: `head-${args[2].endsWith("/7") ? "7" : "8"}`,
        reviews: [],
        assignees: [],
        labels: [],
        statusCheckRollup: [],
      };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const items = await new GitHubAdapter({ run }).searchRelevantPullRequests();

  assert.equal(items.length, 2);
  assert.equal(calls.filter((args) => args[0] === "pr").length, 2);
  assert.ok(
    calls
      .filter((args) => args[0] === "search")
      .every((args) => args.includes("1000")),
  );
  assert.ok(items.every((item) => item.currentUser === "runtime-user"));
  assert.ok(items.every((item) => item.reviewFactsAvailable));
});

test("a partial PR detail failure makes the source stale instead of returning mixed facts", async () => {
  const record = {
    number: 8,
    title: "Review PR",
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
    state: "open",
  };
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--assignee=@me")) {
        return [record];
      }
      if (args[0] === "search") return [];
      if (args[0] === "pr") throw new Error("detail unavailable");
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests(),
    /detail unavailable/,
  );
});

test("review context is head-pinned and truncates oversized patches", async () => {
  const jsonCalls = [];
  const textCalls = [];
  let viewCount = 0;
  const run = async (_command, args) => {
    jsonCalls.push(args);
    viewCount += 1;
    if (viewCount === 1) {
      return {
        title: "Checkout fix",
        body: "Handle declined payments",
        headRefOid: "head-42",
        additions: 12,
        deletions: 3,
        changedFiles: 1,
        files: [{ path: "src/pay.js", additions: 12, deletions: 3 }],
      };
    }
    return { headRefOid: "head-42" };
  };
  const runText = async (_command, args) => {
    textCalls.push(args);
    return "0123456789abcdefghijklmnopqrstuvwxyz";
  };
  const adapter = new GitHubAdapter({ run, runText, maxPatchCharacters: 20 });

  const result = await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    relation: "review_requested",
    headRefOid: "head-42",
    ciStatus: "SUCCESS",
    mergeStateStatus: "CLEAN",
  });

  assert.equal(result.headRefOid, "head-42");
  assert.equal(result.description, "Handle declined payments");
  assert.equal(result.patch, "0123456789abcdefghij");
  assert.equal(result.patchTruncated, true);
  assert.deepEqual(result.files, [
    { path: "src/pay.js", additions: 12, deletions: 3 },
  ]);
  assert.equal(jsonCalls.length, 2);
  assert.deepEqual(textCalls[0].slice(0, 3), ["pr", "diff", result.url]);
});

test("review context reports a head change instead of returning mixed evidence", async () => {
  let viewCount = 0;
  const adapter = new GitHubAdapter({
    run: async () => {
      viewCount += 1;
      return viewCount === 1
        ? { headRefOid: "head-42", files: [] }
        : { headRefOid: "head-43" };
    },
    runText: async () => "diff",
  });

  const result = await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    url: "https://github.com/acme/repo/pull/42",
    headRefOid: "head-42",
  });

  assert.equal(result.headRefOid, "head-43");
  assert.equal(result.patch, "");
  assert.equal(result.patchTruncated, false);
});

test("owner work can load structured PR context without downloading the patch", async () => {
  let textCalls = 0;
  const adapter = new GitHubAdapter({
    run: async () => ({
      title: "Fix CI",
      body: "Repair the failing check",
      headRefOid: "head-42",
      files: [{ path: "test/pay.test.js", additions: 2, deletions: 0 }],
    }),
    runText: async () => {
      textCalls += 1;
      return "should not be read";
    },
  });

  const result = await adapter.loadReviewContext(
    {
      id: "github:pr:acme/repo#42",
      url: "https://github.com/acme/repo/pull/42",
      headRefOid: "head-42",
    },
    { includePatch: false },
  );

  assert.equal(textCalls, 0);
  assert.equal(result.patch, "");
  assert.equal(result.patchTruncated, false);
  assert.deepEqual(result.files, [
    { path: "test/pay.test.js", additions: 2, deletions: 0 },
  ]);
});

test("version records retain source creation timestamps for newest-first display", async () => {
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[1].includes("milestones")) {
        return [
          {
            number: 3,
            title: "M3",
            created_at: "2026-07-20T00:00:00Z",
            updated_at: "2026-07-21T00:00:00Z",
            due_on: "2026-08-01T00:00:00Z",
            open_issues: 2,
            closed_issues: 5,
            html_url: "https://example.invalid/m3",
          },
        ];
      }
      return [
        {
          id: 9,
          name: "v9",
          tag_name: "v9",
          created_at: "2026-07-22T00:00:00Z",
          published_at: "2026-07-23T00:00:00Z",
          html_url: "https://example.invalid/v9",
        },
      ];
    },
  });

  const versions = await adapter.versions(["acme/repo"]);

  assert.equal(
    versions.find((version) => version.type === "milestone").createdAt,
    "2026-07-20T00:00:00Z",
  );
  assert.equal(
    versions.find((version) => version.type === "release").createdAt,
    "2026-07-22T00:00:00Z",
  );
});

test("a partial version API failure cannot erase previously tracked records", async () => {
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[1].includes("milestones")) return [];
      throw new Error("release API unavailable");
    },
  });

  await assert.rejects(
    adapter.versions(["acme/repo"]),
    /only partially refreshed/,
  );
});
