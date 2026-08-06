import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePullRequestGitTarget,
  pullRequestGitTargetFromEvent,
  pullRequestGitTargetMatchesEvent,
  samePullRequestGitTarget,
} from "../src/domain/git-tool-contract.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function target(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "Runtime-User",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: BASE,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: HEAD,
    ...overrides,
  };
}

function event(overrides = {}) {
  const gitTarget = target(overrides);
  return {
    eventType: "pull_request.updated",
    subject: { repository: "acme/repo", number: 42 },
    payload: {
      gitTarget,
      gitTargetAvailable: true,
      headRefOid: gitTarget.headRefOid,
    },
  };
}

test("normalizes one complete GitHub PR target as an immutable fact", () => {
  const normalized = normalizePullRequestGitTarget(target());

  assert.equal(normalized.sourceAccountId, "runtime-user");
  assert.equal(normalized.baseRefOid, BASE);
  assert.equal(normalized.headRefOid, HEAD);
  assert.ok(Object.isFrozen(normalized));
  assert.equal(samePullRequestGitTarget(normalized, target()), true);
});

test("rejects partial, mixed-format, ambiguous, and accessor Git targets", () => {
  for (const invalid of [
    { ...target(), baseRefOid: "" },
    { ...target(), headRefOid: "b".repeat(64) },
    { ...target(), baseRefName: "refs/heads/../main" },
    { ...target(), headRefName: "fix@{upstream}" },
    { ...target(), headRepository: "../repo" },
    { ...target(), baseRepository: "owner-/repo" },
    { ...target(), headRefName: "fix/\u202Etxt" },
    { ...target(), headRefName: "fix/zero\u200Bwidth" },
    { ...target(), headRefName: "fix/next\u0085line" },
    { ...target(), headRefName: "fix/\ud800" },
    { ...target(), extra: true },
  ]) {
    assert.throws(() => normalizePullRequestGitTarget(invalid));
  }

  let invoked = false;
  const accessor = target();
  Object.defineProperty(accessor, "baseRefOid", {
    enumerable: true,
    get() {
      invoked = true;
      return BASE;
    },
  });
  assert.throws(() => normalizePullRequestGitTarget(accessor));
  assert.equal(invoked, false);

  const proxy = new Proxy(target(), {
    getPrototypeOf() {
      invoked = true;
      throw new Error("getPrototypeOf trap must not run");
    },
    ownKeys() {
      invoked = true;
      throw new Error("ownKeys trap must not run");
    },
    getOwnPropertyDescriptor() {
      invoked = true;
      throw new Error("descriptor trap must not run");
    },
    get() {
      invoked = true;
      throw new Error("get trap must not run");
    },
  });
  invoked = false;
  assert.throws(() => normalizePullRequestGitTarget(proxy));
  assert.equal(invoked, false);
});

test("creates a target only from a complete, base-repository-bound event", () => {
  const observed = pullRequestGitTargetFromEvent(event());
  assert.equal(observed.sourceAccountId, "runtime-user");
  assert.equal(pullRequestGitTargetMatchesEvent(observed, event()), true);
  assert.equal(
    pullRequestGitTargetMatchesEvent(observed, event({ baseRefOid: "c".repeat(40) })),
    false,
  );

  assert.equal(
    pullRequestGitTargetFromEvent({
      eventType: "pull_request.updated",
      subject: { repository: "acme/repo", number: 42 },
      payload: { headRefOid: HEAD },
    }),
    null,
  );
  const partial = event();
  delete partial.payload.gitTarget.baseRefOid;
  assert.throws(() => pullRequestGitTargetFromEvent(partial));

  const duplicated = event();
  duplicated.payload.baseRefOid = duplicated.payload.gitTarget.baseRefOid;
  assert.throws(() => pullRequestGitTargetFromEvent(duplicated));

  assert.throws(() => pullRequestGitTargetFromEvent({
    eventType: "pull_request.updated",
    subject: { repository: "acme/repo", number: 42 },
    payload: {
      headRefOid: HEAD,
      gitTargetAvailable: false,
      baseRefOid: BASE,
    },
  }));
  assert.throws(() => pullRequestGitTargetFromEvent({
    eventType: "issue.updated",
    subject: { repository: "acme/repo", number: 42 },
    payload: { gitTargetAvailable: false },
  }));
});
