import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequestExecutionBinding,
  normalizePullRequestExecutionBinding,
  pullRequestExecutionTargetMatchesEvent,
  samePullRequestExecutionBinding,
} from "../src/domain/pull-request-execution-binding.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";

function fixture() {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-06T12:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "Resolve conflict",
      headRefOid: "a".repeat(40),
      state: "open",
    },
  });
  const sourceBinding = {
    kind: "pull_request",
    rootItemId: "work-item-pr-42",
    workKey: `pr-work-${"b".repeat(64)}`,
    inputRevision: 3,
    headRevision: 2,
    headRefOid: event.payload.headRefOid,
    eventId: event.eventId,
    eventDigest: event.contentDigest,
    inputDigest: "c".repeat(64),
  };
  return { event, sourceBinding };
}

function gitFixture(overrides = {}) {
  const source = fixture();
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "a".repeat(40),
    ...(Object.hasOwn(overrides, "githubAccount")
      ? { sourceAccountId: overrides.githubAccount }
      : {}),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "githubAccount"),
    ),
  };
  source.event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-06T12:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "Resolve conflict",
      gitTarget,
      gitTargetAvailable: true,
      headRefOid: gitTarget.headRefOid,
      state: "open",
    },
  });
  source.sourceBinding = {
    ...source.sourceBinding,
    eventId: source.event.eventId,
    eventDigest: source.event.contentDigest,
  };
  return source;
}

test("creates one self-describing immutable PR execution identity", () => {
  const binding = createPullRequestExecutionBinding(fixture());

  assert.deepEqual(binding, {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: 42,
    rootItemId: "work-item-pr-42",
    workKey: `pr-work-${"b".repeat(64)}`,
    inputRevision: 3,
    headRevision: 2,
    headRefOid: "a".repeat(40),
    eventId: fixture().event.eventId,
    eventDigest: fixture().event.contentDigest,
    inputDigest: "c".repeat(64),
  });
  assert.equal(
    samePullRequestExecutionBinding(binding, structuredClone(binding)),
    true,
  );
});

test("rejects mismatched events, extra fields, accessors, and provenance tampering", () => {
  const source = fixture();
  assert.throws(() =>
    createPullRequestExecutionBinding({
      ...source,
      sourceBinding: { ...source.sourceBinding, headRefOid: "b".repeat(40) },
    }),
  );

  const binding = createPullRequestExecutionBinding(source);
  for (const invalid of [
    { ...binding, extra: true },
    { ...binding, eventDigest: "not-a-digest" },
    { ...binding, inputRevision: 0 },
  ]) {
    assert.throws(() => normalizePullRequestExecutionBinding(invalid));
  }

  let invoked = false;
  const accessor = { ...binding };
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() {
      invoked = true;
      return "acme/repo";
    },
  });
  assert.throws(() => normalizePullRequestExecutionBinding(accessor));
  assert.equal(invoked, false);
});

test("creates v2 bindings for complete Git targets while preserving v1 recovery", () => {
  const binding = createPullRequestExecutionBinding(gitFixture());

  assert.equal(binding.schemaVersion, 2);
  assert.deepEqual(binding.gitTarget, {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "a".repeat(40),
  });
  assert.equal(createPullRequestExecutionBinding(fixture()).schemaVersion, 1);
});

test("v2 identity changes when base, branch, repository, or account changes", () => {
  const binding = createPullRequestExecutionBinding(gitFixture());
  const changes = [
    { baseRefOid: "e".repeat(40) },
    { baseRefName: "release/next" },
    { headRepository: "other/repo" },
    { githubAccount: "other-user" },
  ];

  for (const change of changes) {
    const changed = createPullRequestExecutionBinding(gitFixture(change));
    assert.equal(samePullRequestExecutionBinding(binding, changed), false);
  }
  assert.throws(() =>
    normalizePullRequestExecutionBinding({
      ...binding,
      gitTarget: { ...binding.gitTarget, headRefOid: "f".repeat(40) },
    }),
  );
});

test("partial Git facts cannot silently downgrade a new PR binding", () => {
  const partial = gitFixture();
  partial.event = structuredClone(partial.event);
  delete partial.event.payload.gitTarget.baseRefOid;
  assert.throws(() => createPullRequestExecutionBinding(partial));
});

test("legacy v1 recovery cannot authorize against a new target-aware or incomplete observation", () => {
  const legacy = createPullRequestExecutionBinding(fixture());
  assert.equal(
    pullRequestExecutionTargetMatchesEvent(legacy, fixture().event),
    true,
  );
  assert.equal(
    pullRequestExecutionTargetMatchesEvent(legacy, gitFixture().event),
    false,
  );

  const incomplete = fixture();
  incomplete.event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-06T12:00:01.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: fixture().event.subject,
    payload: {
      headRefOid: "a".repeat(40),
      gitTargetAvailable: false,
      state: "open",
    },
  });
  incomplete.sourceBinding = {
    ...incomplete.sourceBinding,
    eventId: incomplete.event.eventId,
    eventDigest: incomplete.event.contentDigest,
  };
  assert.throws(() => createPullRequestExecutionBinding(incomplete));
});
