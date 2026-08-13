import { OperationQueue } from "../lib/operation-queue.js";
import {
  isTrustedPullRequestScopeLifecycleAssignment,
} from "../domain/pull-request-scope-lifecycle.js";
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
  planScopedWorkGraphCancellation,
  planWorkGraphEscalation,
  planWorkGraphTaskPause,
  planWorkGraphTaskReassignment,
  planWorkGraphTaskResume,
} from "./work-ledger-orchestration-commands.js";
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
  planIntentBinding,
  planIntentClaim,
  planIntentStage,
} from "./work-ledger-outbox-commands.js";
import {
  appendWorkLedgerTimeline,
  createAssignmentWorkItem,
  createGapAlertWorkItem,
  createPullRequestSourceRootWorkItem,
  findAssignmentBatchGap,
  MAX_WORK_LEDGER_INTAKE_BATCH,
  MAX_WORK_LEDGER_QUERY_PAGE,
  normalizeAssignmentBatch,
  normalizeReportedAssignmentGap,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  activatePendingPullRequestWorkSource,
  applyPullRequestScopeLifecycle,
  appendPullRequestWorkSource,
  pullRequestTrustedPredecessor,
  verifyPullRequestExecutionBinding as verifyPullRequestExecutionAuthority,
  validatePullRequestSourceTransition,
} from "./work-ledger-pr-source.js";
import {
  appendPullRequestCutoverTimelineEvent,
  arePullRequestCutoverProofsRetained,
  applyReadyPullRequestSourceCutover,
  createPullRequestCutoverTimelineIndex,
  CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  crossRootPullRequestCutoverCandidate,
  crossRootPullRequestCutoverActivation,
  crossRootPullRequestCutoverBlockerReason,
  crossRootPullRequestCutoverPendingId,
  crossRootPullRequestCutoverPendingReason,
  crossRootPullRequestCutoverPredecessorId,
  inspectPullRequestSourceCutover,
  planPullRequestSourceReconciliation,
  retireCrossRootPullRequestPredecessor,
} from "./work-ledger-pr-cutover-commands.js";
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
  hasExactLedgerKeys,
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

const DIRECT_NEW_WORK_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

const PR_SOURCE_REQUEUE_STATUSES = new Set([
  "blocked",
  "working",
  "retry_wait",
  "completed",
]);
const CROSS_ROOT_REPLACED_REASON =
  "pr_source_cross_root_cutover_replaced";
const PR_SOURCE_AUTHORITY_FENCE_DISPOSITIONS = new Set([
  "ignored_authority_fence",
  "ignored_legacy_downgrade",
  "ignored_unproven_head",
]);

function canRequeueAdvancedPullRequestRoot(root) {
  return PR_SOURCE_REQUEUE_STATUSES.has(root.status) ||
    (root.kind === "source_root" &&
      root.source?.kind === "pull_request" &&
      root.status === "superseded" &&
      root.statusReason === CROSS_ROOT_REPLACED_REASON);
}

function samePullRequestSubject(left, right) {
  return Boolean(
    left?.source?.kind === "pull_request" &&
      right?.source?.kind === "pull_request" &&
      left.source.identity.subjectId === right.source.identity.subjectId &&
      left.source.identity.repository === right.source.identity.repository &&
      left.source.identity.pullRequestNumber ===
        right.source.identity.pullRequestNumber,
  );
}

function pullRequestRootForLifecycle(itemsById, event) {
  return [...itemsById.values()].find((item) =>
    item?.source?.kind === "pull_request" &&
    item.source.identity.provider === event.source?.provider &&
    item.source.identity.scopeId === event.source?.scopeId &&
    item.source.identity.subjectId === event.subject?.id &&
    item.source.identity.repository === event.subject?.repository &&
    item.source.identity.pullRequestNumber === event.subject?.number
  ) ?? null;
}

