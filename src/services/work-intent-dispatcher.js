import {
  createWorkIntentDispatchBinding,
  LEGACY_UNKNOWN_WORK_INTENT_BINDING,
  normalizeBoundWorkIntent,
  normalizeWorkIntentDispatchBinding,
} from "../domain/work-intent-dispatch-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";

const MAX_DISPATCH_BATCH = 100;
const QUERY_PAGE_SIZE = 100;
const MAX_QUERY_PAGES = 100;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const WORK_INTENT_ID = /^work-intent-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INVALID_CONTEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const DIRECT_ACTION_ADMISSION = Object.freeze({
  run: (operation) => operation(),
});

const CLAIM_CONTENTION_CODES = new Set([
  "WORK_LEDGER_INTENT_LEASE_ACTIVE",
  "WORK_LEDGER_INTENT_REVISION_CONFLICT",
  "WORK_LEDGER_INTENT_STATUS_CONFLICT",
  "WORK_LEDGER_INTENT_NOT_FOUND",
]);
const POLICY_BLOCK_CODES = new Set([
  "WORK_INTENT_CONTEXT_INVALID",
  "WORK_INTENT_POLICY_DENIED",
  "WORK_INTENT_INVALID",
]);
const ATTENTION_BLOCK_CODES = new Set([
  "ATTENTION_REQUEST_CONFLICT",
  "INVALID_ATTENTION_REQUEST",
]);
const ATTENTION_RETRY_CODES = new Set([
  "ATTENTION_CAPACITY_EXCEEDED",
  "ATTENTION_INBOX_NOT_READY",
]);
const PROPOSAL_BLOCK_CODES = new Set([
  "INVALID_WORK_PROPOSAL",
  "WORK_PROPOSAL_ID_CONFLICT",
]);
const PROPOSAL_RETRY_CODES = new Set([
  "WORK_PROPOSAL_CAPACITY_EXCEEDED",
  "WORK_PROPOSAL_STORE_NOT_READY",
]);
const PROPOSAL_STATUSES = new Set([
  "pending_delivery",
  "waiting_confirmation",
  "running",
  "waiting_retry",
  "succeeded",
  "rejected",
  "stale",
  "failed",
  "unknown",
]);

export class WorkIntentDispatcherError extends Error {
  constructor(code, message, statusCode = 500, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkIntentDispatcherError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function dispatcherError(code, message, statusCode = 500, options) {
  return new WorkIntentDispatcherError(code, message, statusCode, options);
}

function dataMap(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return new Map(entries);
}

function exactDataMap(value, keys) {
  const entries = dataMap(value);
  if (
    !entries ||
    entries.size !== keys.length ||
    keys.some((key) => !entries.has(key))
  ) {
    return null;
  }
  return entries;
}

function validateDependency(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} must provide ${methods.join(", ")}`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function actionAdmissionRun(value) {
  const gate = value === undefined ? DIRECT_ACTION_ADMISSION : value;
  return validateDependency(gate, ["run"], "actionAdmissionGate").run;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new TypeError(`${name} must be between 1000 and 86400000`);
  }
  return value;
}

function validateDispatcherId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new TypeError("dispatcherId is invalid");
  }
  return value;
}

function dispatchLimit(options) {
  const entries = exactDataMap(options, Object.hasOwn(options, "limit") ? ["limit"] : []);
  if (!entries) throw new TypeError("dispatchPending options are invalid");
  const limit = entries.has("limit") ? entries.get("limit") : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISPATCH_BATCH) {
    throw new TypeError(`limit must be between 1 and ${MAX_DISPATCH_BATCH}`);
  }
  return limit;
}

function normalizedTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw dispatcherError(
      "WORK_INTENT_DISPATCHER_CLOCK_INVALID",
      "工作意图分发时钟无效",
    );
  }
  return timestamp;
}

function ownErrorCode(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return null;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function truncateUtf8(value, maximumBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function safeContextText(value) {
  const text = typeof value === "string" ? value : "";
  return truncateUtf8(text.replace(INVALID_CONTEXT_CONTROL, " "), 2_048);
}

function safeReference(value, name) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > 2_048
  ) {
    throw dispatcherError(
      "WORK_INTENT_DOWNSTREAM_RESULT_UNCERTAIN",
      `${name} 返回了不可确认的引用`,
      503,
    );
  }
  return value;
}

function sourceContext(event) {
  const eventEntries = dataMap(event);
  const subjectEntries = dataMap(eventEntries?.get("subject"));
  const eventType = eventEntries?.get("eventType");
  const fragments = [typeof eventType === "string" ? eventType : "workflow-event"];
  const repository = subjectEntries?.get("repository");
  const number = subjectEntries?.get("number");
  const subjectId = subjectEntries?.get("id");
  if (typeof repository === "string") {
    fragments.push(
      Number.isSafeInteger(number) ? `${repository}#${number}` : repository,
    );
  } else if (typeof subjectId === "string") {
    fragments.push(subjectId);
  }
  return safeContextText(fragments.join(" · "));
}

