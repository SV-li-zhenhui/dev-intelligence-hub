import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../domain/github-review-proposal-confirmation.js";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  cloneWorkProposalValue,
  isTerminalWorkProposalStatus,
  normalizeWorkProposalDigest,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { WorkProposalRunnerService } from "./work-proposal-runner.js";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const ACTIVE_PROPOSAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter((status) => !isTerminalWorkProposalStatus(status)),
);
const REQUIRED_CONFIRMATION_KEYS = Object.freeze([
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
]);
const OPTIONAL_CONFIRMATION_KEYS = new Set([
  "receipt",
  "failure",
  "rejection",
  "invalidation",
]);
const FACTORY_KEYS = new Set([
  "enabled",
  "runner",
  "confirmationProducer",
  "actorAccountId",
  "clock",
  "pollIntervalMs",
  "leaseDurationMs",
  "handlerTimeoutMs",
  "retryBaseMs",
  "retryMaxMs",
  "defaultBatchLimit",
]);

function invalidProposal(message = "GitHub Review 工作提案处理失败") {
  return workProposalError("INVALID_GITHUB_REVIEW_PROPOSAL", message);
}

function invalidConfirmation(message = "GitHub Review 确认结果无效") {
  return workProposalError("INVALID_GITHUB_REVIEW_CONFIRMATION", message);
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeActor(value) {
  if (typeof value !== "string" || !GITHUB_LOGIN.test(value)) {
    throw new TypeError("actorAccountId is invalid");
  }
  return value;
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(
    value,
    new TypeError("clock is invalid"),
  );
}

function sameValue(left, right) {
  try {
    return (
      JSON.stringify(cloneWorkProposalValue(left)) ===
      JSON.stringify(cloneWorkProposalValue(right))
    );
  } catch {
    return false;
  }
}

function downstreamReference(value, error) {
  if (value === null) return null;
  if (typeof value !== "string") throw error;
  return value;
}

function normalizeHandlerInput(value) {
  const error = invalidProposal();
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "attempt", "downstreamRef"],
    error,
  );
  if (!ACTIVE_PROPOSAL_STATUSES.has(value.status)) throw error;
  return {
    proposal: value.proposal,
    status: value.status,
    attempt: safeWorkProposalInteger(value.attempt, "attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef: downstreamReference(value.downstreamRef, error),
  };
}

function normalizeFailure(value, error) {
  assertWorkProposalExactKeys(
    value,
    ["code", "outcome", "retryable", "at"],
    error,
  );
  if (
    typeof value.code !== "string" ||
    !FAILURE_CODE.test(value.code) ||
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
  const keys = entries.map(([key]) => key);
  if (
    REQUIRED_CONFIRMATION_KEYS.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !REQUIRED_CONFIRMATION_KEYS.includes(key) &&
        !OPTIONAL_CONFIRMATION_KEYS.has(key),
    )
  ) {
    throw error;
  }
  const item = cloneWorkProposalValue(Object.fromEntries(entries));
  if (
    item.id !== expected.id ||
    item.kind !== expected.kind ||
    !CONFIRMATION_STATUSES.has(item.status) ||
    !Number.isSafeInteger(item.queueRevision) ||
    item.queueRevision < 1 ||
    !Number.isSafeInteger(item.itemRevision) ||
    item.itemRevision < 1 ||
    !sameValue(item.requestedBy, expected.requestedBy) ||
    !sameValue(item.actor, expected.actor) ||
    !sameValue(item.target, expected.target) ||
    !sameValue(item.display, expected.display) ||
    normalizeWorkProposalDigest(item.displayedPayloadDigest, error) !==
      expected.displayedPayloadDigest ||
    normalizeWorkProposalDigest(item.approvalBindingDigest, error) !==
      expected.approvalBindingDigest ||
    typeof item.retryable !== "boolean"
  ) {
    throw error;
  }
  const optional = keys.filter((key) => OPTIONAL_CONFIRMATION_KEYS.has(key));
  const allowedOptional = {
    pending: [],
    executing: [],
    completed: ["receipt"],
    failed: ["failure"],
    stale: ["invalidation"],
    rejected: ["rejection"],
  }[item.status];
  if (optional.some((key) => !allowedOptional.includes(key))) throw error;
  if (
    (item.status === "completed" && !optional.includes("receipt")) ||
    (item.status === "failed" && !optional.includes("failure")) ||
    (item.status === "rejected" && !optional.includes("rejection")) ||
    (item.status !== "failed" && item.retryable)
  ) {
    throw error;
  }
  const failure = item.status === "failed" ? normalizeFailure(item.failure, error) : null;
  if (failure && item.retryable !== failure.retryable) throw error;
  return { ...item, failure };
}

