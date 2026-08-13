import { assertExpectedWorkGraphRevision } from "./work-ledger-graph-command-support.js";
import { requireWorkLedgerItem } from "./work-ledger-item-commands.js";
import {
  activatePendingPullRequestWorkSource,
  currentWorkItemInputBinding,
  pullRequestHeadAdmission,
} from "./work-ledger-pr-source.js";
import { assertItemRevision } from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const ROOT_READY_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "completed",
  "superseded",
]);
const CHILD_SUPERSEDABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "blocked",
]);
const CHILD_TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "superseded",
]);
const CROSS_ROOT_RETIRABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "blocked",
]);
const CROSS_ROOT_FENCE_DISPOSITIONS = new Set([
  "ignored_authority_fence",
  "ignored_legacy_downgrade",
  "ignored_unproven_head",
]);

export const CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON =
  "pr_source_cross_root_cutover_pending";
export const CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON =
  "pr_source_cross_root_cutover_blocker";

function marker(reason, itemId) {
  return `${reason}:${itemId}`;
}

function markedItemId(statusReason, reason) {
  const prefix = `${reason}:`;
  if (typeof statusReason !== "string" || !statusReason.startsWith(prefix)) {
    return null;
  }
  const itemId = statusReason.slice(prefix.length);
  return itemId.length > 0 ? itemId : null;
}

export function crossRootPullRequestCutoverPendingReason(predecessorItemId) {
  return marker(
    CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
    normalizeItemId(predecessorItemId),
  );
}

export function crossRootPullRequestCutoverBlockerReason(pendingItemId) {
  return marker(
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON,
    normalizeItemId(pendingItemId),
  );
}

export function crossRootPullRequestCutoverPredecessorId(item) {
  return markedItemId(
    item?.statusReason,
    CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  );
}

export function crossRootPullRequestCutoverPendingId(item) {
  return markedItemId(
    item?.statusReason,
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON,
  );
}

function invalid(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_INVALID",
    message,
  );
}

function conflict(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    message,
    409,
  );
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function graphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expectedGraphRevision 无效");
  }
  return value;
}

function normalizeItemId(value) {
  try {
    return boundedLedgerString(value, "itemId", 192);
  } catch {
    throw invalid("itemId 无效");
  }
}

function normalizeCommand(value) {
  if (
    !hasExactLedgerKeys(value, [
      "itemId",
      "expectedGraphRevision",
      "expectedRevision",
      "expectedPendingRevision",
    ])
  ) {
    throw invalid("PR 来源对账命令无效");
  }
  return {
    itemId: normalizeItemId(value.itemId),
    expectedGraphRevision: graphRevision(value.expectedGraphRevision),
    expectedRevision: positiveRevision(
      value.expectedRevision,
      "expectedRevision",
    ),
    expectedPendingRevision: positiveRevision(
      value.expectedPendingRevision,
      "expectedPendingRevision",
    ),
  };
}

function pendingHeadChanged(source) {
  if (source.pendingRevision === null) return false;
  const active = source.revisions[source.activeRevision - 1];
  const pending = source.revisions[source.pendingRevision - 1];
  return active.headRevision !== pending.headRevision;
}

function definitivelySettledBlocked(item, outboxById) {
  if (item.status !== "blocked" || item.activeIntentId !== null) return false;
  if ([
    "pr_source_left_scope",
    "pr_source_reentered_scope_without_route",
  ].includes(item.statusReason)) {
    return true;
  }
  if (item.statusReason === "pr_source_cross_root_cutover_retired") {
    return true;
  }
  if (item.statusReason === "decision_attempts_exhausted") {
    return true;
  }
  if (
    item.statusReason === "attention_rejected" &&
    item.decisionContext?.source === "attention" &&
    item.decisionContext?.outcome === "rejected"
  ) {
    return true;
  }
  if (
    item.statusReason === "proposal_failed" &&
    item.decisionContext?.source === "proposal" &&
    item.decisionContext?.outcome === "failed"
  ) {
    return true;
  }
  if (item.statusReason !== "intent_failed") return false;
  return [...outboxById.values()].some(
    (outbox) =>
      outbox.itemId === item.itemId &&
      outbox.inputDigest === item.inputDigest &&
      outbox.status === "failed" &&
      outbox.outcome?.status === "failed" &&
      outbox.updatedAt === item.updatedAt,
  );
}

