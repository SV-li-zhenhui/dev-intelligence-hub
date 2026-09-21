import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MemoryRecordError, normalizeMemoryRecord } from "./memory-record.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import {
  normalizeWorkGraphAcceptanceContract,
  normalizeWorkGraphDelivery,
} from "./work-graph-contract.js";

const EVENT_KINDS = new Set([
  "acceptance_contract",
  "delivery_submitted",
  "delivery_accepted",
  "delivery_rejected",
  "authority_invalidated",
  "authority_observed",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_EVENT_BYTES = 96 * 1024;
const MAX_MEMORY_TITLE_BYTES = 1_024;
const MAX_MEMORY_CONTENT_BYTES = 32 * 1_024;
const MEMORY_DESCRIPTION_PREVIEW_BYTES = 256;
const MEMORY_DESCRIPTION_PREVIEW_COUNT = 4;
const SOURCE_AUTHORITY_KEYS = [
  "applies",
  "citable",
  "bindingDigest",
  "executionBinding",
  "provenance",
];
const PROVENANCE_KEYS = ["provider", "scopeId"];

export class WorkGraphMemoryEventError extends Error {
  constructor(message = "任务图记忆事件无效", options) {
    super(message, options);
    this.name = "WorkGraphMemoryEventError";
    this.code = "WORK_GRAPH_MEMORY_EVENT_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message, cause) {
  return new WorkGraphMemoryEventError(message, cause ? { cause } : undefined);
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name) {
  const entries = dataEntries(value, name);
  const fields = new Map(entries);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} 字段无效`);
  }
  return fields;
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function text(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    INVALID_CONTROL.lastIndex = 0;
    throw invalid(`${name} 无效`);
  }
  INVALID_CONTROL.lastIndex = 0;
  return value;
}

function digest(value, name) {
  const normalized = text(value, name, 64);
  if (!SHA256.test(normalized)) throw invalid(`${name} 无效`);
  return normalized;
}

function timestamp(value, name) {
  const normalized = text(value, name, 64);
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    throw invalid(`${name} 无效`);
  }
  return normalized;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function digestValue(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
}

export function normalizeWorkGraphSourceAuthority(value) {
  const fields = exact(value, SOURCE_AUTHORITY_KEYS, "sourceAuthority");
  if (
    typeof fields.get("applies") !== "boolean" ||
    typeof fields.get("citable") !== "boolean"
  ) {
    throw invalid("sourceAuthority 无效");
  }
  if (fields.get("applies") === false) {
    if (
      fields.get("citable") !== true ||
      fields.get("bindingDigest") !== null ||
      fields.get("executionBinding") !== null ||
      fields.get("provenance") !== null
    ) {
      throw invalid("sourceAuthority 无效");
    }
    return {
      applies: false,
      citable: true,
      bindingDigest: null,
      executionBinding: null,
      provenance: null,
    };
  }
  let executionBinding;
  try {
    executionBinding = normalizePullRequestExecutionBinding(
      fields.get("executionBinding"),
    );
  } catch {
    throw invalid("sourceAuthority executionBinding 无效");
  }
  const provenanceFields = exact(
    fields.get("provenance"),
    PROVENANCE_KEYS,
    "sourceAuthority.provenance",
  );
  const provenance = {
    provider: text(
      provenanceFields.get("provider"),
      "sourceAuthority.provenance.provider",
      128,
    ),
    scopeId: text(
      provenanceFields.get("scopeId"),
      "sourceAuthority.provenance.scopeId",
      256,
    ),
  };
  const bindingDigest = digest(
    fields.get("bindingDigest"),
    "sourceAuthority.bindingDigest",
  );
  if (
    bindingDigest !== digestValue({ executionBinding, provenance }) ||
    (fields.get("citable") && executionBinding.schemaVersion !== 2)
  ) {
    throw invalid("sourceAuthority 绑定摘要无效");
  }
  return {
    applies: true,
    citable: fields.get("citable"),
    bindingDigest,
    executionBinding: structuredClone(executionBinding),
    provenance,
  };
}

export function createWorkGraphSourceAuthority({
  executionBinding = null,
  provenance = null,
  citable = true,
} = {}) {
  if (executionBinding === null) {
    return normalizeWorkGraphSourceAuthority({
      applies: false,
      citable: true,
      bindingDigest: null,
      executionBinding: null,
      provenance: null,
    });
  }
  const normalizedBinding = normalizePullRequestExecutionBinding(
    executionBinding,
  );
  const normalizedProvenance = Object.fromEntries(
    exact(provenance, PROVENANCE_KEYS, "sourceAuthority.provenance"),
  );
  return normalizeWorkGraphSourceAuthority({
    applies: true,
    citable,
    bindingDigest: digestValue({
      executionBinding: normalizedBinding,
      provenance: normalizedProvenance,
    }),
    executionBinding: normalizedBinding,
    provenance: normalizedProvenance,
  });
}

function rawMemoryRecord(value) {
  const { recordId: _recordId, contentDigest: _contentDigest, ...record } =
    normalizeMemoryRecord(value);
  return structuredClone(record);
}

function plainData(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safeText(value, maximumBytes) {
  if (typeof value !== "string") return "";
  let result = "";
  let bytes = 0;
  for (const character of value.replace(INVALID_CONTROL, " ")) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function safeRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value) ? value : null;
}

function safeNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function memoryTitle(prefix, title) {
  return safeText(`${prefix}${title}`, MAX_MEMORY_TITLE_BYTES);
}

function memoryContent(value, fallback) {
  for (const candidate of [value, fallback]) {
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= MAX_MEMORY_CONTENT_BYTES) {
      return serialized;
    }
  }
  return JSON.stringify({
    sourceRecordDigest: fallback.sourceRecordDigest,
    truncated: true,
  });
}

function projectedMemoryRecord(candidate, compactCandidate) {
  try {
    return rawMemoryRecord(candidate);
  } catch (error) {
    if (!(error instanceof MemoryRecordError)) throw error;
    return rawMemoryRecord(compactCandidate);
  }
}

function acceptanceContractMemoryContent(context, record, sourceRecordDigest) {
  const summary = {
    projectionSchemaVersion: 1,
    truncated: true,
    taskId: context.taskId,
    sourceAuthority: context.sourceAuthority,
    sourceRecordDigest,
    contractRevision: record.revision,
    acceptanceCriteriaCount: record.acceptanceCriteria.length,
    expectedDeliverablesCount: record.expectedDeliverables.length,
    criterionIds: record.acceptanceCriteria.map(({ criterionId }) => criterionId),
    expectedDeliverables: record.expectedDeliverables.map(
      ({ deliverableId, required }) => ({ deliverableId, required }),
    ),
  };
  return memoryContent(
    {
      ...summary,
      previews: {
        acceptanceCriteria: record.acceptanceCriteria
          .slice(0, MEMORY_DESCRIPTION_PREVIEW_COUNT)
          .map(({ criterionId, description }) => ({
            criterionId,
            description: safeText(
              description,
              MEMORY_DESCRIPTION_PREVIEW_BYTES,
            ),
          })),
        expectedDeliverables: record.expectedDeliverables
          .slice(0, MEMORY_DESCRIPTION_PREVIEW_COUNT)
          .map(({ deliverableId, kind, description, required }) => ({
            deliverableId,
            kind,
            description: safeText(
              description,
              MEMORY_DESCRIPTION_PREVIEW_BYTES,
            ),
            required,
          })),
      },
    },
    summary,
  );
}

function deliveryMemoryContent(context, content, sourceRecordDigest) {
  const summary = {
    projectionSchemaVersion: 1,
    truncated: true,
    taskId: context.taskId,
    sourceAuthority: context.sourceAuthority,
    sourceRecordDigest,
    deliverableId: content.deliverableId,
    deliveryRevision: content.revision,
    contractRevision: content.contractRevision,
    status: content.status,
    evidenceCount: content.evidence.length,
  };
  return memoryContent({ ...summary, evidence: content.evidence }, summary);
}

function graphContext(item, sourceAuthority) {
  const source = plainData(item.source);
  const current = plainData(source?.current);
  const event = plainData(
    source?.kind === "pull_request" ? current?.event : item.event,
  );
  const subject = plainData(event?.subject);
  const payload = plainData(event?.payload);
  const assignment = plainData(item.assignment);
  const work = plainData(assignment?.work);
  const taskId = text(item.itemId, "taskId", 192);
  const repository = safeRepository(subject?.repository);
  const subjectNumber = safeNumber(subject?.number);
  const title = safeText(
    work?.title || payload?.title || subject?.id || taskId,
    1_024,
  );
  const eventType = typeof event?.eventType === "string" ? event.eventType : null;
  const sourceKind = eventType?.startsWith("pull_request.") ? "pull" : "issues";
  return {
    taskId,
    sourceAuthority,
    repository,
    subjectNumber,
    title: title.trim() ? title : taskId,
    sourceUrl: repository && subjectNumber
      ? `https://github.com/${repository}/${sourceKind}/${subjectNumber}`
      : null,
  };
}

function normalizeStoredRecord(kind, value) {
  if (kind === "acceptance_contract") {
    const fields = exact(
      value,
      ["revision", "acceptanceCriteria", "expectedDeliverables", "recordedAt"],
      "验收契约",
    );
    const contract = normalizeWorkGraphAcceptanceContract({
      revision: fields.get("revision"),
      acceptanceCriteria: fields.get("acceptanceCriteria"),
      expectedDeliverables: fields.get("expectedDeliverables"),
    });
    return {
      ...structuredClone(contract),
      recordedAt: timestamp(fields.get("recordedAt"), "recordedAt"),
    };
  }
  const fields = exact(
    value,
    [
      "deliverableId",
      "revision",
      "contractRevision",
      "status",
      "summary",
      "evidence",
      "recordedAt",
    ],
    "交付记录",
  );
  const delivery = normalizeWorkGraphDelivery({
    deliverableId: fields.get("deliverableId"),
    revision: fields.get("revision"),
    contractRevision: fields.get("contractRevision"),
    status: fields.get("status"),
    summary: fields.get("summary"),
    evidence: fields.get("evidence"),
  });
  if (kind !== `delivery_${delivery.status}`) {
    throw invalid("任务图记忆事件类型与交付状态不一致");
  }
  return {
    ...structuredClone(delivery),
    recordedAt: timestamp(fields.get("recordedAt"), "recordedAt"),
  };
}

function memoryRecordForGraphRecord(
  item,
  kind,
  record,
  sourceRecordDigest,
  sourceAuthority,
) {
  const context = graphContext(item, sourceAuthority);
  const { recordedAt, ...content } = record;
  if (kind === "acceptance_contract") {
    const candidate = {
      schemaVersion: 1,
      source: {
        kind: "work-contract",
        id: `${context.taskId}:contract:${record.revision}`,
      },
      occurredAt: recordedAt,
      roleId: null,
      repository: context.repository,
      eventType: "work.acceptance_contract",
      title: `验收契约 R${record.revision}：${context.title}`,
      summary: `${record.acceptanceCriteria.length} 条验收标准 · ${record.expectedDeliverables.length} 项预期交付`,
      content: JSON.stringify({
        taskId: context.taskId,
        sourceAuthority: context.sourceAuthority,
        acceptanceContract: content,
      }),
      evidence: [],
      tags: ["work", "acceptance_contract"],
      sourceUrl: context.sourceUrl,
      subjectNumber: context.subjectNumber,
    };
    return projectedMemoryRecord(candidate, {
      ...candidate,
      title: memoryTitle(`验收契约 R${record.revision}：`, context.title),
      content: acceptanceContractMemoryContent(
        context,
        content,
        sourceRecordDigest,
      ),
    });
  }
  const candidate = {
    schemaVersion: 1,
    source: {
      kind: "work-delivery",
      id: `${context.taskId}:delivery:${record.revision}`,
    },
    occurredAt: recordedAt,
    roleId: null,
    repository: context.repository,
    eventType: `work.delivery_${record.status}`,
    title: `交付 ${record.deliverableId}：${context.title}`,
    summary: safeText(record.summary, 8_192),
    content: JSON.stringify({
      taskId: context.taskId,
      sourceAuthority: context.sourceAuthority,
      deliverableId: content.deliverableId,
      deliveryRevision: content.revision,
      contractRevision: content.contractRevision,
      status: content.status,
      evidence: content.evidence,
    }),
    evidence: record.evidence.slice(0, 20).map(
      ({ kind: evidenceKind, referenceId, contentDigest }) =>
        safeText(`${evidenceKind}:${referenceId}:${contentDigest}`, 2_048),
    ),
    tags: ["work", "delivery", record.status],
    sourceUrl: context.sourceUrl,
    subjectNumber: context.subjectNumber,
  };
  return projectedMemoryRecord(candidate, {
    ...candidate,
    title: memoryTitle(`交付 ${record.deliverableId}：`, context.title),
    content: deliveryMemoryContent(context, content, sourceRecordDigest),
  });
}

function eventCore(value) {
  return {
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    previousDigest: value.previousDigest,
    ledgerRevision: value.ledgerRevision,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    recordRevision: value.recordRevision,
    sourceRecordDigest: value.sourceRecordDigest,
    kind: value.kind,
    occurredAt: value.occurredAt,
    ...(value.schemaVersion === 2
      ? {
          sourceAuthority: value.sourceAuthority,
          authorityStateDigest: value.authorityStateDigest,
        }
      : {}),
    memoryRecord: value.memoryRecord,
  };
}

export function workGraphMemorySourceRecordDigest({ taskId, kind, record }) {
  if (
    !EVENT_KINDS.has(kind) ||
    ["authority_invalidated", "authority_observed"].includes(kind)
  ) {
    throw invalid("kind 无效");
  }
  const normalizedTaskId = text(taskId, "taskId", 192);
  const normalizedRecord = normalizeStoredRecord(kind, record);
  return digestValue({
    taskId: normalizedTaskId,
    kind,
    record: normalizedRecord,
  });
}

export function createWorkGraphMemoryEvent({
  sequence,
  previousDigest,
  ledgerRevision,
  taskRevision,
  item,
  kind,
  record,
  sourceAuthority = createWorkGraphSourceAuthority(),
  authorityStateDigest = digestValue([]),
}) {
  if (
    !EVENT_KINDS.has(kind) ||
    ["authority_invalidated", "authority_observed"].includes(kind)
  ) {
    throw invalid("kind 无效");
  }
  const normalizedSequence = integer(sequence, "sequence", 1);
  const normalizedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, "previousDigest");
  if ((normalizedSequence === 1) !== (normalizedPreviousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const normalizedLedgerRevision = integer(
    ledgerRevision,
    "ledgerRevision",
    1,
  );
  const normalizedTaskRevision = integer(taskRevision, "taskRevision", 1);
  if (normalizedTaskRevision > normalizedLedgerRevision) {
    throw invalid("taskRevision 超过 ledgerRevision");
  }
  const normalizedRecord = normalizeStoredRecord(kind, record);
  const normalizedAuthority = normalizeWorkGraphSourceAuthority(sourceAuthority);
  const normalizedAuthorityStateDigest = digest(
    authorityStateDigest,
    "authorityStateDigest",
  );
  const taskId = text(item?.itemId, "taskId", 192);
  const sourceRecordDigest = workGraphMemorySourceRecordDigest({
    taskId,
    kind,
    record: normalizedRecord,
  });
  const core = eventCore({
    schemaVersion: 2,
    sequence: normalizedSequence,
    previousDigest: normalizedPreviousDigest,
    ledgerRevision: normalizedLedgerRevision,
    taskId,
    taskRevision: normalizedTaskRevision,
    recordRevision: normalizedRecord.revision,
    sourceRecordDigest,
    kind,
    occurredAt: normalizedRecord.recordedAt,
    sourceAuthority: normalizedAuthority,
    authorityStateDigest: normalizedAuthorityStateDigest,
    memoryRecord: memoryRecordForGraphRecord(
      item,
      kind,
      normalizedRecord,
      sourceRecordDigest,
      normalizedAuthority,
    ),
  });
  const eventDigest = digestValue(core);
  return {
    ...core,
    eventId: `work-graph-memory-event-${eventDigest}`,
    eventDigest,
  };
}

export function createLegacyWorkGraphMemoryEvent({
  sequence,
  previousDigest,
  ledgerRevision,
  taskRevision,
  item,
  kind,
  record,
}) {
  if (
    !EVENT_KINDS.has(kind) ||
    ["authority_invalidated", "authority_observed"].includes(kind)
  ) {
    throw invalid("kind 无效");
  }
  const normalizedSequence = integer(sequence, "sequence", 1);
  const normalizedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, "previousDigest");
  if ((normalizedSequence === 1) !== (normalizedPreviousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const normalizedLedgerRevision = integer(
    ledgerRevision,
    "ledgerRevision",
    1,
  );
  const normalizedTaskRevision = integer(taskRevision, "taskRevision", 1);
  if (normalizedTaskRevision > normalizedLedgerRevision) {
    throw invalid("taskRevision 超过 ledgerRevision");
  }
  const normalizedRecord = normalizeStoredRecord(kind, record);
  const taskId = text(item?.itemId, "taskId", 192);
  const sourceRecordDigest = workGraphMemorySourceRecordDigest({
    taskId,
    kind,
    record: normalizedRecord,
  });
  const core = eventCore({
    schemaVersion: 1,
    sequence: normalizedSequence,
    previousDigest: normalizedPreviousDigest,
    ledgerRevision: normalizedLedgerRevision,
    taskId,
    taskRevision: normalizedTaskRevision,
    recordRevision: normalizedRecord.revision,
    sourceRecordDigest,
    kind,
    occurredAt: normalizedRecord.recordedAt,
    memoryRecord: memoryRecordForGraphRecord(
      item,
      kind,
      normalizedRecord,
      sourceRecordDigest,
      undefined,
    ),
  });
  const eventDigest = digestValue(core);
  return {
    ...core,
    eventId: `work-graph-memory-event-${eventDigest}`,
    eventDigest,
  };
}

export function createWorkGraphAuthorityInvalidationEvent({
  sequence,
  previousDigest,
  ledgerRevision,
  taskRevision,
  item,
  occurredAt,
  reason,
  sourceAuthority,
  authorityStateDigest,
}) {
  const normalizedSequence = integer(sequence, "sequence", 1);
  const normalizedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, "previousDigest");
  if ((normalizedSequence === 1) !== (normalizedPreviousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const normalizedLedgerRevision = integer(
    ledgerRevision,
    "ledgerRevision",
    1,
  );
  const normalizedTaskRevision = integer(taskRevision, "taskRevision", 1);
  if (normalizedTaskRevision > normalizedLedgerRevision) {
    throw invalid("taskRevision 超过 ledgerRevision");
  }
  const normalizedOccurredAt = timestamp(occurredAt, "occurredAt");
  const normalizedReason = text(reason, "reason", 128);
  const normalizedAuthority = normalizeWorkGraphSourceAuthority({
    ...sourceAuthority,
    citable: false,
  });
  const normalizedAuthorityStateDigest = digest(
    authorityStateDigest,
    "authorityStateDigest",
  );
  if (!normalizedAuthority.applies) {
    throw invalid("authority invalidation 缺少 PR 来源绑定");
  }
  const context = graphContext(item, normalizedAuthority);
  const sourceRecordDigest = digestValue({
    taskId: context.taskId,
    reason: normalizedReason,
    sourceAuthority: normalizedAuthority,
    authorityStateDigest: normalizedAuthorityStateDigest,
  });
  const memoryRecord = rawMemoryRecord({
    schemaVersion: 1,
    source: {
      kind: "work-authority-lifecycle",
      id:
        `${context.taskId}:authority:${normalizedAuthority.bindingDigest}:` +
        `ledger:${normalizedLedgerRevision}`,
    },
    occurredAt: normalizedOccurredAt,
    roleId: null,
    repository: context.repository,
    eventType: "work.authority_invalidated",
    title: memoryTitle("旧 PR 工作结论已失效：", context.title),
    summary: safeText(normalizedReason, 8_192),
    content: memoryContent({
      projectionSchemaVersion: 2,
      taskId: context.taskId,
      reason: normalizedReason,
      sourceAuthority: normalizedAuthority,
      authorityStateDigest: normalizedAuthorityStateDigest,
      sourceRecordDigest,
    }, {
      taskId: context.taskId,
      reason: normalizedReason,
      sourceAuthority: normalizedAuthority,
      authorityStateDigest: normalizedAuthorityStateDigest,
      sourceRecordDigest,
    }),
    evidence: [
      `supersedes-work-authority-binding:${normalizedAuthority.bindingDigest}`,
    ],
    tags: ["work", "authority", "supersession", "obsolete"],
    sourceUrl: context.sourceUrl,
    subjectNumber: context.subjectNumber,
  });
  const core = eventCore({
    schemaVersion: 2,
    sequence: normalizedSequence,
    previousDigest: normalizedPreviousDigest,
    ledgerRevision: normalizedLedgerRevision,
    taskId: context.taskId,
    taskRevision: normalizedTaskRevision,
    recordRevision: normalizedTaskRevision,
    sourceRecordDigest,
    kind: "authority_invalidated",
    occurredAt: normalizedOccurredAt,
    sourceAuthority: normalizedAuthority,
    authorityStateDigest: normalizedAuthorityStateDigest,
    memoryRecord,
  });
  const eventDigest = digestValue(core);
  return {
    ...core,
    eventId: `work-graph-memory-event-${eventDigest}`,
    eventDigest,
  };
}

export function createWorkGraphAuthorityObservationEvent({
  sequence,
  previousDigest,
  ledgerRevision,
  taskRevision,
  item,
  occurredAt,
  sourceAuthority,
  authorityStateDigest,
}) {
  const normalizedSequence = integer(sequence, "sequence", 1);
  const normalizedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, "previousDigest");
  if ((normalizedSequence === 1) !== (normalizedPreviousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const normalizedLedgerRevision = integer(ledgerRevision, "ledgerRevision", 1);
  const normalizedTaskRevision = integer(taskRevision, "taskRevision", 1);
  const normalizedOccurredAt = timestamp(occurredAt, "occurredAt");
  const normalizedAuthority = normalizeWorkGraphSourceAuthority(sourceAuthority);
  const normalizedAuthorityStateDigest = digest(
    authorityStateDigest,
    "authorityStateDigest",
  );
  if (!normalizedAuthority.applies || normalizedTaskRevision > normalizedLedgerRevision) {
    throw invalid("authority observation 无效");
  }
  const context = graphContext(item, normalizedAuthority);
  const sourceRecordDigest = digestValue({
    taskId: context.taskId,
    sourceAuthority: normalizedAuthority,
    authorityStateDigest: normalizedAuthorityStateDigest,
  });
  const memoryRecord = rawMemoryRecord({
    schemaVersion: 1,
    source: {
      kind: "work-authority-lifecycle",
      id:
        `${context.taskId}:authority-observed:${normalizedAuthority.bindingDigest}:` +
        `ledger:${normalizedLedgerRevision}`,
    },
    occurredAt: normalizedOccurredAt,
    roleId: null,
    repository: context.repository,
    eventType: "work.authority_observed",
    title: memoryTitle("PR 工作来源权威已核验：", context.title),
    summary: normalizedAuthority.citable
      ? "当前 PR 来源绑定可用于工作结论"
      : "当前 PR 来源绑定不可用于工作结论",
    content: memoryContent({
      projectionSchemaVersion: 2,
      taskId: context.taskId,
      sourceAuthority: normalizedAuthority,
      authorityStateDigest: normalizedAuthorityStateDigest,
      sourceRecordDigest,
    }, {
      taskId: context.taskId,
      sourceAuthority: normalizedAuthority,
      authorityStateDigest: normalizedAuthorityStateDigest,
      sourceRecordDigest,
    }),
    evidence: [],
    tags: ["work", "authority", "observation", "obsolete"],
    sourceUrl: context.sourceUrl,
    subjectNumber: context.subjectNumber,
  });
  const core = eventCore({
    schemaVersion: 2,
    sequence: normalizedSequence,
    previousDigest: normalizedPreviousDigest,
    ledgerRevision: normalizedLedgerRevision,
    taskId: context.taskId,
    taskRevision: normalizedTaskRevision,
    recordRevision: normalizedTaskRevision,
    sourceRecordDigest,
    kind: "authority_observed",
    occurredAt: normalizedOccurredAt,
    sourceAuthority: normalizedAuthority,
    authorityStateDigest: normalizedAuthorityStateDigest,
    memoryRecord,
  });
  const eventDigest = digestValue(core);
  return {
    ...core,
    eventId: `work-graph-memory-event-${eventDigest}`,
    eventDigest,
  };
}

export function normalizeWorkGraphMemoryEvent(value) {
  try {
    const schemaVersion = value?.schemaVersion;
    const fields = exact(
      value,
      [
        "schemaVersion",
        "sequence",
        "eventId",
        "eventDigest",
        "previousDigest",
        "ledgerRevision",
        "taskId",
        "taskRevision",
        "recordRevision",
        "sourceRecordDigest",
        "kind",
        "occurredAt",
        ...(schemaVersion === 2
          ? ["sourceAuthority", "authorityStateDigest"]
          : []),
        "memoryRecord",
      ],
      "任务图记忆事件",
    );
    if (![1, 2].includes(schemaVersion)) throw invalid("schemaVersion 无效");
    const sequence = integer(fields.get("sequence"), "sequence", 1);
    const previousDigest = fields.get("previousDigest") === null
      ? null
      : digest(fields.get("previousDigest"), "previousDigest");
    if ((sequence === 1) !== (previousDigest === null)) {
      throw invalid("previousDigest 与 sequence 不一致");
    }
    const kind = fields.get("kind");
    if (
      !EVENT_KINDS.has(kind) ||
      (schemaVersion === 1 && kind === "authority_invalidated")
    ) {
      throw invalid("kind 无效");
    }
    const event = {
      schemaVersion,
      sequence,
      eventId: text(fields.get("eventId"), "eventId", 128),
      eventDigest: digest(fields.get("eventDigest"), "eventDigest"),
      previousDigest,
      ledgerRevision: integer(fields.get("ledgerRevision"), "ledgerRevision", 1),
      taskId: text(fields.get("taskId"), "taskId", 192),
      taskRevision: integer(fields.get("taskRevision"), "taskRevision", 1),
      recordRevision: integer(fields.get("recordRevision"), "recordRevision", 1),
      sourceRecordDigest: digest(
        fields.get("sourceRecordDigest"),
        "sourceRecordDigest",
      ),
      kind,
      occurredAt: timestamp(fields.get("occurredAt"), "occurredAt"),
      ...(schemaVersion === 2
        ? {
            sourceAuthority: normalizeWorkGraphSourceAuthority(fields.get("sourceAuthority")),
            authorityStateDigest: digest(
              fields.get("authorityStateDigest"),
              "authorityStateDigest",
            ),
          }
        : {}),
      memoryRecord: rawMemoryRecord(fields.get("memoryRecord")),
    };
    if (event.taskRevision > event.ledgerRevision) {
      throw invalid("任务图记忆事件修订无效");
    }
    const expectedSource = kind === "authority_invalidated"
      ? {
          kind: "work-authority-lifecycle",
          id:
            `${event.taskId}:authority:${event.sourceAuthority.bindingDigest}:` +
            `ledger:${event.ledgerRevision}`,
          eventType: "work.authority_invalidated",
        }
      : kind === "authority_observed"
        ? {
            kind: "work-authority-lifecycle",
            id:
              `${event.taskId}:authority-observed:` +
              `${event.sourceAuthority.bindingDigest}:ledger:${event.ledgerRevision}`,
            eventType: "work.authority_observed",
          }
      : kind === "acceptance_contract"
      ? {
          kind: "work-contract",
          id: `${event.taskId}:contract:${event.recordRevision}`,
          eventType: "work.acceptance_contract",
        }
      : {
          kind: "work-delivery",
          id: `${event.taskId}:delivery:${event.recordRevision}`,
          eventType: `work.${kind}`,
        };
    if (
      event.memoryRecord.source.kind !== expectedSource.kind ||
      event.memoryRecord.source.id !== expectedSource.id ||
      event.memoryRecord.eventType !== expectedSource.eventType ||
      event.memoryRecord.occurredAt !== event.occurredAt
    ) {
      throw invalid("任务图记忆记录与事件来源不一致");
    }
    if (schemaVersion === 2) {
      let content;
      try {
        content = JSON.parse(event.memoryRecord.content);
      } catch {
        throw invalid("任务图记忆记录来源绑定无效");
      }
      if (
        !isDeepStrictEqual(content?.sourceAuthority, event.sourceAuthority) ||
        (["authority_invalidated", "authority_observed"].includes(kind) &&
          content?.authorityStateDigest !== event.authorityStateDigest)
      ) {
        throw invalid("任务图记忆记录来源绑定无效");
      }
      if (
        kind === "authority_invalidated" &&
        (!event.sourceAuthority.applies ||
          event.sourceAuthority.citable ||
          !event.memoryRecord.evidence.includes(
            `supersedes-work-authority-binding:${event.sourceAuthority.bindingDigest}`,
          ))
      ) {
        throw invalid("任务图记忆权威失效记录无效");
      }
      if (
        kind === "authority_observed" &&
        (!event.sourceAuthority.applies ||
          event.memoryRecord.evidence.length !== 0)
      ) {
        throw invalid("任务图记忆权威观察记录无效");
      }
    }
    const eventDigest = digestValue(eventCore(event));
    if (
      event.eventDigest !== eventDigest ||
      event.eventId !== `work-graph-memory-event-${eventDigest}` ||
      Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES
    ) {
      throw invalid("任务图记忆事件摘要或容量无效");
    }
    return event;
  } catch (error) {
    if (error instanceof WorkGraphMemoryEventError) throw error;
    throw invalid("任务图记忆事件无效", error);
  }
}

export function memoryRecordForWorkGraphMemoryEvent(value) {
  return structuredClone(normalizeWorkGraphMemoryEvent(value).memoryRecord);
}

export function workGraphMemoryRecordReceipt(value) {
  const event = normalizeWorkGraphMemoryEvent(value);
  const record = normalizeMemoryRecord(event.memoryRecord);
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    taskId: event.taskId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: record.recordId,
    memoryRecordDigest: record.contentDigest,
  };
}
