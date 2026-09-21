import {
  normalizeWorkGraphAcceptanceContract,
  normalizeWorkGraphDelivery,
} from "../domain/work-graph-contract.js";
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
import {
  assertWorkLedgerGraphCompletable,
  createWorkGraphAcceptanceRecord,
  createWorkGraphDeliveryRecord,
} from "./work-ledger-graph.js";
import {
  assertItemRevision,
  assertWorkLease,
  moveWorkItem,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const DELIVERY_DECISIONS = new Map([
  ["accept", "accepted"],
  ["reject", "rejected"],
]);

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

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidCommand(`${name} 无效`);
  }
  return value;
}

function expectedGraphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidCommand("expectedGraphRevision 无效");
  }
  return value;
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

function normalizeCoordinatorEnvelope(input, commandKeys, message) {
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

function normalizeDelivererAuthority(value) {
  if (
    !hasExactLedgerKeys(value, [
      "actorId",
      "scopeRootTaskId",
      "taskId",
      "leaseId",
    ])
  ) {
    throw invalidCommand("交付权限上下文无效");
  }
  const graphAuthority = normalizeWorkGraphCommandAuthority({
    actorId: value.actorId,
    scopeRootTaskId: value.scopeRootTaskId,
  });
  return {
    ...graphAuthority,
    taskId: commandString(value.taskId, "taskId", 192),
    leaseId: commandString(value.leaseId, "leaseId", 128),
  };
}

function normalizeDelivererEnvelope(input, commandKeys, message) {
  if (
    !hasExactLedgerKeys(input, ["authority", "command"]) ||
    !hasExactLedgerKeys(input.command, commandKeys)
  ) {
    throw invalidCommand(message);
  }
  return {
    authority: normalizeDelivererAuthority(input.authority),
    command: input.command,
  };
}

function normalizeContract(value) {
  try {
    return normalizeWorkGraphAcceptanceContract(value);
  } catch {
    throw invalidCommand("验收契约无效");
  }
}

function normalizeDelivery(value) {
  try {
    return normalizeWorkGraphDelivery(value);
  } catch {
    throw invalidCommand("交付物无效");
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordContent({ recordedAt: _recordedAt, ...content }) {
  return content;
}

function sameContractContent(left, right) {
  return sameValue(
    {
      acceptanceCriteria: left.acceptanceCriteria,
      expectedDeliverables: left.expectedDeliverables,
    },
    {
      acceptanceCriteria: right.acceptanceCriteria,
      expectedDeliverables: right.expectedDeliverables,
    },
  );
}

function acceptanceResult(stateRevision, item, contractRevision, applied) {
  return {
    applied,
    graphRevision: stateRevision,
    taskId: item.itemId,
    taskRevision: item.revision,
    contractRevision,
    taskStatus: item.status,
  };
}

function deliveryResult(stateRevision, item, delivery, applied) {
  return {
    applied,
    graphRevision: stateRevision,
    taskId: item.itemId,
    taskRevision: item.revision,
    contractRevision: delivery.contractRevision,
    deliveryRevision: delivery.revision,
    deliveryStatus: delivery.status,
    taskStatus: item.status,
  };
}

function reviseAcceptanceInput(input) {
  const { authority, command } = normalizeCoordinatorEnvelope(
    input,
    [
      "taskId",
      "acceptanceContract",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    "修订验收契约请求无效",
  );
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      acceptanceContract: normalizeContract(command.acceptanceContract),
      reason: commandReason(command.reason),
      expectedGraphRevision: expectedGraphRevision(
        command.expectedGraphRevision,
      ),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

export function planWorkGraphAcceptanceRevision({ state, input, clock }) {
  const { authority, command } = reviseAcceptanceInput(input);
  const item = requireWorkLedgerItem(state, command.taskId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertWorkGraphTasksInScope(
    state,
    [item.itemId],
    authority.scopeRootTaskId,
  );
  const existing = item.graph.acceptanceContracts.find(
    ({ revision }) => revision === command.acceptanceContract.revision,
  );
  if (existing) {
    if (
      !sameValue(
        recordContent(existing),
        command.acceptanceContract,
      )
    ) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_CONTRACT_CONFLICT",
        "相同验收契约 revision 已绑定不同内容",
        409,
      );
    }
    return {
      write: false,
      result: acceptanceResult(state.revision, item, existing.revision, false),
    };
  }

  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(item, command.expectedTaskRevision);
  if (
    item.status !== "queued" ||
    item.activeIntentId !== null ||
    item.ownerId !== null ||
    item.leaseId !== null ||
    item.leaseUntil !== null
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有无活动工作的 queued 任务可以修订验收契约",
      409,
    );
  }
  const currentContract = item.graph.acceptanceContracts.at(-1);
  if (command.acceptanceContract.revision !== currentContract.revision + 1) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_CONTRACT_CONFLICT",
      "验收契约 revision 必须连续递增",
      409,
    );
  }
  if (sameContractContent(currentContract, command.acceptanceContract)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_CONTRACT_CONFLICT",
      "验收契约内容没有变化",
      409,
    );
  }
  if (item.graph.deliveries.at(-1)?.status === "submitted") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "仍有待审核交付物，不能修订验收契约",
      409,
    );
  }
  const now = clock();
  const acceptanceRecord = createWorkGraphAcceptanceRecord(
    command.acceptanceContract,
    now,
  );
  const updated = {
    ...item,
    graph: {
      ...item.graph,
      acceptanceContracts: [
        ...item.graph.acceptanceContracts,
        acceptanceRecord,
      ],
    },
    revision: item.revision + 1,
    statusReason: command.reason,
    updatedAt: now,
  };
  const items = replaceWorkLedgerRecord(state.items, "itemId", updated);
  assertWorkGraphCommandTransition(state, items);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "graph_acceptance_revised",
        at: now,
        actorId: authority.actorId,
        details: {
          fromContractRevision: currentContract.revision,
          toContractRevision: command.acceptanceContract.revision,
          reason: command.reason,
        },
      },
    ],
    result: acceptanceResult(
      state.revision + 1,
      updated,
      command.acceptanceContract.revision,
      true,
    ),
  };
}

