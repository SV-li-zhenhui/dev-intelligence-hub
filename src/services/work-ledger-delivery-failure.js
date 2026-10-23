import { isDeepStrictEqual } from "node:util";
import { createProposalDeliveryEvidenceTarget, deliveryAcceptanceContractDigest,
  deliveryEvidenceKindsForProposal, DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE } from "../domain/delivery-evidence-contract.js";
import { currentWorkItemInputBinding } from "./work-ledger-pr-source.js";

// This explains a failed pre-binding decision to the parent. It does not
// authorize retry, alter the delivery contract, or replay a downstream action.
export function unstartedDeliveryContractFailure(item, outboxes) {
  if (item?.kind !== "graph_task" || item.status !== "blocked" || item.statusReason !== "intent_failed" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.sourceQuarantine !== null) return null;
  const binding = currentWorkItemInputBinding(item), contract = item.graph.acceptanceContracts.at(-1);
  if (binding === null || !contract) return null;
  const matches = outboxes.filter(outbox => outbox.itemId === item.itemId && outbox.status === "failed" &&
    outbox.updatedAt === item.updatedAt && outbox.dispatchBinding === null && outbox.inputDigest === item.inputDigest &&
    isDeepStrictEqual(outbox.sourceBinding, binding) && outbox.requestedBy?.roleId === item.currentTarget.id &&
    outbox.intent?.type === "propose_code_action" && ["verify", "modify"].includes(outbox.intent.operation) &&
    outbox.intent.deliverableId === undefined && outbox.outcome?.status === "failed" &&
    ["policy-binding-invalid", "delivery-evidence-incompatible"].some(code => isDeepStrictEqual(outbox.outcome.details, { code })) &&
    Number.isFinite(Date.parse(contract.recordedAt)) && Date.parse(contract.recordedAt) <= Date.parse(outbox.createdAt));
  if (matches.length !== 1) return null;
  const [failed] = matches;
  const proposal = { kind: "code_action_proposal", operation: failed.intent.operation };
  try {
    createProposalDeliveryEvidenceTarget({ taskId: item.itemId, roleId: item.currentTarget.id, acceptanceContract: contract, proposal });
    return null;
  } catch (error) {
    if (error?.code !== DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE) return null;
  }
  return { intentId: failed.intentId, code: "delivery-evidence-incompatible", downstreamCreated: false,
    operation: failed.intent.operation, contractRevision: contract.revision, contractDigest: deliveryAcceptanceContractDigest(contract),
    compatibleEvidenceKinds: [...deliveryEvidenceKindsForProposal(proposal)],
    expectedDeliverables: contract.expectedDeliverables.map(({ deliverableId, kind }) => ({ deliverableId, kind })) };
}

// A compatible contract can still fail policy binding. Report only the retained
// host outcome; it does not establish the underlying cause or authorize replay.
export function unstartedCodePolicyBindingFailure(item, outboxes) {
  if (item?.kind !== "graph_task" || item.status !== "blocked" || item.statusReason !== "intent_failed" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null ||
      item.sourceQuarantine !== null || item.currentTarget?.type !== "role") return null;
  const binding = currentWorkItemInputBinding(item), contract = item.graph.acceptanceContracts.at(-1);
  if (binding === null || !contract) return null;
  const matches = outboxes.filter(outbox => outbox.itemId === item.itemId && outbox.status === "failed" &&
    outbox.updatedAt === item.updatedAt && outbox.dispatchBinding === null && outbox.inputDigest === item.inputDigest &&
    isDeepStrictEqual(outbox.sourceBinding, binding) && outbox.requestedBy?.roleId === item.currentTarget.id &&
    outbox.intent?.type === "propose_code_action" && ["verify", "modify"].includes(outbox.intent.operation) &&
    outbox.outcome?.status === "failed" && isDeepStrictEqual(outbox.outcome.details, { code: "policy-binding-invalid" }) &&
    Number.isFinite(Date.parse(contract.recordedAt)) && Date.parse(contract.recordedAt) <= Date.parse(outbox.createdAt));
  if (matches.length !== 1) return null;
  const [failed] = matches;
  try {
    createProposalDeliveryEvidenceTarget({ taskId: item.itemId, roleId: item.currentTarget.id, acceptanceContract: contract,
      proposal: { kind: "code_action_proposal", operation: failed.intent.operation }, deliverableId: failed.intent.deliverableId });
  } catch { return null; }
  return { intentId: failed.intentId, code: "policy-binding-invalid", downstreamCreated: false };
}
