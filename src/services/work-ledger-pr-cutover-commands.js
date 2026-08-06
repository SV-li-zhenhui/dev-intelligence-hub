import { assertExpectedWorkGraphRevision } from "./work-ledger-graph-command-support.js";
import { requireWorkLedgerItem } from "./work-ledger-item-commands.js";
import {
  activatePendingPullRequestWorkSource,
  currentWorkItemInputBinding,
} from "./work-ledger-pr-source.js";
import { assertItemRevision } from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const ROOT_READY_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "completed",
]);
const CHILD_SUPERSEDABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "blocked",
]);
const CHILD_TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "superseded",
]);

function invalid(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_INVALID",
    message,
  );
}

function conflict(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    message,
    409,
  );
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function graphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expectedGraphRevision 无效");
  }
  return value;
}

function normalizeItemId(value) {
  try {
    return boundedLedgerString(value, "itemId", 192);
  } catch {
    throw invalid("itemId 无效");
  }
}

function normalizeCommand(value) {
  if (
    !hasExactLedgerKeys(value, [
      "itemId",
      "expectedGraphRevision",
      "expectedRevision",
      "expectedPendingRevision",
    ])
  ) {
    throw invalid("PR 来源对账命令无效");
  }
  return {
    itemId: normalizeItemId(value.itemId),
    expectedGraphRevision: graphRevision(value.expectedGraphRevision),
    expectedRevision: positiveRevision(
      value.expectedRevision,
      "expectedRevision",
    ),
    expectedPendingRevision: positiveRevision(
      value.expectedPendingRevision,
      "expectedPendingRevision",
    ),
  };
}

function pendingHeadChanged(source) {
  if (source.pendingRevision === null) return false;
  const active = source.revisions[source.activeRevision - 1];
  const pending = source.revisions[source.pendingRevision - 1];
  return active.headRevision !== pending.headRevision;
}

function sourceEpochChildren(items, root) {
  const active = currentWorkItemInputBinding(root);
  return items.filter((item) => {
    const binding = currentWorkItemInputBinding(item);
    return (
      item.itemId !== root.itemId &&
      binding?.rootItemId === root.itemId &&
      binding.headRevision === active.headRevision
    );
  });
}

function unstartedIntent(item, outboxById) {
  if (item.status !== "dispatch_pending" || item.activeIntentId === null) {
    return null;
  }
  const outbox = outboxById.get(item.activeIntentId);
  if (
    outbox?.status === "pending" ||
    (outbox?.status === "dispatching" && outbox.dispatchBinding === null)
  ) {
    return outbox;
  }
  return null;
}

export function inspectPullRequestSourceCutover(root, items, outboxById) {
  const headChanged = pendingHeadChanged(root.source);
  const participants = [
    root,
    ...(headChanged ? sourceEpochChildren(items, root) : []),
  ];
  const blockers = participants.filter((item) => {
    if (item.itemId === root.itemId) {
      return !ROOT_READY_STATUSES.has(item.status) &&
        unstartedIntent(item, outboxById) === null;
    }
    return !CHILD_TERMINAL_STATUSES.has(item.status) &&
      !CHILD_SUPERSEDABLE_STATUSES.has(item.status) &&
      unstartedIntent(item, outboxById) === null;
  });
  return { blockers, headChanged, participants };
}

function failSupersededIntent(outbox, nextInputRevision, now) {
  return {
    ...outbox,
    status: "failed",
    revision: outbox.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: {
      status: "failed",
      details: {
        reason: "pr_source_superseded_before_dispatch",
        nextInputRevision,
      },
    },
    updatedAt: now,
  };
}