function sourceEpochChildren(items, root) {
  const active = currentWorkItemInputBinding(root);
  return items.filter((item) => {
    const binding = currentWorkItemInputBinding(item);
    return (
      item.itemId !== root.itemId &&
      binding?.rootItemId === root.itemId &&
      binding.headRevision === active.headRevision
    );
  });
}

function unstartedIntent(item, outboxById) {
  if (item.status !== "dispatch_pending" || item.activeIntentId === null) {
    return null;
  }
  const outbox = outboxById.get(item.activeIntentId);
  if (
    outbox?.status === "pending" ||
    (outbox?.status === "dispatching" && outbox.dispatchBinding === null)
  ) {
    return outbox;
  }
  return null;
}

export function inspectPullRequestSourceCutover(
  root,
  items,
  outboxById,
  { forceHeadChanged = false } = {},
) {
  const headChanged = forceHeadChanged || pendingHeadChanged(root.source);
  const participants = [
    root,
    ...(headChanged ? sourceEpochChildren(items, root) : []),
  ];
  const blockers = participants.filter((item) => {
    if (item.itemId === root.itemId) {
      return !ROOT_READY_STATUSES.has(item.status) &&
        !definitivelySettledBlocked(item, outboxById) &&
        unstartedIntent(item, outboxById) === null;
    }
    return !CHILD_TERMINAL_STATUSES.has(item.status) &&
      !CHILD_SUPERSEDABLE_STATUSES.has(item.status) &&
      !definitivelySettledBlocked(item, outboxById) &&
      unstartedIntent(item, outboxById) === null;
  });
  return { blockers, headChanged, participants };
}

export function crossRootPullRequestCutoverActivation(root, activation) {
  return {
    ...activation,
    participants: activation.participants.filter(
      (participant) =>
        participant.itemId === root.itemId ||
        !CHILD_TERMINAL_STATUSES.has(participant.status),
    ),
  };
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

export function registeredCrossRootPullRequestCutover(
  state,
  item,
  outbox = null,
) {
  const pendingItemId = crossRootPullRequestCutoverPendingId(item);
  if (pendingItemId === null) return null;
  const pendingRoot = state.items.find(
    (candidate) => candidate.itemId === pendingItemId,
  );
  const predecessorItemId = crossRootPullRequestCutoverPredecessorId(
    pendingRoot,
  );
  const predecessor = state.items.find(
    (candidate) => candidate.itemId === predecessorItemId,
  );
  const protectedParticipant = predecessor === undefined
    ? false
    : item.itemId === predecessor.itemId ||
      sourceEpochChildren(state.items, predecessor).some(
        (candidate) => candidate.itemId === item.itemId,
      );
  if (
    pendingRoot?.kind !== "source_root" ||
    pendingRoot.status !== "blocked" ||
    predecessor?.kind !== "source_root" ||
    !samePullRequestSubject(predecessor, pendingRoot) ||
    !protectedParticipant
  ) {
    return null;
  }
  if (outbox !== null) {
    const current = currentWorkItemInputBinding(item);
    const binding = outbox.sourceBinding;
    if (
      current === null ||
      outbox.itemId !== item.itemId ||
      binding?.rootItemId !== current.rootItemId ||
      binding.workKey !== current.workKey ||
      binding.inputRevision !== current.inputRevision ||
      binding.headRevision !== current.headRevision ||
      binding.headRefOid !== current.headRefOid ||
      binding.eventId !== current.eventId ||
      binding.eventDigest !== current.eventDigest ||
      binding.inputDigest !== current.inputDigest
    ) {
      return null;
    }
  }
  return pendingRoot;
}

function failSupersededIntent(outbox, nextInputRevision, now) {
  return {
    ...outbox,
    status: "failed",
    revision: outbox.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: {
      status: "failed",
      details: {
        reason: "pr_source_superseded_before_dispatch",
        nextInputRevision,
      },
    },
    updatedAt: now,
  };
}

export function applyReadyPullRequestSourceCutover({
  root,
  activation,
  itemsById,
  outboxById,
  nextInputRevision,
  nextHeadRevision,
  now,
  timelineEvents,
}) {
  let rootResult = activation.headChanged
    ? { ...root, decisionContext: null }
    : root;
  for (const participant of activation.participants) {
    const activeOutbox = unstartedIntent(participant, outboxById);
    if (activeOutbox !== null) {
      outboxById.set(
        activeOutbox.intentId,
        failSupersededIntent(activeOutbox, nextInputRevision, now),
      );
      timelineEvents.push({
        itemId: participant.itemId,
        type: "intent_superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          intentId: activeOutbox.intentId,
          reason: "pr_source_superseded_before_dispatch",
          nextInputRevision,
        },
      });
      if (participant.itemId === root.itemId) {
        rootResult = {
          ...rootResult,
          status: "queued",
          activeIntentId: null,
          statusReason: "pr_source_revised",
        };
      }
    }
    if (
      activation.headChanged &&
      participant.itemId !== root.itemId &&
      participant.status !== "superseded"
    ) {
      const binding = currentWorkItemInputBinding(participant);
      const superseded = {
        ...participant,
        status: "superseded",
        revision: participant.revision + 1,
        ownerId: null,
        leaseId: null,
        leaseUntil: null,
        activeIntentId: null,
        availableAt: null,
        statusReason: "pr_head_superseded",
        updatedAt: now,
      };
      itemsById.set(superseded.itemId, superseded);
      timelineEvents.push({
        itemId: superseded.itemId,
        type: "superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          rootItemId: root.itemId,
          previousHeadRevision: binding.headRevision,
          nextHeadRevision,
        },
      });
    }
  }
  return rootResult;
}

