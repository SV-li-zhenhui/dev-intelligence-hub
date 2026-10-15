import { normalizeConfirmationPlan, normalizeConfirmationState } from "../domain/confirmation-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { createWorkIntentDispatchBinding } from "../domain/work-intent-dispatch-binding.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { currentWorkItemInputBinding, currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { ledgerDigest } from "./work-ledger-values.js";

const settlements = new WeakMap();
const digest = (value) => ledgerDigest(value, { maximumEntries: 30_000 });

export function isChangedReviewConfirmationDecision(decision) {
  const value = decision?.value;
  if (decision?.source !== "proposal" || decision.outcome !== "stale" ||
      typeof decision.referenceId !== "string" || value?.kind !== "github_review_proposal" || !Array.isArray(value.evidence)) return false;
  if (value.downstreamRef === null) return value.evidence.length === 2 &&
    value.evidence[0] === "authorization_changed" && value.evidence[1] === `proposal:${decision.referenceId}`;
  return typeof value.downstreamRef === "string" && value.downstreamRef.startsWith("confirmation-github-review-") &&
    value.evidence.length === 3 && value.evidence[0] === `confirmation:${value.downstreamRef}` &&
    value.evidence[1] === "authorization_changed" &&
    ["completed", "executing", "failed", "stale"].some((status) => value.evidence[2] === `old_confirmation_status:${status}`);
}

function matchingDeliveredProposal(item, outboxById) {
  if (item?.status !== "blocked" || item.activeIntentId !== null || item.sourceQuarantine != null ||
      !isChangedReviewConfirmationDecision(item.decisionContext)) return null;
  const matches = [...outboxById.values()].filter((entry) => entry.itemId === item.itemId &&
    entry.status === "delivered" && entry.intent?.type === "propose_github_review" &&
    entry.outcome?.status === "delivered" && entry.outcome.details?.downstreamRef === item.decisionContext.referenceId);
  if (matches.length !== 1) return null;
  const outbox = matches[0];
  if (outbox.inputDigest !== item.inputDigest ||
      digest(outbox.sourceBinding) !== digest(currentWorkItemInputBinding(item))) return null;
  const bound = outbox.dispatchBinding?.boundIntent;
  if (bound?.intentId !== item.decisionContext.referenceId ||
      digest(createWorkIntentDispatchBinding(bound)) !== digest(outbox.dispatchBinding)) return null;
  const { intentId, ...content } = bound;
  const proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...content });
  const binding = currentWorkItemExecutionBinding(item);
  if (proposal.kind !== "github_review_proposal" || binding?.schemaVersion !== 2 ||
      !samePullRequestExecutionBinding(binding, proposal.binding.inputBinding) ||
      proposal.requestedBy.workItemId !== item.itemId || proposal.requestedBy.roleId !== item.currentTarget?.id ||
      proposal.requestedBy.roleId !== outbox.requestedBy?.roleId ||
      proposal.source.assignmentId !== item.assignmentId || proposal.source.eventId !== binding.eventId ||
      proposal.contentDigest !== outbox.outcome.details.proposalDigest) return null;
  const attestation = normalizeWorkResultAttestation(outbox.outcome.details.resultAttestation);
  const result = attestation.payload;
  if (attestation.kind !== "proposal_result" || attestation.intentId !== outbox.intentId ||
      attestation.decisionContentDigest !== item.decisionContext.contentDigest ||
      result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
      result.kind !== proposal.kind || digest(result.requestedBy) !== digest(proposal.requestedBy)) return null;
  const decision = createWorkDecisionContext({ source: "proposal", referenceId: result.proposalId, outcome: result.outcome,
    value: { kind: result.kind, resultId: result.resultId, resultDigest: result.contentDigest, summary: result.summary,
      downstreamRef: result.downstreamRef, evidence: result.evidence }, observedAt: result.at });
  if (digest(decision) !== digest(item.decisionContext)) return null;
  return { outbox, proposal, binding };
}

function historicalPlans(delivered, actorAccountId = delivered.binding.gitTarget.sourceAccountId) {
  const { proposal, binding } = delivered;
  if (actorAccountId.toLowerCase() !== binding.gitTarget.sourceAccountId.toLowerCase()) return [];
  const options = { actorAccountId, legacyRecovery: true };
  return [{}, { selfAuthored: true }, { legacySelfAuthored: true }, { legacyUnversionedSelfAuthored: true }]
    .map((variant) => normalizeConfirmationPlan(createGitHubReviewProposalConfirmationPlan(proposal, { ...options, ...variant })));
}

export function reviewConfirmationSettlementIds(item, outboxById) {
  try {
    const delivered = matchingDeliveredProposal(item, outboxById);
    if (!delivered) return [];
    const ids = [...new Set(historicalPlans(delivered).map((plan) => plan.id))];
    return item.decisionContext.value.downstreamRef === null || ids.includes(item.decisionContext.value.downstreamRef) ? ids : [];
  } catch { return []; }
}

export function createCompletedReviewConfirmationSettlement(item, outboxById, snapshots) {
  try {
    const delivered = matchingDeliveredProposal(item, outboxById);
    if (!delivered || !Array.isArray(snapshots)) return null;
    const plans = historicalPlans(delivered);
    if (item.decisionContext.value.downstreamRef !== null &&
        !plans.some((plan) => plan.id === item.decisionContext.value.downstreamRef)) return null;
    const completed = [];
    for (const snapshot of snapshots.filter((value) => value !== null)) {
      const confirmation = normalizeConfirmationState({ schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item] }).items[0];
      const expected = historicalPlans(delivered, confirmation.actor.accountId).find((plan) => plan.id === confirmation.id && digest(plan) ===
        digest(Object.fromEntries(Object.keys(plan).map((key) => [key, confirmation[key]]))));
      if (!expected || confirmation.kind !== "github.work-proposal-review") return null;
      if (confirmation.status === "completed" && confirmation.receipt?.id) completed.push(confirmation);
      else if (!(confirmation.status === "stale" && confirmation.execution === null && confirmation.failure === null)) return null;
    }
    if (completed.length !== 1) return null;
    const proof = Object.freeze({});
    settlements.set(proof, { itemId: item.itemId, itemRevision: item.revision, inputDigest: item.inputDigest,
      decisionDigest: item.decisionContext.contentDigest, intentId: delivered.outbox.intentId,
      outboxDigest: digest(delivered.outbox) });
    return proof;
  } catch { return null; }
}

export function hasReviewConfirmationSettlement(item, outboxById, proof) {
  const stored = proof && settlements.get(proof);
  const outbox = stored && outboxById.get(stored.intentId);
  return Boolean(stored && stored.itemId === item.itemId && stored.itemRevision === item.revision &&
    stored.inputDigest === item.inputDigest && stored.decisionDigest === item.decisionContext?.contentDigest &&
    outbox !== undefined && stored.outboxDigest === digest(outbox));
}
