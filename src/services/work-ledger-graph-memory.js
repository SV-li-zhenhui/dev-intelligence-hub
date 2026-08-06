import { isDeepStrictEqual } from "node:util";
import {
  createWorkGraphMemoryEvent,
  normalizeWorkGraphMemoryEvent,
  workGraphMemorySourceRecordDigest,
  workGraphMemoryRecordReceipt,
} from "../domain/work-graph-memory-event.js";
import {
  cloneLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  prettySerializedLedgerBytes,
  SHA256_PATTERN,
  workLedgerError,
} from "./work-ledger-values.js";

export const MAX_WORK_GRAPH_MEMORY_EVENTS = 50_000;
export const MAX_WORK_GRAPH_MEMORY_EVENT_BYTES = 96 * 1024;
export const MAX_WORK_GRAPH_MEMORY_BATCH = 100;

const PROJECTION_KEYS = [
  "revision",
  "nextSequence",
  "cursor",
  "checkpointDigest",
  "sourceHistoryDigest",
  "lastAcknowledgement",
  "pending",
];
const LEGACY_PROJECTION_KEYS = PROJECTION_KEYS.filter(
  (key) => key !== "sourceHistoryDigest",
);
const ACKNOWLEDGEMENT_KEYS = [
  "sequence",
  "eventId",
  "eventDigest",
  "taskId",
  "sourceRecordDigest",
  "memoryRecordId",
  "memoryRecordDigest",
];

function projectionError(code, message, statusCode = 409) {
  return workLedgerError(code, message, statusCode);
}

function corrupted(message = "任务图记忆投影状态损坏") {
  return projectionError("WORK_LEDGER_GRAPH_MEMORY_CORRUPTED", message, 503);
}

function capacityExceeded() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED",
    "任务图记忆待投影事件达到安全容量，拒绝提交图变更",
  );
}

function orderConflict() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_ORDER_CONFLICT",
    "任务图记忆确认顺序已变化",
  );
}

function bindingConflict() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_BINDING_CONFLICT",
    "任务图记忆确认与待投影事件不一致",
  );
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right);
}

function denseArray(value, maximum, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function safeInteger(value, minimum, error) {
  if (!Number.isSafeInteger(value) || value < minimum) throw error;
  return value;
}

function safeDigest(value, error) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw error;
  return value;
}

function safeText(value, maximumBytes, error) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw error;
  }
  return value;
}

function eventForRecord({
  projection,
  item,
  kind,
  record,
  ledgerRevision,
  limits,
}) {
  if (
    projection.nextSequence >= Number.MAX_SAFE_INTEGER ||
    projection.pending.length >= limits.graphMemoryOutboxLimit
  ) {
    throw capacityExceeded();
  }
  const previousDigest = projection.pending.at(-1)?.eventDigest ??
    projection.checkpointDigest;
  const event = createWorkGraphMemoryEvent({
    sequence: projection.nextSequence,
    previousDigest,
    ledgerRevision,
    taskRevision: item.revision,
    item,
    kind,
    record,
  });
  if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
    throw capacityExceeded();
  }
  return {
    ...projection,
    revision: ledgerRevision,
    nextSequence: projection.nextSequence + 1,
    pending: [...projection.pending, event],
  };
}

export function workGraphMemorySourceHistoryDigest(items) {
  return ledgerDigest(
    items
      .flatMap((item) => recordEventsForItem(item))
      .sort(compareRecordEvents)
      .map(({ item, kind, record }) => ({
        taskId: item.itemId,
        kind,
        recordRevision: record.revision,
        sourceRecordDigest: workGraphMemorySourceRecordDigest({
          taskId: item.itemId,
          kind,
          record,
        }),
      })),
  );
}

function isSyntheticSourceRootContract(item, kind, record) {
  return (
    item.kind === "source_root" &&
    kind === "acceptance_contract" &&
    record.revision === 1 &&
    record.recordedAt === item.createdAt &&
    record.acceptanceCriteria.length === 0 &&
    record.expectedDeliverables.length === 0
  );
}