function validatePage(page, kind) {
  try {
    const entries = exactDataMap(page, ["items", "nextCursor"]);
    const rawItems = entries?.get("items");
    const nextCursor = entries?.get("nextCursor");
    if (
      !entries ||
      !Array.isArray(rawItems) ||
      Object.getPrototypeOf(rawItems) !== Array.prototype ||
      rawItems.length > QUERY_PAGE_SIZE ||
      Reflect.ownKeys(rawItems).length !== rawItems.length + 1 ||
      !(nextCursor === null || typeof nextCursor === "string")
    ) {
      throw new Error("invalid page");
    }
    const items = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawItems, `${index}`);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("invalid page item");
      }
      const record = descriptor.value;
      const recordEntries = dataMap(record);
      const required = kind === "outbox"
        ? [
            "intentId",
            "itemId",
            "inputDigest",
            "requestedBy",
            "status",
            "revision",
            "createdAt",
          ]
        : [
            "itemId",
            "assignmentId",
            "inputDigest",
            "event",
            "currentTarget",
            "status",
            "revision",
          ];
      if (!recordEntries || required.some((key) => !recordEntries.has(key))) {
        throw new Error("invalid page record");
      }
      validatePageRecord(record, recordEntries, kind);
      items.push(record);
    }
    return { items, nextCursor };
  } catch {
    throw dispatcherError(
      "WORK_INTENT_LEDGER_QUERY_INVALID",
      `员工工作台账返回了无效的 ${kind} 分页`,
      503,
    );
  }
}

function safeRecordId(value, maximumBytes = 192) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function validatePageRecord(record, entries, kind) {
  if (kind === "outbox") {
    if (
      !WORK_INTENT_ID.test(entries.get("intentId")) ||
      !safeRecordId(entries.get("itemId")) ||
      !SHA256.test(entries.get("inputDigest")) ||
      !new Set(["pending", "dispatching", "delivered", "failed"]).has(
        entries.get("status"),
      ) ||
      !Number.isSafeInteger(entries.get("revision")) ||
      entries.get("revision") < 1
    ) {
      throw new Error("invalid outbox record");
    }
    normalizedTimestamp(entries.get("createdAt"));
    requestedBy(record);
    return;
  }
  if (
    !safeRecordId(entries.get("itemId")) ||
    !safeRecordId(entries.get("assignmentId")) ||
    !SHA256.test(entries.get("inputDigest")) ||
    !dataMap(entries.get("event")) ||
    !exactDataMap(entries.get("currentTarget"), ["type", "id"]) ||
    typeof entries.get("status") !== "string" ||
    !Number.isSafeInteger(entries.get("revision")) ||
    entries.get("revision") < 1
  ) {
    throw new Error("invalid work item record");
  }
}

function requestedBy(value) {
  const record = dataMap(value);
  const fields = exactDataMap(record?.get("requestedBy"), [
    "roleId",
    "workerId",
  ]);
  const roleId = fields?.get("roleId");
  const workerId = fields?.get("workerId");
  if (
    !fields ||
    typeof roleId !== "string" ||
    !SAFE_ROLE_ID.test(roleId) ||
    typeof workerId !== "string" ||
    !workerId.trim() ||
    Buffer.byteLength(workerId, "utf8") > 128
  ) {
    throw dispatcherError(
      "WORK_INTENT_LEDGER_QUERY_INVALID",
      "员工工作意图请求身份无效",
      503,
    );
  }
  return { roleId, workerId };
}

