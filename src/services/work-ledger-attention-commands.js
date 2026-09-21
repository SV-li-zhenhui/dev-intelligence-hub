import {
  attentionDigest,
  normalizeAttentionAnswer,
} from "../domain/attention-contract.js";
import {
  isWorkItemInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  currentWorkItemExecutionBinding,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "./work-ledger-pr-source.js";
import {
  createAttentionResultAttestation,
} from "./work-ledger-result-attestation.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import { isSettledIssueReason } from "./work-ledger-issue-lifecycle.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";

const MAX_ATTENTION_BATCH = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^attention-[a-f0-9]{64}$/;
const RESULT_ID = /^attention-result-[a-f0-9]{64}$/;
const OUTBOX_ID = /^attention-outbox-[a-f0-9]{64}$/;

function invalid(message = "内部请示结果批次无效") {
  return workLedgerError("WORK_LEDGER_ATTENTION_BATCH_INVALID", message, 502);
}

function exactDataMap(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid();
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid();
    }
    result.set(key, descriptor.value);
  }
  if (
    result.size !== keys.length ||
    keys.some((key) => !result.has(key))
  ) {
    throw invalid();
  }
  return result;
}

function dataArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ATTENTION_BATCH ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function positiveSequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function normalizeResult(value) {
  const fields = exactDataMap(value, [
    "resultId",
    "contentDigest",
    "requestId",
    "requestContentDigest",
    "producerBindingDigest",
    "kind",
    "answer",
    "requestRevision",
    "revision",
    "at",
  ]);
  let answer;
  try {
    answer = normalizeAttentionAnswer(fields.get("answer"));
  } catch {
    throw invalid("内部请示答案无效");
  }
  const kind = fields.get("kind");
  if (
    !new Set(["answered", "rejected"]).has(kind) ||
    (kind === "rejected") !== (answer.type === "reject") ||
    answer.type === "later"
  ) {
    throw invalid("内部请示结果类型无效");
  }
  const core = {
    requestId: boundedLedgerString(fields.get("requestId"), "requestId", 74),
    requestContentDigest: digest(
      fields.get("requestContentDigest"),
      "requestContentDigest",
    ),
    producerBindingDigest: digest(
      fields.get("producerBindingDigest"),
      "producerBindingDigest",
    ),
    kind,
    answer,
    requestRevision: positiveSequence(
      fields.get("requestRevision"),
      "requestRevision",
    ),
    revision: positiveSequence(fields.get("revision"), "result.revision"),
    at: timestamp(fields.get("at"), "result.at"),
  };
  const contentDigest = attentionDigest(core);
  if (
    !REQUEST_ID.test(core.requestId) ||
    core.requestId !== `attention-${core.requestContentDigest}` ||
    fields.get("contentDigest") !== contentDigest ||
    fields.get("resultId") !== `attention-result-${contentDigest}` ||
    !RESULT_ID.test(fields.get("resultId")) ||
    core.requestRevision >= core.revision
  ) {
    throw invalid("内部请示结果摘要或版本无效");
  }
  return {
    resultId: fields.get("resultId"),
    contentDigest,
    ...core,
  };
}

function normalizeEntry(value) {
  const fields = exactDataMap(value, [
    "outboxId",
    "contentDigest",
    "sequence",
    "requestId",
    "requestContentDigest",
    "producer",
    "producerBindingDigest",
    "requestKey",
    "result",
  ]);
  const producerFields = exactDataMap(fields.get("producer"), [
    "roleId",
    "workItemId",
  ]);
  const producer = {
    roleId: boundedLedgerString(producerFields.get("roleId"), "roleId", 128),
    workItemId: boundedLedgerString(
      producerFields.get("workItemId"),
      "workItemId",
      256,
    ),
  };
  const result = normalizeResult(fields.get("result"));
  const core = {
    sequence: positiveSequence(fields.get("sequence"), "sequence"),
    requestId: boundedLedgerString(fields.get("requestId"), "requestId", 74),
    requestContentDigest: digest(
      fields.get("requestContentDigest"),
      "requestContentDigest",
    ),
    producer,
    producerBindingDigest: digest(
      fields.get("producerBindingDigest"),
      "producerBindingDigest",
    ),
    requestKey: boundedLedgerString(fields.get("requestKey"), "requestKey", 128),
    result,
  };
  const producerBindingDigest = attentionDigest({
    requestKey: core.requestKey,
    producer,
  });
  const contentDigest = attentionDigest(core);
  if (
    !REQUEST_ID.test(core.requestId) ||
    core.requestId !== `attention-${core.requestContentDigest}` ||
    core.requestId !== result.requestId ||
    core.requestContentDigest !== result.requestContentDigest ||
    core.producerBindingDigest !== producerBindingDigest ||
    core.producerBindingDigest !== result.producerBindingDigest ||
    fields.get("contentDigest") !== contentDigest ||
    fields.get("outboxId") !== `attention-outbox-${contentDigest}` ||
    !OUTBOX_ID.test(fields.get("outboxId"))
  ) {
    throw invalid("内部请示 outbox 摘要绑定无效");
  }
  return { outboxId: fields.get("outboxId"), contentDigest, ...core };
}

