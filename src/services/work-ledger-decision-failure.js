import { isDeepStrictEqual } from 'node:util';
import { hasExactLedgerKeys } from './work-ledger-values.js';
import { currentWorkItemExecutionBinding, verifyPullRequestExecutionBinding } from './work-ledger-pr-source.js';

export function normalizeRecordedDecisionFailure(value, taskRevision) {
  if (!hasExactLedgerKeys(value, ['code', 'stage', 'taskRevision', 'timelineId', 'timelineDigest', 'recordedAt']) ||
      typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) || value.stage !== 'decision' ||
      !Number.isSafeInteger(taskRevision) || taskRevision < 1 || value.taskRevision !== taskRevision ||
      typeof value.timelineDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.timelineDigest) ||
      value.timelineId !== `work-timeline-${value.timelineDigest}` || typeof value.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) return null;
  return { code: value.code, stage: 'decision', taskRevision, timelineId: value.timelineId,
    timelineDigest: value.timelineDigest, recordedAt: value.recordedAt };
}

// A host decision rejection is a diagnostic, never delivery, publication, or retry authority.
export function recordedDecisionFailure(item, latest, claim) {
  if (item?.kind !== 'graph_task' || item.status !== 'blocked' || item.statusReason !== 'decision_attempts_exhausted' ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null ||
      item.sourceQuarantine !== null || latest?.itemId !== item.itemId || latest.type !== 'transitioned' ||
      latest.at !== item.updatedAt || latest.details?.fromStatus !== 'working' || latest.details.toStatus !== 'blocked' ||
      latest.details.reason !== 'decision_attempts_exhausted' || claim?.itemId !== item.itemId || claim.type !== 'claimed' ||
      claim.actorId !== latest.actorId || claim.details?.attempt !== item.attempt || claim.details.inputDigest !== item.inputDigest) return null;
  return normalizeRecordedDecisionFailure({ code: latest.details.context?.code, stage: 'decision', taskRevision: item.revision,
    timelineId: latest.timelineId, timelineDigest: latest.contentDigest, recordedAt: latest.at }, item.revision);
}

export function indexRecordedDecisionFailures(state) {
  const candidates = new Map(state.items.filter(item => item.status === 'blocked' &&
    item.statusReason === 'decision_attempts_exhausted' && item.kind === 'graph_task').map(item => [item.itemId, item]));
  if (candidates.size === 0) return new Map();
  const recent = new Map();
  const pending = new Set(candidates.keys());
  for (let index = state.timeline.length - 1; index >= 0 && pending.size > 0; index--) {
    const entry = state.timeline[index];
    if (!pending.has(entry.itemId)) continue;
    const entries = recent.get(entry.itemId) ?? [];
    entries.push(entry);
    recent.set(entry.itemId, entries);
    if (entries.length === 2) pending.delete(entry.itemId);
  }
  const failures = new Map();
  for (const [id, item] of candidates) {
    const [latest, claim] = recent.get(id) ?? [];
    const failure = recordedDecisionFailure(item, latest, claim);
    if (failure) failures.set(id, failure);
  }
  return failures;
}

export function decisionFailureParentIds(state, failures) {
  if (failures.size === 0) return new Set();
  const items = new Map(state.items.map(item => [item.itemId, item]));
  const parents = new Set();
  for (const id of failures.keys()) {
    const child = items.get(id), parent = items.get(child.graph.parentItemId);
    if (parents.has(parent?.itemId)) continue;
    if (parent?.kind !== 'source_root' || parent.currentTarget?.id !== 'orchestrator' ||
        !['queued', 'retry_wait'].includes(parent.status) || parent.activeIntentId !== null ||
        parent.ownerId !== null || parent.leaseId !== null || parent.leaseUntil !== null || parent.sourceQuarantine !== null) continue;
    const binding = currentWorkItemExecutionBinding(parent);
    if (!binding || !isDeepStrictEqual(binding, currentWorkItemExecutionBinding(child))) continue;
    try { verifyPullRequestExecutionBinding(state, binding); } catch { continue; }
    parents.add(parent.itemId);
  }
  return parents;
}
