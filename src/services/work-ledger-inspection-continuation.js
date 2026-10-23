import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding, pullRequestHeadAdmission } from "./work-ledger-pr-source.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { ledgerDigest } from "./work-ledger-values.js";

const SOURCE_FIELDS = ["kind", "rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"];

export function continuesOwnPullRequestRepairInspection(item, outbox, result) {
  const bound = outbox.dispatchBinding?.boundIntent;
  const event = currentWorkItemEvent(item);
  if (result.kind !== "code_action_proposal" || result.requestedBy.roleId !== "developer" ||
      outbox.intent.operation !== "inspect" || bound?.payload?.operation !== "inspect" ||
      item.source?.kind !== "pull_request" || item.source.scope.active !== true || item.source.scope.kind !== "automatic" ||
      item.source.pendingRevision !== null || item.source.identity.targetRoleId !== "developer" ||
      event.source.provider !== "github" || event.payload.relation !== "authored" ||
      (event.payload.isDraft === true && event.payload.nextAction !== "resolve_conflict") ||
      event.payload.actionState !== "action_now" || !["address_review", "resolve_conflict"].includes(event.payload.nextAction)) return false;
  try {
    const current = currentWorkItemExecutionBinding(item);
    return SOURCE_FIELDS.every(key => current?.[key] === outbox.sourceBinding?.[key]) &&
      samePullRequestExecutionBinding(current, bound.binding.inputBinding);
  } catch { return false; }
}

export function completedConflictInspectionRecoveryProof(state, item) {
  if (item.kind !== "source_root" || item.status !== "completed" || item.statusReason !== "proposal_succeeded" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.sourceQuarantine !== null ||
      item.graph?.deliveries?.length > 0 || currentWorkItemEvent(item)?.payload?.nextAction !== "resolve_conflict" ||
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
        !continuesOwnPullRequestRepairInspection(item, outbox, result)) return null;
    return { intentId: outbox.intentId, resultId: result.resultId };
  } catch { return null; }
}

export function isRecoveredConflictInspection(previousState, previous, next) {
  if (!next || next.status !== "queued" || next.statusReason !== "pr_conflict_inspection_continued" ||
      next.revision !== previous.revision + 1 || !completedConflictInspectionRecoveryProof(previousState, previous)) return false;
  return ledgerDigest({ ...next, status: previous.status, statusReason: previous.statusReason,
    revision: previous.revision, updatedAt: previous.updatedAt }) === ledgerDigest(previous);
}
