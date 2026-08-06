import { normalizeWorkProposalResult } from "../domain/work-proposal-contract.js";
import { normalizeDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import {
  isWorkItemInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  createWorkDecisionContext,
} from "./work-ledger-state.js";
import {
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "./work-ledger-pr-source.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import {
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const MAX_PROPOSAL_BATCH = 100;
const PROPOSAL_INTENT_TYPES = new Map([
  ["github_review_proposal", "propose_github_review"],
  ["code_action_proposal", "propose_code_action"],
]);

function invalid(message = "工作提案结果批次无效") {
  return workLedgerError("WORK_LEDGER_PROPOSAL_BATCH_INVALID", message, 502);
}

function dataArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_PROPOSAL_BATCH ||
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

function normalizeResult(value) {
  try {
    return normalizeWorkProposalResult(value);
  } catch {
    throw invalid("工作提案结果无效");
  }
}

function normalizeBatch(input, state) {
  if (
    !hasExactLedgerKeys(input, [
      "items",
      "nextSequence",
      "highWatermark",
      "oldestAvailableSequence",
    ])
  ) {
    throw invalid();
  }
  const items = dataArray(input.items).map(normalizeResult);
  const nextSequence = input.nextSequence;
  const highWatermark = input.highWatermark;
  const oldest = input.oldestAvailableSequence;
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
    (items.length === 0 && nextSequence !== state.proposalCursor)
  ) {
    throw invalid("工作提案结果游标契约无效");
  }
  if (highWatermark < state.proposalHighWatermark) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_SOURCE_ROLLBACK",
      "工作提案结果源高水位发生回退",
      409,
    );
  }
  if (
    highWatermark > state.proposalCursor &&
    (oldest === null || oldest > state.proposalCursor + 1)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_GAP",
      "工作提案结果流存在无法安全跨越的缺口",
      409,
    );
  }
  const pending = items.filter(
    ({ sequence }) => sequence > state.proposalCursor,
  );
  if (
    pending.length > 0 &&
    pending[0].sequence !== state.proposalCursor + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_GAP",
      "工作提案结果序号不连续",
      409,
    );
  }
  return { items, pending, nextSequence, highWatermark };
}

function requireBoundProposal(state, result) {
  const item = requireWorkLedgerItem(state, result.requestedBy.workItemId);
  const matchingDownstreams = state.outbox.filter(
    (candidate) =>
      candidate.status === "delivered" &&
      candidate.outcome?.status === "delivered" &&
      candidate.outcome.details?.downstreamRef === result.proposalId,
  );
  const durablyQuarantined =
    item.sourceQuarantine?.kind === LEGACY_PR_SOURCE_QUARANTINE_KIND;
  const quarantinedSettlement =
    durablyQuarantined &&
    item.status === "blocked" &&
    item.activeIntentId === null;
  const outbox = state.outbox.find(
    (candidate) => candidate.intentId === item.activeIntentId,
  ) ?? (quarantinedSettlement && matchingDownstreams.length === 1
    ? matchingDownstreams[0]
    : null);
  const waitingForResult =
    item.status === "waiting_external" &&
    item.activeIntentId === outbox?.intentId;
  const expectedIntentType = PROPOSAL_INTENT_TYPES.get(result.kind);
  if (
    !outbox ||
    matchingDownstreams.length !== 1 ||
    matchingDownstreams[0].intentId !== outbox.intentId ||
    !expectedIntentType ||
    outbox.itemId !== item.itemId ||
    outbox.inputDigest !== item.inputDigest ||
    outbox.status !== "delivered" ||
    outbox.intent.type !== expectedIntentType ||
    outbox.requestedBy.roleId !== result.requestedBy.roleId ||
    (!waitingForResult && !quarantinedSettlement) ||
    outbox.outcome?.status !== "delivered" ||
    outbox.outcome.details?.downstreamRef !== result.proposalId ||
    outbox.outcome.details?.proposalDigest !== result.proposalContentDigest
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
      "工作提案结果没有绑定当前等待中的受信意图",
      409,
    );
  }
  let evidenceTarget = null;
  const rawTarget = outbox.dispatchBinding?.boundIntent?.binding?.evidenceTarget;
  if (rawTarget !== undefined) {
    try {
      evidenceTarget = normalizeDeliveryEvidenceTarget(rawTarget);
    } catch (cause) {
      throw workLedgerError(
        "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        "工作提案证据目标绑定无效",
        409,
        { cause },
      );
    }
    if (
      evidenceTarget.taskId !== item.itemId ||
      evidenceTarget.roleId !== result.requestedBy.roleId
    ) {
      throw workLedgerError(
        "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        "工作提案证据目标不属于当前任务",
        409,
      );
    }
  }
  return {
    item,
    outbox,
    evidenceTarget,
    discardUnsealedLegacyResult:
      durablyQuarantined &&
      (outbox.dispatchBinding === null ||
        !Object.hasOwn(outbox.dispatchBinding, "boundIntent")),
  };
}