export function retireCrossRootPullRequestPredecessor(root, now) {
  if (!CROSS_ROOT_RETIRABLE_STATUSES.has(root.status)) return root;
  return {
    ...root,
    status: "blocked",
    revision: root.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    activeIntentId: null,
    decisionContext: null,
    availableAt: null,
    statusReason: "pr_source_cross_root_cutover_retired",
    updatedAt: now,
  };
}

function publicBlockers(activation) {
  return activation.blockers.map((item) => ({
    itemId: item.itemId,
    status: item.status,
    reason: item.activeIntentId === null
      ? `status:${item.status}`
      : "active_intent",
    activeIntentId: item.activeIntentId,
  }));
}

function resultFor(stateRevision, root, applied, blockers) {
  return {
    applied,
    graphRevision: stateRevision,
    itemId: root.itemId,
    itemRevision: root.revision,
    activeRevision: root.source.activeRevision,
    pendingRevision: root.source.pendingRevision,
    blockers,
  };
}

function crossRootActivationRevision(root) {
  return root.source.pendingRevision ?? root.source.activeRevision;
}

function sourceObservationForRevision(source, inputRevision) {
  const revision = source.revisions[inputRevision - 1];
  const binding = source.bindings.find(
    (candidate) => candidate.inputRevision === inputRevision,
  );
  if (
    revision?.revision !== inputRevision ||
    binding?.eventId !== revision.eventId ||
    !Number.isSafeInteger(binding.sourceSequence) ||
    binding.sourceSequence < 1
  ) {
    throw conflict("跨来源 PR cutover 候选绑定无效");
  }
  return {
    inputRevision,
    sourceSequence: binding.sourceSequence,
  };
}

function fencedCandidateRevision(source) {
  return source.revisions.findLast(
    ({ revision, disposition }) =>
      revision > source.activeRevision &&
      CROSS_ROOT_FENCE_DISPOSITIONS.has(disposition),
  )?.revision ?? null;
}

export function crossRootPullRequestCutoverCandidate(root) {
  if (crossRootPullRequestCutoverPredecessorId(root) === null) return null;
  const inputRevision = root.source.pendingRevision ??
    fencedCandidateRevision(root.source) ??
    root.source.activeRevision;
  const observation = sourceObservationForRevision(root.source, inputRevision);
  const pointer = inputRevision === root.source.pendingRevision
    ? root.source.pending
    : inputRevision === root.source.activeRevision
      ? root.source.current
      : null;
  if (
    pointer !== null &&
    (pointer.sourceSequence !== observation.sourceSequence ||
      pointer.eventId !== root.source.revisions[inputRevision - 1].eventId)
  ) {
    throw conflict("跨来源 PR cutover 候选指针无效");
  }
  return observation;
}

function operationalPullRequestSourceObservation(root) {
  const observation = sourceObservationForRevision(
    root.source,
    root.source.activeRevision,
  );
  if (
    root.source.current.sourceSequence !== observation.sourceSequence ||
    root.source.current.eventId !==
      root.source.revisions[root.source.activeRevision - 1].eventId
  ) {
    throw conflict("跨来源 PR cutover 前驱指针无效");
  }
  return observation;
}

