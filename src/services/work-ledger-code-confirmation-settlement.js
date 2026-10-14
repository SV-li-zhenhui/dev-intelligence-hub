import {
  normalizeConfirmationPlan,
  normalizeConfirmationState,
} from "../domain/confirmation-contract.js";
import { createCodeActionProposalConfirmationPlan } from "../domain/code-action-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { currentWorkItemInputBinding } from "./work-ledger-pr-source.js";
import { ledgerDigest } from "./work-ledger-values.js";

// Only server-side confirmation reads can mint these ephemeral capabilities.
// A public reconciliation command cannot supply a JSON flag as settlement proof.
const settlements = new WeakMap();

export function isRevokedCodeConfirmationDecision(decision) {
  const value = decision?.value;
  return decision?.source === "proposal" && decision.outcome === "stale" &&
    typeof decision.referenceId === "string" &&
    value?.kind === "code_action_proposal" &&
    typeof value.downstreamRef === "string" &&
    value.downstreamRef.startsWith("confirmation-code-job-") &&
    Array.isArray(value.evidence) && value.evidence.length === 3 &&
    value.evidence[0] === `confirmation:${value.downstreamRef}` &&
    value.evidence[1] === "authorization_changed" &&
    value.evidence[2] === "old_confirmation_status:stale";
}

function digest(value) {
  return ledgerDigest(value, { maximumEntries: 30_000 });
}

function matchingDeliveredProposal(item, outboxById) {
  const candidates = [...outboxById.values()].filter((outbox) =>
    outbox.itemId === item.itemId && outbox.status === "delivered" &&
    outbox.intent?.type === "propose_code_action" &&
    outbox.outcome?.status === "delivered" &&
    outbox.outcome.details?.downstreamRef === item.decisionContext.referenceId);
  if (candidates.length !== 1) return null;
  const outbox = candidates[0];
  if (outbox.inputDigest !== item.inputDigest ||
    digest(outbox.sourceBinding) !== digest(currentWorkItemInputBinding(item))) return null;
  const bound = outbox.dispatchBinding?.boundIntent;
  if (!bound || bound.intentId !== item.decisionContext.referenceId) return null;
  const { intentId, ...content } = bound;
  const proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...content });
  if (proposal.kind !== "code_action_proposal" ||
    proposal.requestedBy.workItemId !== item.itemId ||
    proposal.requestedBy.roleId !== item.currentTarget?.id ||
    proposal.requestedBy.roleId !== outbox.requestedBy?.roleId ||
    proposal.contentDigest !== outbox.outcome.details.proposalDigest ||
    outbox.outcome.details.resultAttestation?.decisionContentDigest !==
      item.decisionContext.contentDigest) return null;
  return { proposal, outbox };
}

export function createRevokedCodeConfirmationSettlement(item, outboxById, snapshot) {
  if (item?.status !== "blocked" || item.activeIntentId !== null ||
    item.sourceQuarantine != null ||
    !isRevokedCodeConfirmationDecision(item.decisionContext) || snapshot == null) return null;
  try {
    const confirmation = normalizeConfirmationState({
      schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item],
    }).items[0];
    if (confirmation.id !== item.decisionContext.value.downstreamRef ||
      confirmation.kind !== "local.code-job-create" || confirmation.status !== "stale" ||
      confirmation.execution !== null || confirmation.receipt !== null ||
      confirmation.failure !== null || confirmation.rejection !== null ||
      confirmation.invalidation?.reason !== "authorization_changed" ||
      digest(confirmation.invalidation.requestedBy) !== digest(confirmation.requestedBy) ||
      confirmation.invalidation.approvalBindingDigest !== confirmation.approvalBindingDigest) return null;
    const delivered = matchingDeliveredProposal(item, outboxById);
    if (delivered === null) return null;
    const { proposal, outbox } = delivered;
    const expected = normalizeConfirmationPlan(createCodeActionProposalConfirmationPlan(proposal, {
      grant: confirmation.action.grant,
      // Rebuilding a historical binding does not grant any new execution authority.
      allowedOperationsByRole: { [proposal.requestedBy.roleId]: [proposal.payload.operation] },
    }));
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, confirmation[key]]));
    if (digest(expected) !== digest(actual)) return null;
    const proof = Object.freeze({});
    settlements.set(proof, {
      itemId: item.itemId, itemRevision: item.revision, inputDigest: item.inputDigest,
      decisionDigest: item.decisionContext.contentDigest,
      intentId: outbox.intentId, outboxDigest: digest(outbox),
    });
    return proof;
  } catch {
    // Missing, malformed, mismatched or executed confirmations never release work.
    return null;
  }
}

export function hasRevokedCodeConfirmationSettlement(item, outboxById, proof) {
  const stored = proof && settlements.get(proof);
  const outbox = stored && outboxById.get(stored.intentId);
  return Boolean(stored && stored.itemId === item.itemId &&
    stored.itemRevision === item.revision && stored.inputDigest === item.inputDigest &&
    stored.decisionDigest === item.decisionContext?.contentDigest &&
    outbox !== undefined && digest(outbox) === stored.outboxDigest);
}
