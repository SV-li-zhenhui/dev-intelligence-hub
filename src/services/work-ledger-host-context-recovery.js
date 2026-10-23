import { isDeepStrictEqual } from "node:util";
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";
import { unstartedDeliveryContractFailure } from "./work-ledger-delivery-failure.js";
import { currentWorkItemEvent, currentWorkItemInputBinding, currentWorkItemExecutionBinding,
  verifyPullRequestExecutionBinding } from "./work-ledger-pr-source.js";
import { hasExactLedgerKeys, ledgerDigest } from "./work-ledger-values.js";
import { moveWorkItem } from "./work-ledger-transitions.js";

export const HOST_CONTEXT_RECOVERED = "host_context_facts_recovered";

// Restricted adapter for the old untyped host-status question. Product decisions
// and renewed authorization questions must never be inferred from a choice label.
function requestedChild(intent) {
  if (intent?.type !== "ask_user" || intent.summary !== "补齐未知阻塞的宿主上下文" ||
      !isDeepStrictEqual(intent.choices, [{ id: "supply-blocking-context", label: "补齐阻塞上下文",
        description: "提供宿主记录的阻塞原因和验证提案状态，保留原修复包及任务历史，再按证据继续。" }])) return null;
  const match = /^子任务 revision ([1-9][0-9]*) 的 ledgerStatus 为 blocked，但 blockingCondition 为 null，且没有提案处理结果、失败码或活动执行信息。原交付已退回，当前没有待验收交付。现有只读工具未提供任务详情查询能力，无法可靠确定恢复路径；不能猜测基础设施故障、取消已有修复任务、重复修改或宣告 CI 修复成功。$/.exec(intent.reason);
  const question = /^请补充开发子任务 (work-item-[a-f0-9]{64}) 的宿主阻塞原因及最新补充验证提案处理结果引用，注明是否存在活动执行；如有失败，请提供错误码和恢复状态。本次仅补齐缺失状态，不请求重新授权常规修复或发布。$/.exec(intent.question);
  return match && question && Number.isSafeInteger(Number(match[1])) ? { itemId: question[1], revision: Number(match[1]) } : null;
}

export function hostContextRetirement(outbox) {
  const proof = outbox?.outcome?.details?.hostContextRetirement;
  if (!hasExactLedgerKeys(proof, ["schemaVersion", "intentId", "questionRef", "workItemRevision", "reason",
    "inputBinding", "childId", "childRevision", "childInputBinding", "failure", "recoveryKey", "digest"]) ||
      proof.schemaVersion !== 1 || proof.reason !== HOST_CONTEXT_RECOVERED || proof.intentId !== outbox.intentId ||
      proof.questionRef !== outbox.outcome.details.questionRef || outbox.status !== "delivered" || outbox.outcome.status !== "delivered" ||
      !Number.isSafeInteger(proof.workItemRevision) || proof.workItemRevision < 1 ||
      proof.failure?.code !== "delivery-evidence-incompatible" || proof.failure.downstreamCreated !== false ||
      !isDeepStrictEqual(proof.childInputBinding, outbox.sourceBinding)) return null;
  const { digest, ...core } = proof;
  const pointer = proof.inputBinding && Object.fromEntries(Object.keys(outbox.sourceBinding ?? {}).map(key => [key, proof.inputBinding[key]]));
  return ledgerDigest(core) === digest && isDeepStrictEqual(pointer, outbox.sourceBinding) ? proof : null;
}

export function hostContextRecoveryCandidate(state, item) {
  if (state.attentionCursor < state.attentionHighWatermark || item?.kind !== "source_root" || item.status !== "waiting_user" ||
      item.currentTarget?.id !== "orchestrator" || item.sourceQuarantine !== null || item.ownerId !== null ||
      item.leaseId !== null || item.leaseUntil !== null || !isOwnerRequestedCiRepairEvent(currentWorkItemEvent(item))) return null;
  const ask = state.outbox.find(entry => entry.intentId === item.activeIntentId);
  const wanted = requestedChild(ask?.intent);
  if (!wanted || ask.itemId !== item.itemId || ask.inputDigest !== item.inputDigest || ask.requestedBy.roleId !== "orchestrator" ||
      ask.requestedBy.workerId !== "employee-orchestrator" || ask.status !== "delivered" || ask.outcome?.status !== "delivered" ||
      ask.outcome.details?.resultAttestation || !/^attention-[a-f0-9]{64}$/.test(ask.outcome.details?.questionRef ?? "") ||
      ask.dispatchBinding?.boundIntent?.kind !== "attention_request" ||
      !isDeepStrictEqual(ask.sourceBinding, currentWorkItemInputBinding(item))) return null;
  const child = state.items.find(entry => entry.itemId === wanted.itemId);
  if (child?.revision !== wanted.revision || child.graph?.parentItemId !== item.itemId ||
      child.leaseUntil !== null ||
      !isDeepStrictEqual(currentWorkItemInputBinding(child), currentWorkItemInputBinding(item))) return null;
  if (state.outbox.some(entry => [item.itemId, child.itemId].includes(entry.itemId) &&
      ["pending", "dispatching", "unknown"].includes(entry.status))) return null;
  const failure = unstartedDeliveryContractFailure(child, state.outbox);
  const inputBinding = currentWorkItemExecutionBinding(item);
  if (!failure || !inputBinding) return null;
  try { verifyPullRequestExecutionBinding(state, inputBinding); } catch { return null; }
  // Outboxes are retained with their root (capacity rejects instead of evicting
  // active history). Exclude question/failed-intent IDs from the durable one-shot key.
  const { intentId: _failedIntentId, ...cause } = failure;
  const recoveryKey = ledgerDigest({ rootItemId: item.itemId, inputBinding, childId: child.itemId,
    childInputBinding: currentWorkItemInputBinding(child), cause });
  if (state.outbox.some(entry => hostContextRetirement(entry)?.recoveryKey === recoveryKey)) return null;
  return { item, child, ask, inputBinding, failure, recoveryKey,
    snapshotDigest: ledgerDigest({ item, child, ask, failure }) };
}