function assertCrossRootCutoverChain(root, predecessor) {
  const pendingSequence = crossRootPullRequestCutoverCandidate(root)
    ?.sourceSequence;
  const predecessorSequence = operationalPullRequestSourceObservation(
    predecessor,
  ).sourceSequence;
  if (
    predecessor.kind !== "source_root" ||
    predecessor.source?.kind !== "pull_request" ||
    predecessor.itemId === root.itemId ||
    !samePullRequestSubject(predecessor, root) ||
    predecessor.source.workKey === root.source.workKey ||
    !Number.isSafeInteger(pendingSequence) ||
    !Number.isSafeInteger(predecessorSequence) ||
    predecessorSequence >= pendingSequence
  ) {
    throw conflict("跨来源 PR cutover 绑定链无效");
  }
}

function planCrossRootPullRequestSourceReconciliation({
  state,
  command,
  root,
  predecessorItemId,
  clock,
}) {
  if (root.status !== "blocked") {
    throw conflict("跨来源 PR cutover 状态无效");
  }
  if (
    command.expectedPendingRevision !== crossRootActivationRevision(root)
  ) {
    throw conflict("PR 来源已不再指向预期版本");
  }
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(root, command.expectedRevision);
  const predecessor = state.items.find(
    (candidate) => candidate.itemId === predecessorItemId,
  );
  if (!predecessor) throw conflict("跨来源 PR cutover 前驱不存在");
  assertCrossRootCutoverChain(root, predecessor);
  const rootCandidateSequence = crossRootPullRequestCutoverCandidate(root)
    .sourceSequence;
  const newerPendingRoot = state.items.find(
    (candidate) =>
      candidate.itemId !== root.itemId &&
      samePullRequestSubject(candidate, root) &&
      crossRootPullRequestCutoverPredecessorId(candidate) ===
        predecessor.itemId &&
      crossRootPullRequestCutoverCandidate(candidate).sourceSequence >
        rootCandidateSequence,
  );
  if (newerPendingRoot !== undefined) {
    throw conflict("跨来源 PR cutover 已有更新的待激活来源");
  }
  const pendingAdmission = pullRequestHeadAdmission(state, root);
  if (pendingAdmission.applies && pendingAdmission.current !== true) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, [
        {
          itemId: root.itemId,
          status: root.status,
          reason: "source_authority_fenced",
          activeIntentId: null,
        },
      ]),
    };
  }

  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activation = inspectPullRequestSourceCutover(
    predecessor,
    state.items,
    outboxById,
    { forceHeadChanged: true },
  );
  if (
    activation.blockers.some(
      (blocker) =>
        crossRootPullRequestCutoverPendingId(blocker) !== root.itemId,
    )
  ) {
    throw conflict("跨来源 PR cutover blocker 标记无效");
  }
  const blockers = publicBlockers(activation);
  if (blockers.length > 0) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, blockers),
    };
  }

  const now = clock();
  const itemsById = new Map(
    state.items.map((item) => [item.itemId, item]),
  );
  const timelineEvents = [];
  const crossRootActivation = crossRootPullRequestCutoverActivation(
    predecessor,
    activation,
  );
  const locallySettledPredecessor = applyReadyPullRequestSourceCutover({
    root: predecessor,
    activation: crossRootActivation,
    itemsById,
    outboxById,
    nextInputRevision: crossRootActivationRevision(root),
    nextHeadRevision: root.source.headRevision,
    now,
    timelineEvents,
  });
  const settledPredecessor = retireCrossRootPullRequestPredecessor(
    locallySettledPredecessor,
    now,
  );
  itemsById.set(settledPredecessor.itemId, settledPredecessor);
  for (const item of itemsById.values()) {
    if (crossRootPullRequestCutoverPendingId(item) !== root.itemId) continue;
    itemsById.set(item.itemId, {
      ...item,
      revision: item.revision + 1,
      statusReason: item.statusReason ===
          crossRootPullRequestCutoverBlockerReason(root.itemId)
        ? null
        : item.statusReason,
      updatedAt: now,
    });
  }
  for (const item of itemsById.values()) {
    if (
      item.itemId === root.itemId ||
      !samePullRequestSubject(item, root) ||
      crossRootPullRequestCutoverPredecessorId(item) !== predecessor.itemId ||
      crossRootPullRequestCutoverCandidate(item).sourceSequence >=
        rootCandidateSequence
    ) {
      continue;
    }
    itemsById.set(item.itemId, {
      ...item,
      status: "superseded",
      revision: item.revision + 1,
      ownerId: null,
      leaseId: null,
      leaseUntil: null,
      activeIntentId: null,
      availableAt: null,
      statusReason: "pr_source_cross_root_cutover_replaced",
      updatedAt: now,
    });
    timelineEvents.push({
      itemId: item.itemId,
      type: "superseded",
      at: now,
      actorId: "work-ledger-system",
      details: {
        reason: "pr_source_cross_root_cutover_replaced",
        nextRootItemId: root.itemId,
      },
    });
  }
  const activated = activatePendingPullRequestWorkSource(root.source);
  const next = {
    ...root,
    source: activated.source,
    inputDigest: activated.source.current.inputDigest,
    status: "queued",
    revision: root.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: "pr_source_cutover_activated",
    updatedAt: now,
  };
  itemsById.set(next.itemId, next);
  timelineEvents.push({
    itemId: next.itemId,
    type: "pr_source_activated",
    at: now,
    actorId: "work-ledger-system",
    details: {
      workKey: next.source.workKey,
      activeRevision: next.source.activeRevision,
      headRevision: next.source.headRevision,
      headRefOid: next.source.current.headRefOid,
      predecessorItemId,
    },
  });
  return {
    patch: {
      items: [...itemsById.values()],
      outbox: [...outboxById.values()],
    },
    timelineEvents,
    result: resultFor(state.revision + 1, next, true, []),
  };
}