function nextAttemptAt(clock, pollIntervalMs) {
  return new Date(
    Date.parse(normalizeClock(clock)) + pollIntervalMs,
  ).toISOString();
}

function waitingConfirmation(item, clock, pollIntervalMs) {
  return {
    status: "waiting_confirmation",
    downstreamRef: item.id,
    nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
  };
}

function terminal(status, summary, item, evidence = []) {
  return {
    status,
    summary,
    evidence: [`confirmation:${item.id}`, ...evidence],
  };
}

function transitionFor(item, clock, pollIntervalMs) {
  if (["pending", "executing"].includes(item.status)) {
    return waitingConfirmation(item, clock, pollIntervalMs);
  }
  if (item.status === "completed") {
    return terminal("succeeded", "GitHub Review 已完成", item);
  }
  if (item.status === "rejected") {
    return terminal("rejected", "用户已拒绝 GitHub Review 提案", item);
  }
  if (item.status === "stale") {
    return terminal("stale", "GitHub Review 提案已失效", item);
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
    "GitHub Review 外部结果无法确认",
    item,
    [item.failure.code],
  );
}

export class GitHubReviewProposalHandler {
  #enqueue;
  #get;
  #actorAccountId;
  #clock;
  #pollIntervalMs;

  constructor({
    confirmationProducer,
    actorAccountId,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    const producer = requirePort(
      confirmationProducer,
      ["enqueue", "get"],
      "confirmationProducer",
    );
    this.#enqueue = producer.enqueue;
    this.#get = producer.get;
    this.#actorAccountId = normalizeActor(actorAccountId);
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
    const plan = createGitHubReviewProposalConfirmationPlan(input.proposal, {
      actorAccountId: this.#actorAccountId,
    });
    const expected = normalizeConfirmationPlan(plan);
    if (input.downstreamRef !== null && input.downstreamRef !== expected.id) {
      throw invalidConfirmation("GitHub Review 确认绑定已变化");
    }
    const item = normalizeConfirmationItem(
      input.downstreamRef === null
        ? await this.#enqueue(plan)
        : await this.#get(input.downstreamRef),
      expected,
    );
    return transitionFor(item, this.#clock, this.#pollIntervalMs);
  }
}

function factoryOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("GitHub proposal runner options are invalid");
  }
  const entries = workProposalDataEntries(
    value,
    new TypeError("GitHub proposal runner options are invalid"),
  );
  if (entries.some(([key]) => !FACTORY_KEYS.has(key))) {
    throw new TypeError("GitHub proposal runner options are invalid");
  }
  return Object.fromEntries(entries);
}

export function createGitHubReviewProposalRunnerService(value = {}) {
  const options = factoryOptions(value);
  if (options.enabled === undefined || options.enabled === false) return null;
  if (options.enabled !== true) {
    throw new TypeError("GitHub proposal runner enabled flag is invalid");
  }
  const handler = new GitHubReviewProposalHandler({
    confirmationProducer: options.confirmationProducer,
    actorAccountId: options.actorAccountId,
    clock: options.clock,
    pollIntervalMs: options.pollIntervalMs,
  });
  return new WorkProposalRunnerService({
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
