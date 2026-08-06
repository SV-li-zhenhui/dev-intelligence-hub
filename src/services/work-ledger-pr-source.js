import { isDeepStrictEqual } from "node:util";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import {
  SHA256_PATTERN,
  boundedLedgerString,
  canonicalLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTarget,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";

const SOURCE_KEYS = [
  "schemaVersion",
  "kind",
  "workKey",
  "identity",
  "inputRevision",
  "activeRevision",
  "headRevision",
  "pendingRevision",
  "current",
  "pending",
  "revisions",
  "bindings",
];
const IDENTITY_KEYS = [
  "provider",
  "scopeId",
  "subjectId",
  "repository",
  "pullRequestNumber",
  "targetRoleId",
];
const CURRENT_KEYS = [
  "sourceSequence",
  "eventId",
  "eventDigest",
  "inputDigest",
  "occurredAt",
  "headRefOid",
  "event",
];
const REVISION_KEYS = [
  "revision",
  "eventId",
  "eventDigest",
  "inputDigest",
  "occurredAt",
  "headRevision",
  "headRefOid",
  "previousHeadRefOid",
  "disposition",
];
const BINDING_KEYS = [
  "sourceSequence",
  "assignmentId",
  "assignmentDigest",
  "eventId",
  "inputRevision",
];
const INPUT_BINDING_KEYS = [
  "kind",
  "rootItemId",
  "workKey",
  "inputRevision",
  "headRevision",
  "headRefOid",
  "eventId",
  "eventDigest",
  "inputDigest",
];
const DISPOSITIONS = new Set([
  "accepted",
  "ignored_stale",
  "ignored_unproven_head",
]);
const MAX_TEXT_BYTES = 512;

export const LEGACY_PR_SOURCE_CUTOVER_REASON = "pr_source_legacy_cutover";
export const LEGACY_PR_SOURCE_QUARANTINE_KIND =
  "legacy_pull_request_source";

function invalid(message, code = "WORK_LEDGER_PR_SOURCE_INVALID") {
  return workLedgerError(code, message, 409);
}

function text(value, name, maximumBytes = MAX_TEXT_BYTES) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function digest(value, name) {
  const normalized = text(value, name, 64);
  if (!SHA256_PATTERN.test(normalized)) throw invalid(`${name} 无效`);
  return normalized;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function optionalPositiveInteger(value, name) {
  return value === null ? null : positiveInteger(value, name);
}

function plainArray(value, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function canonical(value, name) {
  try {
    return canonicalLedgerValue(value, {
      maximumEntries: 30_000,
      errorCode: "WORK_LEDGER_PR_SOURCE_INVALID",
    });
  } catch (error) {
    if (error?.code === "WORK_LEDGER_PR_SOURCE_INVALID") throw error;
    throw invalid(`${name} 无效`);
  }
}

function storedEvent(value) {
  try {
    return normalizeStoredWorkflowEvent(canonical(value, "event"));
  } catch {
    throw invalid("PR 来源事件无效");
  }
}

function exact(value, keys, name) {
  if (!hasExactLedgerKeys(value, keys)) throw invalid(`${name} 字段无效`);
  return value;
}

function head(value, name) {
  return text(value, name, 256);
}

function previousHead(value) {
  return value === null ? null : head(value, "previousHeadRefOid");
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function assignmentDigest(assignment, event) {
  return ledgerDigest({ assignment, event }, { maximumEntries: 30_000 });
}

function sourceInputDigest(workKey, event) {
  return ledgerDigest({ workKey, event }, { maximumEntries: 30_000 });
}

function identityFor(assignment, event) {
  let target;
  try {
    target = normalizeLedgerTarget(assignment.target);
  } catch {
    return null;
  }
  if (
    target.type !== "role" ||
    target.id !== "pr-engineer" ||
    !event.eventType.startsWith("pull_request.") ||
    event.source.provider !== "github"
  ) {
    return null;
  }
  return {
    provider: text(event.source.provider, "provider", 128),
    scopeId: text(event.source.scopeId, "scopeId", 256),
    subjectId: text(event.subject.id, "subjectId", 512),
    repository: text(event.subject.repository, "repository", 140),
    pullRequestNumber: positiveInteger(
      event.subject.number,
      "pullRequestNumber",
    ),
    targetRoleId: target.id,
  };
}

function workKeyFor(identity) {
  return `pr-work-${ledgerDigest(identity)}`;
}

function normalizedEnvelope(value) {
  const sequence = positiveInteger(value.sequence, "sourceSequence");
  const assignment = canonical(value.assignment, "assignment");
  const rawEvent = canonical(value.event, "event");
  if (
    assignment.target?.type !== "role" ||
    assignment.target?.id !== "pr-engineer" ||
    typeof rawEvent.eventType !== "string" ||
    !rawEvent.eventType.startsWith("pull_request.")
  ) {
    return null;
  }
  const event = storedEvent(rawEvent);
  const identity = identityFor(assignment, event);
  if (identity === null) return null;
  const assignmentId = text(
    assignment.assignmentId,
    "assignmentId",
    192,
  );
  if (assignment.eventId !== undefined && assignment.eventId !== event.eventId) {
    throw invalid("PR 分派与事件绑定不一致");
  }
  const workKey = workKeyFor(identity);
  const headRefOid = head(event.payload.headRefOid, "headRefOid");
  return {
    sequence,
    assignment,
    assignmentId,
    assignmentDigest: assignmentDigest(assignment, event),
    event,
    identity,
    workKey,
    headRefOid,
    previousHeadRefOid: event.payload.previousHeadRefOid === undefined
      ? null
      : previousHead(event.payload.previousHeadRefOid),
    inputDigest: sourceInputDigest(workKey, event),
  };
}

function revisionFrom(input, revision, headRevision, disposition) {
  return {
    revision,
    eventId: input.event.eventId,
    eventDigest: input.event.contentDigest,
    inputDigest: input.inputDigest,
    occurredAt: input.event.occurredAt,
    headRevision,
    headRefOid: input.headRefOid,
    previousHeadRefOid: input.previousHeadRefOid,
    disposition,
  };
}

function bindingFrom(input, inputRevision) {
  return {
    sourceSequence: input.sequence,
    assignmentId: input.assignmentId,
    assignmentDigest: input.assignmentDigest,
    eventId: input.event.eventId,
    inputRevision,
  };
}

function currentFrom(input) {
  return {
    sourceSequence: input.sequence,
    eventId: input.event.eventId,
    eventDigest: input.event.contentDigest,
    inputDigest: input.inputDigest,
    occurredAt: input.event.occurredAt,
    headRefOid: input.headRefOid,
    event: structuredClone(input.event),
  };
}

export function pullRequestWorkDescriptor(envelope) {
  return normalizedEnvelope(envelope);
}

export function createPullRequestWorkSource(envelope) {
  const input = normalizedEnvelope(envelope);
  if (input === null) return null;
  return {
    descriptor: input,
    source: {
      schemaVersion: 1,
      kind: "pull_request",
      workKey: input.workKey,
      identity: input.identity,
      inputRevision: 1,
      activeRevision: 1,
      headRevision: 1,
      pendingRevision: null,
      current: currentFrom(input),
      pending: null,
      revisions: [revisionFrom(input, 1, 1, "accepted")],
      bindings: [bindingFrom(input, 1)],
    },
  };
}

function latestObservedInput(source) {
  return source.pending ?? source.current;
}

function acceptedHeadChange(source, input) {
  const observed = latestObservedInput(source);
  if (input.headRefOid === observed.headRefOid) return true;
  return (
    input.event.eventType === "pull_request.updated" &&
    Array.isArray(input.event.payload.changedFields) &&
    input.event.payload.changedFields.includes("headRefOid") &&
    input.previousHeadRefOid === observed.headRefOid
  );
}

export function appendPullRequestWorkSource(
  value,
  envelope,
  { activate = true } = {},
) {
  if (typeof activate !== "boolean") throw invalid("PR 来源激活选项无效");
  const source = normalizePullRequestWorkSource(value);
  const input = normalizedEnvelope(envelope);
  if (input === null || input.workKey !== source.workKey) {
    throw invalid("PR 来源工作键不一致");
  }
  const lastBinding = source.bindings.at(-1);
  if (input.sequence <= lastBinding.sourceSequence) {
    throw invalid("PR 来源分派序号没有递增");
  }
  const duplicateBinding = source.bindings.find(
    ({ assignmentId }) => assignmentId === input.assignmentId,
  );
  if (duplicateBinding) {
    if (
      duplicateBinding.sourceSequence === input.sequence &&
      duplicateBinding.assignmentDigest === input.assignmentDigest
    ) {
      return { source, changed: false, disposition: "duplicate" };
    }
    throw invalid("相同 PR assignmentId 对应不同输入");
  }

  const existingRevision = source.revisions.find(
    ({ eventId }) => eventId === input.event.eventId,
  );
  if (existingRevision) {
    if (
      existingRevision.eventDigest !== input.event.contentDigest ||
      existingRevision.inputDigest !== input.inputDigest
    ) {
      throw invalid("相同 PR eventId 对应不同输入");
    }
    return {
      source: {
        ...source,
        bindings: [
          ...source.bindings,
          bindingFrom(input, existingRevision.revision),
        ],
      },
      changed: true,
      disposition: "bound_existing_event",
      headAdvanced: false,
      activeAdvanced: false,
    };
  }

  const revision = source.inputRevision + 1;
  const observed = latestObservedInput(source);
  const stale = Date.parse(input.event.occurredAt) <
    Date.parse(observed.occurredAt);
  const headChanged = input.headRefOid !== observed.headRefOid;
  const headProven = acceptedHeadChange(source, input);
  const disposition = stale
    ? "ignored_stale"
    : headChanged && !headProven
      ? "ignored_unproven_head"
      : "accepted";
  const accepted = disposition === "accepted";
  const headRevision = accepted && headChanged
    ? source.headRevision + 1
    : source.headRevision;
  return {
    source: {
      ...source,
      inputRevision: revision,
      activeRevision: accepted && activate ? revision : source.activeRevision,
      headRevision: accepted ? headRevision : source.headRevision,
      pendingRevision: accepted
        ? activate ? null : revision
        : source.pendingRevision,
      current: accepted && activate ? currentFrom(input) : source.current,
      pending: accepted
        ? activate ? null : currentFrom(input)
        : source.pending,
      revisions: [
        ...source.revisions,
        revisionFrom(
          input,
          revision,
          accepted ? headRevision : null,
          disposition,
        ),
      ],
      bindings: [...source.bindings, bindingFrom(input, revision)],
    },
    changed: true,
    disposition,
    headAdvanced: accepted && headChanged,
    activeAdvanced: accepted && activate,
  };
}

function normalizeIdentity(value) {
  exact(value, IDENTITY_KEYS, "PR identity");
  return {
    provider: text(value.provider, "identity.provider", 128),
    scopeId: text(value.scopeId, "identity.scopeId", 256),
    subjectId: text(value.subjectId, "identity.subjectId", 512),
    repository: text(value.repository, "identity.repository", 140),
    pullRequestNumber: positiveInteger(
      value.pullRequestNumber,
      "identity.pullRequestNumber",
    ),
    targetRoleId: text(value.targetRoleId, "identity.targetRoleId", 128),
  };
}

function normalizeRevision(value, expectedRevision) {
  exact(value, REVISION_KEYS, "PR input revision");
  const revision = positiveInteger(value.revision, "inputRevision.revision");
  const disposition = text(value.disposition, "disposition", 64);
  if (revision !== expectedRevision || !DISPOSITIONS.has(disposition)) {
    throw invalid("PR input revision 顺序或结果无效");
  }
  const headRevision = optionalPositiveInteger(
    value.headRevision,
    "inputRevision.headRevision",
  );
  if ((disposition === "accepted") !== (headRevision !== null)) {
    throw invalid("PR input revision Head epoch 无效");
  }
  return {
    revision,
    eventId: text(value.eventId, "inputRevision.eventId", 192),
    eventDigest: digest(value.eventDigest, "inputRevision.eventDigest"),
    inputDigest: digest(value.inputDigest, "inputRevision.inputDigest"),
    occurredAt: timestamp(value.occurredAt, "inputRevision.occurredAt"),
    headRevision,
    headRefOid: head(value.headRefOid, "inputRevision.headRefOid"),
    previousHeadRefOid: previousHead(value.previousHeadRefOid),
    disposition,
  };
}

function normalizeBinding(value, revisionsByEvent, previousSequence) {
  exact(value, BINDING_KEYS, "PR assignment binding");
  const sourceSequence = positiveInteger(
    value.sourceSequence,
    "binding.sourceSequence",
  );
  const eventId = text(value.eventId, "binding.eventId", 192);
  const inputRevision = positiveInteger(
    value.inputRevision,
    "binding.inputRevision",
  );
  if (
    sourceSequence <= previousSequence ||
    revisionsByEvent.get(eventId)?.revision !== inputRevision
  ) {
    throw invalid("PR assignment binding 顺序或输入引用无效");
  }
  return {
    sourceSequence,
    assignmentId: text(value.assignmentId, "binding.assignmentId", 192),
    assignmentDigest: digest(
      value.assignmentDigest,
      "binding.assignmentDigest",
    ),
    eventId,
    inputRevision,
  };
}

function normalizeEventPointer(
  value,
  source,
  revisionsByEvent,
  expectedRevision,
  name,
) {
  exact(value, CURRENT_KEYS, name);
  const event = storedEvent(value.event);
  const revision = revisionsByEvent.get(event.eventId);
  const current = {
    sourceSequence: positiveInteger(
      value.sourceSequence,
      "current.sourceSequence",
    ),
    eventId: text(value.eventId, "current.eventId", 192),
    eventDigest: digest(value.eventDigest, "current.eventDigest"),
    inputDigest: digest(value.inputDigest, "current.inputDigest"),
    occurredAt: timestamp(value.occurredAt, "current.occurredAt"),
    headRefOid: head(value.headRefOid, "current.headRefOid"),
    event: structuredClone(event),
  };
  if (
    !revision ||
    revision.revision !== expectedRevision ||
    revision.disposition !== "accepted" ||
    current.eventId !== event.eventId ||
    current.eventDigest !== event.contentDigest ||
    current.eventDigest !== revision.eventDigest ||
    current.inputDigest !== revision.inputDigest ||
    current.inputDigest !== sourceInputDigest(source.workKey, event) ||
    current.occurredAt !== event.occurredAt ||
    current.headRefOid !== event.payload.headRefOid ||
    current.headRefOid !== revision.headRefOid
  ) {
    throw invalid("PR current input 绑定无效");
  }
  return current;
}

export function normalizePullRequestWorkSource(value) {
  exact(value, SOURCE_KEYS, "PR source");
  if (value.schemaVersion !== 1 || value.kind !== "pull_request") {
    throw invalid("PR source 版本或类型无效");
  }
  const identity = normalizeIdentity(value.identity);
  const workKey = text(value.workKey, "workKey", 128);
  if (workKey !== workKeyFor(identity)) throw invalid("PR workKey 绑定无效");
  const inputRevision = positiveInteger(value.inputRevision, "inputRevision");
  const activeRevision = positiveInteger(value.activeRevision, "activeRevision");
  const headRevision = positiveInteger(value.headRevision, "headRevision");
  const pendingRevision = optionalPositiveInteger(
    value.pendingRevision,
    "pendingRevision",
  );
  const revisions = plainArray(value.revisions, "revisions").map(
    (revision, index) => normalizeRevision(revision, index + 1),
  );
  if (revisions.length !== inputRevision || activeRevision > inputRevision) {
    throw invalid("PR source revision 指针无效");
  }
  const eventIds = revisions.map(({ eventId }) => eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw invalid("PR source eventId 重复");
  }
  let previousHeadRevision = 0;
  let previousAcceptedHead = null;
  for (const revision of revisions) {
    if (revision.disposition !== "accepted") continue;
    if (
      ![previousHeadRevision, previousHeadRevision + 1].includes(
        revision.headRevision,
      ) ||
      (revision.headRevision === previousHeadRevision + 1 &&
        previousHeadRevision > 0 &&
        revision.previousHeadRefOid !== previousAcceptedHead) ||
      (revision.headRevision === previousHeadRevision &&
        revision.headRefOid !== previousAcceptedHead)
    ) {
      throw invalid("PR Head epoch 历史无效");
    }
    previousHeadRevision = revision.headRevision;
    previousAcceptedHead = revision.headRefOid;
  }
  const acceptedRevisions = revisions.filter(
    ({ disposition }) => disposition === "accepted",
  );
  const latestAccepted = acceptedRevisions.at(-1);
  if (
    previousHeadRevision !== headRevision ||
    !latestAccepted ||
    (pendingRevision === null && activeRevision !== latestAccepted.revision) ||
    (pendingRevision !== null &&
      (pendingRevision !== latestAccepted.revision ||
        pendingRevision <= activeRevision))
  ) {
    throw invalid("PR Head epoch 指针无效");
  }
  const revisionsByEvent = new Map(
    revisions.map((revision) => [revision.eventId, revision]),
  );
  let previousSequence = 0;
  const bindings = plainArray(value.bindings, "bindings").map((binding) => {
    const normalized = normalizeBinding(
      binding,
      revisionsByEvent,
      previousSequence,
    );
    previousSequence = normalized.sourceSequence;
    return normalized;
  });
  if (
    bindings.length === 0 ||
    new Set(bindings.map(({ assignmentId }) => assignmentId)).size !==
      bindings.length
  ) {
    throw invalid("PR assignment binding 历史无效");
  }
  const source = {
    schemaVersion: 1,
    kind: "pull_request",
    workKey,
    identity,
    inputRevision,
    activeRevision,
    headRevision,
    pendingRevision,
    current: null,
    pending: null,
    revisions,
    bindings,
  };
  source.current = normalizeEventPointer(
    value.current,
    source,
    revisionsByEvent,
    activeRevision,
    "PR current input",
  );
  if (pendingRevision === null) {
    if (value.pending !== null) throw invalid("PR pending input 指针无效");
  } else {
    if (value.pending === null) throw invalid("PR pending input 指针无效");
    source.pending = normalizeEventPointer(
      value.pending,
      source,
      revisionsByEvent,
      pendingRevision,
      "PR pending input",
    );
  }
  if (
    !bindings.some(
      ({ sourceSequence, eventId }) =>
        sourceSequence === source.current.sourceSequence &&
        eventId === source.current.eventId,
    )
  ) {
    throw invalid("PR current input 没有分派来源");
  }
  if (
    source.pending !== null &&
    !bindings.some(
      ({ sourceSequence, eventId }) =>
        sourceSequence === source.pending.sourceSequence &&
        eventId === source.pending.eventId,
    )
  ) {
    throw invalid("PR pending input 没有分派来源");
  }
  return source;
}

export function currentWorkItemEvent(item) {
  return item?.source?.kind === "pull_request"
    ? item.source.current.event
    : item?.event;
}

export function currentWorkItemInputBinding(item) {
  if (item?.source?.kind === "pull_request") {
    const revision = item.source.revisions[item.source.activeRevision - 1];
    return Object.freeze({
      kind: "pull_request",
      rootItemId: item.itemId,
      workKey: item.source.workKey,
      inputRevision: item.source.activeRevision,
      headRevision: revision.headRevision,
      headRefOid: item.source.current.headRefOid,
      eventId: item.source.current.eventId,
      eventDigest: item.source.current.eventDigest,
      inputDigest: item.source.current.inputDigest,
    });
  }
  const inherited = item?.kind === "graph_task"
    ? item.assignment?.graphTask?.sourceBinding
    : null;
  return inherited === null || inherited === undefined
    ? null
    : Object.freeze(normalizePullRequestInputBinding(inherited));
}

export function normalizePullRequestInputBinding(value) {
  exact(value, INPUT_BINDING_KEYS, "PR input binding");
  if (value.kind !== "pull_request") throw invalid("PR input binding 类型无效");
  return {
    kind: "pull_request",
    rootItemId: text(value.rootItemId, "inputBinding.rootItemId", 192),
    workKey: text(value.workKey, "inputBinding.workKey", 128),
    inputRevision: positiveInteger(
      value.inputRevision,
      "inputBinding.inputRevision",
    ),
    headRevision: positiveInteger(
      value.headRevision,
      "inputBinding.headRevision",
    ),
    headRefOid: head(value.headRefOid, "inputBinding.headRefOid"),
    eventId: text(value.eventId, "inputBinding.eventId", 192),
    eventDigest: digest(value.eventDigest, "inputBinding.eventDigest"),
    inputDigest: digest(value.inputDigest, "inputBinding.inputDigest"),
  };
}

export function pullRequestHeadAdmission(state, item) {
  const binding = currentWorkItemInputBinding(item);
  if (binding === null) {
    return Object.freeze({ applies: false, current: true, pending: false });
  }
  const root = state?.items?.find(
    (candidate) => candidate.itemId === binding.rootItemId,
  );
  const current = root?.source?.kind === "pull_request"
    ? currentWorkItemInputBinding(root)
    : null;
  const matches =
    current !== null &&
    binding.workKey === current.workKey &&
    binding.headRevision === current.headRevision &&
    binding.headRefOid === current.headRefOid;
  return Object.freeze({
    applies: true,
    current: matches,
    pending:
      root?.source?.kind === "pull_request" &&
      root.source.pendingRevision !== null,
    rootItemId: binding.rootItemId,
    headRevision: binding.headRevision,
    currentHeadRevision: current?.headRevision ?? null,
  });
}

export function activatePendingPullRequestWorkSource(value) {
  const source = normalizePullRequestWorkSource(value);
  if (source.pendingRevision === null) {
    return { source, changed: false };
  }
  return {
    source: normalizePullRequestWorkSource({
      ...source,
      activeRevision: source.pendingRevision,
      pendingRevision: null,
      current: source.pending,
      pending: null,
    }),
    changed: true,
  };
}

export function hasPendingPullRequestSource(item) {
  return item?.source?.kind === "pull_request" &&
    item.source.pendingRevision !== null;
}

export function validatePullRequestSourceTransition(previousItems, nextItems) {
  const nextById = new Map(nextItems.map((item) => [item.itemId, item]));
  for (const previous of previousItems) {
    if (previous.source?.kind !== "pull_request") continue;
    const next = nextById.get(previous.itemId);
    if (!next || next.source?.kind !== "pull_request") {
      throw invalid("PR source root 不能删除", "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID");
    }
    const previousSource = normalizePullRequestWorkSource(previous.source);
    const nextSource = normalizePullRequestWorkSource(next.source);
    if (
      previousSource.workKey !== nextSource.workKey ||
      nextSource.inputRevision < previousSource.inputRevision ||
      nextSource.activeRevision < previousSource.activeRevision ||
      nextSource.headRevision < previousSource.headRevision ||
      (previousSource.pendingRevision !== null &&
        nextSource.pendingRevision !== null &&
        nextSource.pendingRevision < previousSource.pendingRevision) ||
      (previousSource.pendingRevision !== null &&
        nextSource.pendingRevision === null &&
        nextSource.activeRevision < previousSource.pendingRevision) ||
      (nextSource.activeRevision === previousSource.activeRevision &&
        !isDeepStrictEqual(previousSource.current, nextSource.current)) ||
      (nextSource.pendingRevision === previousSource.pendingRevision &&
        !isDeepStrictEqual(previousSource.pending, nextSource.pending)) ||
      !isDeepStrictEqual(
        previousSource.revisions,
        nextSource.revisions.slice(0, previousSource.revisions.length),
      ) ||
      !isDeepStrictEqual(
        previousSource.bindings,
        nextSource.bindings.slice(0, previousSource.bindings.length),
      )
    ) {
      throw invalid(
        "PR source history 只能追加",
        "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
      );
    }
  }
}
