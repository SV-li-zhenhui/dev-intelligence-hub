import {
  assertWorkItemNotInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  assertExpectedWorkGraphRevision,
  assertWorkGraphCommandTransition,
  assertWorkGraphTasksInScope,
  normalizeWorkGraphCommandAuthority,
} from "./work-ledger-graph-command-support.js";
import { planWorkGraphCancellation } from "./work-ledger-graph-commands.js";
import {
  createWorkIntentRecord,
  normalizeLedgerWorkIntent,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  assertItemRevision,
  moveWorkItem,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  normalizeLedgerTarget,
  workLedgerError,
} from "./work-ledger-values.js";
import { currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";

const PAUSABLE_STATUSES = new Set(["queued", "blocked"]);
const ESCALATABLE_STATUSES = new Set(["queued", "retry_wait", "blocked"]);

function invalidCommand(message) {
  return workLedgerError("WORK_LEDGER_GRAPH_COMMAND_INVALID", message);
}

function commandString(value, name, maximumBytes) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw invalidCommand(`${name} 无效`);
  }
}

function commandReason(value) {
  let reason;
  try {
    reason = normalizeWorkReason(value);
  } catch {
    throw invalidCommand("reason 无效");
  }
  if (reason === null) throw invalidCommand("reason 无效");
  return reason;
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidCommand(`${name} 无效`);
  }
  return value;
}

function graphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidCommand("expectedGraphRevision 无效");
  }
  return value;
}

function coordinatorEnvelope(input, commandKeys, message) {
  if (
    !hasExactLedgerKeys(input, ["authority", "command"]) ||
    !hasExactLedgerKeys(input.command, commandKeys)
  ) {
    throw invalidCommand(message);
  }
  return {
    authority: normalizeWorkGraphCommandAuthority(input.authority),
    command: input.command,
  };
}

