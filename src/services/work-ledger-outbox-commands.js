import {
  createWorkIntentDispatchBinding,
  LEGACY_UNKNOWN_WORK_INTENT_BINDING,
  normalizeBoundWorkIntent,
} from "../domain/work-intent-dispatch-binding.js";
import {
  createWorkIntentRecord,
  normalizeLedgerWorkIntent,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  normalizeWorkLeaseDuration,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  assertItemRevision,
  assertWorkLease,
  moveWorkItem,
  normalizeRetryAt,
  normalizeWorkActor,
  normalizeWorkDetails,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  normalizeLedgerTarget,
  workLedgerError,
} from "./work-ledger-values.js";

function requireIntent(state, intentId) {
  const intent = state.outbox.find(
    (candidate) => candidate.intentId === intentId,
  );
  if (!intent) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_NOT_FOUND",
      "工作意图不存在",
      404,
    );
  }
  return intent;
}

function assertIntentRevision(intent, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_REVISION_INVALID",
      "outbox revision 无效",
    );
  }
  if (intent.revision !== expectedRevision) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_REVISION_CONFLICT",
      "工作意图已被其他 dispatcher 更新",
      409,
    );
  }
}

function pendingIntent(existing, item, intent, requestedBy, now) {
  if (!existing) return createWorkIntentRecord(item, intent, requestedBy, now);
  if (existing.status !== "failed") {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_CONFLICT",
      "相同工作意图已经进入 outbox",
      409,
    );
  }
  return {
    ...existing,
    status: "pending",
    revision: existing.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    dispatchBinding: null,
    outcome: null,
    updatedAt: now,
  };
}

function normalizeRequestedBy(input, item, intent) {
  const requestedBy = {
    roleId: boundedLedgerString(input.roleId, "roleId", 128),
    workerId: normalizeWorkActor(input.actorId),
  };
  if (requestedBy.workerId !== item.ownerId) {
    throw workLedgerError(
      "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
      "提交意图的员工不是当前租约所有者",
      409,
    );
  }
  const ownsTarget =
    item.currentTarget.type === "role" &&
    item.currentTarget.id === requestedBy.roleId;
  const orchestratorTakeover =
    requestedBy.roleId === "orchestrator" &&
    requestedBy.workerId === "employee-orchestrator" &&
    intent.type === "ask_user";
  if (!ownsTarget && !orchestratorTakeover) {
    throw workLedgerError(
      "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
      "岗位不能冒充其他目标提交工作意图",
      409,
    );
  }
  return requestedBy;
}

export function planIntentStage({ state, input, clock }) {
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const intent = normalizeLedgerWorkIntent(input.intent);
  const item = requireWorkLedgerItem(state, itemId);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  assertWorkLease(item, input.leaseId, now);
  if (item.status !== "working") {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      "只有正在工作的员工可以提交结构化意图",
      409,
    );
  }
  const requestedBy = normalizeRequestedBy(input, item, intent);
  const actorId = requestedBy.workerId;
  const candidate = createWorkIntentRecord(item, intent, requestedBy, now);
  const existing = state.outbox.find(
    ({ intentId }) => intentId === candidate.intentId,
  );
  const outboxResult = pendingIntent(existing, item, intent, requestedBy, now);
  const itemResult = moveWorkItem(item, {
    status: "dispatch_pending",
    now,
    reason: "intent_staged",
    activeIntentId: outboxResult.intentId,
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
      outbox: existing
        ? replaceWorkLedgerRecord(state.outbox, "intentId", outboxResult)
        : [...state.outbox, outboxResult],
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "intent_staged",
        at: now,
        actorId,
        details: {
          intentId: outboxResult.intentId,
          intentDigest: outboxResult.intentDigest,
          intentType: outboxResult.intent.type,
          inputDigest: item.inputDigest,
          requestedBy,
          reusedFailedIntent: existing !== undefined,
          deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
        },
      },
    ],
    result: {
      item: itemResult,
      outbox: outboxResult,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  };
}