export function planProposalBatchApplication({ state, input, clock }) {
  const batch = normalizeBatch(input, state);
  if (batch.nextSequence <= state.proposalCursor) {
    return {
      write: false,
      result: {
        applied: 0,
        deduplicated: batch.items.length,
        cursor: state.proposalCursor,
        highWatermark: state.proposalHighWatermark,
        itemIds: [],
      },
    };
  }

  const now = clock();
  let items = state.items;
  const timelineEvents = [];
  const appliedItemIds = [];
  for (const result of batch.pending) {
    const workingState = { ...state, items };
    const {
      item,
      outbox,
      evidenceTarget,
      discardUnsealedLegacyResult,
    } = requireBoundProposal(workingState, result);
    if (Date.parse(result.at) > Date.parse(now)) {
      throw invalid("工作提案结果时间晚于台账时钟");
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
        actorId: "work-proposal-result-reconciler",
        details: {
          source: "proposal",
          intentId: outbox.intentId,
          resultRef: result.resultId,
          reason: "unsealed_pr_source_quarantine",
        },
      });
      continue;
    }
    const succeeded = result.outcome === "succeeded";
    const decisionContext = createWorkDecisionContext({
      source: "proposal",
      referenceId: result.proposalId,
      outcome: result.outcome,
      value: {
        kind: result.kind,
        resultId: result.resultId,
        resultDigest: result.contentDigest,
        summary: result.summary,
        downstreamRef: result.downstreamRef,
      },
      observedAt: result.at,
    });
    const continueForEvidence = succeeded && evidenceTarget !== null;
    let nextStatus = "blocked";
    if (succeeded) {
      nextStatus = continueForEvidence ? "queued" : "completed";
    }
    const sealedByLegacyCutover = isWorkItemInLegacyPullRequestCutover(item);
    const itemResult = moveWorkItem(item, {
      status: sealedByLegacyCutover ? "blocked" : nextStatus,
      now,
      reason: sealedByLegacyCutover
        ? LEGACY_PR_SOURCE_CUTOVER_REASON
        : continueForEvidence
          ? "proposal_evidence_ready"
          : `proposal_${result.outcome}`,
      activeIntentId: null,
      decisionContext,
    });
    items = replaceWorkLedgerRecord(items, "itemId", itemResult);
    appliedItemIds.push(item.itemId);
    timelineEvents.push({
      itemId: item.itemId,
      type: "proposal_result_applied",
      at: now,
      actorId: "work-proposal-result-reconciler",
      details: {
        proposalId: result.proposalId,
        resultRef: result.resultId,
        outcome: result.outcome,
        downstreamRef: result.downstreamRef,
        evidenceRefs: result.evidence,
      },
    });
  }
  return {
    patch: {
      items,
      proposalCursor: batch.nextSequence,
      proposalHighWatermark: batch.highWatermark,
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
