import assert from "node:assert/strict";
import test from "node:test";

import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  codeExecutionSourceWritablePaths,
  createConflictCodeExecutionSource,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "../src/domain/code-execution-source.js";

function gitTarget(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "owner-account",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix-conflict",
    headRefOid: "b".repeat(40),
    ...overrides,
  };
}

function inputBinding(target = gitTarget()) {
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
    eventDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    gitTarget: target,
  };
}

function preparationBinding(
  target = gitTarget(),
  conflicts = [
    { path: "src/first.js", mode: "100644" },
    { path: "src/second.js", mode: "100644" },
  ],
) {
  return createConflictPreparationBinding({
    preparation: {
      schemaVersion: 1,
      preparationId: "1".repeat(64),
      status: "conflicted",
      baseCommitOid: target.baseRefOid,
      headCommitOid: target.headRefOid,
      mergeBaseOid: "e".repeat(40),
      resultTreeOid: "f".repeat(40),
      conflicts,
      boundaryDigest: "2".repeat(64),
      evidenceDigest: "3".repeat(64),
      resultObjectDigest: "4".repeat(64),
      materialization: "full-tree",
    },
    gitTarget: target,
  });
}

test("creates one atomic conflict execution source with exact-file scope", () => {
  const pullRequest = inputBinding();
  const preparation = preparationBinding();
  const source = createConflictCodeExecutionSource({
    inputBinding: pullRequest,
    preparationBinding: preparation,
  });

  assert.deepEqual(source, {
    schemaVersion: 1,
    kind: "conflict_preparation",
    inputBinding: pullRequest,
    preparationBinding: preparation,
    writeScope: {
      mode: "exact_files",
      paths: ["src/first.js", "src/second.js"],
    },
  });
  assert.notEqual(source.inputBinding, pullRequest);
  assert.notEqual(source.preparationBinding, preparation);
  assert.deepEqual(codeExecutionSourceWritablePaths(source), [
    "src/first.js",
    "src/second.js",
  ]);
  assert.equal(sameCodeExecutionSource(source, structuredClone(source)), true);
});

test("normalization rejects changed provenance, scope, shape, and legacy PR identity", () => {
  const source = createConflictCodeExecutionSource({
    inputBinding: inputBinding(),
    preparationBinding: preparationBinding(),
  });

  for (const changed of [
    {
      ...source,
      writeScope: { ...source.writeScope, paths: ["src/first.js"] },
    },
    {
      ...source,
      writeScope: {
        ...source.writeScope,
        paths: [...source.writeScope.paths].reverse(),
      },
    },
    { ...source, extra: true },
    {
      ...source,
      preparationBinding: preparationBinding(
        gitTarget({ sourceAccountId: "other-account" }),
      ),
    },
    {
      ...source,
      inputBinding: {
        ...source.inputBinding,
        schemaVersion: 1,
        gitTarget: undefined,
      },
    },
  ]) {
    assert.throws(() => normalizeCodeExecutionSource(changed));
    assert.equal(sameCodeExecutionSource(source, changed), false);
  }

  const accessor = structuredClone(source);
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  assert.throws(() => normalizeCodeExecutionSource(accessor));
  for (const proxy of [
    new Proxy(structuredClone(source), {}),
    {
      ...source,
      writeScope: new Proxy(structuredClone(source.writeScope), {}),
    },
    {
      ...source,
      writeScope: {
        ...source.writeScope,
        paths: new Proxy([...source.writeScope.paths], {}),
      },
    },
  ]) {
    assert.throws(() => normalizeCodeExecutionSource(proxy));
  }
});

test("execution source rejects conflict paths that exceed its durable memory boundary", () => {
  const overlongPath = `${"a".repeat(171)}/${"b".repeat(171)}/${"c".repeat(171)}`;
  const overlongSegment = `${"d".repeat(256)}/value.js`;

  for (const conflictPath of [overlongPath, overlongSegment]) {
    assert.throws(
      () =>
        createConflictCodeExecutionSource({
          inputBinding: inputBinding(),
          preparationBinding: preparationBinding(gitTarget(), [
            { path: conflictPath, mode: "100644" },
          ]),
        }),
      (error) => error?.code === "INVALID_CODE_EXECUTION_SOURCE",
    );
  }
});

test("execution source rejects control characters before they reach durable memory", () => {
  for (const conflictPath of ["src/tab\tname.js", "src/line\nname.js"]) {
    assert.throws(
      () =>
        createConflictCodeExecutionSource({
          inputBinding: inputBinding(),
          preparationBinding: preparationBinding(gitTarget(), [
            { path: conflictPath, mode: "100644" },
          ]),
        }),
      (error) => error?.code === "INVALID_CODE_EXECUTION_SOURCE",
    );
  }
});