function submitDeliveryInput(input) {
  const { authority, command } = normalizeDelivererEnvelope(
    input,
    [
      "deliveryRevision",
      "contractRevision",
      "deliverableId",
      "summary",
      "evidence",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    "提交交付物请求无效",
  );
  return {
    authority,
    command: {
      deliveryRevision: positiveRevision(
        command.deliveryRevision,
        "deliveryRevision",
      ),
      contractRevision: positiveRevision(
        command.contractRevision,
        "contractRevision",
      ),
      deliverableId: command.deliverableId,
      summary: command.summary,
      evidence: command.evidence,
      expectedGraphRevision: expectedGraphRevision(
        command.expectedGraphRevision,
      ),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

function submittedDelivery(command) {
  return normalizeDelivery({
    deliverableId: command.deliverableId,
    revision: command.deliveryRevision,
    contractRevision: command.contractRevision,
    status: "submitted",
    summary: command.summary,
    evidence: command.evidence,
  });
}

function latestDeliveryFor(item, contractRevision, deliverableId) {
  return [...item.graph.deliveries].reverse().find(
    (entry) =>
      entry.contractRevision === contractRevision &&
      entry.deliverableId === deliverableId,
  );
}

function assertCurrentDeliverable(item, delivery) {
  const contract = item.graph.acceptanceContracts.at(-1);
  if (
    delivery.contractRevision !== contract.revision ||
    !contract.expectedDeliverables.some(
      ({ deliverableId }) => deliverableId === delivery.deliverableId,
    )
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "交付物未绑定当前验收契约中的预期交付",
      409,
    );
  }
  const previous = latestDeliveryFor(
    item,
    delivery.contractRevision,
    delivery.deliverableId,
  );
  if (previous?.status === "submitted") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "同一交付物已有待审核提交",
      409,
    );
  }
  if (previous?.status === "accepted") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "当前契约中的交付物已经验收",
      409,
    );
  }
}

export function planWorkGraphDeliverySubmission({ state, input, clock }) {
  const { authority, command } = submitDeliveryInput(input);
  const item = requireWorkLedgerItem(state, authority.taskId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertWorkGraphTasksInScope(
    state,
    [item.itemId],
    authority.scopeRootTaskId,
  );
  const delivery = submittedDelivery(command);
  const existing = item.graph.deliveries[delivery.revision - 1];
  if (existing) {
    if (!sameValue(recordContent(existing), delivery)) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
        "相同交付 revision 已绑定不同内容",
        409,
      );
    }
    return {
      write: false,
      result: deliveryResult(state.revision, item, existing, false),
    };
  }

  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(item, command.expectedTaskRevision);
  if (
    item.status !== "working" ||
    delivery.revision !== item.graph.deliveries.length + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "当前任务或交付 revision 不能提交交付物",
      409,
    );
  }
  assertCurrentDeliverable(item, delivery);
  const now = clock();
  assertWorkLease(item, authority.leaseId, now);
  if (item.ownerId !== authority.actorId) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_AUTHORITY_DENIED",
      "只有当前租约员工可以提交交付物",
      403,
    );
  }
  const deliveryRecord = createWorkGraphDeliveryRecord(delivery, now);
  const updated = {
    ...moveWorkItem(item, {
      status: "waiting_external",
      now,
      reason: "delivery_submitted",
    }),
    graph: {
      ...item.graph,
      deliveries: [...item.graph.deliveries, deliveryRecord],
    },
  };
  const items = replaceWorkLedgerRecord(state.items, "itemId", updated);
  assertWorkGraphCommandTransition(state, items);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "graph_delivery_submitted",
        at: now,
        actorId: authority.actorId,
        details: {
          contractRevision: delivery.contractRevision,
          deliverableId: delivery.deliverableId,
          deliveryRevision: delivery.revision,
        },
      },
    ],
    result: deliveryResult(state.revision + 1, updated, delivery, true),
  };
}

