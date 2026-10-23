import { ledgerDigest } from './work-ledger-values.js';

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