function validateBoundIntent(bound, item, intent, requester) {
  const event = dataMap(item.event);
  const error = dispatcherError(
    "WORK_INTENT_BINDING_INVALID",
    "策略没有返回与可信工作项一致的绑定",
    409,
  );
  return deepFreeze(
    normalizeBoundWorkIntent(
      bound,
      {
        intentType: intent.type,
        roleId: requester.roleId,
        workItemId: item.itemId,
        assignmentId: item.assignmentId,
        eventId: event?.get("eventId"),
      },
      error,
    ),
  );
}

function persistedBoundIntent(value, item, requester) {
  const record = dataMap(value);
  if (!record || !record.has("dispatchBinding")) {
    throw dispatcherError(
      "WORK_INTENT_LEDGER_QUERY_INVALID",
      "员工工作意图缺少持久策略绑定字段",
      503,
    );
  }
  const rawBinding = record.get("dispatchBinding");
  if (rawBinding === null) return null;
  const legacy = exactDataMap(rawBinding, ["status"]);
  if (legacy?.get("status") === LEGACY_UNKNOWN_WORK_INTENT_BINDING) {
    throw dispatcherError(
      "WORK_INTENT_LEGACY_BINDING_UNKNOWN",
      "历史工作意图可能已经产生下游动作，必须人工核对后恢复",
      409,
    );
  }
  const invalid = dispatcherError(
    "WORK_INTENT_LEDGER_QUERY_INVALID",
    "员工工作意图持久策略绑定损坏",
    503,
  );
  try {
    const envelope = normalizeWorkIntentDispatchBinding(rawBinding, invalid);
    return {
      envelope,
      bound: validateBoundIntent(
        envelope.boundIntent,
        item,
        record.get("intent"),
        requester,
      ),
    };
  } catch {
    throw invalid;
  }
}

function bindingUncertain(
  intentId,
  code = "binding-result-uncertain",
  claimed = true,
) {
  return {
    claimed,
    counter: "uncertain",
    result: { intentId, status: "uncertain", code },
  };
}

function hasLegacyUnknownBinding(value) {
  const binding = dataMap(value)?.get("dispatchBinding");
  const legacy = exactDataMap(binding, ["status"]);
  return legacy?.get("status") === LEGACY_UNKNOWN_WORK_INTENT_BINDING;
}

function proposalInput(bound) {
  const input = {
    proposalId: bound.intentId,
    policyVersion: bound.policyVersion,
    kind: bound.kind,
    requestedBy: bound.requestedBy,
    source: bound.source,
    binding: bound.binding,
    payload: bound.payload,
  };
  return { input, normalized: normalizeBoundWorkProposal(input) };
}

function proposalReceipt(value, proposal) {
  const entries = exactDataMap(value, [
    "proposalId",
    "contentDigest",
    "kind",
    "status",
    "revision",
    "createdAt",
  ]);
  if (
    !entries ||
    entries.get("proposalId") !== proposal.proposalId ||
    entries.get("contentDigest") !== proposal.contentDigest ||
    entries.get("kind") !== proposal.kind ||
    !PROPOSAL_STATUSES.has(entries.get("status")) ||
    !Number.isSafeInteger(entries.get("revision")) ||
    entries.get("revision") < 1
  ) {
    throw dispatcherError(
      "WORK_INTENT_DOWNSTREAM_RESULT_UNCERTAIN",
      "工作提案存储返回了不可确认的绑定",
      503,
    );
  }
  normalizedTimestamp(entries.get("createdAt"));
  return {
    proposalId: entries.get("proposalId"),
    contentDigest: entries.get("contentDigest"),
  };
}

function attentionRequest(claimed, item, bound) {
  const payload = exactDataMap(bound.payload, [
    "question",
    "choices",
    "summary",
    "reason",
  ]);
  if (!payload) {
    throw dispatcherError(
      "WORK_INTENT_BINDING_INVALID",
      "请示意图绑定内容无效",
      409,
    );
  }
  return {
    requestKey: claimed.intentId,
    type: "ask_user",
    producer: { roleId: bound.requestedBy.roleId, workItemId: item.itemId },
    question: payload.get("question"),
    context: [
      { label: "工作摘要", value: safeContextText(payload.get("summary")) },
      { label: "判断依据", value: safeContextText(payload.get("reason")) },
      { label: "来源事件", value: sourceContext(item.event) },
    ],
    choices: payload.get("choices"),
  };
}