function decideDeliveryInput(input) {
  const { authority, command } = normalizeCoordinatorEnvelope(
    input,
    [
      "taskId",
      "submittedDeliveryRevision",
      "decision",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    "审核交付物请求无效",
  );
  const status = DELIVERY_DECISIONS.get(command.decision);
  if (!status) throw invalidCommand("decision 无效");
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      submittedDeliveryRevision: positiveRevision(
        command.submittedDeliveryRevision,
        "submittedDeliveryRevision",
      ),
      status,
      reason: commandReason(command.reason),
      expectedGraphRevision: expectedGraphRevision(
        command.expectedGraphRevision,
      ),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

function reviewedDelivery(command, submitted) {
  return normalizeDelivery({
    deliverableId: submitted.deliverableId,
    revision: submitted.revision + 1,
    contractRevision: submitted.contractRevision,
    status: command.status,
    summary: command.reason,
    evidence: submitted.evidence,
  });
}

function completeWhenReady(state, item) {
  const items = replaceWorkLedgerRecord(state.items, "itemId", item);
  try {
    assertWorkLedgerGraphCompletable({ ...state, items }, item.itemId);
  } catch (error) {
    if (error?.code === "WORK_LEDGER_GRAPH_BLOCKED") return item;
    throw error;
  }
  return {
    ...item,
    status: "completed",
    statusReason: "deliverables_accepted",
  };
}

export function planWorkGraphDeliveryDecision({ state, input, clock }) {
  const { authority, command } = decideDeliveryInput(input);
  const item = requireWorkLedgerItem(state, command.taskId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertWorkGraphTasksInScope(
    state,
    [item.itemId],
    authority.scopeRootTaskId,
  );
  const submitted = item.graph.deliveries[
    command.submittedDeliveryRevision - 1
  ];
  if (!submitted || submitted.status !== "submitted") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "待审核交付 revision 不存在或不是 submitted",
      409,
    );
  }
  const delivery = reviewedDelivery(command, submitted);
  const existing = item.graph.deliveries[delivery.revision - 1];
  if (existing) {
    if (!sameValue(recordContent(existing), delivery)) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
        "同一提交已经绑定不同审核结论",
        409,
      );
    }
    return {
      write: false,
      result: deliveryResult(state.revision, item, existing, false),
    };
  }

  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(item, command.expectedTaskRevision);
  if (
    item.status !== "waiting_external" ||
    item.statusReason !== "delivery_submitted" ||
    submitted.contractRevision !==
      item.graph.acceptanceContracts.at(-1).revision ||
    delivery.revision !== item.graph.deliveries.length + 1 ||
    item.graph.deliveries.at(-1).revision !== submitted.revision
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
      "交付审核绑定已变化",
      409,
    );
  }
  const now = clock();
  const deliveryRecord = createWorkGraphDeliveryRecord(delivery, now);
  let updated = {
    ...moveWorkItem(item, {
      status: "queued",
      now,
      reason: delivery.status === "rejected"
        ? "delivery_rejected"
        : "delivery_accepted",
    }),
    graph: {
      ...item.graph,
      deliveries: [...item.graph.deliveries, deliveryRecord],
    },
  };
  if (delivery.status === "accepted") {
    updated = completeWhenReady(state, updated);
  }
  const items = replaceWorkLedgerRecord(state.items, "itemId", updated);
  assertWorkGraphCommandTransition(state, items);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: delivery.status === "accepted"
          ? "graph_delivery_accepted"
          : "graph_delivery_rejected",
        at: now,
        actorId: authority.actorId,
        details: {
          contractRevision: delivery.contractRevision,
          deliverableId: delivery.deliverableId,
          deliveryRevision: delivery.revision,
          reason: command.reason,
          submittedDeliveryRevision: submitted.revision,
          taskStatus: updated.status,
        },
      },
    ],
    result: deliveryResult(state.revision + 1, updated, delivery, true),
  };
}