function recordEventsForItem(item, contractStart = 0, deliveryStart = 0) {
  return [
    ...item.graph.acceptanceContracts.slice(contractStart).map((record) => ({
      item,
      kind: "acceptance_contract",
      record,
    })),
    ...item.graph.deliveries.slice(deliveryStart).map((record) => ({
      item,
      kind: `delivery_${record.status}`,
      record,
    })),
  ].filter(({ kind, record }) =>
    !isSyntheticSourceRootContract(item, kind, record)
  );
}

function compareRecordEvents(left, right) {
  return left.record.recordedAt.localeCompare(right.record.recordedAt, "en") ||
    left.item.itemId.localeCompare(right.item.itemId, "en") ||
    Number(left.kind !== "acceptance_contract") -
      Number(right.kind !== "acceptance_contract") ||
    left.record.revision - right.record.revision;
}

function appendEvents(projection, events, ledgerRevision, limits) {
  let result = projection;
  for (const event of [...events].sort(compareRecordEvents)) {
    result = eventForRecord({
      projection: result,
      ...event,
      ledgerRevision,
      limits,
    });
  }
  return result;
}

function graphRecordCount(items) {
  return items.reduce(
    (total, item) => total + recordEventsForItem(item).length,
    0,
  );
}

function sourceRecordForEvent(item, event) {
  return recordEventsForItem(item).find(
    ({ kind, record }) =>
      kind === event.kind && record.revision === event.recordRevision,
  )?.record ?? null;
}

function assertEventMatchesLedger(event, itemById, stateRevision, error) {
  const item = itemById.get(event.taskId);
  const record = item ? sourceRecordForEvent(item, event) : null;
  if (
    !item ||
    !record ||
    event.taskRevision > item.revision ||
    event.ledgerRevision > stateRevision
  ) {
    throw error;
  }
  let expected;
  try {
    expected = createWorkGraphMemoryEvent({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      ledgerRevision: event.ledgerRevision,
      taskRevision: event.taskRevision,
      item,
      kind: event.kind,
      record,
    });
  } catch {
    throw error;
  }
  if (!sameValue(event, expected)) throw error;
}

function normalizeAcknowledgement(value, error) {
  if (!hasExactLedgerKeys(value, ACKNOWLEDGEMENT_KEYS)) throw error;
  const memoryRecordDigest = safeDigest(value.memoryRecordDigest, error);
  const eventDigest = safeDigest(value.eventDigest, error);
  const eventId = safeText(value.eventId, 128, error);
  const memoryRecordId = safeText(value.memoryRecordId, 80, error);
  if (
    eventId !== `work-graph-memory-event-${eventDigest}` ||
    memoryRecordId !== `memory-${memoryRecordDigest}`
  ) {
    throw error;
  }
  return {
    sequence: safeInteger(value.sequence, 1, error),
    eventId,
    eventDigest,
    taskId: safeText(value.taskId, 192, error),
    sourceRecordDigest: safeDigest(value.sourceRecordDigest, error),
    memoryRecordId,
    memoryRecordDigest,
  };
}

function normalizeLastAcknowledgement(value, error) {
  if (!hasExactLedgerKeys(value, ["event", "receipt"])) throw error;
  let event;
  try {
    event = normalizeWorkGraphMemoryEvent(value.event);
  } catch {
    throw error;
  }
  const receipt = normalizeAcknowledgement(value.receipt, error);
  if (!sameValue(receipt, workGraphMemoryRecordReceipt(event))) throw error;
  return { event, receipt };
}

export function emptyWorkGraphMemoryProjection() {
  return {
    revision: 0,
    nextSequence: 1,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: ledgerDigest([]),
    lastAcknowledgement: null,
    pending: [],
  };
}

export function migrateLegacyWorkGraphMemoryProjection(value, items) {
  if (!hasExactLedgerKeys(value, LEGACY_PROJECTION_KEYS)) throw corrupted();
  return {
    ...cloneLedgerValue(value),
    sourceHistoryDigest: workGraphMemorySourceHistoryDigest(items),
  };
}

