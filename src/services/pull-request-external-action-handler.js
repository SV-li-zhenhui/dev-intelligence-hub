import { digestValue } from "../domain/code-executor-contract.js";
import {
  normalizeConfirmationPlan,
  normalizeConfirmationReceipt,
} from "../domain/confirmation-contract.js";
import { createPullRequestExternalActionConfirmationPlan } from "../domain/pull-request-external-action.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  isTerminalWorkProposalStatus,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { WorkProposalRunnerService } from "./work-proposal-runner.js";

const ACTION_NAMES = Object.freeze({
  pull_request_comment: "comment",
  pull_request_review: "review",
  pull_request_update_branch: "update_branch",
  pull_request_push: "push",
  pull_request_merge: "merge",
});
const ALL_ACTIONS = new Set(Object.values(ACTION_NAMES));
const ACTIVE_PROPOSAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter((status) => !isTerminalWorkProposalStatus(status)),
);
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FACTORY_KEYS = new Set([
  "enabled",
  "enabledActions",
  "runner",
  "confirmationProducer",
  "inputAuthorityVerifier",
  "actorAccountId",
  "clock",
  "pollIntervalMs",
  "leaseDurationMs",
  "handlerTimeoutMs",
  "retryBaseMs",
  "retryMaxMs",
  "defaultBatchLimit",
  "runnerFactory",
]);

function invalidProposal(message = "GitHub PR 外部动作提案处理失败") {
  return workProposalError(
    "INVALID_GITHUB_PULL_REQUEST_ACTION_PROPOSAL",
    message,
  );
}

function invalidConfirmation(message = "GitHub PR 外部动作确认结果无效") {
  return workProposalError(
    "INVALID_GITHUB_PULL_REQUEST_ACTION_CONFIRMATION",
    message,
  );
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function normalizeEnabledActions(value = []) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > ALL_ACTIONS.size ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    value.some((entry) => !ALL_ACTIONS.has(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("enabledActions is invalid");
  }
  return new Set(value);
}

function normalizeHandlerInput(value) {
  const error = invalidProposal();
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "attempt", "downstreamRef"],
    error,
  );
  if (!ACTIVE_PROPOSAL_STATUSES.has(value.status)) throw error;
  if (value.downstreamRef !== null && typeof value.downstreamRef !== "string") {
    throw error;
  }
  return {
    proposal: value.proposal,
    status: value.status,
    attempt: safeWorkProposalInteger(value.attempt, "attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef: value.downstreamRef,
  };
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(value, new TypeError("clock is invalid"));
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeFailure(value, error) {
  assertWorkProposalExactKeys(
    value,
    ["code", "outcome", "retryable", "at"],
    error,
  );
  if (
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.code) ||
    !["absent", "unknown"].includes(value.outcome) ||
    typeof value.retryable !== "boolean" ||
    value.retryable !== (value.outcome === "absent")
  ) {
    throw error;
  }
  return {
    code: value.code,
    outcome: value.outcome,
    retryable: value.retryable,
    at: normalizeWorkProposalTimestamp(value.at, error),
  };
}