function hasStoppedDecision(candidate, control) {
  const { item, ask, inputBinding } = candidate;
  const run = control?.run, receipt = run?.receipt;
  // The decision's revision is followed by exactly two parent revisions:
  // staging its ask_user escalation and acknowledging the question's delivery.
  return typeof control?.actorAccountId === "string" && control.actorAccountId.toLowerCase() === inputBinding.gitTarget.sourceAccountId.toLowerCase() &&
    run?.kind === "work-item" && run.taskId === item.itemId &&
    run.roleId === "orchestrator" && run.active === false && run.mode === "active" && run.pendingCommand === null &&
    run.stopUnconfirmed !== true && run.phase === "completed" && receipt?.kind === "work-item" && receipt.taskId === item.itemId &&
    receipt.roleId === "orchestrator" && receipt.phase === "completed" && receipt.stopConfirmed === true &&
    receipt.taskRevision === item.revision - 2 &&
    [receipt.registeredAt, receipt.modelStartedAt, receipt.finishedAt, ask.createdAt, ask.updatedAt].every(value => Number.isFinite(Date.parse(value))) &&
    Date.parse(receipt.registeredAt) <= Date.parse(receipt.modelStartedAt) && Date.parse(receipt.modelStartedAt) <= Date.parse(receipt.finishedAt) &&
    Date.parse(receipt.finishedAt) <= Date.parse(ask.createdAt) && Date.parse(ask.createdAt) <= Date.parse(ask.updatedAt);
}

export function planHostContextRecovery({ state, captured, control, clock }) {
  const candidate = hostContextRecoveryCandidate(state, state.items.find(item => item.itemId === captured.itemId));
  if (!candidate || candidate.snapshotDigest !== captured.snapshotDigest || !hasStoppedDecision(candidate, control)) {
    return { write: false, result: { retried: 0 } };
  }
  const { item, child, ask, inputBinding, failure, recoveryKey } = candidate;
  const now = clock();
  const updated = moveWorkItem(item, { status: "retry_wait", now, availableAt: now,
    reason: HOST_CONTEXT_RECOVERED, activeIntentId: null });
  const core = { schemaVersion: 1, intentId: ask.intentId, questionRef: ask.outcome.details.questionRef,
    workItemRevision: updated.revision, reason: HOST_CONTEXT_RECOVERED, inputBinding,
    childId: child.itemId, childRevision: child.revision, childInputBinding: currentWorkItemInputBinding(child), failure, recoveryKey };
  return { patch: { items: state.items.map(entry => entry.itemId === item.itemId ? updated : entry),
    outbox: state.outbox.map(entry => entry.intentId === ask.intentId ? { ...ask, revision: ask.revision + 1, updatedAt: now,
      outcome: { ...ask.outcome, details: { ...ask.outcome.details, hostContextRetirement: { ...core, digest: ledgerDigest(core) } } } } : entry) },
    timelineEvents: [{ itemId: item.itemId, type: "intent_superseded", at: now, actorId: "work-ledger-system",
      details: { intentId: ask.intentId, reason: HOST_CONTEXT_RECOVERED, inputBinding, inputDigest: ask.inputDigest,
        workItemRevision: updated.revision, code: failure.code } },
    { itemId: item.itemId, type: "retry_scheduled", at: now, actorId: "work-ledger-system",
      details: { fromStatus: item.status, availableAt: now, reason: HOST_CONTEXT_RECOVERED, restoredAttempts: 0 } }],
    result: { retried: 1 } };
}