export function planIntentClaim({ state, input, clock, newLeaseId }) {
  const intentId = boundedLedgerString(input.intentId, "intentId", 192);
  const dispatcherId = boundedLedgerString(
    input.dispatcherId,
    "dispatcherId",
    128,
  );
  const duration = normalizeWorkLeaseDuration(input.leaseDurationMs);
  const outbox = requireIntent(state, intentId);
  assertIntentRevision(outbox, input.expectedRevision);
  if (
    outbox.dispatchBinding?.status ===
      LEGACY_UNKNOWN_WORK_INTENT_BINDING
  ) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
      "历史工作意图的策略绑定无法证明，必须人工核对后恢复",
      409,
    );
  }
  const now = clock();
  const expiredLease =
    outbox.status === "dispatching" &&
    Date.parse(outbox.dispatchLeaseUntil) <= Date.parse(now);
  if (outbox.status === "dispatching" && !expiredLease) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_LEASE_ACTIVE",
      "工作意图正在由其他 dispatcher 处理",
      409,
    );
  }
  if (!["pending", "dispatching"].includes(outbox.status)) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_STATUS_CONFLICT",
      "工作意图已经得到最终确认",
      409,
    );
  }
  const dispatchLeaseId = newLeaseId();
  const dispatchLeaseUntil = new Date(Date.parse(now) + duration).toISOString();
  const outboxResult = {
    ...outbox,
    status: "dispatching",
    revision: outbox.revision + 1,
    attempt: outbox.attempt + 1,
    dispatcherId,
    dispatchLeaseId,
    dispatchLeaseUntil,
    updatedAt: now,
  };
  const timelineEvents = [];
  if (expiredLease) {
    timelineEvents.push({
      itemId: outbox.itemId,
      type: "intent_lease_expired",
      at: now,
      actorId: dispatcherId,
      details: {
        intentId: outbox.intentId,
        previousDispatcherId: outbox.dispatcherId,
        previousDispatchLeaseId: outbox.dispatchLeaseId,
        previousDispatchLeaseUntil: outbox.dispatchLeaseUntil,
      },
    });
  }
  timelineEvents.push({
    itemId: outbox.itemId,
    type: "intent_claimed",
    at: now,
    actorId: dispatcherId,
    details: {
      intentId: outbox.intentId,
      dispatchLeaseId,
      dispatchLeaseUntil,
      attempt: outboxResult.attempt,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  });
  return {
    patch: {
      outbox: replaceWorkLedgerRecord(
        state.outbox,
        "intentId",
        outboxResult,
      ),
    },
    timelineEvents,
    result: {
      ...outboxResult,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  };
}

export function planIntentBinding({ state, input, clock }) {
  const intentId = boundedLedgerString(input.intentId, "intentId", 192);
  const dispatcherId = boundedLedgerString(
    input.dispatcherId,
    "dispatcherId",
    128,
  );
  const dispatchLeaseId = boundedLedgerString(
    input.dispatchLeaseId,
    "dispatchLeaseId",
    128,
  );
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_REVISION_INVALID",
      "outbox revision 无效",
    );
  }
  const outbox = requireIntent(state, intentId);
  const item = requireWorkLedgerItem(state, outbox.itemId);
  assertItemRevision(item, input.itemExpectedRevision);
  if (
    item.status !== "dispatch_pending" ||
    item.activeIntentId !== outbox.intentId ||
    item.inputDigest !== outbox.inputDigest
  ) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_BINDING_CONFLICT",
      "工作意图与当前工作项不再一致",
      409,
    );
  }
  let dispatchBinding;
  try {
    const boundIntent = normalizeBoundWorkIntent(input.boundIntent, {
      intentType: outbox.intent.type,
      roleId: outbox.requestedBy.roleId,
      workItemId: item.itemId,
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    });
    dispatchBinding = createWorkIntentDispatchBinding(boundIntent);
  } catch (cause) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_BINDING_INVALID",
      "工作意图策略绑定无效",
      400,
      { cause },
    );
  }
  const sameLease =
    outbox.status === "dispatching" &&
    outbox.dispatcherId === dispatcherId &&
    outbox.dispatchLeaseId === dispatchLeaseId;
  const now = clock();
  if (sameLease && Date.parse(outbox.dispatchLeaseUntil) <= Date.parse(now)) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_LEASE_EXPIRED",
      "outbox dispatcher 租约已过期",
      409,
    );
  }
  if (
    sameLease &&
    outbox.revision === input.expectedRevision + 1 &&
    outbox.dispatchBinding?.bindingDigest === dispatchBinding.bindingDigest &&
    JSON.stringify(outbox.dispatchBinding.boundIntent) ===
      JSON.stringify(dispatchBinding.boundIntent)
  ) {
    return {
      write: false,
      result: {
        ...outbox,
        deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
      },
    };
  }
  assertIntentRevision(outbox, input.expectedRevision);
  if (!sameLease) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_LEASE_CONFLICT",
      "outbox dispatcher 租约已变化",
      409,
    );
  }
  if (outbox.dispatchBinding !== null) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_BINDING_CONFLICT",
      "工作意图已经绑定了不同策略结果",
      409,
    );
  }
  const outboxResult = {
    ...outbox,
    dispatchBinding,
    revision: outbox.revision + 1,
    updatedAt: now,
  };
  return {
    patch: {
      outbox: replaceWorkLedgerRecord(
        state.outbox,
        "intentId",
        outboxResult,
      ),
    },
    timelineEvents: [
      {
        itemId: outbox.itemId,
        type: "intent_bound",
        at: now,
        actorId: dispatcherId,
        details: {
          intentId: outbox.intentId,
          bindingDigest: dispatchBinding.bindingDigest,
          dispatchLeaseId,
        },
      },
    ],
    result: {
      ...outboxResult,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  };
}

