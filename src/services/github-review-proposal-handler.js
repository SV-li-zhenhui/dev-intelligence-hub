import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import { normalizeReviewHandoff } from "../domain/review-handoff.js";
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
  "reviewHandoff",
  "resolutionRequired",
  "ownerDecision",
]);
const FACTORY_KEYS = new Set([
  "enabled",
  "runner",
  "confirmationProducer",
  "inputAuthorityVerifier",
  "pullRequestContextReader",
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
  if (item.reviewHandoff !== undefined) {
    normalizeReviewHandoff(item.reviewHandoff, { ...expected, action: expected.display.payload.action });
  }
  const optional = keys.filter((key) => OPTIONAL_CONFIRMATION_KEYS.has(key) && key !== "reviewHandoff");
  const allowedOptional = {
    pending: [],
    executing: [],
    completed: ["receipt"],
    failed: ["failure", "resolutionRequired"],
    stale: ["invalidation"],
    rejected: ["rejection", "ownerDecision", "failure"],
  }[item.status];
  if (optional.some((key) => !allowedOptional.includes(key))) throw error;
  if (
    (item.status === "completed" && !optional.includes("receipt")) ||
    (item.status === "failed" && !optional.includes("failure")) ||
    (item.status === "rejected" && !optional.includes("rejection") && !optional.includes("ownerDecision")) ||
    (item.status !== "failed" && item.retryable)
  ) {
    throw error;
  }
  const failure = optional.includes("failure") ? normalizeFailure(item.failure, error) : null;
  if (failure && item.retryable !== failure.retryable) throw error;
  if (optional.includes("resolutionRequired") &&
      (item.resolutionRequired !== true || failure?.outcome !== "unknown")) throw error;
  if (optional.includes("ownerDecision")) {
    assertWorkProposalExactKeys(item.ownerDecision, ["type", "at"], error);
    if (item.ownerDecision.type !== "seal_unknown_and_forbid_replay" ||
        failure?.outcome !== "unknown" || optional.includes("rejection")) throw error;
    normalizeWorkProposalTimestamp(item.ownerDecision.at, error);
  } else if (item.status === "rejected" && failure !== null) {
    throw error;
  }
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
    if (item.ownerDecision) {
      return terminal("rejected", "用户已承认 GitHub Review 结果未知并封存，禁止重放", item, [item.failure.code]);
    }
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
  // Keep polling the local confirmation until the owner resolves the unknown
  // result. This never retries the external Review or loses the later seal.
  if (item.resolutionRequired === true) return waitingConfirmation(item, clock, pollIntervalMs);
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
  #invalidate;
  #verifyInputAuthority;
  #readPullRequestContext;
  #actorAccountId;
  #clock;
  #pollIntervalMs;

  constructor({
    confirmationProducer,
    inputAuthorityVerifier,
    pullRequestContextReader,
    actorAccountId,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    const producer = requirePort(
      confirmationProducer,
      ["enqueue", "get", "invalidate"],
      "confirmationProducer",
    );
    this.#enqueue = producer.enqueue;
    this.#get = producer.get;
    this.#invalidate = producer.invalidate;
    this.#verifyInputAuthority = requirePort(
      inputAuthorityVerifier,
      ["verify"],
      "inputAuthorityVerifier",
    ).verify;
    this.#readPullRequestContext = pullRequestContextReader === undefined
      ? null
      : requirePort(
          pullRequestContextReader,
          ["readCurrent"],
          "pullRequestContextReader",
        ).readCurrent;
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
    const initialPlan = createGitHubReviewProposalConfirmationPlan(input.proposal, {
      actorAccountId: this.#actorAccountId,
      legacyRecovery: true,
    });
    const selfPlan = createGitHubReviewProposalConfirmationPlan(input.proposal, {
      actorAccountId: this.#actorAccountId,
      legacyRecovery: true,
      selfAuthored: true,
    });
    const legacySelfPlan = createGitHubReviewProposalConfirmationPlan(
      input.proposal,
      {
        actorAccountId: this.#actorAccountId,
        legacyRecovery: true,
        legacySelfAuthored: true,
      },
    );
    const legacyUnversionedSelfPlan =
      createGitHubReviewProposalConfirmationPlan(input.proposal, {
        actorAccountId: this.#actorAccountId,
        legacyRecovery: true,
        legacyUnversionedSelfAuthored: true,
      });
    const inputBinding =
      initialPlan.action.inputBinding ?? initialPlan.display.payload.inputBinding;
    const authority = await this.#currentAuthority(inputBinding);
    const selfAuthored =
      typeof authority?.author === "string" &&
      authority?.author.toLowerCase() === this.#actorAccountId.toLowerCase();
    const plan = selfAuthored ? selfPlan : initialPlan;
    const expected = normalizeConfirmationPlan(plan);
    const initialExpected = normalizeConfirmationPlan(initialPlan);
    const selfExpected = normalizeConfirmationPlan(selfPlan);
    const legacySelfExpected = normalizeConfirmationPlan(legacySelfPlan);
    const legacyUnversionedSelfExpected = normalizeConfirmationPlan(
      legacyUnversionedSelfPlan,
    );
    const referencedExpecteds = input.downstreamRef === null
      ? []
      : [
          initialExpected,
          selfExpected,
          legacySelfExpected,
          legacyUnversionedSelfExpected,
        ].filter((candidate) => candidate.id === input.downstreamRef);
    const legacyInputBinding =
      inputBinding !== null &&
      inputBinding !== undefined &&
      inputBinding.schemaVersion !== 2;
    if (
      input.downstreamRef !== null &&
      referencedExpecteds.length === 0
    ) {
      throw invalidConfirmation("GitHub Review 确认绑定已变化");
    }
    let item = null;
    let referencedExpected = null;
    if (input.downstreamRef !== null) {
      try {
        const stored = await this.#get(input.downstreamRef);
        for (const candidate of referencedExpecteds) {
          try {
            item = normalizeConfirmationItem(stored, candidate);
            referencedExpected = candidate;
            break;
          } catch (error) {
            if (error?.code !== "INVALID_GITHUB_REVIEW_CONFIRMATION") {
              throw error;
            }
          }
        }
        if (item === null) throw invalidConfirmation();
      } catch (error) {
        if (!legacyInputBinding || error?.code !== "CONFIRMATION_NOT_FOUND") {
          throw error;
        }
      }
    }
    const migratesLegacySelfReview =
      selfAuthored &&
      referencedExpected !== null &&
      referencedExpected.approvalBindingDigest !== expected.approvalBindingDigest;
    if (
      authority !== null &&
      referencedExpected !== null &&
      referencedExpected.approvalBindingDigest !== expected.approvalBindingDigest &&
      !migratesLegacySelfReview
    ) {
      throw invalidConfirmation("GitHub Review 确认绑定已变化");
    }
    if (authority === null) {
      if (item === null) {
        return {
          status: "stale",
          summary: "GitHub Review 授权已变化，未进入确认队列",
          evidence: [
            "authorization_changed",
            `proposal:${input.proposal.proposalId}`,
          ],
        };
      }
      if (["completed", "rejected", "stale"].includes(item.status)) {
        return transitionFor(item, this.#clock, this.#pollIntervalMs);
      }
      return this.#invalidateChangedAuthorization(
        item,
        referencedExpected ?? expected,
        input.proposal,
      );
    }
    if (migratesLegacySelfReview) {
      return this.#migrateLegacySelfReview(
        item,
        referencedExpected,
        plan,
        expected,
        input.proposal,
      );
    }
    if (item === null) {
      item = normalizeConfirmationItem(await this.#enqueue(plan), expected);
    }
    return transitionFor(item, this.#clock, this.#pollIntervalMs);
  }

  async #currentAuthority(inputBinding) {
    if (inputBinding?.schemaVersion !== 2) return null;
    if (this.#readPullRequestContext === null) {
      let verified;
      try {
        verified = await this.#verifyInputAuthority(
          cloneWorkProposalValue(inputBinding),
        );
      } catch {
        return null;
      }
      return sameValue(verified, inputBinding) ? { author: null } : null;
    }
    let context;
    try {
      context = await this.#readPullRequestContext(
        cloneWorkProposalValue(inputBinding),
      );
    } catch {
      return null;
    }
    if (
      context === null ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      Object.getPrototypeOf(context) !== Object.prototype ||
      Reflect.ownKeys(context).length !== 2 ||
      !Object.hasOwn(context, "inputBinding") ||
      !Object.hasOwn(context, "author") ||
      !sameValue(context.inputBinding, inputBinding) ||
      (context.author !== null &&
        (typeof context.author !== "string" || !GITHUB_LOGIN.test(context.author)))
    ) {
      return null;
    }
    return { author: context.author };
  }

  async #invalidateChangedAuthorization(item, expected, proposal) {
    let current = item;
    if (
      item.status === "pending" ||
      (item.status === "failed" && item.failure?.retryable) ||
      item.status === "stale"
    ) {
      try {
        current = normalizeConfirmationItem(
          await this.#invalidate(item.id, {
            requestedBy: proposal.requestedBy,
            approvalBindingDigest: item.approvalBindingDigest,
            reason: "authorization_changed",
          }),
          expected,
        );
      } catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_INVALIDATABLE") throw error;
        current = normalizeConfirmationItem(
          await this.#get(item.id),
          expected,
        );
      }
    }
    if (current.status === "pending") {
      throw invalidConfirmation("旧 GitHub Review 确认未能安全撤销");
    }
    return terminal(
      "stale",
      "GitHub Review 授权已变化，旧确认已撤销或隔离",
      current,
      ["authorization_changed", `old_confirmation_status:${current.status}`],
    );
  }

  async #migrateLegacySelfReview(
    item,
    legacyExpected,
    plan,
    expected,
    proposal,
  ) {
    let current = item;
    if (
      item.status === "pending" ||
      (item.status === "failed" && item.failure?.retryable) ||
      item.status === "stale"
    ) {
      if (item.status !== "stale") {
        try {
          current = normalizeConfirmationItem(
            await this.#invalidate(item.id, {
              requestedBy: proposal.requestedBy,
              approvalBindingDigest: item.approvalBindingDigest,
              reason: "authorization_changed",
            }),
            legacyExpected,
          );
        } catch (error) {
          if (error?.code !== "CONFIRMATION_NOT_INVALIDATABLE") throw error;
          current = normalizeConfirmationItem(
            await this.#get(item.id),
            legacyExpected,
          );
        }
      }
      if (current.status === "stale") {
        const replacement = normalizeConfirmationItem(
          await this.#enqueue(plan),
          expected,
        );
        const transition = transitionFor(
          replacement,
          this.#clock,
          this.#pollIntervalMs,
        );
        return Object.hasOwn(transition, "downstreamRef")
          ? { ...transition, downstreamRef: item.id }
          : transition;
      }
    }
    return transitionFor(current, this.#clock, this.#pollIntervalMs);
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
    inputAuthorityVerifier: options.inputAuthorityVerifier,
    pullRequestContextReader: options.pullRequestContextReader,
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
