import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkCoordinationTiming,
  WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
  WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS,
} from "../src/services/work-coordination-timing.js";

const ROLE_CONTEXT = Object.freeze({ roleContextEnabled: true });

test("role-context timing defaults share one lease budget", () => {
  const timing = normalizeWorkCoordinationTiming({}, ROLE_CONTEXT);

  assert.deepEqual(timing, {
    leaseDurationMs: 120_000,
    resolveTimeoutMs: 10_000,
    decisionTimeoutMs: 60_000,
    evidenceVerificationTimeoutMs: 49_000,
    evidenceMutationMarginMs: 1_000,
  });
  assert.equal(Object.isFrozen(timing), true);
  assert.equal(WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS, 1_000);
  assert.equal(WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS, 10_000);
});

test("each omitted timing field is derived without losing the evidence margin", () => {
  assert.deepEqual(
    normalizeWorkCoordinationTiming(
      { resolveTimeoutMs: 2_000, decisionTimeoutMs: 3_000 },
      ROLE_CONTEXT,
    ),
    {
      leaseDurationMs: 120_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 3_000,
      evidenceVerificationTimeoutMs: 114_000,
      evidenceMutationMarginMs: 1_000,
    },
  );
  assert.deepEqual(
    normalizeWorkCoordinationTiming(
      { leaseDurationMs: 16_000, decisionTimeoutMs: 3_000 },
      ROLE_CONTEXT,
    ),
    {
      leaseDurationMs: 16_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 3_000,
      evidenceVerificationTimeoutMs: 10_000,
      evidenceMutationMarginMs: 1_000,
    },
  );
  assert.deepEqual(
    normalizeWorkCoordinationTiming(
      { leaseDurationMs: 16_000, resolveTimeoutMs: 2_000 },
      ROLE_CONTEXT,
    ),
    {
      leaseDurationMs: 16_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 3_000,
      evidenceVerificationTimeoutMs: 10_000,
      evidenceMutationMarginMs: 1_000,
    },
  );
});

test("the minimum role-context lease preserves the evidence timeout target", () => {
  assert.deepEqual(
    normalizeWorkCoordinationTiming(
      { leaseDurationMs: 13_000 },
      ROLE_CONTEXT,
    ),
    {
      leaseDurationMs: 13_000,
      resolveTimeoutMs: 1_000,
      decisionTimeoutMs: 1_000,
      evidenceVerificationTimeoutMs: 10_000,
      evidenceMutationMarginMs: 1_000,
    },
  );
  assert.throws(
    () => normalizeWorkCoordinationTiming(
      { leaseDurationMs: 12_999 },
      ROLE_CONTEXT,
    ),
    /must preserve at least 1000ms.*10000ms for evidence verification/,
  );
  assert.throws(
    () => normalizeWorkCoordinationTiming(
      {
        leaseDurationMs: 16_000,
        resolveTimeoutMs: 999,
        decisionTimeoutMs: 3_000,
      },
      ROLE_CONTEXT,
    ),
    /role context timeouts must be at least 1000ms/,
  );
});

test("explicit timing conflicts are rejected instead of compressed", () => {
  assert.throws(
    () => normalizeWorkCoordinationTiming(
      {
        leaseDurationMs: 16_000,
        resolveTimeoutMs: 2_000,
        decisionTimeoutMs: 3_001,
      },
      ROLE_CONTEXT,
    ),
    /10000ms for evidence verification/,
  );
  assert.throws(
    () => normalizeWorkCoordinationTiming(
      {
        leaseDurationMs: 16_000,
        resolveTimeoutMs: 8_000,
        decisionTimeoutMs: 7_000,
      },
      ROLE_CONTEXT,
    ),
    /10000ms for evidence verification/,
  );
});