function normalizeHandoffAcknowledgement(outbox, input) {
  const hasTarget = Object.hasOwn(input, "target");
  const deliveredHandoff =
    outbox.intent.type === "handoff" && input.outcome === "delivered";
  if (!deliveredHandoff) {
    if (hasTarget || input.nextStatus === "queued") {
      throw workLedgerError(
        "WORK_LEDGER_INTENT_ACK_INVALID",
        "只有已交付的转交意图可以原子重新排队",
      );
    }
    return null;
  }
  if (input.nextStatus !== "queued" || !hasTarget) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_ACK_INVALID",
      "转交意图必须原子确认目标岗位并重新排队",
    );
  }
  const target = normalizeLedgerTarget(input.target);
  if (target.type !== "role") {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_ACK_INVALID",
      "转交意图只能交给策略绑定的岗位",
    );
  }
  return target;
}

function acknowledgedNextStatus(outcome, nextStatus) {
  const allowedNext = outcome === "delivered"
    ? new Set([
        "queued",
        "waiting_user",
        "waiting_condition",
        "waiting_external",
        "completed",
      ])
    : new Set(["retry_wait", "blocked"]);
  if (!allowedNext.has(nextStatus)) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_ACK_INVALID",
      "outbox 结果与工作项后继状态不一致",
    );
  }
}

export function planIntentAcknowledgement({ state, input, clock }) {
  const intentId = boundedLedgerString(input.intentId, "intentId", 192);
  const dispatchLeaseId = boundedLedgerString(
    input.dispatchLeaseId,
    "dispatchLeaseId",
    128,
  );
  const actorId = normalizeWorkActor(input.actorId);
  const context = normalizeWorkDetails(input.details ?? {});
  if (!new Set(["delivered", "failed"]).has(input.outcome)) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_ACK_INVALID",
      "outbox acknowledgement 无效",
    );
  }
  acknowledgedNextStatus(input.outcome, input.nextStatus);
  const outbox = requireIntent(state, intentId);
  assertIntentRevision(outbox, input.expectedRevision);
  const handoffTarget = normalizeHandoffAcknowledgement(outbox, input);
  if (
    outbox.status !== "dispatching" ||
    outbox.dispatchLeaseId !== dispatchLeaseId
  ) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_LEASE_CONFLICT",
      "outbox dispatcher 租约已变化",
      409,
    );
  }
  const now = clock();
  if (Date.parse(outbox.dispatchLeaseUntil) <= Date.parse(now)) {
    throw workLedgerError(
      "WORK_LEDGER_INTENT_LEASE_EXPIRED",
      "outbox dispatcher 租约已过期",
      409,
    );
  }
  const item = requireWorkLedgerItem(state, outbox.itemId);
  assertItemRevision(item, input.itemExpectedRevision);
  if (item.status !== "dispatch_pending") {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      "outbox 对应工作项不再等待分发",
      409,
    );
  }
  const availableAt = input.nextStatus === "retry_wait"
    ? normalizeRetryAt(input.availableAt, now)
    : null;
  const itemResult = moveWorkItem(item, {
    status: input.nextStatus,
    now,
    reason: input.outcome === "delivered" ? "intent_delivered" : "intent_failed",
    availableAt,
    activeIntentId: new Set([
      "waiting_user",
      "waiting_condition",
      "waiting_external",
    ]).has(input.nextStatus)
      ? outbox.intentId
      : null,
    ...(handoffTarget ? { target: handoffTarget } : {}),
  });
  const outboxResult = {
    ...outbox,
    status: input.outcome,
    revision: outbox.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: { status: input.outcome, details: context },
    updatedAt: now,
  };
  const timelineEvents = [
    {
      itemId: item.itemId,
      type: "intent_acknowledged",
      at: now,
      actorId,
      details: {
        intentId: outbox.intentId,
        outcome: input.outcome,
        nextStatus: input.nextStatus,
        availableAt,
        context,
      },
    },
  ];
  if (input.nextStatus === "retry_wait") {
    timelineEvents.push({
      itemId: item.itemId,
      type: "retry_scheduled",
      at: now,
      actorId,
      details: {
        fromStatus: item.status,
        availableAt,
        reason: "intent_failed",
      },
    });
  }
  if (input.nextStatus === "completed") {
    timelineEvents.push({
      itemId: item.itemId,
      type: "completed",
      at: now,
      actorId,
      details: {
        fromStatus: item.status,
        result: {
          outcome: "intent_delivered",
          resultRef: outbox.intentId,
        },
      },
    });
  }
  if (handoffTarget) {
    timelineEvents.push({
      itemId: item.itemId,
      type: "handed_off",
      at: now,
      actorId,
      details: {
        fromTarget: item.currentTarget,
        toTarget: handoffTarget,
        fromStatus: item.status,
        reason: "intent_delivered",
      },
    });
  }
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
      outbox: replaceWorkLedgerRecord(
        state.outbox,
        "intentId",
        outboxResult,
      ),
    },
    timelineEvents,
    result: { item: itemResult, outbox: outboxResult },
  };
}