function normalizeConfirmationItem(value, expected) {
  const error = invalidConfirmation();
  const entries = workProposalDataEntries(value, error);
  const item = Object.fromEntries(entries);
  const required = [
    "id",
    "kind",
    "status",
    "queueRevision",
    "itemRevision",
    "requestedBy",
    "actor",
    "target",
    "display",
    "displayedPayloadDigest",
    "approvalBindingDigest",
    "retryable",
  ];
  const optional = new Set(["receipt", "failure", "rejection", "invalidation"]);
  if (
    required.some((key) => !Object.hasOwn(item, key)) ||
    Object.keys(item).some((key) => !required.includes(key) && !optional.has(key)) ||
    item.id !== expected.id ||
    item.kind !== expected.kind ||
    !CONFIRMATION_STATUSES.has(item.status) ||
    !Number.isSafeInteger(item.queueRevision) ||
    item.queueRevision < 1 ||
    !Number.isSafeInteger(item.itemRevision) ||
    item.itemRevision < 1 ||
    item.displayedPayloadDigest !== expected.displayedPayloadDigest ||
    item.approvalBindingDigest !== expected.approvalBindingDigest ||
    digestValue(item.requestedBy) !== digestValue(expected.requestedBy) ||
    digestValue(item.actor) !== digestValue(expected.actor) ||
    digestValue(item.target) !== digestValue(expected.target) ||
    digestValue(item.display) !== digestValue(expected.display) ||
    typeof item.retryable !== "boolean"
  ) {
    throw error;
  }
  const allowedOptional = {
    pending: [],
    executing: [],
    completed: ["receipt"],
    failed: ["failure"],
    stale: ["invalidation"],
    rejected: ["rejection"],
  }[item.status];
  const presentOptional = Object.keys(item).filter((key) => optional.has(key));
  if (
    presentOptional.some((key) => !allowedOptional.includes(key)) ||
    (item.status === "completed" && !Object.hasOwn(item, "receipt")) ||
    (item.status === "failed" && !Object.hasOwn(item, "failure")) ||
    (item.status === "rejected" && !Object.hasOwn(item, "rejection")) ||
    (item.status !== "failed" && item.retryable)
  ) {
    throw error;
  }
  const failure = item.status === "failed"
    ? normalizeFailure(item.failure, error)
    : null;
  if (failure !== null && failure.retryable !== item.retryable) throw error;
  let receipt = null;
  if (item.status === "completed") {
    try {
      receipt = normalizeConfirmationReceipt(item.receipt);
    } catch {
      throw error;
    }
  }
  return {
    ...structuredClone(item),
    ...(receipt === null ? {} : { receipt }),
    failure,
  };
}

function nextAttemptAt(clock, pollIntervalMs) {
  return new Date(
    Date.parse(normalizeClock(clock)) + pollIntervalMs,
  ).toISOString();
}

function actionName(plan) {
  const result = ACTION_NAMES[plan.action.type];
  if (result === undefined) throw invalidProposal("外部动作类型无效");
  return result;
}

function terminal(status, summary, item, evidence = []) {
  return {
    status,
    summary,
    evidence: [`confirmation:${item.id}`, ...evidence],
  };
}

function completedEvidence(item, confirmationAction) {
  const evidence = [`receipt:${item.receipt.id}`];
  if (confirmationAction.type === "pull_request_push") {
    evidence.push(
      `controlled-commit:${confirmationAction.controlledCommitEvidence.evidenceId}`,
      `commit:${confirmationAction.controlledCommitEvidence.commit.oid}`,
    );
  }
  return evidence;
}

