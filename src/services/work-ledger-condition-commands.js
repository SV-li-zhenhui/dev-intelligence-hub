import {
  assertWorkItemNotInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import {
  assertItemRevision,
  moveWorkItem,
  normalizeWorkActor,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";

function invalid(message = "条件观察结果无效") {
  return workLedgerError("WORK_LEDGER_CONDITION_OBSERVATION_INVALID", message);
}

function observationTimestamp(value) {
  try {
    return normalizeLedgerTimestamp(value, "observation.observedAt");
  } catch {
    throw invalid("条件观察时间无效");
  }
}

function normalizeObservation(value, condition, now) {
  if (condition.kind === "time") {
    if (!hasExactLedgerKeys(value, ["kind", "observedAt"]) || value.kind !== "time") {
      throw invalid();
    }
    const observedAt = observationTimestamp(value.observedAt);
    if (
      Date.parse(observedAt) < Date.parse(condition.notBefore) ||
      Date.parse(observedAt) > Date.parse(now)
    ) {
      throw invalid("时间条件尚未满足");
    }
    return {
      observedAt,
      value: { kind: "time", notBefore: condition.notBefore },
    };
  }
  if (
    !hasExactLedgerKeys(value, ["kind", "fact", "value", "observedAt"]) ||
    value.kind !== "workflow_fact" ||
    value.fact !== condition.fact ||
    typeof value.value !== "string" ||
    !condition.oneOf.includes(value.value)
  ) {
    throw invalid("工作流事实没有满足等待条件");
  }
  const observedAt = observationTimestamp(value.observedAt);
  if (Date.parse(observedAt) > Date.parse(now)) {
    throw invalid("工作流事实观察时间晚于台账时钟");
  }
  return {
    observedAt,
    value: {
      kind: "workflow_fact",
      fact: condition.fact,
      value: value.value,
    },
  };
}

function requireBoundCondition(state, item, intentId) {
  const outbox = state.outbox.find((entry) => entry.intentId === intentId);
  if (
    !outbox ||
    outbox.itemId !== item.itemId ||
    outbox.inputDigest !== item.inputDigest ||
    outbox.status !== "delivered" ||
    outbox.intent.type !== "wait_condition"
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CONDITION_BINDING_CONFLICT",
      "等待条件没有绑定已交付的 wait_condition 意图",
      409,
    );
  }
  return outbox;
}

export function planConditionWake({ state, input, clock }) {
  if (
    !hasExactLedgerKeys(input, [
      "itemId",
      "expectedRevision",
      "intentId",
      "actorId",
      "observation",
    ])
  ) {
    throw invalid("条件唤醒命令字段无效");
  }
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const intentId = boundedLedgerString(input.intentId, "intentId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  const outbox = requireBoundCondition(state, item, intentId);
  const now = clock();
  const observation = normalizeObservation(
    input.observation,
    outbox.intent.condition,
    now,
  );
  const decisionContext = createWorkDecisionContext({
    source: "condition",
    referenceId: intentId,
    outcome: "satisfied",
    value: observation.value,
    observedAt: observation.observedAt,
  });
  if (
    item.status === "queued" &&
    item.activeIntentId === null &&
    item.decisionContext?.contentDigest === decisionContext.contentDigest
  ) {
    return { write: false, result: item };
  }
  assertItemRevision(item, input.expectedRevision);
  if (item.status !== "waiting_condition" || item.activeIntentId !== intentId) {
    throw workLedgerError(
      "WORK_LEDGER_CONDITION_BINDING_CONFLICT",
      "工作项不再等待该条件",
      409,
    );
  }
  const itemResult = moveWorkItem(item, {
    status: "queued",
    now,
    reason: "condition_satisfied",
    decisionContext,
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "condition_satisfied",
        at: now,
        actorId,
        details: {
          conditionRef: intentId,
          resultRef: decisionContext.contentDigest,
          outcome: "satisfied",
        },
      },
    ],
    result: itemResult,
  };
}
