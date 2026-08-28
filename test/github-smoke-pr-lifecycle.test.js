import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupSmokePullRequest,
  runGitHubCli,
  withSmokePullRequestCleanup,
} from "../scripts/github-smoke-pr-lifecycle.mjs";

function smokePullRequest(overrides = {}) {
  return {
    repository: "acme/repo",
    number: 24231,
    title: "[MyDashboard E2E] assignment smoke — DO NOT MERGE",
    state: "OPEN",
    author: "smoke-owner",
    headRepository: "acme/repo",
    headRefName: "test/mydashboard-e2e-20260827-161028",
    ...overrides,
  };
}

test("live PR smoke cleanup closes the marked PR before deleting its branch", async () => {
  const operations = [];

  const result = await cleanupSmokePullRequest({
    pullRequest: smokePullRequest(),
    authenticatedLogin: "smoke-owner",
    closePullRequest: async () => operations.push("close"),
    deleteHeadBranch: async () => operations.push("delete"),
  });

  assert.deepEqual(operations, ["close", "delete"]);
  assert.deepEqual(result, { closed: true, branchDeleted: true });
});

test("live PR smoke cleanup rejects ordinary or foreign pull requests", async () => {
  const noOp = async () => assert.fail("unsafe cleanup operation was invoked");
  for (const pullRequest of [
    smokePullRequest({ title: "Real product PR" }),
    smokePullRequest({ headRefName: "feature/real-work" }),
    smokePullRequest({ headRepository: "someone/fork" }),
    smokePullRequest({ author: "someone-else" }),
  ]) {
    await assert.rejects(
      cleanupSmokePullRequest({
        pullRequest,
        authenticatedLogin: "smoke-owner",
        closePullRequest: noOp,
        deleteHeadBranch: noOp,
      }),
      /refusing to clean up/i,
    );
  }
});

test("live PR smoke cleanup deletes a marked branch without re-closing a closed PR", async () => {
  const events = [];
  const result = await cleanupSmokePullRequest({
    pullRequest: smokePullRequest({ state: "CLOSED" }),
    authenticatedLogin: "smoke-owner",
    closePullRequest: async () => events.push("close"),
    deleteHeadBranch: async () => events.push("delete"),
  });

  assert.deepEqual(events, ["delete"]);
  assert.deepEqual(result, { closed: false, branchDeleted: true });
});

test("GitHub CLI smoke operations have a finite timeout", async () => {
  let received = null;
  const output = await runGitHubCli({
    execute: async (...arguments_) => {
      received = arguments_;
      return { stdout: "ok\n" };
    },
    arguments_: ["api", "user"],
  });

  assert.equal(output, "ok");
  assert.equal(received[0], "gh");
  assert.deepEqual(received[1], ["api", "user"]);
  assert.equal(received[2].timeout, 60_000);
});

test("live PR smoke wrapper performs cleanup after success and failure", async () => {
  const events = [];
  const success = await withSmokePullRequestCleanup({
    run: async () => {
      events.push("run-success");
      return "verified";
    },
    cleanup: async () => events.push("cleanup-success"),
  });
  assert.equal(success, "verified");

  await assert.rejects(
    withSmokePullRequestCleanup({
      run: async () => {
        events.push("run-failure");
        throw new Error("verification failed");
      },
      cleanup: async () => events.push("cleanup-failure"),
    }),
    /verification failed/,
  );
  assert.deepEqual(events, [
    "run-success",
    "cleanup-success",
    "run-failure",
    "cleanup-failure",
  ]);
});

test("live PR smoke wrapper preserves cleanup failures and both failure causes", async () => {
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    withSmokePullRequestCleanup({
      run: async () => "verified",
      cleanup: async () => { throw cleanupFailure; },
    }),
    (error) => error === cleanupFailure,
  );

  const runFailure = new Error("verification failed");
  await assert.rejects(
    withSmokePullRequestCleanup({
      run: async () => { throw runFailure; },
      cleanup: async () => { throw cleanupFailure; },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === runFailure &&
      error.errors[1] === cleanupFailure,
  );
});