export function migrateWorkGraphMemoryProjection(items, ledgerRevision, limits) {
  const events = items
    .flatMap((item) => recordEventsForItem(item))
    .sort(compareRecordEvents);
  if (events.length > limits.graphMemoryOutboxLimit) throw capacityExceeded();
  const pending = [];
  let nextSequence = 1;
  let previousDigest = null;
  for (const descriptor of events) {
    if (nextSequence >= Number.MAX_SAFE_INTEGER) throw capacityExceeded();
    const event = createWorkGraphMemoryEvent({
      sequence: nextSequence,
      previousDigest,
      ledgerRevision,
      taskRevision: descriptor.item.revision,
      item: descriptor.item,
      kind: descriptor.kind,
      record: descriptor.record,
    });
    if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
      throw capacityExceeded();
    }
    pending.push(event);
    nextSequence += 1;
    previousDigest = event.eventDigest;
  }
  return {
    revision: events.length > 0 ? ledgerRevision : 0,
    nextSequence,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: workGraphMemorySourceHistoryDigest(items),
    lastAcknowledgement: null,
    pending,
  };
}

export function appendWorkGraphMemoryEvents(
  previousState,
  candidateState,
  limits,
) {
  if (
    !sameValue(
      candidateState.graphMemoryProjection,
      previousState.graphMemoryProjection,
    )
  ) {
    throw projectionError(
      "WORK_LEDGER_GRAPH_MEMORY_TRANSITION_INVALID",
      "业务命令不能直接修改任务图记忆投影状态",
    );
  }
  const previousById = new Map(
    previousState.items.map((item) => [item.itemId, item]),
  );
  const additions = [];
  for (const item of candidateState.items) {
    const previous = previousById.get(item.itemId);
    const contractStart = previous?.graph.acceptanceContracts.length ?? 0;
    const deliveryStart = previous?.graph.deliveries.length ?? 0;
    if (
      item.graph.acceptanceContracts.length < contractStart ||
      item.graph.deliveries.length < deliveryStart
    ) {
      throw projectionError(
        "WORK_LEDGER_GRAPH_MEMORY_TRANSITION_INVALID",
        "任务图历史不能在记忆投影前被删除",
      );
    }
    additions.push(...recordEventsForItem(item, contractStart, deliveryStart));
  }
  let graphMemoryProjection = appendEvents(
    previousState.graphMemoryProjection,
    additions,
    candidateState.revision,
    limits,
  );
  if (additions.length > 0) {
    graphMemoryProjection = {
      ...graphMemoryProjection,
      sourceHistoryDigest: workGraphMemorySourceHistoryDigest(
        candidateState.items,
      ),
    };
  }
  return {
    ...candidateState,
    graphMemoryProjection,
  };
}

export function normalizeWorkGraphMemoryProjection(
  value,
  stateRevision,
  items,
  limits,
) {
  const error = corrupted();
  if (!hasExactLedgerKeys(value, PROJECTION_KEYS)) throw error;
  const revision = safeInteger(value.revision, 0, error);
  const nextSequence = safeInteger(value.nextSequence, 1, error);
  const cursor = safeInteger(value.cursor, 0, error);
  const checkpointDigest = value.checkpointDigest === null
    ? null
    : safeDigest(value.checkpointDigest, error);
  const sourceHistoryDigest = safeDigest(value.sourceHistoryDigest, error);
  const lastAcknowledgement = value.lastAcknowledgement === null
    ? null
    : normalizeLastAcknowledgement(value.lastAcknowledgement, error);
  const pending = denseArray(
    value.pending,
    limits.graphMemoryOutboxLimit,
    error,
  ).map((entry) => {
    let event;
    try {
      event = normalizeWorkGraphMemoryEvent(entry);
    } catch {
      throw error;
    }
    if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
      throw error;
    }
    return event;
  });
  if (
    revision > stateRevision ||
    cursor > Number.MAX_SAFE_INTEGER - pending.length - 1 ||
    nextSequence !== cursor + pending.length + 1 ||
    (nextSequence === 1) !== (revision === 0) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    (cursor === 0) !== (lastAcknowledgement === null) ||
    nextSequence - 1 !== graphRecordCount(items) ||
    sourceHistoryDigest !== workGraphMemorySourceHistoryDigest(items) ||
    (lastAcknowledgement !== null &&
      (lastAcknowledgement.event.sequence !== cursor ||
        lastAcknowledgement.event.eventDigest !== checkpointDigest))
  ) {
    throw error;
  }
  let previousDigest = checkpointDigest;
  for (let index = 0; index < pending.length; index += 1) {
    const event = pending[index];
    if (
      event.sequence !== cursor + index + 1 ||
      event.previousDigest !== previousDigest
    ) {
      throw error;
    }
    previousDigest = event.eventDigest;
  }
  const itemById = new Map(items.map((item) => [item.itemId, item]));
  if (lastAcknowledgement !== null) {
    assertEventMatchesLedger(
      lastAcknowledgement.event,
      itemById,
      stateRevision,
      error,
    );
  }
  for (const event of pending) {
    assertEventMatchesLedger(event, itemById, stateRevision, error);
  }
  return {
    revision,
    nextSequence,
    cursor,
    checkpointDigest,
    sourceHistoryDigest,
    lastAcknowledgement,
    pending,
  };
}

