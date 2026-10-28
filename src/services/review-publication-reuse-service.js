import { normalizeBoundWorkProposal, normalizeWorkProposalResult, WORK_PROPOSAL_TERMINAL_STATUSES } from "../domain/work-proposal-contract.js";
import { historicalGitHubReviewConfirmationPlans } from "../domain/github-review-proposal-confirmation.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext } from "../domain/pull-request-read-facts.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { createProposalDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import { requiredReviewDeliverables } from "../domain/pr-review-work-policy.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { createReviewPublicationCandidate, createReviewPublicationAdoption, verifyReviewPublicationAdoption } from "./published-review-adoption.js";

const failure = code => Object.assign(new Error(code), { code });
const same = (left, right) => canonicalJsonDigest(left) === canonicalJsonDigest(right);
const held = status => ["paused", "cancelled", "superseded"].includes(status);
const check = signal => signal?.throwIfAborted();

export function createReviewAdoptionTaskReader(ledger) {
  return Object.freeze({ async read({ taskId }) {
    const item = await ledger.readItemForReconciliation({ itemId: taskId });
    if (!item || item.sourceQuarantine !== null || item.currentTarget?.type !== "role") return null;
    const inputBinding = currentWorkItemExecutionBinding(item);
    if (inputBinding === null) return null;
    const root = inputBinding.rootItemId === item.itemId ? item : await ledger.readItemForReconciliation({ itemId: inputBinding.rootItemId });
    if (!root || root.sourceQuarantine !== null || root.source?.scope?.active !== true) return null;
    return { taskId: item.itemId, revision: item.revision, roleId: item.currentTarget.id, status: item.status,
      activeIntentId: item.activeIntentId, rootStatus: root.status, inputBinding, event: currentWorkItemEvent(item),
      acceptanceContract: structuredClone(item.graph?.acceptanceContracts?.at(-1) ?? null), requestedAt: root.createdAt };
  } });
}

// This service owns only local adoption receipts. It has no GitHub write port.
export class ReviewPublicationReuseService {
  #ports;
  constructor({ taskReader, factsReader, publicationSourceReader, confirmationReader, materialsReader, receiptStore, inputAuthorityVerifier, clock = () => new Date() }) {
    for (const [port, methods] of [[taskReader, ["read"]], [factsReader, ["get"]],
      [publicationSourceReader, ["listReviewPublicationSources"]], [confirmationReader, ["readSettlements"]],
      [materialsReader, ["read"]], [receiptStore, ["getForProposal", "record"]], [inputAuthorityVerifier, ["verify"]]]) {
      if (methods.some(method => typeof port?.[method] !== "function")) throw new TypeError("Invalid Review reuse port");
    }
    this.#ports = { taskReader, factsReader, publicationSourceReader, confirmationReader, materialsReader, receiptStore, inputAuthorityVerifier, clock };
  }
  async #task(taskId, signal) {
    check(signal);
    const task = await this.#ports.taskReader.read({ taskId });
    check(signal);
    if (!task || task.taskId !== taskId || task.roleId !== "pr-engineer" || held(task.status) || held(task.rootStatus) || task.acceptanceContract === null) {
      throw failure("REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE");
    }
    const current = await this.#ports.inputAuthorityVerifier.verify(task.inputBinding);
    check(signal);
    if (!samePullRequestExecutionBinding(current, task.inputBinding)) throw failure("REVIEW_PUBLICATION_REUSE_INPUT_CHANGED");
    return task;
  }
  #target(task, deliverableId) {
    try {
      return { inputBinding: task.inputBinding, requestedAt: task.requestedAt,
        evidenceTarget: createProposalDeliveryEvidenceTarget({ taskId: task.taskId, roleId: task.roleId,
          acceptanceContract: task.acceptanceContract, proposal: { kind: "github_review_proposal" }, deliverableId }) };
    } catch { throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED"); }
  }
  #settlementIds(row, task) {
    const ids = new Set((row.result?.evidence ?? []).filter(value => value.startsWith("confirmation:")).map(value => value.slice("confirmation:".length)));
    if (row.downstreamRef) ids.add(row.downstreamRef);
    try { for (const plan of historicalGitHubReviewConfirmationPlans(row.proposal, task.inputBinding.gitTarget.sourceAccountId)) ids.add(plan.id); } catch { /* Invalid historical payloads cannot form adoption sources. */ }
    return [...ids];
  }
  async #candidates(task, facts, signal) {
    const scan = await this.#ports.publicationSourceReader.listReviewPublicationSources({ inputBinding: task.inputBinding, limit: 100,
      ...(signal === null ? {} : { signal }) });
    check(signal);
    if (scan?.complete !== true || !Array.isArray(scan.items)) throw failure("REVIEW_PUBLICATION_REUSE_SOURCE_INCOMPLETE");
    const rows = scan.items.filter(row => !row.proposal?.payload?.publicationReuse);
    if (rows.some(row => !WORK_PROPOSAL_TERMINAL_STATUSES.includes(row.status) || row.status === "unknown")) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
    const rowsWithIds = rows.map(row => ({ row, ids: this.#settlementIds(row, task) }));
    const confirmationIds = [...new Set(rowsWithIds.flatMap(value => value.ids))];
    const snapshot = confirmationIds.length === 0 ? { items: [] } :
      await this.#ports.confirmationReader.readSettlements({ confirmationIds });
    check(signal);
    const settlements = new Map(snapshot.items.map(item => [item.id, { queueRevision: snapshot.queueRevision, item }]));
    const candidates = [];
    for (const { row, ids } of rowsWithIds) {
      if (ids.map(id => settlements.get(id)).some(value => value && (["pending", "executing"].includes(value.item.status) ||
          value.item.failure?.outcome === "unknown" || value.item.execution?.outcome === "unknown" || value.item.failure?.retryable === true ||
          (value.item.status === "completed" && row.status !== "succeeded")))) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      if (row.status !== "succeeded") continue;
      if (row.result?.outcome !== "succeeded") throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      const references = row.result.evidence.filter(value => value.startsWith("confirmation:"));
      if (references.length !== 1) continue;
      const confirmationSnapshot = settlements.get(references[0].slice("confirmation:".length));
      if (confirmationSnapshot == null) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      for (const deliverable of requiredReviewDeliverables(task.acceptanceContract)) {
        const candidate = createReviewPublicationCandidate({ source: { proposal: row.proposal, result: row.result, confirmationSnapshot },
          target: this.#target(task, deliverable.deliverableId), facts });
        if (candidate !== null) candidates.push(candidate);
      }
    }
    return candidates;
  }
  async listCandidates({ taskId, materialDigest }, { signal = null } = {}) {
    const task = await this.#task(taskId, signal);
    const facts = normalizePullRequestReadFacts(await this.#ports.factsReader.get({ executionBinding: task.inputBinding, event: task.event }));
    if (projectPullRequestReadFactsContext(facts).materialDigest !== materialDigest) throw failure("REVIEW_PUBLICATION_REUSE_MATERIAL_CHANGED");
    const candidates = await this.#candidates(task, facts, signal);
    return { complete: true, candidates: candidates.map(value => ({ candidateId: value.candidateId, materialDigest: value.materialDigest,
      deliverableId: value.target.evidenceTarget.deliverables[0].deliverableId, verdict: value.source.publishedVerdict,
      reviewUrl: value.coverage.publishedReviewUrl, publishedAt: value.source.receipt.createdAt, requiresCurrentReview: true })) };
  }
  #proposal(value) {
    const { contentDigest, ...content } = value;
    const proposal = normalizeBoundWorkProposal(content);
    if (proposal.contentDigest !== contentDigest || proposal.kind !== "github_review_proposal" || !proposal.payload.publicationReuse) throw failure("REVIEW_PUBLICATION_REUSE_INVALID");
    return proposal;
  }
  async #assessment(proposal, signal) {
    const task = await this.#task(proposal.requestedBy.workItemId, signal);
    if (!samePullRequestExecutionBinding(task.inputBinding, proposal.binding.inputBinding) ||
        !same(this.#target(task, proposal.binding.evidenceTarget?.deliverables?.[0]?.deliverableId).evidenceTarget, proposal.binding.evidenceTarget)) throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED");
    const material = await this.#ports.materialsReader.read({ taskId: task.taskId, gitTarget: task.inputBinding.gitTarget,
      pullRequestNumber: task.inputBinding.pullRequestNumber }, { signal });
    check(signal);
    const facts = normalizePullRequestReadFacts(material.facts);
    if (!samePullRequestExecutionBinding(facts.identity.executionBinding, task.inputBinding)) throw failure("REVIEW_PUBLICATION_REUSE_INPUT_CHANGED");
    const candidates = (await this.#candidates(task, facts, signal)).filter(value => value.candidateId === proposal.payload.publicationReuse.candidateId);
    if (candidates.length !== 1) throw failure("REVIEW_PUBLICATION_REUSE_CANDIDATE_STALE");
    const coverageDigest = material.feedbackSnapshot.coverageDigest;
    if (proposal.payload.publicationReuse.coverageDigest !== coverageDigest) throw failure("REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED");
    return { task, candidate: candidates[0], coverageDigest };
  }
  async handle({ proposal: value }, { signal = null } = {}) {
    const proposal = this.#proposal(value);
    const assessment = await this.#assessment(proposal, signal);
    if (!["dispatch_pending", "waiting_external"].includes(assessment.task.status) || assessment.task.activeIntentId !== proposal.proposalId) throw failure("REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE");
    let receipt = await this.#ports.receiptStore.getForProposal({ proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest });
    if (receipt !== null) {
      if (!verifyReviewPublicationAdoption({ ...assessment, receipt, proposal })) throw failure("REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED");
    } else {
      receipt = createReviewPublicationAdoption({ ...assessment, proposal, adoptedAt: new Date(this.#ports.clock()).toISOString() });
      if (receipt === null) throw failure("REVIEW_PUBLICATION_REUSE_MATERIAL_CHANGED");
      receipt = await this.#ports.receiptStore.record(receipt);
    }
    const current = await this.#task(assessment.task.taskId, signal);
    if (current.activeIntentId !== proposal.proposalId || !same(this.#target(current, receipt.target.evidenceTarget.deliverables[0].deliverableId).evidenceTarget, receipt.target.evidenceTarget)) throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED");
    return { status: "succeeded", summary: "已核实并采用既有 GitHub Review；未重复发布",
      evidence: [`adoption:${receipt.adoptionId}`, `confirmation:${receipt.source.confirmationId}`, `github-review:${receipt.source.receipt.id}`] };
  }
  async verifyProposal({ proposal: value, result: rawResult, authority, signal = null }) {
    const proposal = this.#proposal(value), result = normalizeWorkProposalResult(rawResult);
    if (result.outcome !== "succeeded" || result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
        !same(result.requestedBy, proposal.requestedBy)) return false;
    if (authority && (authority.taskId !== proposal.requestedBy.workItemId || authority.roleId !== proposal.requestedBy.roleId ||
        authority.contractRevision !== proposal.binding.evidenceTarget.contractRevision || authority.contractDigest !== proposal.binding.evidenceTarget.contractDigest)) return false;
    const receipt = await this.#ports.receiptStore.getForProposal({ proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest });
    if (receipt === null || result.evidence.filter(value => value.startsWith("adoption:")).length !== 1 || !result.evidence.includes(`adoption:${receipt.adoptionId}`)) return false;
    try {
      const assessment = await this.#assessment(proposal, signal);
      return verifyReviewPublicationAdoption({ ...assessment, receipt, proposal });
    } catch (error) {
      check(signal);
      if (["REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE", "REVIEW_PUBLICATION_REUSE_INPUT_CHANGED", "REVIEW_PUBLICATION_REUSE_TARGET_CHANGED",
        "REVIEW_PUBLICATION_REUSE_CANDIDATE_STALE", "REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED"].includes(error.code)) return false;
      throw error;
    }
  }
}