export function planPullRequestSourceReconciliation({ state, input, clock }) {
  const command = normalizeCommand(input);
  const root = requireWorkLedgerItem(state, command.itemId);
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request") {
    throw conflict("工作项不是 PR 来源根");
  }
  const predecessorItemId = crossRootPullRequestCutoverPredecessorId(root);
  if (predecessorItemId !== null) {
    return planCrossRootPullRequestSourceReconciliation({
      state,
      command,
      root,
      predecessorItemId,
      clock,
    });
  }
  if (
    typeof root.statusReason === "string" &&
    root.statusReason.startsWith(
      `${CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON}:`,
    )
  ) {
    throw conflict("跨来源 PR cutover marker 损坏");
  }
  if (root.source.pendingRevision === null) {
    if (root.source.activeRevision !== command.expectedPendingRevision) {
      throw conflict("PR 来源已不再指向预期版本");
    }
    return {
      write: false,
      result: resultFor(state.revision, root, false, []),
    };
  }
  if (root.source.pendingRevision !== command.expectedPendingRevision) {
    throw conflict("PR pending 版本已变化");
  }
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(root, command.expectedRevision);

  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activation = inspectPullRequestSourceCutover(
    root,
    state.items,
    outboxById,
  );
  const blockers = publicBlockers(activation);
  if (blockers.length > 0) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, blockers),
    };
  }

  const now = clock();
  const pendingRevision = root.source.pendingRevision;
  const pendingHeadRevision = root.source.revisions[
    pendingRevision - 1
  ].headRevision;
  const itemsById = new Map(
    state.items.map((item) => [item.itemId, item]),
  );
  const timelineEvents = [];
  const locallySettledRoot = applyReadyPullRequestSourceCutover({
    root,
    activation,
    itemsById,
    outboxById,
    nextInputRevision: pendingRevision,
    nextHeadRevision: pendingHeadRevision,
    now,
    timelineEvents,
  });
  const activated = activatePendingPullRequestWorkSource(root.source);
  const next = {
    ...locallySettledRoot,
    source: activated.source,
    inputDigest: activated.source.current.inputDigest,
    status: locallySettledRoot.status === "paused" ? "paused" : "queued",
    revision: locallySettledRoot.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: "pr_source_cutover_activated",
    updatedAt: now,
  };
  itemsById.set(next.itemId, next);
  timelineEvents.push({
    itemId: next.itemId,
    type: "pr_source_activated",
    at: now,
    actorId: "work-ledger-system",
    details: {
      workKey: next.source.workKey,
      activeRevision: next.source.activeRevision,
      headRevision: pendingHeadRevision,
      headRefOid: next.source.current.headRefOid,
    },
  });
  return {
    patch: {
      items: [...itemsById.values()],
      outbox: [...outboxById.values()],
    },
    timelineEvents,
    result: resultFor(state.revision + 1, next, true, []),
  };
}
