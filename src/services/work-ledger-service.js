import { OperationQueue } from "../lib/operation-queue.js";
import {
  planWorkItemClaim,
  planWorkItemCompletion,
  planWorkItemHandoff,
  planWorkItemRetry,
  planWorkItemTransition,
} from "./work-ledger-item-commands.js";
import { planAttentionBatchApplication } from "./work-ledger-attention-commands.js";
import { planProposalBatchApplication } from "./work-ledger-proposal-commands.js";
import { planConditionWake } from "./work-ledger-condition-commands.js";
import {
  planWorkGraphCancellation,
  planWorkGraphChildCreation,
} from "./work-ledger-graph-commands.js";
import {
  planWorkGraphAcceptanceRevision,
  planWorkGraphDeliveryDecision,
  planWorkGraphDeliverySubmission,
} from "./work-ledger-delivery-commands.js";
import {
  acknowledgeWorkGraphMemoryProjectionBatch,
  appendWorkGraphMemoryEvents,
  readWorkGraphMemoryProjectionBatch,
} from "./work-ledger-graph-memory.js";
import {
  planIntentAcknowledgement,
  planIntentClaim,
  planIntentStage,
} from "./work-ledger-outbox-commands.js";
import {
  appendWorkLedgerTimeline,
  createAssignmentWorkItem,
  createGapAlertWorkItem,
  findAssignmentBatchGap,
  MAX_WORK_LEDGER_INTAKE_BATCH,
  MAX_WORK_LEDGER_QUERY_PAGE,
  normalizeAssignmentBatch,
  normalizeReportedAssignmentGap,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  assertWorkLedgerCapacity,
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
  normalizeWorkLedgerPersistedState,
  WORK_LEDGER_STATE_KEY,
  workLedgerPersistedStateDigest,
} from "./work-ledger-state.js";
import {
  boundedLedgerString,
  cloneLedgerValue,
  isPlainLedgerObject,
  normalizeLedgerTimestamp,
  validatePositiveLimit,
  workLedgerError,
  WORK_LEDGER_OUTBOX_STATUSES,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";
import {
  projectWorkLedgerGraphView,
  validateWorkLedgerGraphTransition,
} from "./work-ledger-graph.js";

function queryPage(records, idName, options = {}, allowedStatuses = null) {
  if (!isPlainLedgerObject(options)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const allowedKeys = new Set(["cursor", "limit", "status", "order"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const requestedLimit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "查询条数无效");
  }
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw workLedgerError("WORK_LEDGER_CURSOR_INVALID", "工作台账游标无效");
  }
  if (
    options.status !== undefined &&
    (!allowedStatuses || !allowedStatuses.has(options.status))
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "状态过滤无效");
  }
  if (
    options.order !== undefined &&
    !new Set(["oldest", "newest"]).has(options.order)
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "排序方式无效");
  }
  const filtered = records.filter(
    (record) =>
      options.status === undefined || record.status === options.status,
  );
  if (options.order === "newest") filtered.reverse();
  let start = 0;
  if (options.cursor) {
    const cursorIndex = filtered.findIndex(
      (record) => record[idName] === options.cursor,
    );
    if (cursorIndex < 0) {
      throw workLedgerError(
        "WORK_LEDGER_CURSOR_INVALID",
        "工作台账游标已失效",
      );
    }
    start = cursorIndex + 1;
  }
  const limit = Math.min(requestedLimit, MAX_WORK_LEDGER_QUERY_PAGE);
  const items = filtered.slice(start, start + limit).map(cloneLedgerValue);
  return {
    items,
    nextCursor:
      start + items.length < filtered.length && items.length
        ? items.at(-1)[idName]
        : null,
  };
}