function normalizeTaskCommand(input, message) {
  const { authority, command } = coordinatorEnvelope(
    input,
    [
      "taskId",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    message,
  );
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      reason: commandReason(command.reason),
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

function normalizeReassignCommand(input) {
  const { authority, command } = coordinatorEnvelope(
    input,
    [
      "taskId",
      "target",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    "重新分派任务请求无效",
  );
  let target;
  try {
    target = normalizeLedgerTarget(command.target);
  } catch {
    throw invalidCommand("target 无效");
  }
  if (target.type !== "role") {
    throw invalidCommand("重新分派任务只能绑定可信岗位");
  }
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      target,
      reason: commandReason(command.reason),
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

function requireScopedTask(state, authority, taskId) {
  const item = requireWorkLedgerItem(state, taskId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertWorkGraphTasksInScope(state, [item.itemId], authority.scopeRootTaskId);
  return item;
}

function assertCoordinatableTask(item) {
  if (!["assignment", "graph_task"].includes(item.kind)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "系统工作项不能由任务图编排器修改",
      409,
    );
  }
}

function hasSubmittedDelivery(item) {
  return item.graph.deliveries.at(-1)?.status === "submitted";
}

function assertNoActiveSideEffects(item) {
  if (
    item.ownerId !== null ||
    item.leaseId !== null ||
    item.leaseUntil !== null ||
    item.activeIntentId !== null ||
    hasSubmittedDelivery(item)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "任务仍有租约、活动意图或待审核交付，不能安全编排",
      409,
    );
  }
}

function assertCommandCas(state, item, command) {
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(item, command.expectedTaskRevision);
}

function replaceAndValidate(state, updated) {
  const items = replaceWorkLedgerRecord(state.items, "itemId", updated);
  assertWorkGraphCommandTransition(state, items);
  return items;
}

export function planWorkGraphTaskReassignment({ state, input, clock }) {
  const { authority, command } = normalizeReassignCommand(input);
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item);
  assertNoActiveSideEffects(item);
  if (
    item.status !== "queued" ||
    (
      item.currentTarget.type === command.target.type &&
      item.currentTarget.id === command.target.id
    )
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有责任目标发生变化的安全 queued 任务可以重新分派",
      409,
    );
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "queued",
    now,
    reason: command.reason,
    target: command.target,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "handed_off",
        at: now,
        actorId: authority.actorId,
        details: {
          fromTarget: item.currentTarget,
          toTarget: command.target,
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planWorkGraphTaskPause({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "暂停任务请求无效",
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item);
  assertNoActiveSideEffects(item);
  if (!PAUSABLE_STATUSES.has(item.status)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有无活动副作用的 queued 或 blocked 任务可以暂停",
      409,
    );
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "paused",
    now,
    reason: command.reason,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "transitioned",
        at: now,
        actorId: authority.actorId,
        details: {
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planWorkGraphTaskResume({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "恢复任务请求无效",
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item);
  assertNoActiveSideEffects(item);
  if (item.status !== "paused") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有 paused 任务可以恢复为 queued",
      409,
    );
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "queued",
    now,
    reason: command.reason,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "transitioned",
        at: now,
        actorId: authority.actorId,
        details: {
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planScopedWorkGraphCancellation({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "取消任务请求无效",
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCoordinatableTask(item);
  return planWorkGraphCancellation({
    state,
    clock,
    input: {
      itemId: command.taskId,
      expectedGraphRevision: command.expectedGraphRevision,
      expectedRevision: command.expectedTaskRevision,
      actorId: authority.actorId,
      reason: command.reason,
    },
  });
}

function normalizeEscalationCommand(input) {
  const { authority, command } = coordinatorEnvelope(
    input,
    [
      "taskId",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
      "summary",
      "question",
      "choices",
    ],
    "升级任务请求无效",
  );
  let intent;
  try {
    intent = normalizeLedgerWorkIntent({
      schemaVersion: 1,
      type: "ask_user",
      summary: command.summary,
      reason: command.reason,
      question: command.question,
      choices: command.choices,
    });
  } catch {
    throw invalidCommand("升级任务的 ask_user 内容无效");
  }
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      reason: intent.reason,
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
      intent,
    },
  };
}

function pendingEscalation(existing, candidate, now) {
  if (!existing) return candidate;
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

export function planWorkGraphEscalation({ state, input, clock }) {
  const { authority, command } = normalizeEscalationCommand(input);
  const item = requireScopedTask(state, authority, command.taskId);
  const requestedBy = {
    roleId: "orchestrator",
    workerId: authority.actorId,
  };
  const now = clock();
  const candidate = createWorkIntentRecord(
    item,
    command.intent,
    requestedBy,
    now,
  );
  const existing = state.outbox.find(
    ({ intentId }) => intentId === candidate.intentId,
  );
  if (existing && existing.status !== "failed") {
    if (item.activeIntentId !== existing.intentId) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_TASK_CONFLICT",
        "历史升级意图不再是任务的活动意图，不能作为幂等重放",
        409,
      );
    }
    return {
      write: false,
      result: {
        applied: false,
        item,
        outbox: existing,
        deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
      },
    };
  }

  assertCommandCas(state, item, command);
  assertCoordinatableTask(item);
  assertNoActiveSideEffects(item);
  if (!ESCALATABLE_STATUSES.has(item.status)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有无活动副作用的 queued、retry_wait 或 blocked 任务可以升级",
      409,
    );
  }
  const outboxResult = pendingEscalation(existing, candidate, now);
  const itemResult = moveWorkItem(item, {
    status: "dispatch_pending",
    now,
    reason: "intent_staged",
    activeIntentId: outboxResult.intentId,
  });
  const items = replaceAndValidate(state, itemResult);
  return {
    patch: {
      items,
      outbox: existing
        ? replaceWorkLedgerRecord(state.outbox, "intentId", outboxResult)
        : [...state.outbox, outboxResult],
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "intent_staged",
        at: now,
        actorId: authority.actorId,
        details: {
          inputBinding: currentWorkItemExecutionBinding(item),
          workItemRevision: itemResult.revision,
          intentId: outboxResult.intentId,
          intentDigest: outboxResult.intentDigest,
          intentType: outboxResult.intent.type,
          inputDigest: item.inputDigest,
          requestedBy,
          reusedFailedIntent: existing !== undefined,
          deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
          ...(outboxResult.intent.type === "ask_user"
            ? {
                consultationRequest: {
                  summary: outboxResult.intent.summary,
                  reason: outboxResult.intent.reason,
                  question: outboxResult.intent.question,
                  choices: outboxResult.intent.choices,
                },
              }
            : {}),
        },
      },
    ],
    result: {
      applied: true,
      item: itemResult,
      outbox: outboxResult,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  };
}