function handoffTarget(bound) {
  const binding = dataMap(bound.binding);
  const targetRoleId = binding?.get("targetRoleId");
  if (typeof targetRoleId !== "string" || !SAFE_ROLE_ID.test(targetRoleId)) {
    throw dispatcherError(
      "WORK_INTENT_BINDING_INVALID",
      "策略没有为转交意图绑定可信岗位",
      409,
    );
  }
  return { type: "role", id: targetRoleId };
}

function emptyResult(scanned) {
  return {
    scanned,
    claimed: 0,
    delivered: 0,
    blocked: 0,
    retryWait: 0,
    uncertain: 0,
    skipped: 0,
    items: [],
  };
}

export class WorkIntentDispatcher {
  #ledger;
  #bind;
  #admitAction;
  #createAttention;
  #createProposal;
  #clock;
  #dispatcherId;
  #leaseDurationMs;
  #retryDelayMs;

  constructor({
    ledger,
    policy,
    attentionProducer,
    proposalProducer,
    actionAdmissionGate,
    clock = () => new Date(),
    dispatcherId = "work-intent-dispatcher",
    leaseDurationMs = DEFAULT_LEASE_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {}) {
    this.#ledger = validateDependency(
      ledger,
      ["listOutbox", "listItems", "claimIntent", "bindIntent", "ackIntent"],
      "ledger",
    );
    this.#bind = validateDependency(policy, ["bind"], "policy").bind;
    this.#admitAction = actionAdmissionRun(actionAdmissionGate);
    this.#createAttention = validateDependency(
      attentionProducer,
      ["create"],
      "attentionProducer",
    ).create;
    this.#createProposal = validateDependency(
      proposalProducer,
      ["create"],
      "proposalProducer",
    ).create;
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#clock = clock;
    this.#dispatcherId = validateDispatcherId(dispatcherId);
    this.#leaseDurationMs = validateDuration(leaseDurationMs, "leaseDurationMs");
    this.#retryDelayMs = validateDuration(retryDelayMs, "retryDelayMs");
    Object.freeze(this);
  }

  async dispatchPending(options = {}) {
    const limit = dispatchLimit(options);
    const now = this.#now();
    const { candidates, quarantined } = await this.#eligibleOutbox(now, limit);
    const result = emptyResult(candidates.length + quarantined.length);
    for (const candidate of quarantined) {
      const isolated = bindingUncertain(
        candidate.intentId,
        "legacy-binding-unknown",
        false,
      );
      result.items.push(isolated.result);
      result[isolated.counter] += 1;
    }
    if (!candidates.length) return result;
    const items = await this.#itemsById(
      new Set(candidates.map(({ itemId }) => itemId)),
    );

    for (const candidate of candidates) {
      const dispatched = await this.#dispatch(candidate, items.get(candidate.itemId));
      result.items.push(dispatched.result);
      if (dispatched.claimed) result.claimed += 1;
      result[dispatched.counter] += 1;
    }
    return result;
  }

  async #eligibleOutbox(now, limit) {
    const [pending, dispatching] = await Promise.all([
      this.#readAllPages(this.#ledger.listOutbox, { status: "pending" }, "outbox"),
      this.#readAllPages(
        this.#ledger.listOutbox,
        { status: "dispatching" },
        "outbox",
      ),
    ]);
    const nowMs = Date.parse(now);
    const eligible = [
      ...pending,
      ...dispatching.filter((entry) => {
        const leaseUntil = Date.parse(entry.dispatchLeaseUntil);
        if (!Number.isFinite(leaseUntil)) {
          throw dispatcherError(
            "WORK_INTENT_LEDGER_QUERY_INVALID",
            "员工工作台账返回了无效的 dispatcher 租约",
            503,
          );
        }
        return leaseUntil <= nowMs;
      }),
    ];
    const unique = new Map();
    for (const entry of eligible) {
      if (typeof entry?.intentId !== "string" || unique.has(entry.intentId)) {
        throw dispatcherError(
          "WORK_INTENT_LEDGER_QUERY_INVALID",
          "员工工作台账返回了重复或无效的工作意图",
          503,
        );
      }
      unique.set(entry.intentId, entry);
    }
    const ordered = [...unique.values()].sort(
      (left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt), "en") ||
        left.intentId.localeCompare(right.intentId, "en"),
    );
    const candidates = [];
    const quarantined = [];
    for (const entry of ordered) {
      if (hasLegacyUnknownBinding(entry)) {
        if (quarantined.length < limit) quarantined.push(entry);
      } else if (candidates.length < limit) {
        candidates.push(entry);
      }
    }
    return { candidates, quarantined };
  }

  async #itemsById(requiredIds) {
    const found = new Map();
    const seenIds = new Set();
    let cursor;
    const seenCursors = new Set();
    for (let pageNumber = 0; pageNumber < MAX_QUERY_PAGES; pageNumber += 1) {
      const page = validatePage(
        await this.#ledger.listItems({
          limit: QUERY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
        "items",
      );
      for (const item of page.items) {
        if (seenIds.has(item.itemId)) {
          throw dispatcherError(
            "WORK_INTENT_LEDGER_QUERY_INVALID",
            "员工工作台账返回了重复工作项",
            503,
          );
        }
        seenIds.add(item.itemId);
        if (requiredIds.has(item?.itemId)) found.set(item.itemId, item);
      }
      if (found.size === requiredIds.size || page.nextCursor === null) break;
      if (seenCursors.has(page.nextCursor)) {
        throw dispatcherError(
          "WORK_INTENT_LEDGER_QUERY_INVALID",
          "员工工作项分页游标循环",
          503,
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return found;
  }

  async #readAllPages(method, fixedOptions, kind) {
    const records = [];
    let cursor;
    const seenCursors = new Set();
    for (let pageNumber = 0; pageNumber < MAX_QUERY_PAGES; pageNumber += 1) {
      const page = validatePage(
        await method({
          ...fixedOptions,
          limit: QUERY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
        kind,
      );
      records.push(...page.items);
      if (page.nextCursor === null) return records;
      if (seenCursors.has(page.nextCursor)) {
        throw dispatcherError(
          "WORK_INTENT_LEDGER_QUERY_INVALID",
          "员工工作台账分页游标循环",
          503,
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw dispatcherError(
      "WORK_INTENT_LEDGER_QUERY_INVALID",
      "员工工作台账分页超过安全上限",
      503,
    );
  }

  async #dispatch(candidate, item) {
    const claimAdmission = await this.#admitAction(() => {
      try {
        return {
          operation: this.#ledger.claimIntent({
            intentId: candidate.intentId,
            expectedRevision: candidate.revision,
            dispatcherId: this.#dispatcherId,
            leaseDurationMs: this.#leaseDurationMs,
          }),
          synchronousError: null,
        };
      } catch (error) {
        return { operation: null, synchronousError: error };
      }
    });
    let claimed;
    try {
      if (claimAdmission.synchronousError !== null) {
        throw claimAdmission.synchronousError;
      }
      claimed = await claimAdmission.operation;
    } catch (error) {
      const code = ownErrorCode(error);
      return {
        claimed: false,
        counter: code && CLAIM_CONTENTION_CODES.has(code) ? "skipped" : "uncertain",
        result: {
          intentId: candidate.intentId,
          status: code && CLAIM_CONTENTION_CODES.has(code) ? "skipped" : "uncertain",
          code: code && CLAIM_CONTENTION_CODES.has(code)
            ? "claim-contended"
            : "claim-result-uncertain",
        },
      };
    }

    let requester;
    try {
      requester = requestedBy(claimed);
      const candidateRequester = requestedBy(candidate);
      if (
        requester.roleId !== candidateRequester.roleId ||
        requester.workerId !== candidateRequester.workerId
      ) {
        throw new Error("requester changed while claiming");
      }
    } catch {
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: candidate.intentId,
          status: "uncertain",
          code: "ledger-requester-binding-invalid",
        },
      };
    }

    if (
      !item ||
      item.itemId !== claimed.itemId ||
      item.inputDigest !== claimed.inputDigest ||
      item.status !== "dispatch_pending"
    ) {
      return this.#ackFailure(claimed, item, {
        nextStatus: "blocked",
        code: "ledger-item-binding-invalid",
      });
    }

    let persisted;
    try {
      persisted = persistedBoundIntent(claimed, item, requester);
    } catch (error) {
      return bindingUncertain(
        claimed.intentId,
        ownErrorCode(error) === "WORK_INTENT_LEGACY_BINDING_UNKNOWN"
          ? "legacy-binding-unknown"
          : "ledger-binding-invalid",
      );
    }

    let bound;
    if (persisted !== null) {
      bound = persisted.bound;
    } else {
      const bindingPlan = await this.#admitAction(() => {
        let plannedBound;
        try {
          const rawBound = this.#bind({
            context: {
              assignmentId: item.assignmentId,
              workItemId: item.itemId,
              roleId: requester.roleId,
              event: item.event,
            },
            intent: claimed.intent,
          });
          if (rawBound instanceof Promise) {
            void rawBound.catch(() => {});
            throw dispatcherError(
              "WORK_INTENT_BINDING_INVALID",
              "工作意图策略必须同步返回完整绑定",
              409,
            );
          }
          plannedBound = validateBoundIntent(
            rawBound,
            item,
            claimed.intent,
            requester,
          );
        } catch (error) {
          const code = ownErrorCode(error);
          return {
            status: "failed",
            code: POLICY_BLOCK_CODES.has(code)
              ? "policy-denied"
              : "policy-binding-invalid",
          };
        }
        try {
          return {
            status: "persisting",
            bound: plannedBound,
            operation: this.#ledger.bindIntent({
              intentId: claimed.intentId,
              expectedRevision: claimed.revision,
              itemExpectedRevision: item.revision,
              dispatcherId: this.#dispatcherId,
              dispatchLeaseId: claimed.dispatchLeaseId,
              boundIntent: plannedBound,
            }),
            synchronousError: null,
          };
        } catch (error) {
          return {
            status: "persisting",
            bound: plannedBound,
            operation: null,
            synchronousError: error,
          };
        }
      });
      if (bindingPlan.status === "failed") {
        return this.#ackFailure(claimed, item, {
          nextStatus: "blocked",
          code: bindingPlan.code,
        });
      }
      let bindingReceipt;
      try {
        if (bindingPlan.synchronousError !== null) {
          throw bindingPlan.synchronousError;
        }
        bindingReceipt = await bindingPlan.operation;
      } catch {
        return bindingUncertain(claimed.intentId);
      }
      try {
        const receiptEntries = dataMap(bindingReceipt);
        const expectedEnvelope = createWorkIntentDispatchBinding(bindingPlan.bound);
        persisted = persistedBoundIntent(bindingReceipt, item, requester);
        if (
          !receiptEntries ||
          receiptEntries.get("intentId") !== claimed.intentId ||
          receiptEntries.get("status") !== "dispatching" ||
          receiptEntries.get("revision") !== claimed.revision + 1 ||
          receiptEntries.get("dispatchLeaseId") !== claimed.dispatchLeaseId ||
          persisted === null ||
          persisted.envelope.bindingDigest !== expectedEnvelope.bindingDigest
        ) {
          throw new Error("binding receipt does not match the admitted plan");
        }
      } catch {
        return bindingUncertain(claimed.intentId, "binding-receipt-invalid");
      }
      claimed = bindingReceipt;
      bound = persisted.bound;
    }

    if (bound.kind === "attention_request") {
      return this.#dispatchAttention(claimed, item, bound);
    }
    if (
      bound.kind === "github_review_proposal" ||
      bound.kind === "code_action_proposal"
    ) {
      return this.#dispatchProposal(claimed, item, bound);
    }
    return this.#ackBoundIntent(claimed, item, bound);
  }

  async #dispatchAttention(claimed, item, bound) {
    let receipt;
    try {
      receipt = await this.#createAttention(attentionRequest(claimed, item, bound));
    } catch (error) {
      const code = ownErrorCode(error);
      if (ATTENTION_BLOCK_CODES.has(code)) {
        return this.#ackFailure(claimed, item, {
          nextStatus: "blocked",
          code: "attention-conflict",
        });
      }
      if (ATTENTION_RETRY_CODES.has(code)) {
        return this.#ackFailure(claimed, item, {
          nextStatus: "retry_wait",
          code: "attention-temporarily-unavailable",
        });
      }
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "attention-result-uncertain",
        },
      };
    }

    let questionRef;
    try {
      questionRef = safeReference(receipt?.requestId, "attentionProducer.create");
    } catch {
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "attention-result-uncertain",
        },
      };
    }
    return this.#ackDelivered(claimed, item, {
      nextStatus: "waiting_user",
      details: { questionRef, downstreamRef: bound.intentId },
    });
  }

  async #dispatchProposal(claimed, item, bound) {
    let proposal;
    try {
      proposal = proposalInput(bound);
    } catch {
      return this.#ackFailure(claimed, item, {
        nextStatus: "blocked",
        code: "proposal-binding-invalid",
      });
    }
    let receipt;
    try {
      receipt = proposalReceipt(
        await this.#createProposal(proposal.input),
        proposal.normalized,
      );
    } catch (error) {
      const code = ownErrorCode(error);
      if (PROPOSAL_BLOCK_CODES.has(code)) {
        return this.#ackFailure(claimed, item, {
          nextStatus: "blocked",
          code: "proposal-conflict",
        });
      }
      if (PROPOSAL_RETRY_CODES.has(code)) {
        return this.#ackFailure(claimed, item, {
          nextStatus: "retry_wait",
          code: "proposal-temporarily-unavailable",
        });
      }
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "proposal-result-uncertain",
        },
      };
    }
    return this.#ackDelivered(claimed, item, {
      nextStatus: "waiting_external",
      details: {
        downstreamRef: receipt.proposalId,
        proposalDigest: receipt.contentDigest,
      },
    });
  }

  #ackBoundIntent(claimed, item, bound) {
    if (bound.kind === "wait_condition") {
      return this.#ackDelivered(claimed, item, {
        nextStatus: "waiting_condition",
        details: { conditionRef: bound.intentId, downstreamRef: bound.intentId },
      });
    }
    if (bound.kind === "complete") {
      const outcome = dataMap(bound.payload)?.get("outcome");
      return this.#ackDelivered(claimed, item, {
        nextStatus: "completed",
        details: {
          resultRef: bound.intentId,
          ...(typeof outcome === "string" ? { outcome } : {}),
        },
      });
    }
    if (bound.kind === "handoff") {
      let target;
      try {
        target = handoffTarget(bound);
      } catch {
        return this.#ackFailure(claimed, item, {
          nextStatus: "blocked",
          code: "policy-binding-invalid",
        });
      }
      return this.#ackDelivered(claimed, item, {
        nextStatus: "queued",
        target,
        details: { downstreamRef: bound.intentId },
      });
    }
    return this.#ackFailure(claimed, item, {
      nextStatus: "blocked",
      code: "policy-binding-invalid",
    });
  }

  async #ackDelivered(claimed, item, { nextStatus, details, target }) {
    try {
      await this.#ledger.ackIntent({
        intentId: claimed.intentId,
        expectedRevision: claimed.revision,
        dispatchLeaseId: claimed.dispatchLeaseId,
        itemExpectedRevision: item.revision,
        outcome: "delivered",
        nextStatus,
        actorId: this.#dispatcherId,
        details,
        ...(target ? { target } : {}),
      });
      return {
        claimed: true,
        counter: "delivered",
        result: {
          intentId: claimed.intentId,
          status: "delivered",
          nextStatus,
          downstreamRef: details.downstreamRef ?? details.resultRef,
        },
      };
    } catch {
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "ack-result-uncertain",
        },
      };
    }
  }

  async #ackFailure(claimed, item, { nextStatus, code }) {
    if (!item || !Number.isSafeInteger(item.revision)) {
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "ledger-item-binding-invalid",
        },
      };
    }
    const retry = nextStatus === "retry_wait";
    try {
      await this.#ledger.ackIntent({
        intentId: claimed.intentId,
        expectedRevision: claimed.revision,
        dispatchLeaseId: claimed.dispatchLeaseId,
        itemExpectedRevision: item.revision,
        outcome: "failed",
        nextStatus,
        ...(retry
          ? {
              availableAt: new Date(
                Date.parse(this.#now()) + this.#retryDelayMs,
              ).toISOString(),
            }
          : {}),
        actorId: this.#dispatcherId,
        details: { code },
      });
      return {
        claimed: true,
        counter: retry ? "retryWait" : "blocked",
        result: {
          intentId: claimed.intentId,
          status: nextStatus,
          code,
        },
      };
    } catch {
      return {
        claimed: true,
        counter: "uncertain",
        result: {
          intentId: claimed.intentId,
          status: "uncertain",
          code: "failure-ack-result-uncertain",
        },
      };
    }
  }

  #now() {
    try {
      return normalizedTimestamp(this.#clock());
    } catch (error) {
      if (error instanceof WorkIntentDispatcherError) throw error;
      throw dispatcherError(
        "WORK_INTENT_DISPATCHER_CLOCK_INVALID",
        "工作意图分发时钟无效",
        500,
        { cause: error },
      );
    }
  }
}
