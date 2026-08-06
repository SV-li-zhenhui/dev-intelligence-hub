import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequestExecutionBinding,
  normalizePullRequestExecutionBinding,
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
