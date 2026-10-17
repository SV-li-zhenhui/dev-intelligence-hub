import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { createPullRequestExternalActionConfirmationPlan } from "../domain/pull-request-external-action.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { approveOwnPrAction, repairCommitMatchesJob } from "./automatic-own-pr-repair-authorization.js";

const STATE_KEY = "automatic-own-pr-conflict-state";
const STATUSES = new Set(["working", "pushing", "published", "failed", "stale"]);
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const digest = value => createHash("sha256").update(value).digest("hex");
const samePr = (left, right) => left.repository === right.repository && left.pullRequestNumber === right.pullRequestNumber;
const active = record => ["working", "pushing"].includes(record.status);
const conflictTask = event => event?.payload?.nextAction === "resolve_conflict" && (
  event.payload.relation === "authored" ||
  (event.source?.provider === "local-owner" && event.eventType === "pull_request.owner_requested")
);

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error("自动冲突修复记录无效");
  const ids = new Set();
  for (const record of value.records) {
    normalizePullRequestExecutionBinding(record.inputBinding);
    if (typeof record.jobId !== "string" || ids.has(record.jobId) || typeof record.confirmationId !== "string" ||
        !STATUSES.has(record.status) || !(record.pushConfirmationId === null || typeof record.pushConfirmationId === "string")) {
      throw new Error("自动冲突修复绑定无效");
    }
    ids.add(record.jobId);
  }
  return structuredClone(value);
}

// Uses the existing sealed conflict snapshot, validation profiles and two-parent
// commit pipeline. It grants no general-purpose push or self-review authority.
export class AutomaticOwnPrConflict {
  #queue = new OperationQueue();
  #state;
  #lastJobId = null;

  constructor({ configurationReader, store, ledger, github, confirmations, codeJobReader,
    controlledCommitReader, objectSync, grantVerifier }) {
    Object.assign(this, { configurationReader, store, ledger, github, confirmations, codeJobReader,
      controlledCommitReader, objectSync, grantVerifier });
  }

  async recover() {
    this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
  }

  async shouldRun(item) {
    const binding = item.source?.identity;
    const event = currentWorkItemEvent(item);
    const target = { repository: binding?.repository ?? event?.subject?.repository,
      pullRequestNumber: binding?.pullRequestNumber ?? event?.subject?.number };
    if (!this.isInFlight(target)) return true;
    const config = (await this.configurationReader.readActive())?.configuration;
    return config?.githubActions?.automaticOwnPrRepair !== true;
  }

  isInFlight(binding) {
    return this.#state.records.some(record => active(record) && samePr(record.inputBinding, binding));
  }

