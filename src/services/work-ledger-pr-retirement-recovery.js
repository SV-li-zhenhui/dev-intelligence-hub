import { currentWorkItemInputBinding, pullRequestHeadAdmission } from "./work-ledger-pr-source.js";

const SETTLED_CHILD_STATUSES = new Set(["completed", "cancelled", "superseded"]);

function recoverableRootStateProof(state, root, activation) {
  const entry = state.timeline.findLast(event => event.itemId === root.itemId && event.sequence < activation.sequence &&
    !["pr_source_revised", "pr_source_ignored"].includes(event.type));
  if (!entry) return null;
  const status = {
    pr_source_created: "queued",
    claimed: "working",
    retry_scheduled: "retry_wait",
    transitioned: entry.details.toStatus,
    graph_parent_revised: entry.details.toStatus,
  }[entry.type];
  // Retirement erased the previous status. Require positive evidence that
  // this task was runnable, rather than silently undoing an owner pause.
  return ["queued", "working", "retry_wait"].includes(status) ? entry : null;
}

function inactiveMetadataActivationProof(state, root, candidate) {
  const source = candidate.source;
  if (source?.kind !== "pull_request" || source.scope.kind !== "automatic" || source.scope.active ||
      source.identity.subjectId !== root.source.identity.subjectId ||
      source.identity.repository !== root.source.identity.repository ||
      source.identity.pullRequestNumber !== root.source.identity.pullRequestNumber ||
      source.pendingRevision !== null || candidate.sourceQuarantine !== null ||
      source.current.event.eventType !== "pull_request.updated" ||
      source.current.headRefOid !== root.source.current.headRefOid || candidate.updatedAt !== root.updatedAt ||
      source.current.sourceSequence <= root.source.current.sourceSequence) return null;
  const exit = source.revisions.find(revision => revision.eventId === source.scope.lastLifecycleEventId);
  const exitBinding = source.bindings.find(binding => binding.inputRevision === exit?.revision);
  // The source was already revoked before the live task was admitted. A source
  // that legitimately took over and then left scope is deliberately excluded.
  if (!exitBinding || exitBinding.sourceSequence >= root.source.current.sourceSequence ||
      exit.revision >= source.activeRevision) return null;
  const recordedExit = exitBinding.scopeLifecycle === true || state.timeline.some(entry =>
    entry.itemId === candidate.itemId && entry.type === "pr_source_revised" &&
    entry.details.scopeActive === false && entry.details.activeRevision === exit.revision &&
    entry.details.sourceSequence === exitBinding.sourceSequence);
  if (!recordedExit) return null;
  return state.timeline.findLast(entry => entry.itemId === candidate.itemId &&
    entry.type === "pr_source_revised" && entry.at === root.updatedAt &&
    entry.details.disposition === "accepted" && entry.details.headAdvanced === true &&
    entry.details.pendingRevision === null && entry.details.activeRevision === source.activeRevision &&
    entry.details.sourceSequence === source.current.sourceSequence &&
    entry.details.headRefOid === root.source.current.headRefOid &&
    typeof entry.details.previousHeadRefOid === "string" &&
    entry.details.previousHeadRefOid !== entry.details.headRefOid) ?? null;
}

export function inactivePullRequestTakeoverRecoveryProof(state, root) {
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request" ||
      !["owner_requested", "internal_review"].includes(root.source.scope.kind) ||
      root.source.scope.active !== true || root.status !== "blocked" ||
      root.statusReason !== "pr_source_cross_root_cutover_retired" ||
      root.source.pendingRevision !== null || root.sourceQuarantine !== null ||
      root.activeIntentId !== null || root.decisionContext !== null ||
      root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null) return null;
  const admission = pullRequestHeadAdmission(state, root);
  if (!admission.current || admission.pending) return null;
  const participants = state.items.filter(item => currentWorkItemInputBinding(item)?.rootItemId === root.itemId);
  if (participants.some(item => item.itemId !== root.itemId && !SETTLED_CHILD_STATUSES.has(item.status))) return null;
  const participantIds = new Set(participants.map(item => item.itemId));
  if (state.outbox.some(entry => participantIds.has(entry.itemId) && ["pending", "dispatching"].includes(entry.status))) return null;
  for (const candidate of state.items) {
    const proof = inactiveMetadataActivationProof(state, root, candidate);
    const rootStateProof = proof === null ? null : recoverableRootStateProof(state, root, proof);
    if (rootStateProof !== null) return { timelineId: proof.timelineId,
      rootStateTimelineId: rootStateProof.timelineId, inactiveRootItemId: candidate.itemId };
  }
  return null;
}
