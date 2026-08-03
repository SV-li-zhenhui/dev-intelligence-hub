import {
  createWorkGraphSnapshot,
  validateWorkGraphTransition,
} from "../domain/work-graph-contract.js";
import {
  boundedLedgerString,
  cloneLedgerValue,
  ledgerDataEntries,
  workLedgerError,
} from "./work-ledger-values.js";

export const WORK_LEDGER_GRAPH_ID = "work-ledger";

// Only queued work is graph-ready. Retry deadlines and recoverable blocks stay
// non-terminal so the ledger can safely requeue them later.
const GRAPH_STATUS_BY_LEDGER_STATUS = new Map([
  ["queued", "pending"],
  ["working", "in_progress"],
  ["dispatch_pending", "in_progress"],
  ["waiting_user", "in_progress"],
  ["waiting_condition", "in_progress"],
  ["waiting_external", "in_progress"],
  ["retry_wait", "in_progress"],
  ["completed", "completed"],
  ["blocked", "in_progress"],
  ["cancelled", "cancelled"],
]);

const DEFAULT_ACCEPTANCE_CONTRACT = Object.freeze({
  revision: 1,
  acceptanceCriteria: Object.freeze([]),
  expectedDeliverables: Object.freeze([]),
});

const GRAPH_METADATA_KEYS = [
  "parentItemId",
  "dependsOnItemIds",
  "acceptanceContracts",
  "deliveries",
];

export function createDefaultWorkGraphMetadata() {
  return {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: DEFAULT_ACCEPTANCE_CONTRACT.revision,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
    ],
    deliveries: [],
  };
}

export function workLedgerStatusToGraphStatus(status) {
  const graphStatus = GRAPH_STATUS_BY_LEDGER_STATUS.get(status);
  if (graphStatus === undefined) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项状态无法投影到工作图",
    );
  }
  return graphStatus;
}

function graphTaskFromItem(item) {
  const itemEntries = ledgerDataEntries(item);
  if (!itemEntries) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项不是安全的数据对象",
    );
  }
  const fields = new Map(itemEntries);
  const graphEntries = ledgerDataEntries(fields.get("graph"));
  const graphKeys = graphEntries && new Set(graphEntries.map(([key]) => key));
  if (
    !graphEntries ||
    graphEntries.length !== GRAPH_METADATA_KEYS.length ||
    GRAPH_METADATA_KEYS.some((key) => !graphKeys.has(key))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项的工作图元数据字段无效",
    );
  }
  const graph = new Map(graphEntries);
  return {
    taskId: fields.get("itemId"),
    revision: fields.get("revision"),
    parentTaskId: graph.get("parentItemId"),
    status: workLedgerStatusToGraphStatus(fields.get("status")),
    responsibility: fields.get("currentTarget"),
    acceptanceContracts: graph.get("acceptanceContracts"),
    deliveries: graph.get("deliveries"),
    dependsOn: graph.get("dependsOnItemIds"),
  };
}

function metadataFromTask(task) {
  return cloneLedgerValue({
    parentItemId: task.parentTaskId,
    dependsOnItemIds: task.dependsOn,
    acceptanceContracts: task.acceptanceContracts,
    deliveries: task.deliveries,
  });
}

function denseItems(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项集合必须是连续的纯数据数组",
    );
  }
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
        "工作项集合不能包含访问器",
      );
    }
    items.push(descriptor.value);
  }
  return items;
}

function freezeProjection(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) freezeProjection(child);
  return Object.freeze(value);
}

function projectedItemWork(item) {
  const assignmentEntries = ledgerDataEntries(item.get("assignment"));
  const eventEntries = ledgerDataEntries(item.get("event"));
  if (!assignmentEntries || !eventEntries) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项说明不是安全的数据对象",
    );
  }
  const assignment = new Map(assignmentEntries);
  const event = new Map(eventEntries);
  const source = item.get("kind") === "graph_task"
    ? assignment.get("work")
    : new Map(ledgerDataEntries(event.get("payload")) ?? []);
  const entries = source instanceof Map ? source : new Map(
    ledgerDataEntries(source) ?? [],
  );
  const title = entries.get("title");
  const description = entries.get("description");
  if (
    item.get("kind") === "graph_task" &&
    (typeof title !== "string" || typeof description !== "string")
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "图任务缺少工作说明",
    );
  }
  return {
    title: typeof title === "string" ? title : null,
    description: typeof description === "string" ? description : null,
  };
}

export function projectWorkLedgerGraphSnapshot(state, options) {
  const stateEntries = ledgerDataEntries(state);
  if (!stateEntries) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作台账不是安全的数据对象",
    );
  }
  const fields = new Map(stateEntries);
  const stateRevision = fields.get("revision");
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作台账修订无效",
    );
  }
  const items = denseItems(fields.get("items"));
  return createWorkGraphSnapshot(
    {
      graphId: WORK_LEDGER_GRAPH_ID,
      revision: stateRevision,
      tasks: items.map(graphTaskFromItem),
    },
    options,
  );
}