function normalizeBatch(input, state) {
  let fields;
  let items;
  try {
    fields = exactDataMap(input, [
      "items",
      "nextSequence",
      "highWatermark",
      "oldestAvailableSequence",
    ]);
    items = dataArray(fields.get("items")).map(normalizeEntry);
  } catch (error) {
    if (error?.code === "WORK_LEDGER_ATTENTION_BATCH_INVALID") throw error;
    throw invalid();
  }
  const nextSequence = fields.get("nextSequence");
  const highWatermark = fields.get("highWatermark");
  const oldest = fields.get("oldestAvailableSequence");
  if (
    !Number.isSafeInteger(nextSequence) ||
    nextSequence < 0 ||
    !Number.isSafeInteger(highWatermark) ||
    highWatermark < 0 ||
    nextSequence > highWatermark ||
    !(oldest === null || (Number.isSafeInteger(oldest) && oldest >= 1)) ||
    items.some(
      (item, index) =>
        item.sequence > highWatermark ||
        (index > 0 && item.sequence !== items[index - 1].sequence + 1),
    ) ||
    (items.length > 0 && items.at(-1).sequence !== nextSequence) ||
    (items.length === 0 && nextSequence !== state.attentionCursor)
  ) {
    throw invalid("内部请示 outbox 游标契约无效");
  }
  if (highWatermark < state.attentionHighWatermark) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_SOURCE_ROLLBACK",
      "内部请示结果源高水位发生回退",
      409,
    );
  }
  if (
    highWatermark > state.attentionCursor &&
    (oldest === null || oldest > state.attentionCursor + 1)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_GAP",
      "内部请示结果流存在无法安全跨越的缺口",
      409,
    );
  }
  const pending = items.filter(({ sequence }) => sequence > state.attentionCursor);
  if (
    pending.length > 0 &&
    pending[0].sequence !== state.attentionCursor + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_GAP",
      "内部请示结果序号不连续",
      409,
    );
  }
  return { items, pending, nextSequence, highWatermark, oldest };
}

function requireBoundAskUser(state, entry) {
  const item = requireWorkLedgerItem(state, entry.producer.workItemId);
  const outbox = state.outbox.find(
    (candidate) => candidate.intentId === entry.requestKey,
  );
  const outcome = outbox?.outcome;
  const waitingForResult =
    item.status === "waiting_user" && item.activeIntentId === outbox?.intentId;
  const durablyQuarantined =
    item.sourceQuarantine?.kind === LEGACY_PR_SOURCE_QUARANTINE_KIND;
  const quarantinedSettlement =
    durablyQuarantined &&
    item.status === "blocked" &&
    item.activeIntentId === null;
  const closedIssueSettlement =
    item.status === "cancelled" &&
    item.activeIntentId === null &&
    isSettledIssueReason(item.statusReason);
  const sealedQuarantinedSettlement =
    !durablyQuarantined ||
    (outbox?.dispatchBinding !== null &&
      outbox?.dispatchBinding !== undefined &&
      Object.hasOwn(outbox.dispatchBinding, "boundIntent"));
  if (
    !outbox ||
    outbox.itemId !== item.itemId ||
    outbox.inputDigest !== item.inputDigest ||
    outbox.status !== "delivered" ||
    outbox.intent.type !== "ask_user" ||
    outbox.requestedBy.roleId !== entry.producer.roleId ||
    (!waitingForResult && !quarantinedSettlement && !closedIssueSettlement) ||
    outcome?.status !== "delivered" ||
    outcome.details?.questionRef !== entry.requestId
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_BINDING_CONFLICT",
      "内部请示结果没有绑定当前等待中的 ask_user 意图",
      409,
    );
  }
  return {
    item,
    outbox,
    discardClosedIssueResult: closedIssueSettlement,
    discardUnsealedLegacyResult:
      durablyQuarantined && !sealedQuarantinedSettlement,
  };
}

