import { ledgerDigest } from './work-ledger-values.js';
import { isDeepStrictEqual } from 'node:util';
import { currentWorkItemExecutionBinding, verifyPullRequestExecutionBinding } from './work-ledger-pr-source.js';

// A retained failure makes coordination ready; it never grants a child retry.
export function recordedFailureParentIds(state, failures) {
  if (failures.size === 0) return new Set();
  const items = new Map(state.items.map(item => [item.itemId, item]));
  const parents = new Set();
  for (const id of failures.keys()) {
    const child = items.get(id), parent = items.get(child?.graph?.parentItemId);
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

// Related-task progress is a scheduling observation, not the root's execution
// identity. Unrelated graph activity must not renew a stalled root's budget.
export function indexWorkLedgerGraphProgress(items) {
  const byId = new Map(items.map(item => [item.itemId, item]));
  const childrenByParent = new Map();
  for (const item of items) {
    const parentId = item.graph?.parentItemId;
    if (typeof parentId !== 'string') continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(item);
    childrenByParent.set(parentId, children);
  }
  const summarize = id => {
    const item = byId.get(id);
    return { itemId: id, revision: item?.revision ?? null, status: item?.status ?? null };
  };
  const graphProgressDigest = item => {
    const children = childrenByParent.get(item.itemId) ?? [];
    const dependencies = item.graph?.dependsOnItemIds ?? [];
    if (children.length === 0 && dependencies.length === 0) return null;
    return ledgerDigest({ domain: 'work-ledger-related-progress/v1', itemId: item.itemId,
      children: children.map(child => child.itemId).sort().map(summarize),
      dependencies: [...dependencies].sort().map(summarize) }, {
      // This trusted projection has five container/scalar entries plus four per
      // related task. Keep its budget bounded by the already-validated ledger.
      maximumEntries: 5 + 4 * (children.length + dependencies.length),
    });
  };
  return { byId, childrenByParent, graphProgressDigest };
}
