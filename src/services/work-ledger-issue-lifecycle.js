import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { moveWorkItem } from "./work-ledger-transitions.js";

const LIFECYCLE_EVENTS = new Set([
  "issue.completed",
  "issue.left_scope",
]);
const SETTLEABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
  "retry_wait",
  "blocked",
]);

function lifecycleReason(eventType) {
  return eventType === "issue.completed"
    ? "issue_source_completed"
    : "issue_source_left_scope";
}

function sameIssueSubject(left, right) {
  return Boolean(
    left?.source?.provider === "github" &&
      right?.source?.provider === "github" &&
      left.source.scopeId === right.source.scopeId &&
      left.subject?.id === right.subject?.id &&
      left.subject?.repository === right.subject?.repository &&
      left.subject?.number === right.subject?.number,
  );
}

function workItemEvent(item) {
  try {
    return currentWorkItemEvent(item);
  } catch {
    return null;
  }
}

function failActiveIntent(outbox, event, reason, now) {
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
        reason,
        lifecycleEventId: event.eventId,
      },
    },
    updatedAt: now,
  };
}

function issueWorkTree(itemsById, event, sourceSequence) {
  const selected = new Set(
    [...itemsById.values()]
      .filter((item) => {
        const candidate = workItemEvent(item);
        return (
          candidate !== null &&
          sameIssueSubject(candidate, event) &&
          item.sourceSequence <= sourceSequence
        );
      })
      .map(({ itemId }) => itemId),
  );
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const item of itemsById.values()) {
      if (
        !selected.has(item.itemId) &&
        selected.has(item.graph?.parentItemId)
      ) {
        selected.add(item.itemId);
        foundDescendant = true;
      }
    }
  }
  return selected;
}

export function isIssueScopeLifecycleEvent(event) {
  return LIFECYCLE_EVENTS.has(event?.eventType);
}

export function settleIssueScope({
  event,
  sourceSequence,
  itemsById,
  outboxById,
  now,
  timelineEvents,
}) {
  if (!isIssueScopeLifecycleEvent(event)) return [];
  const reason = lifecycleReason(event.eventType);
  const settled = [];
  for (const itemId of issueWorkTree(itemsById, event, sourceSequence)) {
    const item = itemsById.get(itemId);
    if (!SETTLEABLE_STATUSES.has(item.status)) continue;
    const outbox = item.activeIntentId === null
      ? null
      : outboxById.get(item.activeIntentId) ?? null;
    if (outbox?.status === "pending" || outbox?.status === "dispatching") {
      outboxById.set(
        outbox.intentId,
        failActiveIntent(outbox, event, reason, now),
      );
    }
    itemsById.set(
      itemId,
      moveWorkItem(item, {
        status: "cancelled",
        now,
        reason,
      }),
    );
    settled.push(itemId);
    timelineEvents.push({
      itemId,
      type: "cancelled",
      at: now,
      actorId: "work-ledger-system",
      details: {
        lifecycleEventId: event.eventId,
        lifecycleEventType: event.eventType,
        subjectId: event.subject.id,
      },
    });
  }
  return settled;
}

export function planRecoveredIssueScopeSettlement(state, now) {
  const lifecycleItems = state.items
    .map((item) => ({ item, event: workItemEvent(item) }))
    .filter(({ event }) => isIssueScopeLifecycleEvent(event))
    .sort((left, right) => left.item.sourceSequence - right.item.sourceSequence);
  if (lifecycleItems.length === 0) return null;
  const itemsById = new Map(state.items.map((item) => [item.itemId, item]));
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const timelineEvents = [];
  for (const { item, event } of lifecycleItems) {
    settleIssueScope({
      event,
      sourceSequence: item.sourceSequence,
      itemsById,
      outboxById,
      now,
      timelineEvents,
    });
  }
  return timelineEvents.length === 0
    ? null
    : {
        items: [...itemsById.values()],
        outbox: [...outboxById.values()],
        timelineEvents,
      };
}
