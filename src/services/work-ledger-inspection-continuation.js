import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding, pullRequestHeadAdmission } from "./work-ledger-pr-source.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { ledgerDigest } from "./work-ledger-values.js";

const SOURCE_FIELDS = ["kind", "rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"];

function isOwnPullRequestRepairEvidenceItem(item) {
  if (item.source?.kind !== 'pull_request' || item.source.scope.active !== true || item.source.scope.kind !== 'automatic' ||
      item.source.pendingRevision !== null || item.source.identity.targetRoleId !== 'developer') return false;
  const event = currentWorkItemEvent(item);
  return event.source.provider === 'github' && event.payload.relation === 'authored' &&
    (event.payload.isDraft !== true || ['resolve_conflict', 'fix_ci'].includes(event.payload.nextAction)) &&
    event.payload.actionState === 'action_now' && ['address_review', 'resolve_conflict', 'fix_ci'].includes(event.payload.nextAction);
}

export function continuesOwnPullRequestRepairEvidence(item, outbox, result) {
  const bound = outbox.dispatchBinding?.boundIntent;
  const event = currentWorkItemEvent(item);
  const operation = outbox.intent.operation;
  if (result.kind !== "code_action_proposal" || result.requestedBy.roleId !== "developer" ||
      !["inspect", "verify"].includes(operation) || bound?.payload?.operation !== operation ||
      !isOwnPullRequestRepairEvidenceItem(item)) return false;
  if (operation === "verify" && event.payload.nextAction !== "fix_ci") return false;
  try {
    const current = currentWorkItemExecutionBinding(item);
    return SOURCE_FIELDS.every(key => current?.[key] === outbox.sourceBinding?.[key]) &&
      samePullRequestExecutionBinding(current, bound.binding.inputBinding);
  } catch { return false; }
}

function settledRepairEvidence(state, item) {
  if (item.kind !== "source_root" || !isOwnPullRequestRepairEvidenceItem(item) ||
      item.activeIntentId !== null || item.sourceQuarantine !== null ||
      item.graph?.deliveries?.length > 0 || !["resolve_conflict", "fix_ci"].includes(currentWorkItemEvent(item)?.payload?.nextAction) ||
      item.decisionContext?.source !== "proposal" || item.decisionContext.outcome !== "succeeded") return null;
  const admission = pullRequestHeadAdmission(state, item);
  if (!admission.current || admission.pending) return null;
  const entries = state.outbox.filter(entry => entry.itemId === item.itemId && entry.status === "delivered" &&
    entry.intent.type === "propose_code_action" && entry.outcome?.status === "delivered" &&
    entry.outcome.details?.downstreamRef === item.decisionContext.referenceId);
  if (entries.length !== 1) return null;
  const outbox = entries[0];
  try {
    const attestation = normalizeWorkResultAttestation(outbox.outcome.details.resultAttestation);
    const result = attestation.payload;
    if (attestation.kind !== "proposal_result" || attestation.intentId !== outbox.intentId ||
        attestation.decisionContentDigest !== item.decisionContext.contentDigest || result.outcome !== "succeeded" ||
        result.proposalId !== item.decisionContext.referenceId || result.resultId !== item.decisionContext.value.resultId ||
        result.contentDigest !== item.decisionContext.value.resultDigest ||
        result.proposalContentDigest !== outbox.outcome.details.proposalDigest ||
        !continuesOwnPullRequestRepairEvidence(item, outbox, result)) return null;
    const reason = currentWorkItemEvent(item).payload.nextAction === "fix_ci"
      ? outbox.intent.operation === "verify" ? "pr_ci_verification_continued" : "pr_ci_inspection_continued"
      : "pr_conflict_inspection_continued";
    return { outbox, attestation, result, reason };
  } catch { return null; }
}

export function completedRepairEvidenceRecoveryProof(state, item) {
  if (item.status !== 'completed' || item.statusReason !== 'proposal_succeeded' ||
      item.ownerId !== null || item.leaseId !== null) return null;
  const proof = settledRepairEvidence(state, item);
  return proof === null ? null : { intentId: proof.outbox.intentId, resultId: proof.result.resultId, reason: proof.reason };
}

// Successful intermediate work starts the next decision step. Lifetime claims
// and the persisted Head epoch stay intact; repeated failures without new sealed
// progress still consume the same bounded retry budget.
export function repairDecisionAttemptBudget(state, item) {
  if (item.currentTarget?.id !== 'developer' || !['queued', 'working', 'retry_wait', 'blocked'].includes(item.status) ||
      (item.status !== 'working' && (item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null)) ||
      (item.status === 'blocked' && item.statusReason !== 'decision_attempts_exhausted')) return null;
  const proof = settledRepairEvidence(state, item);
  if (proof === null) return null;
  const history = state.timeline.filter(entry => entry.itemId === item.itemId);
  const settledIndex = history.findLastIndex(entry => entry.type === 'proposal_result_applied' &&
    entry.details?.intentId === proof.outbox.intentId && entry.details.outcome === 'succeeded' &&
    entry.details.decision?.contentDigest === item.decisionContext.contentDigest &&
    entry.details.resultAttestationDigest === proof.attestation.attestationDigest);
  if (settledIndex < 0) return null;
  const stagedIndex = history.findLastIndex((entry, index) => index < settledIndex && entry.type === 'intent_staged' &&
    entry.details?.intentId === proof.outbox.intentId);
  const progressClaim = history.findLast((entry, index) => index < stagedIndex && entry.type === 'claimed');
  const offset = progressClaim?.details?.attempt;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > item.attempt ||
      progressClaim.actorId !== proof.outbox.requestedBy.workerId ||
      progressClaim.details.inputDigest !== proof.outbox.inputDigest) return null;
  const claim = history.findLast(entry => entry.type === 'claimed');
  if (!claim || claim.details?.attempt !== item.attempt || claim.details.inputDigest !== item.inputDigest) return null;
  const failedIndex = history.findLastIndex((entry, index) => index > settledIndex &&
    ['transitioned', 'retry_scheduled'].includes(entry.type) &&
    typeof entry.details?.context?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(entry.details.context.code));
  const failed = history[failedIndex], failedClaim = history[failedIndex - 1];
  const failure = failed && failedClaim?.type === 'claimed' && failedClaim.actorId === failed.actorId &&
    failedClaim.details?.inputDigest === item.inputDigest
    ? { code: failed.details.context.code, timelineId: failed.timelineId, at: failed.at,
      leaseId: failedClaim.details.leaseId, claimAt: failedClaim.at,
      current: failedIndex === history.length - 1 && failed.at === item.updatedAt &&
        failed.details.fromStatus === 'working' && failed.details.toStatus === 'blocked' &&
        failed.details.reason === 'decision_attempts_exhausted' }
    : null;
  return { attempt: item.attempt - offset, offset, intentId: proof.outbox.intentId, resultId: proof.result.resultId,
    claimLeaseId: claim.details.leaseId, failure };
}

export function isRecoveredRepairEvidence(previousState, previous, next) {
  if (!next || next.status !== "queued" || next.revision !== previous.revision + 1) return false;
  const proof = completedRepairEvidenceRecoveryProof(previousState, previous);
  if (!proof || next.statusReason !== proof.reason) return false;
  return ledgerDigest({ ...next, status: previous.status, statusReason: previous.statusReason,
    revision: previous.revision, updatedAt: previous.updatedAt }) === ledgerDigest(previous);
}