export class WorkLedgerService {
  constructor({
    store,
    assignmentSource,
    exclusiveLease,
    operationQueue,
    clock = () => new Date(),
    idFactory,
    limits,
  } = {}) {
    if (
      !store ||
      typeof store.read !== "function" ||
      typeof store.write !== "function"
    ) {
      throw new TypeError("WorkLedgerService requires a durable store");
    }
    if (
      !assignmentSource ||
      typeof assignmentSource.readAssignmentBatch !== "function"
    ) {
      throw new TypeError(
        "assignmentSource must provide readAssignmentBatch({ afterSequence, limit })",
      );
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("WorkLedgerService requires an exclusiveLease");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof idFactory !== "function") {
      throw new TypeError("idFactory must be a function");
    }
    this.store = store;
    this.assignmentSource = assignmentSource;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue || new OperationQueue();
    this.clock = clock;
    this.idFactory = idFactory;
    this.limits = normalizeWorkLedgerLimits(limits);
    this.state = emptyWorkLedgerState();
    this.ready = false;
    this.recoveryPromise = null;
  }

  async recover() {
    if (this.ready) return this.getSummary();
    this.recoveryPromise ||= this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
          this.ready = true;
          return this.getSummary();
        } catch (error) {
          this.ready = false;
          if (error?.code === "WORK_LEDGER_STATE_CORRUPTED") throw error;
          throw workLedgerError(
            "WORK_LEDGER_STATE_CORRUPTED",
            "无法恢复员工工作台账",
            503,
            { cause: error },
          );
        }
      }),
    );
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async getSummary() {
    this.#assertReady();
    const itemCounts = Object.fromEntries(
      [...WORK_LEDGER_STATUSES].map((status) => [status, 0]),
    );
    for (const item of this.state.items) itemCounts[item.status] += 1;
    const outboxCounts = { pending: 0, dispatching: 0, delivered: 0, failed: 0 };
    for (const entry of this.state.outbox) outboxCounts[entry.status] += 1;
    return cloneLedgerValue({
      revision: this.state.revision,
      intakeCursor: this.state.intakeCursor,
      sourceHighWatermark: this.state.sourceHighWatermark,
      attentionCursor: this.state.attentionCursor,
      attentionHighWatermark: this.state.attentionHighWatermark,
      proposalCursor: this.state.proposalCursor,
      proposalHighWatermark: this.state.proposalHighWatermark,
      timelineStartSequence: this.state.timelineStartSequence,
      nextTimelineSequence: this.state.nextTimelineSequence,
      itemCounts,
      outboxCounts,
      graphMemoryProjection: {
        cursor: this.state.graphMemoryProjection.cursor,
        highWatermark: this.state.graphMemoryProjection.nextSequence - 1,
        pending: this.state.graphMemoryProjection.pending.length,
      },
      outboxDeliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    });
  }

  async listItems(options = {}) {
    this.#assertReady();
    return queryPage(this.state.items, "itemId", options, WORK_LEDGER_STATUSES);
  }

  async listTimeline(options = {}) {
    this.#assertReady();
    return queryPage(this.state.timeline, "timelineId", options);
  }

  async listOutbox(options = {}) {
    this.#assertReady();
    return queryPage(
      this.state.outbox,
      "intentId",
      options,
      WORK_LEDGER_OUTBOX_STATUSES,
    );
  }

  async getGraphSnapshot() {
    this.#assertReady();
    return projectWorkLedgerGraphView(this.state);
  }

  async readGraphMemoryProjectionBatch(options = {}) {
    this.#assertReady();
    return readWorkGraphMemoryProjectionBatch(
      this.state.graphMemoryProjection,
      options,
    );
  }

  async acknowledgeGraphMemoryProjection(input = {}) {
    return this.acknowledgeGraphMemoryProjectionBatch({ receipts: [input] });
  }

  async acknowledgeGraphMemoryProjectionBatch(input = {}) {
    this.#assertReady();
    return this.#writeTransaction(async () => {
      const nextRevision = this.state.revision + 1;
      const acknowledgement = acknowledgeWorkGraphMemoryProjectionBatch(
        this.state.graphMemoryProjection,
        input,
        nextRevision,
      );
      if (!acknowledgement.write) {
        return cloneLedgerValue(acknowledgement.result);
      }
      await this.#persist(
        {
          ...this.state,
          revision: nextRevision,
          graphMemoryProjection: acknowledgement.projection,
        },
        { appendGraphMemory: false },
      );
      return cloneLedgerValue(acknowledgement.result);
    });
  }

  async intake({ limit = 100 } = {}) {
    this.#assertReady();
    const batchLimit = validatePositiveLimit(
      limit,
      MAX_WORK_LEDGER_INTAKE_BATCH,
      "limit",
    );
    return this.#writeTransaction(async () => {
      const afterSequence = this.state.intakeCursor;
      let rawBatch;
      try {
        rawBatch = await this.assignmentSource.readAssignmentBatch({
          afterSequence,
          limit: batchLimit,
        });
      } catch (error) {
        const reportedGap = normalizeReportedAssignmentGap(error, afterSequence);
        if (reportedGap) {
          this.#assertSourceHighWatermark(reportedGap.highWatermark);
          return this.#recordGap(
            { highWatermark: reportedGap.highWatermark },
            reportedGap,
            this.#now(),
          );
        }
        if (error?.code === "WORK_LEDGER_SOURCE_INVALID") throw error;
        throw workLedgerError(
          "WORK_LEDGER_SOURCE_UNAVAILABLE",
          "无法读取可靠工作分派流",
          503,
          { cause: error },
        );
      }
      const batch = normalizeAssignmentBatch(rawBatch, {
        afterSequence,
        requestedLimit: batchLimit,
        itemByteBudget: this.limits.itemByteBudget,
      });
      this.#assertSourceHighWatermark(batch.highWatermark);
      const now = this.#now();
      const gap = findAssignmentBatchGap(batch, afterSequence);
      return gap
        ? this.#recordGap(batch, gap, now)
        : this.#recordBatch(batch, now);
    });
  }

  async claim(input = {}) {
    return this.#executeCommand(planWorkItemClaim, input, true);
  }

  async transition(input = {}) {
    return this.#executeCommand(planWorkItemTransition, input);
  }

  async scheduleRetry(input = {}) {
    return this.#executeCommand(planWorkItemRetry, input);
  }

  async handoff(input = {}) {
    return this.#executeCommand(planWorkItemHandoff, input);
  }

  async complete(input = {}) {
    return this.#executeCommand(planWorkItemCompletion, input);
  }

  async cancelGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphCancellation, input);
  }

  async createGraphChild(input = {}) {
    return this.#executeCommand(planWorkGraphChildCreation, input);
  }

  async reviseGraphAcceptance(input = {}) {
    return this.#executeCommand(planWorkGraphAcceptanceRevision, input);
  }

  async submitGraphDelivery(input = {}) {
    return this.#executeCommand(planWorkGraphDeliverySubmission, input);
  }

  async decideGraphDelivery(input = {}) {
    return this.#executeCommand(planWorkGraphDeliveryDecision, input);
  }

  async stageIntent(input = {}) {
    return this.#executeCommand(planIntentStage, input);
  }

  async claimIntent(input = {}) {
    return this.#executeCommand(planIntentClaim, input, true);
  }

  async ackIntent(input = {}) {
    return this.#executeCommand(planIntentAcknowledgement, input);
  }

  async applyAttentionBatch(input = {}) {
    return this.#executeCommand(planAttentionBatchApplication, input);
  }

  async applyProposalBatch(input = {}) {
    return this.#executeCommand(planProposalBatchApplication, input);
  }

  async wakeCondition(input = {}) {
    return this.#executeCommand(planConditionWake, input);
  }

  #executeCommand(planner, input, requiresLeaseId = false) {
    this.#assertReady();
    return this.#writeTransaction(() => {
      const mutation = planner({
        state: this.state,
        input,
        clock: () => this.#now(),
        ...(requiresLeaseId
          ? { newLeaseId: () => this.#newLeaseId() }
          : {}),
      });
      if (mutation.write === false) return cloneLedgerValue(mutation.result);
      return this.#commitMutation(mutation);
    });
  }

  async #commitMutation({ patch, timelineEvents, result }) {
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        ...patch,
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue(result);
  }

  async #recordGap(batch, gap, now) {
    const alert = createGapAlertWorkItem(gap, now);
    const existing = this.state.items.find(
      ({ assignmentId }) => assignmentId === alert.assignmentId,
    );
    if (existing && existing.inputDigest !== alert.inputDigest) {
      throw workLedgerError(
        "WORK_LEDGER_ASSIGNMENT_CONFLICT",
        "系统 gap 告警 ID 对应了不同输入",
        409,
      );
    }
    const items = existing ? this.state.items : [...this.state.items, alert];
    const timelineEvents = [];
    if (!existing) {
      timelineEvents.push({
        itemId: alert.itemId,
        type: "assignment_intaken",
        at: now,
        actorId: "work-ledger-system",
        details: {
          assignmentId: alert.assignmentId,
          sourceSequence: 0,
          inputDigest: alert.inputDigest,
          kind: "system_alert",
        },
      });
    }
    timelineEvents.push({
      itemId: alert.itemId,
      type: "intake_gap",
      at: now,
      actorId: "work-ledger-system",
      details: gap,
    });
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        sourceHighWatermark: batch.highWatermark,
        items,
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue({
      received: 0,
      deduplicated: existing ? 1 : 0,
      cursor: this.state.intakeCursor,
      highWatermark: this.state.sourceHighWatermark,
      gap,
      itemIds: existing ? [] : [alert.itemId],
      alertItemId: alert.itemId,
    });
  }

  async #recordBatch(batch, now) {
    const knownAssignments = new Map(
      this.state.items.map((item) => [item.assignmentId, item]),
    );
    const created = [];
    let deduplicated = 0;
    for (const envelope of batch.items) {
      const item = createAssignmentWorkItem(envelope, now);
      const existing = knownAssignments.get(item.assignmentId);
      if (existing) {
        if (
          existing.inputDigest !== item.inputDigest ||
          existing.sourceSequence !== item.sourceSequence
        ) {
          throw workLedgerError(
            "WORK_LEDGER_ASSIGNMENT_CONFLICT",
            "相同 assignmentId 对应了不同输入，拒绝推进游标",
            409,
          );
        }
        deduplicated += 1;
        continue;
      }
      knownAssignments.set(item.assignmentId, item);
      created.push(item);
    }
    const timelineEvents = created.map((item) => ({
      itemId: item.itemId,
      type: "assignment_intaken",
      at: now,
      actorId: "work-ledger-system",
      details: {
        assignmentId: item.assignmentId,
        sourceSequence: item.sourceSequence,
        inputDigest: item.inputDigest,
        kind: item.kind,
      },
    }));
    timelineEvents.push({
      itemId: null,
      type: "intake_completed",
      at: now,
      actorId: "work-ledger-system",
      details: {
        afterSequence: this.state.intakeCursor,
        nextSequence: batch.nextSequence,
        highWatermark: batch.highWatermark,
        received: created.length,
        deduplicated,
      },
    });
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        intakeCursor: batch.nextSequence,
        sourceHighWatermark: batch.highWatermark,
        items: [...this.state.items, ...created],
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue({
      received: created.length,
      deduplicated,
      cursor: this.state.intakeCursor,
      highWatermark: this.state.sourceHighWatermark,
      gap: null,
      itemIds: created.map(({ itemId }) => itemId),
      alertItemId: null,
    });
  }

  #assertSourceHighWatermark(highWatermark) {
    if (highWatermark < this.state.sourceHighWatermark) {
      throw workLedgerError(
        "WORK_LEDGER_SOURCE_ROLLBACK",
        "分派源高水位发生回退，拒绝推进游标",
        409,
      );
    }
  }

  #candidateWithTimeline(candidate, events) {
    const timeline = appendWorkLedgerTimeline(
      this.state,
      events,
      this.limits.timelineLimit,
    );
    return {
      ...candidate,
      timeline: timeline.timeline,
      timelineStartSequence: timeline.timelineStartSequence,
      nextTimelineSequence: timeline.nextTimelineSequence,
    };
  }

  #newLeaseId() {
    try {
      return boundedLedgerString(this.idFactory(), "leaseId", 128);
    } catch (error) {
      throw workLedgerError(
        "WORK_LEDGER_ID_INVALID",
        "租约 ID 生成器返回了无效值",
        500,
        { cause: error },
      );
    }
  }

  #now() {
    try {
      return normalizeLedgerTimestamp(this.clock(), "clock");
    } catch (error) {
      if (error?.code === "WORK_LEDGER_CLOCK_INVALID") throw error;
      throw workLedgerError(
        "WORK_LEDGER_CLOCK_INVALID",
        "工作台账时钟无效",
        500,
        { cause: error },
      );
    }
  }

  async #persist(candidate, { appendGraphMemory = true } = {}) {
    if (candidate.revision !== this.state.revision + 1) {
      throw workLedgerError(
        "WORK_LEDGER_STATE_REVISION_CONFLICT",
        "员工工作台账 revision 冲突",
        409,
      );
    }
    if (appendGraphMemory) {
      candidate = appendWorkGraphMemoryEvents(
        this.state,
        candidate,
        this.limits,
      );
    }
    assertWorkLedgerCapacity(candidate, this.limits);
    let normalized;
    try {
      normalized = normalizeWorkLedgerPersistedState(candidate, this.limits);
    } catch (error) {
      if (error?.code === "WORK_LEDGER_CAPACITY_EXCEEDED") throw error;
      throw workLedgerError(
        "WORK_LEDGER_STATE_CORRUPTED",
        "拒绝写入不一致的员工工作台账",
        503,
        { cause: error },
      );
    }
    try {
      validateWorkLedgerGraphTransition(this.state, normalized);
    } catch (error) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_TRANSITION_INVALID",
        "员工工作图转换与台账修订不一致",
        409,
        { cause: error },
      );
    }
    try {
      await this.store.write(WORK_LEDGER_STATE_KEY, normalized);
    } catch (error) {
      throw workLedgerError(
        "WORK_LEDGER_STATE_WRITE_FAILED",
        "无法持久化员工工作台账",
        503,
        { cause: error },
      );
    }
    this.state = normalized;
  }

  async #readDurableState() {
    const stored = await this.store.read(WORK_LEDGER_STATE_KEY, null);
    if (stored === null) {
      if (this.ready && this.state.revision !== 0) {
        throw workLedgerError(
          "WORK_LEDGER_STATE_CORRUPTED",
          "员工工作台账持久状态意外消失",
          503,
        );
      }
      return emptyWorkLedgerState();
    }
    const durable = normalizeWorkLedgerPersistedState(stored, this.limits);
    if (
      this.ready &&
      (durable.revision < this.state.revision ||
        (durable.revision === this.state.revision &&
          workLedgerPersistedStateDigest(durable) !==
            workLedgerPersistedStateDigest(this.state)))
    ) {
      throw workLedgerError(
        "WORK_LEDGER_STATE_REVISION_CONFLICT",
        "员工工作台账持久状态发生回退或分叉",
        409,
      );
    }
    return durable;
  }

  #writeTransaction(operation) {
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
        } catch (error) {
          if (
            error?.code === "WORK_LEDGER_STATE_CORRUPTED" ||
            error?.code === "WORK_LEDGER_STATE_REVISION_CONFLICT"
          ) {
            throw error;
          }
          throw workLedgerError(
            "WORK_LEDGER_STATE_CORRUPTED",
            "无法重读员工工作台账",
            503,
            { cause: error },
          );
        }
        return operation();
      }),
    );
  }

  #assertReady() {
    if (!this.ready) {
      throw workLedgerError(
        "WORK_LEDGER_NOT_READY",
        "员工工作台账尚未恢复",
        503,
      );
    }
  }
}
