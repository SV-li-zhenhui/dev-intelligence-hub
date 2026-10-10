import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { createReviewRepairCodeExecutionSource } from "../domain/code-execution-source.js";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { createPullRequestExternalActionConfirmationPlan } from "../domain/pull-request-external-action.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";

const STATE_KEY = "automatic-own-pr-repair-state";
const DIGEST = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["working", "failed", "stale", "pushing", "published"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fingerprintsValid = (value) => value === undefined ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string" && DIGEST.test(entry)) && new Set(value).size === value.length);
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const samePullRequest = (binding, repository, number) =>
  binding.repository === repository && binding.pullRequestNumber === number;

function repairError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.repairs) || !Array.isArray(value.published)) {
    throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复记录无法读取");
  }
  const ids = new Set();
  for (const row of value.repairs) {
    normalizePullRequestExecutionBinding(row.inputBinding);
    if (!STATUSES.has(row.status) || !DIGEST.test(row.feedbackDigest) ||
        typeof row.jobId !== "string" || typeof row.confirmationId !== "string" || ids.has(row.jobId) ||
        !fingerprintsValid(row.feedbackFingerprints)) {
      throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复记录绑定无效");
    }
    ids.add(row.jobId);
  }
  for (const row of value.published) {
    if (typeof row.repository !== "string" || !Number.isSafeInteger(row.number) ||
        !DIGEST.test(row.feedbackDigest) || !/^[a-f0-9]{40,64}$/.test(row.commitOid) ||
        typeof row.confirmationId !== "string" || !fingerprintsValid(row.feedbackFingerprints)) {
      throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复发布记录绑定无效");
    }
  }
  return structuredClone(value);
}

// This port is composed from trusted configuration, ledger and GitHub facts.
// A model cannot opt an unrelated task into unattended execution.
export class AutomaticOwnPrRepair {
  #queue = new OperationQueue();
  #state = null;
  #lastJobId = null;

  constructor({ configurationReader, store, ledger, github, confirmations,
    codeJobReader = null, controlledCommitReader = null, objectSync = null, grantVerifier }) {
    if (typeof grantVerifier?.verify !== "function") throw new TypeError("Automatic own PR repair requires current grant verification");
    this.configurationReader = configurationReader;
    this.store = store;
    this.ledger = ledger;
    this.github = github;
    this.confirmations = confirmations;
    this.codeJobReader = codeJobReader;
    this.controlledCommitReader = controlledCommitReader;
    this.objectSync = objectSync;
    this.grantVerifier = grantVerifier;
  }