export function applyReadyPullRequestSourceCutover({
  root,
  activation,
  itemsById,
  outboxById,
  nextInputRevision,
  nextHeadRevision,
  now,
  timelineEvents,
}) {
  let rootResult = activation.headChanged
    ? { ...root, decisionContext: null }
    : root;
  for (const participant of activation.participants) {
    const activeOutbox = unstartedIntent(participant, outboxById);
    if (activeOutbox !== null) {
      outboxById.set(
        activeOutbox.intentId,
        failSupersededIntent(activeOutbox, nextInputRevision, now),
      );
      timelineEvents.push({
        itemId: participant.itemId,
        type: "intent_superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          intentId: activeOutbox.intentId,
          reason: "pr_source_superseded_before_dispatch",
          nextInputRevision,
        },
      });
      if (participant.itemId === root.itemId) {
        rootResult = {
          ...rootResult,
          status: "queued",
          activeIntentId: null,
          statusReason: "pr_source_revised",
        };
      }
    }
    if (
      activation.headChanged &&
      participant.itemId !== root.itemId &&
      participant.status !== "superseded"
    ) {
      const binding = currentWorkItemInputBinding(participant);
      const superseded = {
        ...participant,
        status: "superseded",
        revision: participant.revision + 1,
        ownerId: null,
        leaseId: null,
        leaseUntil: null,
        activeIntentId: null,
        availableAt: null,
        statusReason: "pr_head_superseded",
        updatedAt: now,
      };
      itemsById.set(superseded.itemId, superseded);
      timelineEvents.push({
        itemId: superseded.itemId,
        type: "superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          rootItemId: root.itemId,
          previousHeadRevision: binding.headRevision,
          nextHeadRevision,
        },
      });
    }
  }
  return rootResult;
}

function publicBlockers(activation) {
  return activation.blockers.map((item) => ({
    itemId: item.itemId,
    status: item.status,
    reason: item.activeIntentId === null
      ? `status:${item.status}`
      : "active_intent",
    activeIntentId: item.activeIntentId,
  }));
}

function resultFor(stateRevision, root, applied, blockers) {
  return {
    applied,
    graphRevision: stateRevision,
    itemId: root.itemId,
    itemRevision: root.revision,
    activeRevision: root.source.activeRevision,
    pendingRevision: root.source.pendingRevision,
    blockers,
  };
}

export function planPullRequestSourceReconciliation({ state, input, clock }) {
  const command = normalizeCommand(input);
  const root = requireWorkLedgerItem(state, command.itemId);
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request") {
    throw conflict("工作项不是 PR 来源根");
  }
  if (root.source.pendingRevision === null) {
    if (root.source.activeRevision !== command.expectedPendingRevision) {
      throw conflict("PR 来源已不再指向预期版本");
    }
    return {
      write: false,
      result: resultFor(state.revision, root, false, []),
    };
  }
  if (root.source.pendingRevision !== command.expectedPendingRevision) {
    throw conflict("PR pending 版本已变化");
  }
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(root, command.expectedRevision);

  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activation = inspectPullRequestSourceCutover(
    root,
    state.items,
    outboxById,
  );
  const blockers = publicBlockers(activation);
  if (blockers.length > 0) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, blockers),
    };
  }

  const now = clock();
  const pendingRevision = root.source.pendingRevision;
  const pendingHeadRevision = root.source.revisions[
    pendingRevision - 1
  ].headRevision;
  const itemsById = new Map(
    state.items.map((item) => [item.itemId, item]),
  );
  const timelineEvents = [];
  const locallySettledRoot = applyReadyPullRequestSourceCutover({
    root,
    activation,
    itemsById,
    outboxById,
    nextInputRevision: pendingRevision,
    nextHeadRevision: pendingHeadRevision,
    now,
    timelineEvents,
  });
  const activated = activatePendingPullRequestWorkSource(root.source);
  const next = {
    ...locallySettledRoot,
    source: activated.source,
    inputDigest: activated.source.current.inputDigest,
    status: locallySettledRoot.status === "paused" ? "paused" : "queued",
    revision: locallySettledRoot.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: "pr_source_cutover_activated",
    updatedAt: now,
  };
  itemsById.set(next.itemId, next);
  timelineEvents.push({
    itemId: next.itemId,
    type: "pr_source_activated",
    at: now,
    actorId: "work-ledger-system",
    details: {
      workKey: next.source.workKey,
      activeRevision: next.source.activeRevision,
      headRevision: pendingHeadRevision,
      headRefOid: next.source.current.headRefOid,
    },
  });
  return {
    patch: {
      items: [...itemsById.values()],
      outbox: [...outboxById.values()],
    },
    timelineEvents,
    result: resultFor(state.revision + 1, next, true, []),
  };
}
