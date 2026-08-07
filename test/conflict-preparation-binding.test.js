import assert from "node:assert/strict";
import test from "node:test";

import {
  ConflictPreparationBindingError,
  conflictPreparationBindingMatchesPullRequest,
  conflictPreparationWritablePaths,
  createConflictPreparationBinding,
  normalizeConflictPreparationBinding,
  sameConflictPreparationBinding,
} from "../src/domain/conflict-preparation-binding.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const RESULT_TREE = "d".repeat(40);

function gitTarget(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: BASE,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: HEAD,
    ...overrides,
  };
}

function preparation(overrides = {}) {
  return {
    schemaVersion: 1,
    preparationId: "1".repeat(64),
    status: "conflicted",
    baseCommitOid: BASE,
    headCommitOid: HEAD,
    mergeBaseOid: MERGE_BASE,
    resultTreeOid: RESULT_TREE,
    conflicts: [
      { path: "src/first.js", mode: "100644" },
      { path: "src/second.js", mode: "100644" },
    ],
    boundaryDigest: "2".repeat(64),
    evidenceDigest: "3".repeat(64),
    resultObjectDigest: "4".repeat(64),
    materialization: "full-tree",
    ...overrides,
  };
}

function pullRequestBinding(target = gitTarget()) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: target.baseRepository,
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/repo#42",
    workKey: "pr:acme/repo#42",
    inputRevision: 3,
    headRevision: 5,
    headRefOid: target.headRefOid,
    eventId: "github-event-42",
    eventDigest: "5".repeat(64),
    inputDigest: "6".repeat(64),
    gitTarget: target,
  };
}

test("creates a detached exact binding for one conflicted Git preparation", () => {
  const target = gitTarget();
  const prepared = preparation();

  const binding = createConflictPreparationBinding({
    preparation: prepared,
    gitTarget: target,
  });

  assert.deepEqual(binding, {
    schemaVersion: 1,
    kind: "controlled_git_conflict",
    preparationId: prepared.preparationId,
    gitTarget: target,
    status: "conflicted",
    mergeBaseOid: MERGE_BASE,
    resultTreeOid: RESULT_TREE,
    conflicts: prepared.conflicts,
    boundaryDigest: prepared.boundaryDigest,
    evidenceDigest: prepared.evidenceDigest,
    resultObjectDigest: prepared.resultObjectDigest,
    materialization: "full-tree",
  });
  assert.notStrictEqual(binding.gitTarget, target);
  assert.notStrictEqual(binding.conflicts, prepared.conflicts);
  assert.notStrictEqual(binding.conflicts[0], prepared.conflicts[0]);
  assert.deepEqual(conflictPreparationWritablePaths(binding), [
    "src/first.js",
    "src/second.js",
  ]);

  target.baseRefName = "changed";
  prepared.conflicts[0].path = "changed.js";
  assert.equal(binding.gitTarget.baseRefName, "main");
  assert.equal(binding.conflicts[0].path, "src/first.js");
});

test("normalizes only exact, sorted ordinary conflict evidence", () => {
  const binding = createConflictPreparationBinding({
    preparation: preparation(),
    gitTarget: gitTarget(),
  });
  assert.deepEqual(normalizeConflictPreparationBinding(binding), binding);

  const invalidBindings = [
    { ...binding, extra: true },
    { ...binding, schemaVersion: 2 },
    { ...binding, kind: "git_head" },
    { ...binding, preparationId: "x".repeat(64) },
    { ...binding, status: "clean" },
    { ...binding, mergeBaseOid: "a".repeat(64) },
    { ...binding, materialization: "conflicts-only" },
    { ...binding, conflicts: [] },
    {
      ...binding,
      conflicts: [binding.conflicts[1], binding.conflicts[0]],
    },
    {
      ...binding,
      conflicts: [{ path: "../outside.js", mode: "100644" }],
    },
    {
      ...binding,
      conflicts: [{ path: ".env.production", mode: "100644" }],
    },
    {
      ...binding,
      conflicts: [{ path: "src/link", mode: "120000" }],
    },
  ];
  for (const candidate of invalidBindings) {
    assert.throws(
      () => normalizeConflictPreparationBinding(candidate),
      (error) =>
        error instanceof ConflictPreparationBindingError &&
        error.code === "INVALID_CONFLICT_PREPARATION_BINDING",
    );
  }
});

test("creation rejects clean or mismatched preparation projections", () => {
  for (const prepared of [
    preparation({ status: "clean", conflicts: [] }),
    preparation({ baseCommitOid: "7".repeat(40) }),
    preparation({ headCommitOid: "8".repeat(40) }),
    preparation({ conflicts: [{ path: "src/value.js", mode: "100755" }] }),
    { ...preparation(), extra: true },
  ]) {
    assert.throws(
      () =>
        createConflictPreparationBinding({
          preparation: prepared,
          gitTarget: gitTarget(),
        }),
      ConflictPreparationBindingError,
    );
  }
});

test("matches the complete PR Git identity and rejects every changed provenance", () => {
  const binding = createConflictPreparationBinding({
    preparation: preparation(),
    gitTarget: gitTarget(),
  });
  assert.equal(
    conflictPreparationBindingMatchesPullRequest(
      binding,
      pullRequestBinding(),
    ),
    true,
  );

  for (const changedTarget of [
    gitTarget({ sourceAccountId: "other-user" }),
    gitTarget({ baseRepository: "other/repo" }),
    gitTarget({ baseRefName: "release" }),
    gitTarget({ baseRefOid: "7".repeat(40) }),
    gitTarget({ headRepository: "other/fork" }),
    gitTarget({ headRefName: "other-branch" }),
    gitTarget({ headRefOid: "8".repeat(40) }),
  ]) {
    assert.equal(
      conflictPreparationBindingMatchesPullRequest(
        binding,
        pullRequestBinding(changedTarget),
      ),
      false,
    );
  }
  assert.equal(
    conflictPreparationBindingMatchesPullRequest(binding, {
      ...pullRequestBinding(),
      schemaVersion: 1,
      gitTarget: undefined,
    }),
    false,
  );
});

test("comparison fails closed for invalid, accessor, and proxy objects", () => {
  const binding = createConflictPreparationBinding({
    preparation: preparation(),
    gitTarget: gitTarget(),
  });
  const accessor = { ...binding };
  let reads = 0;
  Object.defineProperty(accessor, "preparationId", {
    enumerable: true,
    get() {
      reads += 1;
      return binding.preparationId;
    },
  });
  assert.equal(sameConflictPreparationBinding(binding, accessor), false);
  assert.equal(reads, 0);

  const proxy = new Proxy(binding, {
    ownKeys() {
      throw new Error("proxy trap must not run");
    },
  });
  assert.equal(sameConflictPreparationBinding(binding, proxy), false);
  assert.equal(
    conflictPreparationBindingMatchesPullRequest(proxy, pullRequestBinding()),
    false,
  );
});