function operationalPullRequestPredecessor(itemsById, root, authority) {
  const canonicalItemId = authority?.canonicalRootItemId ??
    authority?.lastTrustedRootItemId ?? null;
  if (canonicalItemId === null || canonicalItemId === root.itemId) return null;
  let candidate = itemsById.get(canonicalItemId) ?? null;
  if (
    candidate?.kind !== "source_root" ||
    !samePullRequestSubject(candidate, root)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      "跨来源 PR cutover 当前来源绑定无效",
      409,
    );
  }
  const pendingPredecessorItemId =
    crossRootPullRequestCutoverPredecessorId(candidate);
  if (pendingPredecessorItemId !== null) {
    candidate = itemsById.get(pendingPredecessorItemId) ?? null;
  }
  if (candidate?.itemId === root.itemId) return null;
  if (
    candidate?.kind !== "source_root" ||
    !samePullRequestSubject(candidate, root)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      "跨来源 PR cutover 前驱绑定无效",
      409,
    );
  }
  return candidate;
}

function newWorkAdmissionRun(value) {
  const gate = value === undefined ? DIRECT_NEW_WORK_ADMISSION : value;
  if (!gate || typeof gate.run !== "function") {
    throw new TypeError("actionAdmissionGate must provide run(operation)");
  }
  return gate.run.bind(gate);
}

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
    actionAdmissionGate,
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
    this.runNewWorkAdmission = newWorkAdmissionRun(actionAdmissionGate);
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

  async listPendingPullRequestSources(options = {}) {
    this.#assertReady();
    const pendingRoots = this.state.items.filter((item) =>
      item.kind === "source_root" &&
      item.source?.kind === "pull_request" &&
      (
        item.source.pendingRevision !== null ||
        item.statusReason?.startsWith(
          `${CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON}:`,
        )
      )
    );
    return queryPage(
      pendingRoots,
      "itemId",
      options,
      WORK_LEDGER_STATUSES,
    );
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

  async readItemForReconciliation(input = {}) {
    this.#assertReady();
    if (!hasExactLedgerKeys(input, ["itemId"])) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作项恢复查询无效",
      );
    }
    let itemId;
    try {
      itemId = boundedLedgerString(input.itemId, "itemId", 192);
    } catch {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作项恢复查询无效",
      );
    }
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        const item = this.state.items.find(
          (candidate) => candidate.itemId === itemId,
        );
        return item ? cloneLedgerValue(item) : null;
      }),
    );
  }

  async verifyPullRequestExecutionBinding(input = {}) {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        return cloneLedgerValue(
          verifyPullRequestExecutionAuthority(this.state, input),
        );
      }),
    );
  }

  async getGraphSnapshot() {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        // Graph reads are also used to reconcile uncertain writes. Refresh
        // from durable state so an applied write with a lost ACK is visible in
        // the same recovery cycle rather than only after another mutation.
        this.state = await this.#readDurableState();
        return projectWorkLedgerGraphView(this.state);
      }),
    );
  }

  async readGraphMemoryProjectionBatch(options = {}) {
    this.#assertReady();
    return readWorkGraphMemoryProjectionBatch(
      this.state.graphMemoryProjection,
      options,
    );
  }

  async readMemoryAuthoritySnapshot({ limit = 100 } = {}) {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        return cloneLedgerValue({
          ledgerRevision: this.state.revision,
          items: this.state.items,
          timeline: this.state.timeline,
          graph: readWorkGraphMemoryProjectionBatch(
            this.state.graphMemoryProjection,
            { limit },
          ),
        });
      }),
    );
  }

  async readMemoryAuthorityStatus() {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        const graph = this.state.graphMemoryProjection;
        return cloneLedgerValue({
          ledgerRevision: this.state.revision,
          graph: {
            cursor: graph.cursor,
            highWatermark: graph.nextSequence - 1,
            checkpointDigest: graph.checkpointDigest,
            highWatermarkDigest:
              graph.pending.at(-1)?.eventDigest ?? graph.checkpointDigest,
            authorityStateDigest: graph.authorityStateDigest,
          },
        });
      }),
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
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
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
    }));
  }

  async reconcilePullRequestSource(input = {}) {
    return this.#executeCommand(planPullRequestSourceReconciliation, input);
  }

  async claim(input = {}) {
    return this.#admitNewWork(() =>
      this.#executeCommand(planWorkItemClaim, input, true),
    );
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
    const planner = hasExactLedgerKeys(input, ["authority", "command"])
      ? planScopedWorkGraphCancellation
      : planWorkGraphCancellation;
    return this.#executeCommand(planner, input);
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

  async reassignGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskReassignment, input);
  }

  async pauseGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskPause, input);
  }

  async resumeGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskResume, input);
  }

  async stageGraphEscalation(input = {}) {
    return this.#executeCommand(planWorkGraphEscalation, input);
  }

  async stageIntent(input = {}) {
    return this.#executeCommand(planIntentStage, input);
  }

  async claimIntent(input = {}) {
    return this.#executeCommand(planIntentClaim, input, true);
  }

  async bindIntent(input = {}) {
    return this.#executeCommand(planIntentBinding, input);
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
        timelineLimit: this.limits.timelineLimit,
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

  async #recordBatch(batch, now, deniedCutoverProofs = new Set()) {
    if (batch.items.length === 0) {
      return cloneLedgerValue({
        received: 0,
        deduplicated: 0,
        cursor: this.state.intakeCursor,
        highWatermark: this.state.sourceHighWatermark,
        gap: null,
        itemIds: [],
        alertItemId: null,
      });
    }
    const knownAssignments = new Map(
      this.state.items.map((item) => [
        item.assignmentId,
        {
          inputDigest: item.kind === "source_root"
            ? null
            : item.inputDigest,
          sourceSequence: item.sourceSequence,
        },
      ]),
    );
    for (const item of this.state.items) {
      if (item.source?.kind !== "pull_request") continue;
      for (const binding of item.source.bindings) {
        knownAssignments.set(binding.assignmentId, {
          inputDigest: binding.assignmentDigest,
          sourceSequence: binding.sourceSequence,
        });
      }
    }
    const initialItemIds = new Set(
      this.state.items.map(({ itemId }) => itemId),
    );
    const rootByWorkKey = new Map(
      this.state.items
        .filter(({ source }) => source?.kind === "pull_request")
        .map((item) => [item.source.workKey, item]),
    );
    const itemsById = new Map(
      this.state.items.map((item) => [item.itemId, item]),
    );
    const outboxById = new Map(
      this.state.outbox.map((entry) => [entry.intentId, entry]),
    );
    const touchedItemIds = new Set();
    const revisedItemIds = new Set();
    const timelineEvents = [];
    const cutoverTimelineIndex = createPullRequestCutoverTimelineIndex(
      this.state.timeline,
      this.limits.timelineLimit,
    );
    let indexedTimelineEventCount = 0;
    const currentCutoverTimelineIndex = () => {
      while (indexedTimelineEventCount < timelineEvents.length) {
        appendPullRequestCutoverTimelineEvent(
          cutoverTimelineIndex,
          timelineEvents[indexedTimelineEventCount],
        );
        indexedTimelineEventCount += 1;
      }
      return cutoverTimelineIndex;
    };
    const cutoverProofChecks = [];
    const applyCutoverProofPolicy = (activation, checkId) => {
      if (activation.proposalSettlements.length === 0) return activation;
      if (deniedCutoverProofs.has(checkId)) {
        const blockersByItemId = new Map(
          activation.blockers.map((blocker) => [blocker.itemId, blocker]),
        );
        for (const { participant } of activation.proposalSettlements) {
          blockersByItemId.set(participant.itemId, participant);
        }
        return {
          ...activation,
          blockers: [...blockersByItemId.values()],
          proposalSettlements: [],
        };
      }
      cutoverProofChecks.push({
        checkId,
        proofs: activation.proposalSettlements.map(({ proof }) => proof),
      });
      return activation;
    };
    let received = 0;
    let deduplicated = 0;
    for (const envelope of batch.items) {
      const assignmentItem = createAssignmentWorkItem(envelope, now);
      const existing = knownAssignments.get(assignmentItem.assignmentId);
      if (existing) {
        if (
          existing.inputDigest !== assignmentItem.inputDigest ||
          existing.sourceSequence !== assignmentItem.sourceSequence
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
      const trustedScopeLifecycle =
        isTrustedPullRequestScopeLifecycleAssignment(
          envelope.assignment,
          envelope.event,
        );
      const ordinaryRouteForLifecycle = batch.items.some(
        (candidate) =>
          candidate.event.eventId === envelope.event.eventId &&
          candidate.assignment.target?.type === "role" &&
          candidate.assignment.target?.id === "pr-engineer",
      );
      if (trustedScopeLifecycle) {
        let root = pullRequestRootForLifecycle(itemsById, envelope.event);
        if (root !== null) {
          const applied = applyPullRequestScopeLifecycle(root.source, envelope);
          const active = applied.source.scope.active;
          let cutover = inspectPullRequestSourceCutover(
            root,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          cutover = applyCutoverProofPolicy(
            cutover,
            `lifecycle:${envelope.assignment.assignmentId}:${root.itemId}`,
          );
          if (cutover.blockers.length === 0) {
            root = applyReadyPullRequestSourceCutover({
              root,
              activation: cutover,
              itemsById,
              outboxById,
              nextInputRevision: applied.source.activeRevision,
              nextHeadRevision: applied.source.headRevision,
              now,
              timelineEvents,
            });
          }
          const firstRevisionInBatch =
            initialItemIds.has(root.itemId) &&
            !revisedItemIds.has(root.itemId);
          const settlementPending = cutover.blockers.length > 0;
          root = {
            ...root,
            source: applied.source,
            inputDigest: applied.source.current.inputDigest,
            ...(firstRevisionInBatch
              ? { revision: root.revision + 1 }
              : {}),
            ...(settlementPending
              ? {
                  statusReason: active
                    ? "pr_source_reentered_scope_pending_settlement"
                    : "pr_source_left_scope_pending_settlement",
                }
              : {
                  status: active && ordinaryRouteForLifecycle
                    ? "queued"
                    : "blocked",
                  ownerId: null,
                  leaseId: null,
                  leaseUntil: null,
                  activeIntentId: null,
                  decisionContext: null,
                  availableAt: null,
                  statusReason: active
                    ? ordinaryRouteForLifecycle
                      ? "pr_source_reentered_scope"
                      : "pr_source_reentered_scope_without_route"
                    : "pr_source_left_scope",
                }),
            updatedAt: now,
          };
          if (firstRevisionInBatch) revisedItemIds.add(root.itemId);
          rootByWorkKey.set(root.source.workKey, root);
          itemsById.set(root.itemId, root);
          touchedItemIds.add(root.itemId);
          timelineEvents.push({
            itemId: root.itemId,
            type: "pr_source_revised",
            at: now,
            actorId: "work-ledger-system",
            details: {
              workKey: root.source.workKey,
              sourceSequence: envelope.sequence,
              inputRevision: root.source.inputRevision,
              activeRevision: root.source.activeRevision,
              pendingRevision: root.source.pendingRevision,
              headRevision: root.source.headRevision,
              headRefOid: root.source.current.headRefOid,
              disposition: applied.disposition,
              scopeActive: active,
              authorityEpoch: root.source.authorityEpoch,
            },
          });
        }
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      if (envelope.event.eventType === "pull_request.left_scope") {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      const rootCandidate = createPullRequestSourceRootWorkItem(envelope, now);
      if (rootCandidate === null) {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        itemsById.set(assignmentItem.itemId, assignmentItem);
        touchedItemIds.add(assignmentItem.itemId);
        received += 1;
        timelineEvents.push({
          itemId: assignmentItem.itemId,
          type: "assignment_intaken",
          at: now,
          actorId: "work-ledger-system",
          details: {
            assignmentId: assignmentItem.assignmentId,
            sourceSequence: assignmentItem.sourceSequence,
            inputDigest: assignmentItem.inputDigest,
            kind: assignmentItem.kind,
          },
        });
        continue;
      }

      let root = rootByWorkKey.get(rootCandidate.source.workKey);
      let disposition = "accepted";
      let headAdvanced = false;
      if (!root) {
        const pendingCrossRoot = [...itemsById.values()].find(
          (item) =>
            item.itemId !== rootCandidate.itemId &&
            samePullRequestSubject(item, rootCandidate) &&
            crossRootPullRequestCutoverPredecessorId(item) !== null,
        );
        const priorAuthority = pullRequestTrustedPredecessor(
          { items: [...itemsById.values()] },
          rootCandidate,
        );
        const predecessorItemId = pendingCrossRoot === undefined
          ? priorAuthority?.canonicalRootItemId ??
            priorAuthority?.lastTrustedRootItemId ?? null
          : crossRootPullRequestCutoverPredecessorId(pendingCrossRoot);
        const predecessor = predecessorItemId === null
          ? null
          : itemsById.get(predecessorItemId) ?? null;
        const candidateAuthority = pullRequestTrustedPredecessor(
          { items: [...itemsById.values(), rootCandidate] },
          rootCandidate,
        );
        const candidateIsAuthoritative =
          candidateAuthority?.canonicalRootItemId === rootCandidate.itemId;
        const candidateFencesAuthority =
          candidateAuthority?.canonicalRootItemId === null &&
          candidateAuthority.authorityFenced === true &&
          candidateAuthority.lastTrustedRootItemId === predecessor?.itemId;
        if (
          predecessor !== null &&
          samePullRequestSubject(predecessor, rootCandidate) &&
          (candidateIsAuthoritative || candidateFencesAuthority)
        ) {
          let activation = inspectPullRequestSourceCutover(
            predecessor,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          activation = applyCutoverProofPolicy(
            activation,
            `new-root:${envelope.assignment.assignmentId}:${predecessor.itemId}:${rootCandidate.itemId}`,
          );
          if (activation.blockers.length > 0) {
            rootCandidate.status = "blocked";
            rootCandidate.statusReason =
              crossRootPullRequestCutoverPendingReason(predecessor.itemId);
            for (const blocker of activation.blockers) {
              const marked = {
                ...blocker,
                revision:
                  initialItemIds.has(blocker.itemId) &&
                    !revisedItemIds.has(blocker.itemId)
                    ? blocker.revision + 1
                    : blocker.revision,
                statusReason: crossRootPullRequestCutoverBlockerReason(
                  rootCandidate.itemId,
                ),
                updatedAt: now,
              };
              if (initialItemIds.has(marked.itemId)) {
                revisedItemIds.add(marked.itemId);
              }
              itemsById.set(marked.itemId, marked);
              if (marked.source?.kind === "pull_request") {
                rootByWorkKey.set(marked.source.workKey, marked);
              }
            }
          } else if (candidateIsAuthoritative) {
            const locallySettled = applyReadyPullRequestSourceCutover({
              root: predecessor,
              activation: crossRootPullRequestCutoverActivation(
                predecessor,
                activation,
              ),
              itemsById,
              outboxById,
              nextInputRevision: rootCandidate.source.activeRevision,
              nextHeadRevision: rootCandidate.source.headRevision,
              now,
              timelineEvents,
            });
            const retired = retireCrossRootPullRequestPredecessor(
              locallySettled,
              now,
            );
            const settled = initialItemIds.has(predecessor.itemId)
              ? retired
              : {
                  ...retired,
                  status: "blocked",
                  revision: predecessor.revision,
                };
            if (
              initialItemIds.has(settled.itemId) &&
              settled.revision !== predecessor.revision
            ) {
              revisedItemIds.add(settled.itemId);
            }
            itemsById.set(settled.itemId, settled);
            rootByWorkKey.set(settled.source.workKey, settled);
          }
        } else if (
          predecessorItemId !== null &&
          (predecessor === null ||
            !samePullRequestSubject(predecessor, rootCandidate))
        ) {
          throw workLedgerError(
            "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
            "跨来源 PR cutover 前驱绑定无效",
            409,
          );
        }
        root = rootCandidate;
        rootByWorkKey.set(root.source.workKey, root);
        itemsById.set(root.itemId, root);
        timelineEvents.push({
          itemId: root.itemId,
          type: "pr_source_created",
          at: now,
          actorId: "work-ledger-system",
          details: {
            workKey: root.source.workKey,
            sourceSequence: envelope.sequence,
            inputRevision: 1,
            headRevision: 1,
            headRefOid: root.source.current.headRefOid,
          },
        });
      } else {
        const predecessor = pullRequestTrustedPredecessor(
          { items: [...itemsById.values()] },
          root,
        );
        const crossRootPredecessor = operationalPullRequestPredecessor(
          itemsById,
          root,
          predecessor,
        );
        let appended = appendPullRequestWorkSource(
          root.source,
          envelope,
          {
            activate: false,
            ...(predecessor === null
              ? {}
              : { causalHeadRefOid: predecessor.headRefOid }),
            authorityEpochChanged:
              predecessor?.canonicalRootItemId !== root.itemId,
            authorityFenceRecovery:
              predecessor?.authorityFenced === true &&
              predecessor.trustedSourceRootItemId === root.itemId,
          },
        );
        if (
          PR_SOURCE_AUTHORITY_FENCE_DISPOSITIONS.has(
            appended.disposition,
          ) &&
          crossRootPredecessor !== null
        ) {
          const currentPredecessor = itemsById.get(
            crossRootPredecessor.itemId,
          );
          let activation = inspectPullRequestSourceCutover(
            currentPredecessor,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          activation = applyCutoverProofPolicy(
            activation,
            `authority-fence:${envelope.assignment.assignmentId}:${currentPredecessor.itemId}:${root.itemId}`,
          );
          if (activation.blockers.length > 0) {
            root = {
              ...root,
              source: appended.source,
              status: "blocked",
              ownerId: null,
              leaseId: null,
              leaseUntil: null,
              activeIntentId: null,
              decisionContext: null,
              availableAt: null,
              statusReason: crossRootPullRequestCutoverPendingReason(
                currentPredecessor.itemId,
              ),
            };
            for (const blocker of activation.blockers) {
              const marked = {
                ...blocker,
                revision:
                  initialItemIds.has(blocker.itemId) &&
                    !revisedItemIds.has(blocker.itemId)
                    ? blocker.revision + 1
                    : blocker.revision,
                statusReason: crossRootPullRequestCutoverBlockerReason(
                  root.itemId,
                ),
                updatedAt: now,
              };
              if (initialItemIds.has(marked.itemId)) {
                revisedItemIds.add(marked.itemId);
              }
              itemsById.set(marked.itemId, marked);
              if (marked.source?.kind === "pull_request") {
                rootByWorkKey.set(marked.source.workKey, marked);
              }
            }
          }
        }
        if (appended.disposition === "accepted") {
          const obsoletePendingRoots = [...itemsById.values()].filter(
            (candidate) =>
              candidate.itemId !== root.itemId &&
              samePullRequestSubject(candidate, root) &&
              crossRootPullRequestCutoverPredecessorId(candidate) !== null &&
              crossRootPullRequestCutoverCandidate(candidate).sourceSequence <
                envelope.sequence,
          );
          for (const obsolete of obsoletePendingRoots) {
            const persisted = initialItemIds.has(obsolete.itemId);
            const replaced = {
              ...obsolete,
              status: persisted ? "superseded" : "blocked",
              revision:
                persisted && !revisedItemIds.has(obsolete.itemId)
                  ? obsolete.revision + 1
                  : obsolete.revision,
              ownerId: null,
              leaseId: null,
              leaseUntil: null,
              activeIntentId: null,
              availableAt: null,
              statusReason: "pr_source_cross_root_cutover_replaced",
              updatedAt: now,
            };
            if (persisted) revisedItemIds.add(replaced.itemId);
            itemsById.set(replaced.itemId, replaced);
            rootByWorkKey.set(replaced.source.workKey, replaced);
            for (const participant of itemsById.values()) {
              if (
                crossRootPullRequestCutoverPendingId(participant) !==
                  obsolete.itemId
              ) {
                continue;
              }
              const participantPersisted = initialItemIds.has(
                participant.itemId,
              );
              const cleared = {
                ...participant,
                revision:
                  participantPersisted &&
                    !revisedItemIds.has(participant.itemId)
                    ? participant.revision + 1
                    : participant.revision,
                statusReason: "pr_source_revised",
                updatedAt: now,
              };
              if (participantPersisted) revisedItemIds.add(cleared.itemId);
              itemsById.set(cleared.itemId, cleared);
              if (cleared.source?.kind === "pull_request") {
                rootByWorkKey.set(cleared.source.workKey, cleared);
              }
              if (cleared.itemId === root.itemId) root = cleared;
            }
          }
          const pendingRoot = { ...root, source: appended.source };
          if (crossRootPredecessor !== null) {
            const pendingRevision = appended.source.pendingRevision;
            const pendingHeadRevision = appended.source.revisions[
              pendingRevision - 1
            ].headRevision;
            const currentPredecessor = itemsById.get(
              crossRootPredecessor.itemId,
            );
            let activation = inspectPullRequestSourceCutover(
              currentPredecessor,
              [...itemsById.values()],
              outboxById,
              {
                forceHeadChanged: true,
                timelineIndex: currentCutoverTimelineIndex(),
              },
            );
            activation = applyCutoverProofPolicy(
              activation,
              `existing-root:${envelope.assignment.assignmentId}:${currentPredecessor.itemId}:${root.itemId}`,
            );
            if (activation.blockers.length > 0) {
              root = {
                ...pendingRoot,
                status: "blocked",
                ownerId: null,
                leaseId: null,
                leaseUntil: null,
                activeIntentId: null,
                decisionContext: null,
                availableAt: null,
                statusReason: crossRootPullRequestCutoverPendingReason(
                  currentPredecessor.itemId,
                ),
              };
              for (const blocker of activation.blockers) {
                const marked = {
                  ...blocker,
                  revision:
                    initialItemIds.has(blocker.itemId) &&
                      !revisedItemIds.has(blocker.itemId)
                      ? blocker.revision + 1
                      : blocker.revision,
                  statusReason: crossRootPullRequestCutoverBlockerReason(
                    root.itemId,
                  ),
                  updatedAt: now,
                };
                if (initialItemIds.has(marked.itemId)) {
                  revisedItemIds.add(marked.itemId);
                }
                itemsById.set(marked.itemId, marked);
                if (marked.source?.kind === "pull_request") {
                  rootByWorkKey.set(marked.source.workKey, marked);
                }
              }
            } else {
              const locallySettled = applyReadyPullRequestSourceCutover({
                root: currentPredecessor,
                activation: crossRootPullRequestCutoverActivation(
                  currentPredecessor,
                  activation,
                ),
                itemsById,
                outboxById,
                nextInputRevision: pendingRevision,
                nextHeadRevision: pendingHeadRevision,
                now,
                timelineEvents,
              });
              const retired = retireCrossRootPullRequestPredecessor(
                locallySettled,
                now,
              );
              const settled = initialItemIds.has(currentPredecessor.itemId)
                ? retired
                : {
                    ...retired,
                    status: "blocked",
                    revision: currentPredecessor.revision,
                  };
              if (
                initialItemIds.has(settled.itemId) &&
                settled.revision !== currentPredecessor.revision
              ) {
                revisedItemIds.add(settled.itemId);
              }
              itemsById.set(settled.itemId, settled);
              rootByWorkKey.set(settled.source.workKey, settled);
              const activated = activatePendingPullRequestWorkSource(
                appended.source,
              );
              appended = {
                ...appended,
                source: activated.source,
                activeAdvanced: true,
              };
            }
          } else {
            let activation = inspectPullRequestSourceCutover(
              pendingRoot,
              [...itemsById.values()],
              outboxById,
              { timelineIndex: currentCutoverTimelineIndex() },
            );
            activation = applyCutoverProofPolicy(
              activation,
              `same-root:${envelope.assignment.assignmentId}:${pendingRoot.itemId}`,
            );
            if (activation.blockers.length === 0) {
              const pendingRevision = appended.source.pendingRevision;
              const pendingHeadRevision = appended.source.revisions[
                pendingRevision - 1
              ].headRevision;
              root = applyReadyPullRequestSourceCutover({
                root,
                activation,
                itemsById,
                outboxById,
                nextInputRevision: pendingRevision,
                nextHeadRevision: pendingHeadRevision,
                now,
                timelineEvents,
              });
              const activated = activatePendingPullRequestWorkSource(
                appended.source,
              );
              appended = {
                ...appended,
                source: activated.source,
                activeAdvanced: true,
              };
            }
          }
        }
        disposition = appended.disposition;
        headAdvanced = appended.headAdvanced === true;
        const restoresLifecycleRoute =
          appended.disposition === "bound_existing_event" &&
          envelope.event.eventType === "pull_request.created" &&
          root.source.scope.active === true &&
          root.statusReason === "pr_source_reentered_scope_without_route";
        const firstRevisionInBatch =
          initialItemIds.has(root.itemId) && !revisedItemIds.has(root.itemId);
        root = {
          ...root,
          source: appended.source,
          inputDigest: appended.source.current.inputDigest,
          ...(firstRevisionInBatch
            ? { revision: root.revision + 1 }
            : {}),
          ...((appended.activeAdvanced && canRequeueAdvancedPullRequestRoot(root)) ||
            restoresLifecycleRoute
            ? {
                status: "queued",
                ownerId: null,
                leaseId: null,
                leaseUntil: null,
                availableAt: null,
                statusReason: restoresLifecycleRoute
                  ? "pr_source_reentered_scope"
                  : "pr_source_revised",
              }
            : {}),
          updatedAt: now,
        };
        revisedItemIds.add(root.itemId);
        rootByWorkKey.set(root.source.workKey, root);
        itemsById.set(root.itemId, root);
        const currentHeadRevision = root.source.revisions[
          root.source.activeRevision - 1
        ].headRevision;
        const pendingHeadRevision = root.source.pendingRevision === null
          ? null
          : root.source.revisions[root.source.pendingRevision - 1].headRevision;
        timelineEvents.push({
          itemId: root.itemId,
          type: disposition.startsWith("ignored_")
            ? "pr_source_ignored"
            : "pr_source_revised",
          at: now,
          actorId: "work-ledger-system",
          details: {
            workKey: root.source.workKey,
            sourceSequence: envelope.sequence,
            inputRevision: root.source.inputRevision,
            activeRevision: root.source.activeRevision,
            pendingRevision: root.source.pendingRevision,
            headRevision: currentHeadRevision,
            headRefOid: root.source.current.headRefOid,
            currentHeadRevision,
            currentHeadRefOid: root.source.current.headRefOid,
            pendingHeadRevision,
            pendingHeadRefOid: root.source.pending?.headRefOid ?? null,
            observedHeadRevision: root.source.headRevision,
            observedHeadRefOid: (root.source.pending ?? root.source.current)
              .headRefOid,
            disposition,
            headAdvanced,
          },
        });
      }
      knownAssignments.set(assignmentItem.assignmentId, {
        inputDigest: assignmentItem.inputDigest,
        sourceSequence: assignmentItem.sourceSequence,
      });
      touchedItemIds.add(root.itemId);
      received += 1;
    }
    timelineEvents.push({
      itemId: null,
      type: "intake_completed",
      at: now,
      actorId: "work-ledger-system",
      details: {
        afterSequence: this.state.intakeCursor,
        nextSequence: batch.nextSequence,
        highWatermark: batch.highWatermark,
        received,
        deduplicated,
      },
    });
    const invalidCutoverProofs = cutoverProofChecks.filter(
      ({ proofs }) => !arePullRequestCutoverProofsRetained({
        timeline: this.state.timeline,
        timelineLimit: this.limits.timelineLimit,
        appendedEventCount: timelineEvents.length,
        proofs,
      }),
    );
    if (invalidCutoverProofs.length > 0) {
      const nextDeniedCutoverProofs = new Set(deniedCutoverProofs);
      for (const { checkId } of invalidCutoverProofs) {
        nextDeniedCutoverProofs.add(checkId);
      }
      if (nextDeniedCutoverProofs.size === deniedCutoverProofs.size) {
        throw workLedgerError(
          "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
          "PR cutover 证明无法在提交窗口内保持有效",
          409,
        );
      }
      return this.#recordBatch(batch, now, nextDeniedCutoverProofs);
    }
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        intakeCursor: batch.nextSequence,
        sourceHighWatermark: batch.highWatermark,
        items: [...itemsById.values()],
        outbox: [...outboxById.values()],
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue({
      received,
      deduplicated,
      cursor: this.state.intakeCursor,
      highWatermark: this.state.sourceHighWatermark,
      gap: null,
      itemIds: [...touchedItemIds],
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
      validatePullRequestSourceTransition(this.state.items, normalized.items);
    } catch (error) {
      throw workLedgerError(
        "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
        "PR 来源历史与台账修订不一致",
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

  async #admitNewWork(operation) {
    const admitted = await this.runNewWorkAdmission(() => ({
      // The service queue is the admission boundary. Carry its Promise out so
      // cutover never waits on the assignment source or durable store.
      operation: operation(),
    }));
    return admitted.operation;
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