export function projectWorkLedgerGraphView(state, options) {
  const graph = projectWorkLedgerGraphSnapshot(state, options);
  const stateEntries = ledgerDataEntries(state);
  const fields = new Map(stateEntries);
  const itemsById = new Map(
    denseItems(fields.get("items")).map((item) => {
      const entries = ledgerDataEntries(item);
      if (!entries) {
        throw workLedgerError(
          "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
          "工作项运行状态不是安全的数据对象",
        );
      }
      const itemFields = new Map(entries);
      return [itemFields.get("itemId"), itemFields];
    }),
  );
  const taskStates = graph.tasks.map((task) => {
    const item = itemsById.get(task.taskId);
    if (!item || item.get("revision") !== task.revision) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
        "工作图与台账运行状态修订不一致",
      );
    }
    workLedgerStatusToGraphStatus(item.get("status"));
    return {
      taskId: task.taskId,
      taskRevision: task.revision,
      ledgerStatus: item.get("status"),
      ownerId: item.get("ownerId"),
      leaseUntil: item.get("leaseUntil"),
      availableAt: item.get("availableAt"),
      statusReason: item.get("statusReason"),
      updatedAt: item.get("updatedAt"),
      work: projectedItemWork(item),
    };
  });
  return freezeProjection({
    schemaVersion: 1,
    graph,
    taskStates,
  });
}

export function validateWorkLedgerGraphTransition(previousState, nextState) {
  const previous = projectWorkLedgerGraphSnapshot(previousState);
  const next = projectWorkLedgerGraphSnapshot(nextState);
  return validateWorkGraphTransition(previous, next);
}

function workLedgerGraphTaskContext(state, itemId) {
  const normalizedItemId = boundedLedgerString(itemId, "itemId", 192);
  const snapshot = projectWorkLedgerGraphSnapshot(state);
  const task = snapshot.tasks.find(({ taskId }) => taskId === normalizedItemId);
  if (!task) {
    throw workLedgerError(
      "WORK_LEDGER_ITEM_NOT_FOUND",
      "工作项不存在",
      404,
    );
  }
  const byId = new Map(snapshot.tasks.map((entry) => [entry.taskId, entry]));
  const children = snapshot.tasks.filter(
    ({ parentTaskId }) => parentTaskId === normalizedItemId,
  );
  return { task, byId, children };
}

export function assertWorkLedgerGraphClaimable(state, itemId) {
  const { task, byId, children } = workLedgerGraphTaskContext(state, itemId);
  const blockedByDependency = task.dependsOn.some(
    (dependencyId) => byId.get(dependencyId).status !== "completed",
  );
  const blockedByChild = children.some(
    ({ status }) => status !== "completed",
  );
  if (blockedByChild || blockedByDependency) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_BLOCKED",
      "工作项仍有子任务或未完成依赖，当前不可领取",
      409,
    );
  }
}

function missingRequiredDeliverables(task) {
  const currentContract = task.acceptanceContracts.at(-1);
  const latestByDeliverable = new Map();
  for (const delivery of task.deliveries) {
    if (delivery.contractRevision === currentContract.revision) {
      latestByDeliverable.set(delivery.deliverableId, delivery);
    }
  }
  return currentContract.expectedDeliverables
    .filter(({ required }) => required)
    .filter(
      ({ deliverableId }) =>
        latestByDeliverable.get(deliverableId)?.status !== "accepted",
    );
}

export function assertWorkLedgerGraphCompletable(state, itemId) {
  const { task, byId, children } = workLedgerGraphTaskContext(state, itemId);
  const hasIncompleteDependency = task.dependsOn.some(
    (dependencyId) => byId.get(dependencyId).status !== "completed",
  );
  const hasIncompleteChild = children.some(
    ({ status }) => status !== "completed",
  );
  if (
    hasIncompleteDependency ||
    hasIncompleteChild ||
    missingRequiredDeliverables(task).length > 0
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_BLOCKED",
      "工作项仍有未完成依赖、子任务或必需交付物",
      409,
    );
  }
}

export function normalizeWorkLedgerGraphItems(items, stateRevision) {
  const safeItems = denseItems(items);
  const snapshot = projectWorkLedgerGraphSnapshot({
    revision: stateRevision,
    items: safeItems,
  });
  const tasksById = new Map(
    snapshot.tasks.map((task) => [task.taskId, task]),
  );
  return safeItems.map((item) => ({
    ...item,
    graph: metadataFromTask(tasksById.get(item.itemId)),
  }));
}