function transitionFor(
  item,
  action,
  confirmationAction,
  clock,
  pollIntervalMs,
) {
  if (["pending", "executing"].includes(item.status)) {
    return {
      status: "waiting_confirmation",
      downstreamRef: item.id,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  if (item.status === "completed") {
    return terminal(
      "succeeded",
      `GitHub PR ${action} 已完成`,
      item,
      completedEvidence(item, confirmationAction),
    );
  }
  if (item.status === "rejected") {
    return terminal("rejected", `用户已拒绝 GitHub PR ${action}`, item);
  }
  if (item.status === "stale") {
    return terminal("stale", `GitHub PR ${action} 确认已失效`, item);
  }
  if (item.failure.retryable) {
    return {
      status: "waiting_retry",
      reason: item.failure.code,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  return terminal(
    "unknown",
    `GitHub PR ${action} 外部结果无法确认`,
    item,
    [item.failure.code],
  );
}

function disabledTransition(proposal, action, reason) {
  return {
    status: "stale",
    summary: `GitHub PR ${action} 未启用或授权已变化`,
    evidence: [reason, `proposal:${proposal.proposalId}`],
  };
}

export class PullRequestExternalActionProposalHandler {
  #enabledActions;
  #enqueue;
  #get;
  #invalidateConfirmation;
  #verifyInputAuthority;
  #actorAccountId;
  #clock;
  #pollIntervalMs;

  constructor({
    enabledActions = [],
    confirmationProducer,
    inputAuthorityVerifier,
    actorAccountId,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    this.#enabledActions = normalizeEnabledActions(enabledActions);
    const producer = requirePort(
      confirmationProducer,
      ["enqueue", "get", "invalidate"],
      "confirmationProducer",
    );
    this.#enqueue = producer.enqueue;
    this.#get = producer.get;
    this.#invalidateConfirmation = producer.invalidate;
    this.#verifyInputAuthority = requirePort(
      inputAuthorityVerifier,
      ["verify"],
      "inputAuthorityVerifier",
    ).verify;
    if (typeof actorAccountId !== "string" || actorAccountId.length === 0) {
      throw new TypeError("actorAccountId is invalid");
    }
    this.#actorAccountId = actorAccountId;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#pollIntervalMs = positiveInteger(
      pollIntervalMs,
      "pollIntervalMs",
      MAX_POLL_INTERVAL_MS,
    );
  }

  async handle(value) {
    const input = normalizeHandlerInput(value);
    const plan = createPullRequestExternalActionConfirmationPlan(
      input.proposal,
      { actorAccountId: this.#actorAccountId },
    );
    const expected = normalizeConfirmationPlan(plan);
    const action = actionName(plan);
    if (input.downstreamRef !== null && input.downstreamRef !== expected.id) {
      throw invalidConfirmation("外部动作确认绑定已变化");
    }
    let item = null;
    if (input.downstreamRef !== null) {
      item = normalizeConfirmationItem(
        await this.#get(input.downstreamRef),
        expected,
      );
      if (["completed", "rejected", "stale"].includes(item.status)) {
        return transitionFor(
          item,
          action,
          plan.action,
          this.#clock,
          this.#pollIntervalMs,
        );
      }
    }
    if (!this.#enabledActions.has(action)) {
      return item === null
        ? disabledTransition(input.proposal, action, "action_disabled")
        : this.#invalidateChanged(item, input.proposal, expected, action);
    }
    if (!(await this.#authorityCurrent(plan.action.inputBinding))) {
      return item === null
        ? disabledTransition(input.proposal, action, "authorization_changed")
        : this.#invalidateChanged(item, input.proposal, expected, action);
    }
    if (item === null) {
      item = normalizeConfirmationItem(await this.#enqueue(plan), expected);
    }
    return transitionFor(
      item,
      action,
      plan.action,
      this.#clock,
      this.#pollIntervalMs,
    );
  }

  async #authorityCurrent(binding) {
    try {
      const verified = await this.#verifyInputAuthority(structuredClone(binding));
      return samePullRequestExecutionBinding(verified, binding);
    } catch {
      return false;
    }
  }

  async #invalidateChanged(item, proposal, expected, action) {
    if (
      item.status === "pending" ||
      (item.status === "failed" && item.failure?.retryable)
    ) {
      try {
        item = normalizeConfirmationItem(
          await this.#invalidateConfirmation(item.id, {
            requestedBy: proposal.requestedBy,
            approvalBindingDigest: item.approvalBindingDigest,
            reason: "authorization_changed",
          }),
          expected,
        );
      } catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_INVALIDATABLE") throw error;
        item = normalizeConfirmationItem(await this.#get(item.id), expected);
      }
    }
    if (item.status === "pending") {
      throw invalidConfirmation("旧外部动作确认未能安全撤销");
    }
    return transitionFor(
      item,
      action,
      expected.action,
      this.#clock,
      this.#pollIntervalMs,
    );
  }
}

function factoryOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("external action proposal runner options are invalid");
  }
  const entries = workProposalDataEntries(
    value,
    new TypeError("external action proposal runner options are invalid"),
  );
  if (entries.some(([key]) => !FACTORY_KEYS.has(key))) {
    throw new TypeError("external action proposal runner options are invalid");
  }
  return Object.fromEntries(entries);
}

export function createPullRequestExternalActionProposalRunnerService(value = {}) {
  const options = factoryOptions(value);
  if (options.enabled === undefined || options.enabled === false) return null;
  if (options.enabled !== true) {
    throw new TypeError("external action proposal runner enabled flag is invalid");
  }
  const handler = new PullRequestExternalActionProposalHandler({
    enabledActions: options.enabledActions,
    confirmationProducer: options.confirmationProducer,
    inputAuthorityVerifier: options.inputAuthorityVerifier,
    actorAccountId: options.actorAccountId,
    clock: options.clock,
    pollIntervalMs: options.pollIntervalMs,
  });
  const Runner = options.runnerFactory ?? ((runnerOptions) =>
    new WorkProposalRunnerService(runnerOptions));
  if (typeof Runner !== "function") throw new TypeError("runnerFactory is invalid");
  return Runner({
    runner: options.runner,
    handler,
    clock: options.clock,
    leaseDurationMs: options.leaseDurationMs,
    handlerTimeoutMs: options.handlerTimeoutMs,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    defaultBatchLimit: options.defaultBatchLimit,
  });
}
