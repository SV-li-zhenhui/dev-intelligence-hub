import {
  boundedLedgerString,
  canonicalLedgerValue,
  normalizeLedgerTarget,
  normalizeLedgerTimestamp,
  normalizeOptionalLedgerReason,
  workLedgerError,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";

const GENERAL_TRANSITIONS = new Map([
  ["queued", new Set(["blocked"])],
  [
    "working",
    new Set([
      "waiting_user",
      "waiting_condition",
      "waiting_external",
      "blocked",
    ]),
  ],
  ["waiting_user", new Set(["queued", "blocked"])],
  ["waiting_condition", new Set(["queued", "blocked"])],
  ["waiting_external", new Set(["queued", "blocked"])],
  ["retry_wait", new Set(["queued", "blocked"])],
  ["blocked", new Set(["queued"])],
]);

const RETRY_FROM = new Set([
  "working",
  "dispatch_pending",
  "waiting_condition",
  "waiting_external",
]);
const COMPLETE_FROM = new Set([
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
]);

export function normalizeWorkActor(value) {
  return boundedLedgerString(value, "actorId", 128);
}

export function normalizeWorkReason(value) {
  return normalizeOptionalLedgerReason(value, "reason");
}

export function normalizeWorkDetails(value = {}) {
  const normalized = canonicalLedgerValue(value, {
    maximumEntries: 5_000,
    maximumStringBytes: 16 * 1024,
    errorCode: "WORK_LEDGER_DETAILS_INVALID",
  });
  const allowed = new Set([
    "code",
    "conditionRef",
    "downstreamRef",
    "evidenceRefs",
    "note",
    "outcome",
    "proposalDigest",
    "questionRef",
    "resultRef",
  ]);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized) ||
    Object.keys(normalized).some((key) => !allowed.has(key))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_DETAILS_INVALID",
      "工作状态详情包含未授权字段",
    );
  }
  for (const [key, entry] of Object.entries(normalized)) {
    if (key === "evidenceRefs") {
      if (
        !Array.isArray(entry) ||
        entry.length > 20 ||
        entry.some(
          (reference) =>
            typeof reference !== "string" ||
            !reference.trim() ||
            Buffer.byteLength(reference, "utf8") > 512,
        )
      ) {
        throw workLedgerError(
          "WORK_LEDGER_DETAILS_INVALID",
          "evidenceRefs 无效",
        );
      }
      continue;
    }
    if (
      typeof entry !== "string" ||
      !entry.trim() ||
      Buffer.byteLength(entry, "utf8") > 2_048
    ) {
      throw workLedgerError(
        "WORK_LEDGER_DETAILS_INVALID",
        `${key} 无效`,
      );
    }
  }
  return normalized;
}

export function assertItemRevision(item, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw workLedgerError(
      "WORK_LEDGER_REVISION_INVALID",
      "工作项 revision 无效",
    );
  }
  if (item.revision !== expectedRevision) {
    throw workLedgerError(
      "WORK_LEDGER_REVISION_CONFLICT",
      "工作项已被其他员工更新",
      409,
    );
  }
}

export function assertWorkLease(item, leaseId, now) {
  if (item.status === "working") {
    if (typeof leaseId !== "string" || leaseId !== item.leaseId) {
      throw workLedgerError(
        "WORK_LEDGER_LEASE_CONFLICT",
        "工作项租约已变化",
        409,
      );
    }
    if (Date.parse(now) >= Date.parse(item.leaseUntil)) {
      throw workLedgerError(
        "WORK_LEDGER_LEASE_EXPIRED",
        "工作项租约已经过期",
        409,
      );
    }
    return;
  }
  if (leaseId !== undefined && leaseId !== null) {
    throw workLedgerError(
      "WORK_LEDGER_LEASE_CONFLICT",
      "当前工作项没有可使用的员工租约",
      409,
    );
  }
}

export function assertGeneralTransition(fromStatus, toStatus) {
  if (
    !WORK_LEDGER_STATUSES.has(toStatus) ||
    !GENERAL_TRANSITIONS.get(fromStatus)?.has(toStatus)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      `不允许从 ${fromStatus} 转换到 ${String(toStatus)}`,
      409,
    );
  }
}

export function assertRetryTransition(fromStatus) {
  if (!RETRY_FROM.has(fromStatus)) {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      `不允许从 ${fromStatus} 安排重试`,
      409,
    );
  }
}

export function assertHandoffTransition(fromStatus) {
  if (
    ["paused", "completed", "cancelled", "superseded"].includes(fromStatus)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      "暂停或终态工作项不能再转交",
      409,
    );
  }
}

export function assertCompleteTransition(fromStatus) {
  if (!COMPLETE_FROM.has(fromStatus)) {
    throw workLedgerError(
      "WORK_LEDGER_TRANSITION_INVALID",
      `不允许从 ${fromStatus} 直接完成`,
      409,
    );
  }
}

export function moveWorkItem(
  item,
  {
    status,
    now,
    reason = null,
    target = item.currentTarget,
    availableAt = null,
    activeIntentId = null,
    decisionContext = item.decisionContext,
  },
) {
  return {
    ...item,
    currentTarget: target,
    activeIntentId,
    decisionContext,
    status,
    revision: item.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt,
    statusReason: reason,
    updatedAt: now,
  };
}

export function normalizeRetryAt(value, now) {
  const availableAt = normalizeLedgerTimestamp(value, "availableAt");
  if (Date.parse(availableAt) <= Date.parse(now)) {
    throw workLedgerError(
      "WORK_LEDGER_RETRY_INVALID",
      "重试时间必须晚于当前时间",
    );
  }
  return availableAt;
}

export function normalizeHandoffTarget(value) {
  return normalizeLedgerTarget(value);
}
