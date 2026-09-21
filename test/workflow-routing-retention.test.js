import assert from "node:assert/strict";
import test from "node:test";
import { retainWorkflowState } from "../src/services/workflow-routing-retention.js";
import {
  MAX_WORKFLOW_AUDIT_BYTES,
  MAX_WORKFLOW_BUNDLE_BYTES,
  MAX_WORKFLOW_STATE_BYTES,
  workflowPersistedStateDigest,
} from "../src/services/workflow-routing-state.js";
import { prettySerializedWorkflowBytes } from "../src/services/workflow-routing-values.js";

function nearCapacityState(count = 5_000) {
  const largeExplanation = "x".repeat(80);
  return {
    schemaVersion: 1,
    revision: 1,
    currentConfig: null,
    configHistory: [],
    events: Array.from({ length: count }, (_, index) => ({
      eventId: `event-${index.toString().padStart(4, "0")}`,
      sequence: index,
    })),
    assignments: [],
    audit: Array.from({ length: count }, (_, index) => ({
      auditId: `audit-${index.toString().padStart(4, "0")}`,
      eventId: `event-${index.toString().padStart(4, "0")}`,
      explanation: largeExplanation,
    })),
    checkpoint: null,
    lastSnapshot: null,
  };
}

test("batch retention uses an injected byte boundary and the default remains 32 MiB", () => {
  const stateByteBudget = 512 * 1024;
  const candidate = nearCapacityState();
  const sample = { value: "工作流" };
  assert.equal(MAX_WORKFLOW_STATE_BYTES, 32 * 1024 * 1024);
  assert.equal(
    prettySerializedWorkflowBytes(sample),
    Buffer.byteLength(`${JSON.stringify(sample, null, 2)}\n`, "utf8"),
  );
  assert.ok(prettySerializedWorkflowBytes(candidate) > stateByteBudget);

  const { state, stats } = retainWorkflowState(candidate, {
    recordLimit: 5_000,
    stateByteBudget,
    auditByteBudget: MAX_WORKFLOW_AUDIT_BYTES,
    bundleByteBudget: MAX_WORKFLOW_BUNDLE_BYTES,
  });
  const retainedIds = new Set(state.events.map(({ eventId }) => eventId));

  assert.ok(stats.droppedBundles > 0);
  assert.equal(stats.examinedBundles, stats.droppedBundles);
  assert.ok(stats.examinedBundles <= candidate.events.length);
  assert.equal(state.events.length, state.audit.length);
  assert.equal(
    state.audit.every(({ eventId }) => retainedIds.has(eventId)),
    true,
  );
  assert.equal(stats.retainedBytes, prettySerializedWorkflowBytes(state));
  assert.ok(stats.retainedBytes <= stateByteBudget);
  assert.ok(stats.retainedBytes <= MAX_WORKFLOW_STATE_BYTES);
});

test("record-count retention drops one prefix and filters each record array once", () => {
  const candidate = nearCapacityState(1_000);
  const { state, stats } = retainWorkflowState(candidate, {
    recordLimit: 600,
    stateByteBudget: MAX_WORKFLOW_STATE_BYTES,
    auditByteBudget: MAX_WORKFLOW_AUDIT_BYTES,
    bundleByteBudget: MAX_WORKFLOW_BUNDLE_BYTES,
  });

  assert.equal(stats.examinedBundles, 400);
  assert.equal(stats.droppedBundles, 400);
  assert.equal(state.events.length, 600);
  assert.equal(state.audit.length, 600);
  assert.equal(state.events[0].eventId, "event-0400");
  assert.equal(state.audit[0].eventId, "event-0400");
});

test("large-state digest stays stable while rejecting accessors, cycles, and non-JSON", () => {
  assert.equal(
    workflowPersistedStateDigest({ beta: [2], alpha: 1 }),
    workflowPersistedStateDigest({ alpha: 1, beta: [2] }),
  );
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;

  for (const value of [accessor, cyclic, { value: undefined }]) {
    assert.throws(
      () => workflowPersistedStateDigest(value),
      (error) => error.code === "WORKFLOW_VALUE_INVALID",
    );
  }
});
