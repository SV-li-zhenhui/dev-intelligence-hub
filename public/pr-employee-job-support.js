const RECOVERY_ACTIONS = Object.freeze([
  Object.freeze({ id: "retry", label: "重新分析" }),
  Object.freeze({ id: "dismiss", label: "关闭此失败" }),
]);

export function prEmployeeBlockedActions(job) {
  if (
    !job ||
    typeof job !== "object" ||
    job.status !== "blocked" ||
    job.confirmationId ||
    job.confirmationFailure
  ) {
    return [];
  }
  return RECOVERY_ACTIONS;
}

export function createPrEmployeeRecoveryIntent(job, expectedRevision) {
  if (
    prEmployeeBlockedActions(job).length === 0 ||
    typeof job.id !== "string" ||
    !job.id ||
    typeof job.headRefOid !== "string" ||
    !job.headRefOid ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return null;
  }
  return Object.freeze({
    id: job.id,
    headRefOid: job.headRefOid,
    expectedRevision,
  });
}

export function isPrEmployeeRecoveryIntentCurrent(
  intent,
  job,
  expectedRevision,
) {
  if (!intent || typeof intent !== "object") return false;
  const current = createPrEmployeeRecoveryIntent(job, expectedRevision);
  return Boolean(
    current &&
      intent.id === current.id &&
      intent.headRefOid === current.headRefOid &&
      intent.expectedRevision === current.expectedRevision,
  );
}