export function normalizeWorkGraphMemoryBatchOptions(value = {}) {
  const error = new TypeError("task graph memory batch options are invalid");
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactLedgerKeys(value, Object.hasOwn(value, "limit") ? ["limit"] : [])
  ) {
    throw error;
  }
  const limit = Object.hasOwn(value, "limit") ? value.limit : 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_WORK_GRAPH_MEMORY_BATCH
  ) {
    throw error;
  }
  return { limit };
}

export function readWorkGraphMemoryProjectionBatch(projection, value = {}) {
  const { limit } = normalizeWorkGraphMemoryBatchOptions(value);
  return cloneLedgerValue({
    cursor: projection.cursor,
    highWatermark: projection.nextSequence - 1,
    items: projection.pending.slice(0, limit),
  });
}

export function acknowledgeWorkGraphMemoryProjection(
  projection,
  value,
  stateRevision,
) {
  return acknowledgeWorkGraphMemoryProjectionBatch(
    projection,
    { receipts: [value] },
    stateRevision,
  );
}

export function acknowledgeWorkGraphMemoryProjectionBatch(
  projection,
  value,
  stateRevision,
) {
  const error = projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_ACK_INVALID",
    "任务图记忆确认格式无效",
    400,
  );
  if (!hasExactLedgerKeys(value, ["receipts"])) throw error;
  const requests = denseArray(
    value.receipts,
    MAX_WORK_GRAPH_MEMORY_BATCH,
    error,
  ).map((receipt) => normalizeAcknowledgement(receipt, error));
  if (requests.length === 0) throw error;
  const first = requests[0];
  if (first.sequence <= projection.cursor) {
    if (
      requests.length === 1 &&
      first.sequence === projection.cursor &&
      projection.lastAcknowledgement !== null &&
      sameValue(first, projection.lastAcknowledgement.receipt)
    ) {
      return {
        write: false,
        projection,
        result: {
          status: "already",
          cursor: projection.cursor,
          highWatermark: projection.nextSequence - 1,
        },
      };
    }
    throw orderConflict();
  }
  if (
    first.sequence !== projection.cursor + 1 ||
    requests.length > projection.pending.length
  ) {
    throw orderConflict();
  }
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const event = projection.pending[index];
    if (request.sequence !== projection.cursor + index + 1) {
      throw orderConflict();
    }
    if (!sameValue(request, workGraphMemoryRecordReceipt(event))) {
      throw bindingConflict();
    }
  }
  const lastIndex = requests.length - 1;
  const request = requests[lastIndex];
  const event = projection.pending[lastIndex];
  const nextProjection = {
    ...projection,
    revision: stateRevision,
    cursor: request.sequence,
    checkpointDigest: event.eventDigest,
    lastAcknowledgement: { event, receipt: request },
    pending: projection.pending.slice(requests.length),
  };
  return {
    write: true,
    projection: nextProjection,
    result: {
      status: "applied",
      cursor: nextProjection.cursor,
      highWatermark: nextProjection.nextSequence - 1,
    },
  };
}
