const DEFAULT_LEASE_DURATION_MS = 2 * 60 * 1000;
const RESOLVE_TIMEOUT_TARGET_MS = 10_000;
const DECISION_TIMEOUT_TARGET_MS = 60_000;
const MINIMUM_LEASE_DURATION_MS = 1_000;
const MAXIMUM_DURATION_MS = 24 * 60 * 60 * 1000;
const MINIMUM_ROLE_PHASE_TIMEOUT_MS = 1_000;
export const WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS = 10_000;
export const WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS = 1_000;

function duration(value, name, minimum = 1) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAXIMUM_DURATION_MS
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function optionalDuration(value, name) {
  return value == null ? null : duration(value, name);
}

function roleContextBudgetMustFit() {
  throw new TypeError(
    `role context timing must preserve at least ${MINIMUM_ROLE_PHASE_TIMEOUT_MS}ms ` +
      "for resolve and decision and " +
      `${WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS}ms for evidence verification ` +
      "within leaseDurationMs; context and decision timeouts must fit within leaseDurationMs",
  );
}

export function normalizeWorkCoordinationTiming(
  value = {},
  { roleContextEnabled = false } = {},
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("work coordination timing is invalid");
  }
  if (typeof roleContextEnabled !== "boolean") {
    throw new TypeError("roleContextEnabled is invalid");
  }

  const leaseDurationMs = duration(
    value.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    "leaseDurationMs",
    MINIMUM_LEASE_DURATION_MS,
  );
  let resolveTimeoutMs = optionalDuration(
    value.resolveTimeoutMs,
    "resolveTimeoutMs",
  );
  let decisionTimeoutMs = optionalDuration(
    value.decisionTimeoutMs,
    "decisionTimeoutMs",
  );

  if (
    (resolveTimeoutMs !== null && resolveTimeoutMs >= leaseDurationMs) ||
    (decisionTimeoutMs !== null && decisionTimeoutMs >= leaseDurationMs)
  ) {
    throw new TypeError("role timeouts must be shorter than leaseDurationMs");
  }

  if (!roleContextEnabled) {
    resolveTimeoutMs ??= Math.min(
      RESOLVE_TIMEOUT_TARGET_MS,
      leaseDurationMs - 1,
    );
    decisionTimeoutMs ??= Math.min(
      DECISION_TIMEOUT_TARGET_MS,
      leaseDurationMs - 1,
    );
    return Object.freeze({
      leaseDurationMs,
      resolveTimeoutMs,
      decisionTimeoutMs,
      evidenceVerificationTimeoutMs: null,
      evidenceMutationMarginMs:
        WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
    });
  }
  if (
    (resolveTimeoutMs !== null &&
      resolveTimeoutMs < MINIMUM_ROLE_PHASE_TIMEOUT_MS) ||
    (decisionTimeoutMs !== null &&
      decisionTimeoutMs < MINIMUM_ROLE_PHASE_TIMEOUT_MS)
  ) {
    throw new TypeError(
      `role context timeouts must be at least ${MINIMUM_ROLE_PHASE_TIMEOUT_MS}ms`,
    );
  }

  if (resolveTimeoutMs === null && decisionTimeoutMs === null) {
    const availableMs =
      leaseDurationMs -
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS -
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS;
    if (availableMs < 2 * MINIMUM_ROLE_PHASE_TIMEOUT_MS) {
      roleContextBudgetMustFit();
    }
    resolveTimeoutMs = Math.min(
      RESOLVE_TIMEOUT_TARGET_MS,
      availableMs - MINIMUM_ROLE_PHASE_TIMEOUT_MS,
    );
  }
  if (resolveTimeoutMs === null) {
    const availableMs =
      leaseDurationMs -
      decisionTimeoutMs -
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS -
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS;
    if (availableMs < MINIMUM_ROLE_PHASE_TIMEOUT_MS) {
      roleContextBudgetMustFit();
    }
    resolveTimeoutMs = Math.min(RESOLVE_TIMEOUT_TARGET_MS, availableMs);
  }
  if (decisionTimeoutMs === null) {
    const availableMs =
      leaseDurationMs -
      resolveTimeoutMs -
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS -
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS;
    if (availableMs < MINIMUM_ROLE_PHASE_TIMEOUT_MS) {
      roleContextBudgetMustFit();
    }
    decisionTimeoutMs = Math.min(DECISION_TIMEOUT_TARGET_MS, availableMs);
  }

  const evidenceVerificationTimeoutMs =
    leaseDurationMs -
    resolveTimeoutMs -
    decisionTimeoutMs -
    WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS;
  if (
    evidenceVerificationTimeoutMs <
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS
  ) {
    roleContextBudgetMustFit();
  }
  return Object.freeze({
    leaseDurationMs,
    resolveTimeoutMs,
    decisionTimeoutMs,
    evidenceVerificationTimeoutMs,
    evidenceMutationMarginMs:
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
  });
}