export function planAttentionBatchApplication({ state, input, clock }) {
  const batch = normalizeBatch(input, state);
  if (batch.nextSequence <= state.attentionCursor) {
    return {
      write: false,
      result: {
        applied: 0,
        deduplicated: batch.items.length,
        cursor: state.attentionCursor,
        highWatermark: state.attentionHighWatermark,
        itemIds: [],
      },
    };
  }
  const now = clock();
  let items = state.items;
  let outboxEntries = state.outbox;
  const timelineEvents = [];
  const appliedItemIds = [];
  for (const entry of batch.pending) {
    const workingState = { ...state, items, outbox: outboxEntries };
    const {
      item,
      outbox,
      discardClosedIssueResult,
      discardUnsealedLegacyResult,
    } =
      requireBoundAskUser(workingState, entry);
    if (Date.parse(entry.result.at) > Date.parse(now)) {
      throw invalid("内部请示结果时间晚于台账时钟");
    }
    if (discardUnsealedLegacyResult) {
      const itemResult = moveWorkItem(item, {
        status: "blocked",
        now,
        reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
        activeIntentId: null,
      });
      items = replaceWorkLedgerRecord(items, "itemId", itemResult);
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "legacy_result_discarded",
        at: now,
        actorId: "attention-result-reconciler",
        details: {
          source: "attention",
          intentId: outbox.intentId,
          resultRef: entry.result.resultId,
          reason: "unsealed_pr_source_quarantine",
        },
      });
      continue;
    }
    if (discardClosedIssueResult) {
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "stale_result_discarded",
        at: now,
        actorId: "attention-result-reconciler",
        details: {
          source: "attention",
          intentId: outbox.intentId,
          resultRef: entry.result.resultId,
          reason: item.statusReason,
        },
      });
      continue;
    }
    const decisionContext = createWorkDecisionContext({
      source: "attention",
      referenceId: entry.requestId,
      outcome: entry.result.kind,
      value: {
        answer: entry.result.answer,
        requestContentDigest: entry.requestContentDigest,
        resultId: entry.result.resultId,
        resultDigest: entry.result.contentDigest,
      },
      observedAt: entry.result.at,
    });
    const resultAttestation = createAttentionResultAttestation({
      entry,
      intentId: outbox.intentId,
      decisionContentDigest: decisionContext.contentDigest,
    });
    const outboxResult = {
      ...outbox,
      revision: outbox.revision + 1,
      outcome: {
        ...outbox.outcome,
        details: {
          ...outbox.outcome.details,
          resultAttestation,
        },
      },
      updatedAt: now,
    };
    outboxEntries = replaceWorkLedgerRecord(
      outboxEntries,
      "intentId",
      outboxResult,
    );
    const rejected = entry.result.kind === "rejected";
    const sealedByLegacyCutover = isWorkItemInLegacyPullRequestCutover(item);
    const itemResult = moveWorkItem(item, {
      status: sealedByLegacyCutover
        ? "blocked"
        : rejected
          ? "blocked"
          : "queued",
      now,
      reason: sealedByLegacyCutover
        ? LEGACY_PR_SOURCE_CUTOVER_REASON
        : rejected
          ? "attention_rejected"
          : "attention_answered",
      activeIntentId: null,
      decisionContext,
    });
    items = replaceWorkLedgerRecord(items, "itemId", itemResult);
    appliedItemIds.push(item.itemId);
    timelineEvents.push({
      itemId: item.itemId,
      type: rejected
        ? "attention_rejection_applied"
        : "attention_answer_applied",
      at: now,
      actorId: "attention-result-reconciler",
      details: {
        inputBinding: currentWorkItemExecutionBinding(item),
        workItemRevision: itemResult.revision,
        inputDigest: item.inputDigest,
        intentId: entry.requestKey,
        resultAttestationDigest: resultAttestation.attestationDigest,
        questionRef: entry.requestId,
        resultRef: entry.result.resultId,
        outcome: entry.result.kind,
        answer: entry.result.answer,
        requestContentDigest: entry.requestContentDigest,
        resultDigest: entry.result.contentDigest,
      },
    });
  }
  return {
    patch: {
      items,
      outbox: outboxEntries,
      attentionCursor: batch.nextSequence,
      attentionHighWatermark: batch.highWatermark,
    },
    timelineEvents,
    result: {
      applied: batch.pending.length,
      deduplicated: batch.items.length - batch.pending.length,
      cursor: batch.nextSequence,
      highWatermark: batch.highWatermark,
      itemIds: appliedItemIds,
    },
  };
}
