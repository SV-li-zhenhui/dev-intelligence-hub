import {
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  assertItemRevision,
  moveWorkItem,
  normalizeWorkActor,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const CANCELLABLE_STATUSES = new Set(["queued", "retry_wait", "blocked"]);
const ACTIVE_SIDE_EFFECT_STATUSES = new Set([
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
]);

function normalizeExpectedRevisions(input) {
  if (
    !Number.isSafeInteger(input.expectedGraphRevision) ||
    input.expectedGraphRevision < 0 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_REVISION_INVALID",
      "工作图或工作项 revision 无效",
    );
  }
}

function assertExpectedGraphRevision(value, state) {
  if (value !== state.revision) {
    throw workLedgerError(
      "WORK_LEDGER_STATE_REVISION_CONFLICT",
      "工作图已被其他员工更新",
      409,
    );
  }
}

function activeAncestorItems(state, root) {
  const byId = new Map(state.items.map((item) => [item.itemId, item]));
  const ancestors = [];
  let parentItemId = root.graph.parentItemId;
  while (parentItemId !== null) {
    const parent = byId.get(parentItemId);
    if (!parent) break;
    if (ACTIVE_SIDE_EFFECT_STATUSES.has(parent.status)) ancestors.push(parent);
    parentItemId = parent.graph.parentItemId;
  }
  return ancestors;
}

function descendantItems(state, rootItemId) {
  const childrenByParent = new Map();
  for (const item of state.items) {
    const siblings = childrenByParent.get(item.graph.parentItemId) ?? [];
    siblings.push(item);
    childrenByParent.set(item.graph.parentItemId, siblings);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(rootItemId) ?? [])];
  while (pending.length > 0) {
    const item = pending.pop();
    descendants.push(item);
    pending.push(...(childrenByParent.get(item.itemId) ?? []));
  }
  return descendants.sort((left, right) =>
    left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0
  );
}

function cancellationResult(rootItemId, items, changedItemIds) {
  return {
    root: items.find(({ itemId }) => itemId === rootItemId),
    cancelledItemIds: [...changedItemIds].sort(),
  };
}

function activeDependentItems(state, cancelledItemIds) {
  const affected = new Set(cancelledItemIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.items) {
      if (
        affected.has(item.itemId) ||
        !item.graph.dependsOnItemIds.some((itemId) => affected.has(itemId))
      ) {
        continue;
      }
      affected.add(item.itemId);
      changed = true;
    }
  }
  return state.items.filter(
    (item) =>
      !cancelledItemIds.has(item.itemId) &&
      affected.has(item.itemId) &&
      ACTIVE_SIDE_EFFECT_STATUSES.has(item.status),
  );
}

export function planWorkGraphCancellation({ state, input, clock }) {
  if (
    !hasExactLedgerKeys(input, [
      "itemId",
      "expectedGraphRevision",
      "expectedRevision",
      "actorId",
      "reason",
    ])
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_INVALID",
      "取消任务请求无效",
    );
  }
  normalizeExpectedRevisions(input);
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const reason = normalizeWorkReason(input.reason);
  if (reason === null) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_INVALID",
      "取消任务必须说明原因",
    );
  }
  const root = requireWorkLedgerItem(state, itemId);
  assertExpectedGraphRevision(input.expectedGraphRevision, state);
  assertItemRevision(root, input.expectedRevision);
  if (root.status === "cancelled") {
    return {
      write: false,
      result: cancellationResult(root.itemId, state.items, []),
    };
  }
  if (root.status === "completed") {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_CONFLICT",
      "已完成工作项不能取消",
      409,
    );
  }

  const scope = [root, ...descendantItems(state, root.itemId)];
  const unsafe = scope.filter(
    (item) =>
      !["completed", "cancelled"].includes(item.status) &&
      !CANCELLABLE_STATUSES.has(item.status),
  );
  const changed = scope.filter(({ status }) => CANCELLABLE_STATUSES.has(status));
  const changedItemIds = new Set(changed.map(({ itemId: changedId }) => changedId));
  if (
    unsafe.length > 0 ||
    activeAncestorItems(state, root).length > 0 ||
    activeDependentItems(state, changedItemIds).length > 0
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_UNSAFE",
      "任务树仍有员工租约、等待结果或待分发副作用，不能直接取消",
      409,
    );
  }

  const now = clock();
  const cancelled = changed.map((item) =>
    moveWorkItem(item, {
      status: "cancelled",
      now,
      reason,
    }),
  );
  let items = state.items;
  for (const item of cancelled) {
    items = replaceWorkLedgerRecord(items, "itemId", item);
  }
  const cancelledItemIds = cancelled.map(({ itemId }) => itemId);
  return {
    patch: { items },
    timelineEvents: cancelled.map((item) => ({
      itemId: item.itemId,
      type: "cancelled",
      at: now,
      actorId,
      details: {
        rootItemId: root.itemId,
        reason,
      },
    })),
    result: cancellationResult(root.itemId, items, cancelledItemIds),
  };
}