  async recover() {
    this.#state = normalizeState(await this.store.read(STATE_KEY, {
      schemaVersion: 1, repairs: [], published: [],
    }));
  }

  async #configuration() {
    return (await this.configurationReader.readActive())?.configuration;
  }

  async #grantCurrent(grant) {
    try { return isDeepStrictEqual(await this.grantVerifier.verify(grant), grant); }
    catch (error) {
      if (error?.code === "INVALID_CODE_JOB_AUTHORITY") return false;
      throw error;
    }
  }

  #wasPublished(repository, number, feedbackDigest) {
    return this.#state.published.some((row) => row.repository === repository &&
      row.number === number && row.feedbackDigest === feedbackDigest);
  }

  #isInFlight(repository, number) {
    return this.#state.repairs.some((row) => samePullRequest(row.inputBinding, repository, number) &&
      ["working", "pushing"].includes(row.status));
  }

  #feedbackPublished(repository, number, facts) {
    if (this.#wasPublished(repository, number, facts.reviewFeedbackDigest)) return true;
    const fingerprints = facts.reviewFeedbackFingerprints;
    if (!fingerprintsValid(fingerprints) || !fingerprints?.length) return false;
    const consumed = new Set(this.#state.published
      .filter((row) => row.repository === repository && row.number === number)
      .flatMap((row) => row.feedbackFingerprints ?? []));
    return fingerprints.every((value) => consumed.has(value));
  }

  async shouldRun(item) {
    const event = currentWorkItemEvent(item);
    if (event?.payload?.relation !== "authored" || event.payload.nextAction !== "address_review") return true;
    const config = await this.#configuration();
    if (config?.githubActions?.automaticOwnPrRepair !== true) return true;
    const payload = event.payload;
    const repository = event.subject?.repository ?? payload.repo;
    const number = event.subject?.number ?? payload.number;
    if (this.#wasPublished(repository, number, payload.reviewFeedbackDigest) ||
        this.#isInFlight(repository, number)) return false;
    if (!this.#state.published.some((row) => row.repository === repository && row.number === number)) return true;
    const facts = await this.github.readOwnPullRequestFeedback({ repository, number, account: config.githubActions.actorAccountId });
    return !this.#feedbackPublished(repository, number, facts);
  }

  async #current(binding) {
    const config = await this.#configuration();
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories.includes(binding.repository)) return null;
    const context = await this.ledger.readPullRequestExecutionContext(binding);
    if (!samePullRequestExecutionBinding(context.inputBinding, binding) ||
        !sameLogin(context.author, config.githubActions.actorAccountId)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const event = currentWorkItemEvent(root);
    if (event?.payload?.relation !== "authored" || event.payload.nextAction !== "address_review") return null;
    const facts = await this.github.readOwnPullRequestFeedback({
      repository: binding.repository, number: binding.pullRequestNumber,
      account: config.githubActions.actorAccountId,
    });
    if (facts.state !== "open" || !sameLogin(facts.author, context.author) ||
        facts.headRefOid !== binding.headRefOid || facts.reviewFeedbackAvailable !== true ||
        !Number.isSafeInteger(facts.reviewFeedbackCount) || facts.reviewFeedbackCount < 1 || !DIGEST.test(facts.reviewFeedbackDigest) ||
        facts.reviewFeedbackDigest !== event.payload.reviewFeedbackDigest ||
        this.#feedbackPublished(binding.repository, binding.pullRequestNumber, facts)) return null;
    return { config, facts };
  }

  async prepare({ item, intent, inputBinding, roleId }) {
    if (roleId !== "developer" || intent.type !== "propose_code_action" || intent.operation !== "modify" ||
        currentWorkItemEvent(item)?.payload?.relation !== "authored" ||
        currentWorkItemEvent(item)?.payload?.nextAction !== "address_review") return undefined;
    const current = await this.#current(inputBinding);
    if (!current) return undefined;
    const workspaceId = current.config.workCoordination.policy.workspaceByRepository[inputBinding.repository];
    const workspace = current.config.codeExecutor.workspaces.find(({ id }) => id === workspaceId);
    if (!workspace || workspace.gitHeadSnapshot !== true) return undefined;
    return createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: workspace.writablePaths });
  }

  async approveCodeJob(item) {
    if (item.kind !== "local.code-job-create" || item.status !== "pending" || item.requestedBy.roleId !== "developer") return item;
    const grant = item.display?.payload?.action?.grant;
    if (!grant?.inputBinding || !["inspect", "modify", "verify"].includes(grant.operation) ||
        (grant.operation === "modify" && grant.executionSource?.kind !== "review_repair")) return item;
    let current = await this.#current(grant.inputBinding);
    if (!current) return item;
    if (this.objectSync) {
      await this.objectSync.prepare({ configuration: current.config, inputBinding: grant.inputBinding });
      current = await this.#current(grant.inputBinding);
      if (!current) return item;
    }
    if (grant.operation === "modify") {
      const jobId = codeJobIdForGrant(grant);
      await this.#queue.enqueue(async () => {
        if (this.#state.repairs.some((row) => row.jobId === jobId)) return;
        const duplicate = this.#isInFlight(grant.repository, grant.inputBinding.pullRequestNumber) ||
          this.#wasPublished(grant.repository, grant.inputBinding.pullRequestNumber, current.facts.reviewFeedbackDigest);
        if (duplicate) throw repairError("OWN_PR_REPAIR_ALREADY_RUNNING", "此轮 Review 意见已经在修复");
        await this.#save({ ...this.#state, repairs: [...this.#state.repairs, {
          jobId, confirmationId: item.id, inputBinding: grant.inputBinding,
          feedbackDigest: current.facts.reviewFeedbackDigest, status: "working", pushConfirmationId: null,
          ...(current.facts.reviewFeedbackFingerprints ? { feedbackFingerprints: current.facts.reviewFeedbackFingerprints } : {}),
        }] });
      });
    }
    return this.#approve(item);
  }

  #approve(item) {
    return this.confirmations.approve(item.id, {
      requestId: `auto-own-pr-repair-v1-${digest(item.id + ":" + item.approvalBindingDigest).slice(0, 48)}`,
      expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
      displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
    });
  }

  async verifyPush(envelope) {
    if (envelope.kind !== "github.pull-request-push" || envelope.requestedBy?.roleId !== "developer" ||
        envelope.action?.controlledCommitEvidence?.executionSource?.kind !== "review_repair") return false;
    const source = envelope.action.controlledCommitEvidence.executionSource;
    const record = this.#state.repairs.find((row) => row.pushConfirmationId === envelope.id &&
      samePullRequestExecutionBinding(row.inputBinding, source.inputBinding));
    if (!record || record.status !== "pushing") return false;
    const codeItem = await this.confirmations.get(record.confirmationId);
    if (!await this.#grantCurrent(codeItem.display.payload.action.grant)) return false;
    const current = await this.#current(source.inputBinding);
    return current !== null && current.facts.reviewFeedbackDigest === record.feedbackDigest;
  }

  async recordPublished(value) {
    return this.#queue.enqueue(async () => {
      if (this.#wasPublished(value.repository, value.number, value.feedbackDigest)) return;
      await this.#save({ ...this.#state, published: [...this.#state.published, value] });
    });
  }

  runCycle({ limit = 10 } = {}) {
    return this.#queue.enqueue(async () => {
      if (!this.codeJobReader || !this.controlledCommitReader) return { scanned: 0, published: 0 };
      const pending = this.#state.repairs.filter((row) => ["working", "pushing"].includes(row.status));
      const start = pending.findIndex((row) => row.jobId === this.#lastJobId) + 1;
      const candidates = [...pending.slice(start), ...pending.slice(0, start)].slice(0, limit);
      this.#lastJobId = candidates.at(-1)?.jobId ?? null;
      const result = { scanned: candidates.length, published: 0, failed: 0, stale: 0 };
      for (const record of candidates) {
        try {
          const status = await this.#advance(record);
          if (Object.hasOwn(result, status)) result[status] += 1;
        } catch (error) {
          // Keep durable work eligible for reconciliation; unknown writes are
          // never automatically retried as a new GitHub publication.
          result.failed += 1;
          result.lastFailure = error?.code ?? "OWN_PR_REPAIR_PROGRESS_UNAVAILABLE";
        }
      }
      return result;
    });
  }

  async #advance(record) {
    if (record.pushConfirmationId) {
      let push;
      try { push = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_FOUND") throw error;
        record = { ...record, pushConfirmationId: null };
      }
      // An absent item after recording the intent can be reconstructed with
      // its deterministic id; an unknown queue outcome must not be replayed.
      if (!push) return this.#advance(record);
      if (push.status === "completed") {
        const commitOid = push.display.payload.action.controlledCommitEvidence.commit.oid;
        const published = { repository: record.inputBinding.repository,
          number: record.inputBinding.pullRequestNumber, feedbackDigest: record.feedbackDigest,
          commitOid, confirmationId: push.id };
        if (record.feedbackFingerprints) published.feedbackFingerprints = record.feedbackFingerprints;
        await this.#save({ ...this.#state,
          published: this.#wasPublished(published.repository, published.number, published.feedbackDigest)
            ? this.#state.published : [...this.#state.published, published],
          repairs: this.#state.repairs.map((row) => row.jobId === record.jobId ? { ...row, status: "published" } : row),
        });
        return "published";
      }
      if (push.status === "failed" && push.failure?.outcome === "unknown") return "waiting";
      if (["rejected", "stale", "failed"].includes(push.status)) {
        await this.#update(record, { status: push.status === "stale" ? "stale" : "failed" });
        return push.status === "stale" ? "stale" : "failed";
      }
      if (push.status === "pending" && await this.#current(record.inputBinding)) await this.#approve(push);
      return "waiting";
    }
    const detail = await this.codeJobReader.getDetail({ jobId: record.jobId });
    if (!detail) {
      const codeItem = await this.confirmations.get(record.confirmationId);
      if (["rejected", "stale"].includes(codeItem.status) ||
          (codeItem.status === "failed" && codeItem.failure?.outcome !== "unknown")) {
        const status = codeItem.status === "stale" ? "stale" : "failed";
        await this.#update(record, { status }); return status;
      }
      if (codeItem.status === "pending") {
        let current = await this.#current(record.inputBinding);
        if (!current) { await this.#update(record, { status: "stale" }); return "stale"; }
        if (this.objectSync) {
          await this.objectSync.prepare({ configuration: current.config, inputBinding: record.inputBinding });
          current = await this.#current(record.inputBinding);
          if (!current) { await this.#update(record, { status: "stale" }); return "stale"; }
        }
        await this.#approve(codeItem);
      }
      return "waiting";
    }
    if (["failed", "cancelled", "fenced"].includes(detail.job.status)) {
      await this.#update(record, { status: "failed" }); return "failed";
    }
    const receipt = detail.changePackage?.receipt?.controlledCommit;
    if (detail.job.status !== "completed" || !receipt) return "waiting";
    const codeItem = await this.confirmations.get(record.confirmationId);
    const grant = codeItem.display.payload.action.grant;
    if (!await this.#grantCurrent(grant)) { await this.#update(record, { status: "stale" }); return "stale"; }
    const evidence = await this.controlledCommitReader.verify({ evidenceId: receipt.evidenceId });
    if (evidence.evidenceDigest !== receipt.evidenceDigest || evidence.commit.oid !== receipt.commitOid ||
        evidence.package.job.id !== record.jobId || evidence.executionSource.kind !== "review_repair" ||
        codeJobIdForGrant(grant) !== record.jobId ||
        evidence.package.grant.digest !== grant.grantDigest ||
        evidence.package.proposal.id !== grant.proposalId || evidence.package.proposal.contentDigest !== grant.contentDigest ||
        evidence.workspace.id !== grant.workspaceId || !isDeepStrictEqual(evidence.executionSource, grant.executionSource) ||
        evidence.tests.profiles.length !== grant.requiredProfiles.length ||
        !grant.requiredProfiles.every((required) => evidence.tests.profiles.some((profile) =>
          profile.id === required.id && profile.configDigest === required.configDigest &&
          profile.workspaceRevision === evidence.workspace.workspaceRevision)) ||
        !samePullRequestExecutionBinding(evidence.executionSource.inputBinding, record.inputBinding)) {
      throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "修复提交与代码任务不匹配");
    }
    const current = await this.#current(record.inputBinding);
    if (!current) { await this.#update(record, { status: "stale" }); return "stale"; }
    const proposal = normalizeBoundWorkProposal({
      proposalId: `auto-own-pr-repair-push-${digest(record.jobId)}`,
      policyVersion: grant.policyVersion, kind: "github_pull_request_action_proposal",
      requestedBy: grant.requestedBy, source: grant.source,
      binding: { eventId: grant.source.eventId, subject: grant.subject,
        repository: grant.repository, pullRequestNumber: grant.inputBinding.pullRequestNumber,
        headRefOid: grant.inputBinding.headRefOid, inputBinding: grant.inputBinding },
      payload: { action: { type: "push", controlledCommitEvidence: evidence },
        summary: "自动修复 Review 意见，更新原 PR", reason: "隔离修改已通过配置的验证，推送受控提交",
        evidence: [`code-job:${record.jobId}`, `controlled-commit:${evidence.evidenceId}`] },
    });
    const plan = createPullRequestExternalActionConfirmationPlan(proposal,
      { actorAccountId: current.config.githubActions.actorAccountId });
    await this.#update(record, { status: "pushing", pushConfirmationId: plan.id });
    const push = await this.confirmations.enqueue(plan);
    if (push.status === "pending") await this.#approve(push);
    return "waiting";
  }

  async #update(record, patch) {
    await this.#save({ ...this.#state, repairs: this.#state.repairs.map((row) => row.jobId === record.jobId ? { ...row, ...patch } : row) });
  }

  async #save(value) {
    const state = normalizeState(value);
    try { await this.store.write(STATE_KEY, state); }
    catch (error) {
      this.#state = normalizeState(await this.store.read(STATE_KEY, this.#state));
      throw error;
    }
    this.#state = state;
  }
}
