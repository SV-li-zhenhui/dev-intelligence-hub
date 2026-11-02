import { createWorkIntentDispatchBinding } from '../domain/work-intent-dispatch-binding.js';
import { currentWorkItemEvent, currentWorkItemExecutionBinding, currentWorkItemInputBinding,
  pullRequestHeadAdmission } from './work-ledger-pr-source.js';
import { ledgerDigest } from './work-ledger-values.js';

// Evidence of one acknowledged responsibility transfer, not a model report of
// work completion. Its exact dispatch and adjacent host event must agree.
export function currentPrRoleHandoffProof(state, item, { fromRoleId, targetRoleId, capability, timeline = state.timeline }) {
  if (item?.currentTarget?.type !== 'role' || item.currentTarget.id !== targetRoleId || item.sourceQuarantine != null) return null;
  const admission = pullRequestHeadAdmission(state, item);
  if (admission.applies && (!admission.current || admission.pending)) return null;
  const outbox = state.outbox.findLast(entry => entry.itemId === item.itemId && entry.intent.type === 'handoff' &&
    entry.status === 'delivered' && entry.outcome?.status === 'delivered');
  const bound = outbox?.dispatchBinding?.boundIntent;
  const sourceBinding = currentWorkItemInputBinding(item), executionBinding = currentWorkItemExecutionBinding(item);
  const event = currentWorkItemEvent(item);
  if (!outbox || !bound || sourceBinding == null || executionBinding?.schemaVersion !== 2 ||
      outbox.inputDigest !== item.inputDigest || ledgerDigest(outbox.sourceBinding) !== ledgerDigest(sourceBinding) ||
      outbox.requestedBy.roleId !== fromRoleId || outbox.intent.capability !== capability ||
      bound.kind !== 'handoff' || bound.requestedBy.roleId !== fromRoleId || bound.requestedBy.workItemId !== item.itemId ||
      bound.binding.targetRoleId !== targetRoleId || bound.binding.eventId !== event.eventId ||
      ledgerDigest(bound.binding.subject) !== ledgerDigest(event.subject) ||
      bound.source.assignmentId !== item.assignmentId || bound.source.eventId !== event.eventId ||
      bound.payload.capability !== capability || bound.payload.brief !== outbox.intent.brief ||
      ledgerDigest(bound.payload.evidence) !== ledgerDigest(outbox.intent.evidence) ||
      ledgerDigest(createWorkIntentDispatchBinding(bound)) !== ledgerDigest(outbox.dispatchBinding) ||
      outbox.outcome.details?.downstreamRef !== bound.intentId) return null;
  const acknowledged = timeline.findLast(entry => entry.itemId === item.itemId && entry.type === 'intent_acknowledged' &&
    entry.details?.intentId === outbox.intentId && entry.details.outcome === 'delivered' && entry.details.nextStatus === 'queued');
  const handedOff = acknowledged && timeline.find(entry => entry.sequence === acknowledged.sequence + 1);
  if (handedOff?.type !== 'handed_off' || handedOff.itemId !== item.itemId || handedOff.at !== outbox.updatedAt ||
      handedOff.details?.fromTarget?.type !== 'role' || handedOff.details.fromTarget.id !== fromRoleId ||
      handedOff.details.toTarget?.type !== 'role' || handedOff.details.toTarget.id !== targetRoleId) return null;
  return { outbox, bound, executionBinding, acknowledged, handedOff };
}