  async #current(binding) {
    const config = (await this.configurationReader.readActive())?.configuration;
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories.includes(binding.repository) ||
        !sameLogin(binding.gitTarget?.sourceAccountId, config.githubActions.actorAccountId)) return null;
    const context = await this.ledger.readPullRequestExecutionContext(binding);
    if (!samePullRequestExecutionBinding(context.inputBinding, binding)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const event = currentWorkItemEvent(root);
    if (!conflictTask(event) || (event.payload.relation === "authored" && !sameLogin(context.author, config.githubActions.actorAccountId))) return null;
    const facts = await this.github.readOwnPullRequestConflict({ repository: binding.repository,
      number: binding.pullRequestNumber, account: config.githubActions.actorAccountId });
    if (facts.state !== "open" || facts.isDraft === true || facts.draft === true ||
        !sameLogin(facts.author, config.githubActions.actorAccountId) || facts.headRefOid !== binding.headRefOid ||
        facts.baseRefOid !== binding.gitTarget.baseRefOid || facts.mergeStateStatus !== "DIRTY") return null;
    return config;
  }

  async #grantCurrent(grant) {
    try { return isDeepStrictEqual(await this.grantVerifier.verify(grant), grant); }
    catch (error) { if (error?.code === "INVALID_CODE_JOB_AUTHORITY") return false; throw error; }
  }

  async approveCodeJob(item) {
    if (item.kind !== "local.code-job-create" || item.status !== "pending" || item.requestedBy?.roleId !== "developer") return item;
    const grant = item.display?.payload?.action?.grant;
    if (!grant?.inputBinding || !["inspect", "verify", "modify"].includes(grant.operation) ||
        (grant.operation === "modify" && (grant.executionSource?.kind !== "conflict_preparation" ||
          !samePullRequestExecutionBinding(grant.executionSource.inputBinding, grant.inputBinding)))) return item;
    let config = await this.#current(grant.inputBinding);
    if (!config || !await this.#grantCurrent(grant)) return item;
    if (this.objectSync) {
      await this.objectSync.prepare({ configuration: config, inputBinding: grant.inputBinding });
      config = await this.#current(grant.inputBinding);
      if (!config) return item;
    }
    if (grant.operation === "modify") {
      await this.#queue.enqueue(async () => {
        const jobId = codeJobIdForGrant(grant);
        if (this.#state.records.some(record => record.jobId === jobId)) return;
        if (this.#state.records.some(record => active(record) && samePr(record.inputBinding, grant.inputBinding))) {
          throw Object.assign(new Error("此 PR 的冲突修复正在执行"), { code: "OWN_PR_REPAIR_ALREADY_RUNNING" });
        }
        await this.#save({ ...this.#state, records: [...this.#state.records, {
          jobId, confirmationId: item.id, inputBinding: grant.inputBinding, status: "working", pushConfirmationId: null,
        }] });
      });
    }
    return this.#approve(item);
  }

  #approve(item) {
    return approveOwnPrAction(this.confirmations, item);
  }

  async verifyPush(envelope) {
    if (envelope.kind !== "github.pull-request-push" || envelope.requestedBy?.roleId !== "developer" ||
        envelope.action?.controlledCommitEvidence?.executionSource?.kind !== "conflict_preparation") return false;
    const source = envelope.action.controlledCommitEvidence.executionSource;
    const record = this.#state.records.find(record => record.pushConfirmationId === envelope.id && record.status === "pushing" &&
      samePullRequestExecutionBinding(record.inputBinding, source.inputBinding));
    if (!record) return false;
    const codeItem = await this.confirmations.get(record.confirmationId);
    return await this.#grantCurrent(codeItem.display.payload.action.grant) && await this.#current(record.inputBinding) !== null;
  }

  runCycle({ limit = 10 } = {}) {
    return this.#queue.enqueue(async () => {
      const pending = this.#state.records.filter(active);
      const start = pending.findIndex(record => record.jobId === this.#lastJobId) + 1;
      const candidates = [...pending.slice(start), ...pending.slice(0, start)].slice(0, limit);
      this.#lastJobId = candidates.at(-1)?.jobId ?? null;
      const result = { scanned: candidates.length, published: 0, failed: 0, stale: 0 };
      for (const record of candidates) {
        try { const status = await this.#advance(record); if (Object.hasOwn(result, status)) result[status] += 1; }
        catch (error) { result.failed += 1; result.lastFailure = error?.code ?? "OWN_PR_CONFLICT_PROGRESS_UNAVAILABLE"; }
      }
      return result;
    });
  }

  async #advance(record) {
    const codeItem = await this.confirmations.get(record.confirmationId);
    const grant = codeItem.display.payload.action.grant;
    if (record.pushConfirmationId) {
      let push;
      try { push = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) { if (error?.code !== "CONFIRMATION_NOT_FOUND") throw error; }
      if (!push) return this.#advance({ ...record, pushConfirmationId: null });
      if (push.status === "completed") { await this.#update(record, "published"); return "published"; }
      if (push.status === "failed" && push.failure?.outcome === "unknown") return "waiting";
      if (["stale", "rejected", "failed"].includes(push.status)) {
        const status = push.status === "stale" ? "stale" : "failed";
        await this.#update(record, status); return status;
      }
      if (push.status === "pending") {
        if (!await this.#grantCurrent(grant) || !await this.#current(record.inputBinding)) return this.#retirePending(record, push);
        await this.#approve(push);
      }
      return "waiting";
    }
    const detail = await this.codeJobReader.getDetail({ jobId: record.jobId });
    if (!detail) {
      if (["stale", "rejected", "failed"].includes(codeItem.status)) {
        if (codeItem.failure?.outcome === "unknown") return "waiting";
        const status = codeItem.status === "stale" ? "stale" : "failed";
        await this.#update(record, status); return status;
      }
      if (codeItem.status === "pending") {
        if (!await this.#grantCurrent(grant) || !await this.#current(record.inputBinding)) return this.#retirePending(record, codeItem);
        await this.#approve(codeItem);
      }
      return "waiting";
    }
    if (["failed", "cancelled", "fenced"].includes(detail.job.status)) { await this.#update(record, "failed"); return "failed"; }
    const receipt = detail.changePackage?.receipt?.controlledCommit;
    if (detail.job.status !== "completed" || !receipt) return "waiting";
    const config = await this.#current(record.inputBinding);
    if (!config || !await this.#grantCurrent(grant)) { await this.#update(record, "stale"); return "stale"; }
    const evidence = await this.controlledCommitReader.verify({ evidenceId: receipt.evidenceId });
    if (!repairCommitMatchesJob({ evidence, receipt, record, grant, sourceKind: "conflict_preparation", requireProfiles: true })) {
      throw Object.assign(new Error("冲突提交与验证任务不匹配"), { code: "OWN_PR_REPAIR_COMMIT_INVALID" });
    }
    const proposal = normalizeBoundWorkProposal({
      proposalId: `auto-own-pr-conflict-push-${digest(record.jobId)}`, policyVersion: grant.policyVersion,
      kind: "github_pull_request_action_proposal", requestedBy: grant.requestedBy, source: grant.source,
      binding: { eventId: grant.source.eventId, subject: grant.subject, repository: grant.repository,
        pullRequestNumber: grant.inputBinding.pullRequestNumber, headRefOid: grant.inputBinding.headRefOid, inputBinding: grant.inputBinding },
      payload: { action: { type: "push", controlledCommitEvidence: evidence }, summary: "自动解决合并冲突，更新原 PR",
        reason: "受控冲突修复已通过配置的验证", evidence: [`code-job:${record.jobId}`, `controlled-commit:${evidence.evidenceId}`] },
    });
    const plan = createPullRequestExternalActionConfirmationPlan(proposal, { actorAccountId: config.githubActions.actorAccountId });
    await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId
      ? { ...row, status: "pushing", pushConfirmationId: plan.id } : row) });
    const push = await this.confirmations.enqueue(plan);
    if (push.status === "pending") await this.#approve(push);
    return "waiting";
  }

  async #update(record, status) {
    await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId ? { ...row, status } : row) });
  }

  async #retirePending(record, item) {
    try {
      await this.confirmations.invalidate(item.id, { requestedBy: item.requestedBy,
        approvalBindingDigest: item.approvalBindingDigest, reason: "authorization_changed" });
    } catch (error) {
      if (error?.code === "CONFIRMATION_NOT_INVALIDATABLE") return "waiting";
      throw error;
    }
    await this.#update(record, "stale");
    return "stale";
  }

  async #save(value) {
    const next = normalizeState(value);
    try { await this.store.write(STATE_KEY, next); }
    catch (error) { this.#state = normalizeState(await this.store.read(STATE_KEY, this.#state)); throw error; }
    this.#state = next;
  }
}
