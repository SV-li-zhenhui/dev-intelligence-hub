import { normalizeWorkDecision } from "../domain/work-intent.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { brainFailureOwnerAttention } from "./brain-failure-policy.js";
import { OrchestratorServiceError } from "./orchestrator-service.js";
import {
  normalizeWorkCoordinationTiming,
  WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
  WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS,
} from "./work-coordination-timing.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { isPreWriteGraphRevisionConflict } from "./work-ledger-graph-command-support.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DEFAULT_INTAKE_LIMIT = 100;
const DEFAULT_WORK_LIMIT = 20;
const MAX_PAGE_COUNT = 100;
const PAGE_SIZE = 100;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const ORCHESTRATOR_ROLE_ID = "orchestrator";
const ORCHESTRATOR_WORKER_ID = "employee-orchestrator";
const SATISFIED_GRAPH_STATUSES = new Set(["completed", "superseded"]);
const SETTLED_GRAPH_CHILD_STATUSES = new Set([
  ...SATISFIED_GRAPH_STATUSES,
  "cancelled",
]);
const RUNTIME_ADMISSION_ERROR_CODES = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);
const ROOT_DECISION_DEFERRED_ERROR_CODES = new Set([
  "STRUCTURED_BRAIN_RESPONSE_INVALID",
  "STRUCTURED_PROVIDER_RESPONSE_INVALID",
]);
const CONTEXT_CONTENTION_ERROR_CODES = new Set([
  "ROLE_CONTEXT_STALE",
  "ROLE_DECISION_INPUT_STALE",
  "ORCHESTRATOR_CONTEXT_STALE",
  "WORK_LEDGER_REVISION_CONFLICT",
]);

function isContextContention(error) {
  return CONTEXT_CONTENTION_ERROR_CODES.has(stableFailureCode(error)) ||
    isPreWriteGraphRevisionConflict(error);
}
const NON_BUDGET_CLAIM_FAILURE_CODES = new Set([
  "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
]);
const DECISION_FAILURE_REASONS = Object.freeze({
  retry: "decision_failed",
  exhausted: "decision_attempts_exhausted",
});
const DELIVERY_FAILURE_REASONS = Object.freeze({
  retry: "delivery_failed",
  exhausted: "delivery_attempts_exhausted",
});
const OWNER_REQUEST_PRIORITIES = Object.freeze({
  normal: 1,
  high: 2,
  urgent: 3,
});
const HIGH_PRIORITY_ISSUE_LABELS = new Set([
  "urgent",
  "blocker",
  "priority: high",
  "p0",
  "p1",
]);

function requirePort(value, methods, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const port = {};
  try {
    for (const method of methods) {
      let current = value;
      let found = false;
      while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, method);
        if (descriptor) {
          if (
            !("value" in descriptor) ||
            typeof descriptor.value !== "function"
          ) {
            throw new TypeError(`${name} is invalid`);
          }
          port[method] = descriptor.value.bind(value);
          found = true;
          break;
        }
        current = Object.getPrototypeOf(current);
      }
      if (!found) throw new TypeError(`${name} is invalid`);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  return Object.freeze(port);
}

function optionalPortMethod(value, method, name) {
  let current = value;
  try {
    while (current !== null && current !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  return null;
}

function boundedString(value, name, maximumBytes = 128) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeRoleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError("roleId is invalid");
  }
  return value;
}

function dataEntries(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function cycleOptions(value = {}) {
  const entries = dataEntries(value);
  if (!entries) throw new TypeError("runCycle options are invalid");
  const input = Object.fromEntries(entries);
  if (
    Object.keys(input).some(
      (key) =>
        !["trigger", "intakeLimit", "workLimit", "roleId", "signal"].includes(
          key,
        ),
    )
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  return Object.freeze({
    trigger:
      input.trigger === undefined
        ? "scheduled"
        : boundedString(input.trigger, "trigger"),
    intakeLimit:
      input.intakeLimit === undefined
        ? DEFAULT_INTAKE_LIMIT
        : positiveInteger(input.intakeLimit, "intakeLimit", 100),
    workLimit:
      input.workLimit === undefined
        ? DEFAULT_WORK_LIMIT
        : positiveInteger(input.workLimit, "workLimit", 100),
    roleId: input.roleId === undefined ? null : safeRoleId(input.roleId),
    signal: normalizeAbortSignal(input.signal ?? null),
  });
}

function throwIfLoopAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error("Proactive work cycle was cancelled"), {
    code: "PROACTIVE_WORK_CANCELLED",
  });
}

function normalizeLoopClock(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    throw new TypeError("clock failed", { cause: error });
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw new TypeError("clock is invalid");
  }
  return timestamp;
}

function targetKey(target) {
  return `${target.type}:${target.id}`;
}

function isAvailable(item, now) {
  if (item.status === "queued") return true;
  if (item.status === "retry_wait") {
    return Date.parse(item.availableAt) <= Date.parse(now);
  }
  return (
    item.status === "working" &&
    typeof item.leaseUntil === "string" &&
    Date.parse(item.leaseUntil) <= Date.parse(now)
  );
}

function ownerRequestPriority(item) {
  let event;
  try {
    event = currentWorkItemEvent(item);
  } catch {
    return 0;
  }
  if (
    event?.source?.provider !== "local-owner" ||
    ![
      "owner_request.created",
      "pull_request.owner_requested",
      "issue.owner_requested",
    ].includes(
      event.eventType,
    )
  ) {
    return 0;
  }
  return OWNER_REQUEST_PRIORITIES[event.payload?.priority] ?? 0;
}

function issueEventFacts(item) {
  let event;
  try {
    event = currentWorkItemEvent(item);
  } catch {
    return null;
  }
  if (
    event?.source?.provider !== "github" ||
    typeof event.eventType !== "string" ||
    !event.eventType.startsWith("issue.") ||
    !event.payload ||
    typeof event.payload !== "object"
  ) {
    return null;
  }
  return event;
}

function issueUpdatedAt(event) {
  const value = event?.payload?.updatedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
}

function issueIsEligible(item, now, activeWindowDays) {
  const event = issueEventFacts(item);
  if (event === null) return true;
  if (["issue.completed", "issue.left_scope"].includes(event.eventType)) {
    return true;
  }
  const updatedAt = issueUpdatedAt(event);
  if (updatedAt === null) return true;
  return updatedAt > Date.parse(now) - activeWindowDays * 86_400_000;
}

function issuePriority(item) {
  const event = issueEventFacts(item);
  if (event === null) return 0;
  const labels = Array.isArray(event.payload.labels)
    ? event.payload.labels
    : [];
  return labels.some(
    (label) =>
      typeof label === "string" &&
      HIGH_PRIORITY_ISSUE_LABELS.has(label.toLowerCase()),
  )
    ? 1
    : 0;
}

function prioritizeWorkItems(items, candidateFacts = null) {
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const children = childrenByParent.get(parentItemId) ?? [];
    children.push(item);
    childrenByParent.set(parentItemId, children);
  }
  return items
    .map((item, index) => {
      const issueEvent = issueEventFacts(item);
      const facts = candidateFacts?.get(item.itemId);
      const children = item.currentTarget?.type === "role" &&
          item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
          item.graph?.parentItemId === null
        ? childrenByParent.get(item.itemId) ?? []
        : [];
      return {
        item,
        index,
        priority: ownerRequestPriority(item),
        issuePriority: issuePriority(item),
        issueUpdatedAt: issueUpdatedAt(issueEvent) ?? 0,
        isIssue: issueEvent !== null,
        submittedChildren: facts?.submittedChildren ?? children.filter((child) =>
          child.graph?.deliveries?.at(-1)?.status === "submitted"
        ).length,
        satisfiedChildren: facts?.satisfiedChildren ?? children.filter((child) =>
          SETTLED_GRAPH_CHILD_STATUSES.has(child.status)
        ).length,
      };
    })
    .sort((left, right) =>
      right.priority - left.priority ||
      right.submittedChildren - left.submittedChildren ||
      right.satisfiedChildren - left.satisfiedChildren ||
      right.issuePriority - left.issuePriority ||
      (left.isIssue && right.isIssue
        ? right.issueUpdatedAt - left.issueUpdatedAt
        : 0) ||
      left.index - right.index
    )
    .map(({ item }) => item);
}

function graphBlockedItemIds(items) {
  const statusById = new Map(items.map((item) => [item.itemId, item.status]));
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const childIds = childrenByParent.get(parentItemId) ?? [];
    childIds.push(item.itemId);
    childrenByParent.set(parentItemId, childIds);
  }
  return new Set(
    items
      .filter((item) => {
        const dependencies = item.graph?.dependsOnItemIds;
        const blockedByDependency = Array.isArray(dependencies) &&
          dependencies.some(
            (dependencyId) =>
              !SATISFIED_GRAPH_STATUSES.has(statusById.get(dependencyId)),
          );
        const blockedByChild = (childrenByParent.get(item.itemId) ?? []).some(
          (childId) =>
            !SETTLED_GRAPH_CHILD_STATUSES.has(statusById.get(childId)),
        );
        return blockedByDependency || blockedByChild;
      })
      .map(({ itemId }) => itemId),
  );
}

function candidatePriorityFacts(items) {
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const children = childrenByParent.get(parentItemId) ?? [];
    children.push(item);
    childrenByParent.set(parentItemId, children);
  }
  return new Map(items.map((item) => {
    const children = childrenByParent.get(item.itemId) ?? [];
    return [item.itemId, {
      itemId: item.itemId,
      submittedChildren: children.filter((child) =>
        child.graph?.deliveries?.at(-1)?.status === "submitted"
      ).length,
      satisfiedChildren: children.filter((child) =>
        SETTLED_GRAPH_CHILD_STATUSES.has(child.status)
      ).length,
    }];
  }));
}

function isConfiguredRootItem(item, resolution) {
  return (
    resolution.orchestrator === false &&
    resolution.roleId === ORCHESTRATOR_ROLE_ID &&
    item.currentTarget.type === "role" &&
    item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
    item.graph?.parentItemId === null
  );
}

function stableFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (
      typeof code === "string" &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ) {
      return code;
    }
  } catch {
    // Errors are untrusted; fall through to one stable local classification.
  }
  return "ROLE_DECISION_FAILED";
}

function terminalPullRequestState(error) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return null;
    }
    visited.add(current);
    try {
      const codeDescriptor = Object.getOwnPropertyDescriptor(current, "code");
      const stateDescriptor = Object.getOwnPropertyDescriptor(
        current,
        "terminalState",
      );
      if (
        codeDescriptor &&
        "value" in codeDescriptor &&
        codeDescriptor.value === "PR_FACTS_TERMINAL" &&
        stateDescriptor &&
        "value" in stateDescriptor &&
        ["CLOSED", "MERGED"].includes(stateDescriptor.value)
      ) {
        return stateDescriptor.value;
      }
      const causeDescriptor = Object.getOwnPropertyDescriptor(current, "cause");
      if (!causeDescriptor || !("value" in causeDescriptor)) return null;
      current = causeDescriptor.value;
    } catch {
      return null;
    }
  }
  return null;
}

function claimFailureOutcome(claim) {
  return {
    status: claim.status,
    ...(claim.code ? { code: claim.code } : {}),
  };
}

function claimFailureConsumesWorkBudget(claim) {
  return !NON_BUDGET_CLAIM_FAILURE_CODES.has(claim.code);
}

function configuredResultConsumesWorkBudget(result) {
  return result.claimed ||
    !result.claimAttempted ||
    claimFailureConsumesWorkBudget(result.outcome);
}

function ownerBrainAttentionDecision(error, roleId) {
  const code = stableFailureCode(error);
  const attention = brainFailureOwnerAttention(code);
  if (!attention) return null;
  const summary = `${attention.summary}（${roleId}）`;
  return {
    schemaVersion: 1,
    confidence: 100,
    summary,
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary,
      reason: `真实任务不得回退到例行大脑；系统已安全停止（${attention.code}）`,
      question: `${attention.remediation}。完成后请选择“已配置，重试”；若不再继续该任务，请拒绝本次请示。`,
      choices: [
        {
          id: "configured-retry",
          label: "已配置，重试",
          description: "重新唤醒原任务，并再次核验任务大脑和授权。",
        },
      ],
    },
  };
}

function timeoutError(code) {
  return Object.assign(new Error(code), { code });
}

async function withinAbortable(
  operation,
  durationMs,
  code,
  parentSignal = null,
) {
  const controller = new AbortController();
  const deadline = timeoutError(code);
  const handleParentAbort = () => {
    if (controller.signal.aborted) return;
    controller.abort(
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : Object.assign(new Error("Proactive work cycle was cancelled"), {
            code: "PROACTIVE_WORK_CANCELLED",
          }),
    );
  };
  if (parentSignal?.aborted) handleParentAbort();
  parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(deadline);
  }, durationMs);
  try {
    const result = await Promise.resolve().then(() =>
      operation(controller.signal),
    );
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", handleParentAbort);
  }
}

function workerItemDto(item) {
  const {
    ownerId: _ownerId,
    leaseId: _leaseId,
    leaseUntil: _leaseUntil,
    ...visible
  } = item;
  return structuredClone({
    ...visible,
    event: currentWorkItemEvent(item),
  });
}

function orchestratorDecision(target) {
  const targetLabel = `${target.type}:${target.id}`;
  return {
    schemaVersion: 1,
    confidence: 100,
    summary: "需要用户决定缺失岗位的工作路由",
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary: `目标 ${targetLabel} 当前没有可执行员工`,
      reason: "系统保留了原始分派，但无法安全替用户选择接手人",
      question: `工作原计划交给 ${targetLabel}，请决定由谁接手或如何重新路由。`,
      choices: [
        {
          id: "reroute",
          label: "重新路由",
          description: "选择另一个岗位或员工处理。",
        },
        {
          id: "take-over",
          label: "我来接手",
          description: "将该工作保留给用户亲自处理。",
        },
        {
          id: "keep-waiting",
          label: "继续等待",
          description: "保持工作不执行，等待目标岗位可用。",
        },
      ],
    },
  };
}

function activeQuestionTargets(items) {
  return new Set(
    items
      .filter((item) =>
        ["dispatch_pending", "waiting_user"].includes(item.status),
      )
      .map((item) => targetKey(item.currentTarget)),
  );
}

export class ProactiveWorkLoop {
  constructor({
    ledger,
    roleDirectory,
    clock = () => new Date(),
    leaseDurationMs,
    maxAttempts = 3,
    retryBaseMs = 30 * 1000,
    retryMaxMs = 15 * 60 * 1000,
    resolveTimeoutMs,
    decideTimeoutMs,
    roleContextAssembler,
    orchestratorService,
    memoryQueryService,
    issueActiveWindowDays = 14,
  } = {}) {
    this.ledger = requirePort(
      ledger,
      [
        "intake",
        "listItems",
        "claim",
        "stageIntent",
        "scheduleRetry",
        "transition",
      ],
      "ledger",
    );
    this.readItemForReconciliation = optionalPortMethod(
      ledger,
      "readItemForReconciliation",
      "ledger.readItemForReconciliation",
    );
    this.listClaimCandidates = optionalPortMethod(
      ledger,
      "listClaimCandidates",
      "ledger.listClaimCandidates",
    );
    this.retireInactiveIssues = optionalPortMethod(
      ledger,
      "retireInactiveIssues",
      "ledger.retireInactiveIssues",
    );
    this.roleDirectory = requirePort(
      roleDirectory,
      ["resolve"],
      "roleDirectory",
    );
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.clock = clock;
    const timing = normalizeWorkCoordinationTiming(
      {
        leaseDurationMs,
        resolveTimeoutMs,
        decisionTimeoutMs: decideTimeoutMs,
      },
      {
        roleContextEnabled:
          roleContextAssembler != null && orchestratorService != null,
      },
    );
    this.leaseDurationMs = timing.leaseDurationMs;
    this.resolveTimeoutMs = timing.resolveTimeoutMs;
    this.decideTimeoutMs = timing.decisionTimeoutMs;
    this.maxAttempts = positiveInteger(maxAttempts, "maxAttempts", 100);
    this.retryBaseMs = positiveInteger(
      retryBaseMs,
      "retryBaseMs",
      24 * 60 * 60 * 1000,
    );
    this.retryMaxMs = positiveInteger(
      retryMaxMs,
      "retryMaxMs",
      24 * 60 * 60 * 1000,
    );
    this.issueActiveWindowDays = positiveInteger(
      issueActiveWindowDays,
      "issueActiveWindowDays",
      3_650,
    );
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new TypeError("retryMaxMs is invalid");
    }
    if ((roleContextAssembler == null) !== (orchestratorService == null)) {
      throw new TypeError(
        "roleContextAssembler and orchestratorService must be configured together",
      );
    }
    this.roleContextAssembler = roleContextAssembler == null
      ? null
      : requirePort(
          roleContextAssembler,
          ["assemble"],
          "roleContextAssembler",
        );
    this.orchestratorService = orchestratorService == null
      ? null
      : requirePort(
          orchestratorService,
          ["execute"],
          "orchestratorService",
        );
    if (memoryQueryService != null && this.roleContextAssembler === null) {
      throw new TypeError(
        "memoryQueryService requires roleContextAssembler",
      );
    }
    this.memoryQueryService = memoryQueryService == null
      ? null
      : requirePort(
          memoryQueryService,
          ["execute", "verifyContext"],
          "memoryQueryService",
        );
    const leaseSafeDecisionPhaseMs =
      this.leaseDurationMs -
      this.resolveTimeoutMs -
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS -
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS;
    this.decisionPhaseTimeoutMs = this.memoryQueryService === null
      ? this.decideTimeoutMs
      : Math.min(this.decideTimeoutMs * 3, leaseSafeDecisionPhaseMs);
    this.inFlightByScope = new Map();
    this.inFlightItemIds = new Set();
    this.inFlightQuestionTargets = new Set();
    this.lastIssueRetirementKey = null;
    this.issueRetirementSweep = null;
    this.fencedClaimDeferrals = new Map();
    this.claimCycleSequence = 0;
  }

  runCycle(input = {}) {
    const options = cycleOptions(input);
    throwIfLoopAborted(options.signal);
    const scope = options.roleId ?? "*";
    const running = this.inFlightByScope.get(scope);
    if (running) return running;
    const execution = this.#executeCycle(options);
    const tracked = execution.finally(() => {
      if (this.inFlightByScope.get(scope) === tracked) {
        this.inFlightByScope.delete(scope);
      }
    });
    this.inFlightByScope.set(scope, tracked);
    return tracked;
  }

  async #executeCycle(options) {
    throwIfLoopAborted(options.signal);
    const now = normalizeLoopClock(this.clock);
    const issueRetirementCutoff = new Date(
      Date.parse(now) - this.issueActiveWindowDays * 86_400_000,
    ).toISOString();
    const intake = await this.ledger.intake({ limit: options.intakeLimit });
    throwIfLoopAborted(options.signal);
    await this.#retireInactiveIssueWork(
      intake,
      issueRetirementCutoff,
      now,
      options.signal,
    );
    throwIfLoopAborted(options.signal);
    const candidateAt = normalizeLoopClock(this.clock);
    const candidateWindow = await this.#listCandidateWindow(
      options,
      candidateAt,
    );
    const items = candidateWindow.items;
    throwIfLoopAborted(options.signal);
    const claimCycleSequence = ++this.claimCycleSequence;
    const itemRevisions = new Map(
      items.map((item) => [item.itemId, item.revision]),
    );
    for (const [itemId, deferral] of this.fencedClaimDeferrals) {
      if (
        (
          itemRevisions.has(itemId) &&
          itemRevisions.get(itemId) !== deferral.revision
        ) ||
        deferral.retryAfterCycle < claimCycleSequence
      ) {
        this.fencedClaimDeferrals.delete(itemId);
      }
    }
    const graphBlocked = candidateWindow.graphBlocked;
    const activeQuestions = candidateWindow.activeQuestions;
    const resolutions = new Map();
    const outcomes = intake.error
      ? [{ status: "intake_deferred", code: intake.error.code }]
      : [];
    let claimedCount = 0;
    let claimAttempts = 0;
    let workAttempts = 0;
    let availabilityChecks = 0;
    let availabilityBudgetUsed = 0;
    const availabilityCheckLimit = Math.max(
      options.workLimit + 3,
      options.workLimit * 2,
    );
    const claimAttemptLimit = Math.max(availabilityCheckLimit * 8, 32);

    for (const item of prioritizeWorkItems(items, candidateWindow.facts)) {
      throwIfLoopAborted(options.signal);
      if (workAttempts >= options.workLimit) break;
      if (availabilityBudgetUsed >= availabilityCheckLimit) break;
      if (claimAttempts >= claimAttemptLimit) break;
      const fencedDeferral = this.fencedClaimDeferrals.get(item.itemId);
      if (
        fencedDeferral?.revision === item.revision &&
        fencedDeferral.retryAfterCycle >= claimCycleSequence
      ) {
        continue;
      }
      if (!isAvailable(item, normalizeLoopClock(this.clock))) continue;
      if (
        !issueIsEligible(
          item,
          normalizeLoopClock(this.clock),
          this.issueActiveWindowDays,
        )
      ) {
        continue;
      }
      if (
        options.roleId !== null &&
        options.roleId !== ORCHESTRATOR_ROLE_ID &&
        (item.currentTarget.type !== "role" ||
          item.currentTarget.id !== options.roleId)
      ) {
        continue;
      }
      const key = targetKey(item.currentTarget);
      let resolution;
      try {
        if (!resolutions.has(key)) {
          try {
            resolutions.set(
              key,
              await this.#resolve(item.currentTarget, options.signal),
            );
          } catch (error) {
            throwIfLoopAborted(options.signal);
            resolutions.set(key, { status: "resolution_failed", error });
          }
        }
        resolution = resolutions.get(key);
      } catch {
        outcomes.push({ itemId: item.itemId, status: "resolution_failed" });
        continue;
      }
      if (resolution.status === "resolution_failed") {
        outcomes.push({ itemId: item.itemId, status: "resolution_failed" });
        continue;
      }
      if (options.roleId !== null && resolution.roleId !== options.roleId) {
        continue;
      }
      if (resolution.status === "paused") {
        outcomes.push({ itemId: item.itemId, status: "paused" });
        continue;
      }
      const isGraphBlocked = graphBlocked.has(item.itemId);
      const configuredRoot = isConfiguredRootItem(item, resolution);
      if (
        (resolution.orchestrator || this.roleContextAssembler === null) &&
        isGraphBlocked
      ) {
        continue;
      }
      if (resolution.orchestrator && activeQuestions.has(key)) {
        outcomes.push({
          itemId: item.itemId,
          status: "missing_target_waiting",
        });
        continue;
      }
      let reservedQuestionTarget = false;
      if (resolution.orchestrator) {
        if (this.inFlightQuestionTargets.has(key)) {
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
        this.inFlightQuestionTargets.add(key);
        reservedQuestionTarget = true;
        let questionAlreadyExists;
        try {
          questionAlreadyExists = activeQuestionTargets(
            await this.#listAllItems(options.signal),
          ).has(key);
          throwIfLoopAborted(options.signal);
        } catch (error) {
          this.inFlightQuestionTargets.delete(key);
          throw error;
        }
        if (questionAlreadyExists) {
          this.inFlightQuestionTargets.delete(key);
          activeQuestions.add(key);
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
      }
      if (
        this.roleContextAssembler !== null &&
        !resolution.orchestrator &&
        !configuredRoot &&
        isGraphBlocked
      ) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "graph_blocked" });
        continue;
      }
      if (this.inFlightItemIds.has(item.itemId)) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "already_in_flight" });
        continue;
      }
      this.inFlightItemIds.add(item.itemId);
      try {
        availabilityChecks += 1;
        availabilityBudgetUsed += 1;
        const availabilityOutcome = await this.#checkAvailability(
          item,
          resolution,
          options.signal,
        );
        if (availabilityOutcome !== null) {
          outcomes.push({ itemId: item.itemId, ...availabilityOutcome });
          continue;
        }
        if (
          this.roleContextAssembler !== null &&
          configuredRoot
        ) {
          const processed = await this.#processConfiguredOrchestrator({
            item,
            worker: resolution,
            options,
            graphBlocked: isGraphBlocked,
          });
          if (configuredResultConsumesWorkBudget(processed)) {
            workAttempts += 1;
          } else {
            availabilityBudgetUsed -= 1;
            this.fencedClaimDeferrals.set(item.itemId, {
              revision: item.revision,
              retryAfterCycle: claimCycleSequence + 1,
            });
          }
          if (configuredResultConsumesWorkBudget(processed)) {
            this.fencedClaimDeferrals.delete(item.itemId);
          }
          claimAttempts += processed.claimAttempted ? 1 : 0;
          claimedCount += processed.claimed ? 1 : 0;
          outcomes.push({ itemId: item.itemId, ...processed.outcome });
          continue;
        }

        claimAttempts += 1;
        const claim = await this.#claim(item, resolution, options);
        if (!claim.item) {
          if (claimFailureConsumesWorkBudget(claim)) {
            workAttempts += 1;
            this.fencedClaimDeferrals.delete(item.itemId);
          } else {
            availabilityBudgetUsed -= 1;
            this.fencedClaimDeferrals.set(item.itemId, {
              revision: item.revision,
              retryAfterCycle: claimCycleSequence + 1,
            });
          }
          outcomes.push({ itemId: item.itemId, ...claimFailureOutcome(claim) });
          continue;
        }
        this.fencedClaimDeferrals.delete(item.itemId);
        workAttempts += 1;
        claimedCount += 1;
        const outcome = this.roleContextAssembler === null || resolution.orchestrator
          ? await this.#decideAndStage(claim.item, resolution, options)
          : await this.#processSpecialist(claim.item, resolution, options);
        outcomes.push({ itemId: item.itemId, ...outcome });
        if (
          resolution.orchestrator &&
          ["staged", "stage_recovered", "stage_uncertain"].includes(
            outcome.status,
          )
        ) {
          activeQuestions.add(key);
        }
      } finally {
        this.inFlightItemIds.delete(item.itemId);
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
      }
    }

    throwIfLoopAborted(options.signal);
    return {
      trigger: options.trigger,
      roleId: options.roleId,
      intake,
      scanned: items.length,
      availabilityChecks,
      workAttempts,
      claimAttempts,
      claimed: claimedCount,
      staged: outcomes.filter(({ status }) => status === "staged").length,
      recoveredStages: outcomes.filter(
        ({ status }) => status === "stage_recovered",
      ).length,
      retried: outcomes.filter(({ status }) => status === "retry_scheduled")
        .length,
      blocked: outcomes.filter(({ status }) => status === "blocked").length,
      orchestrated: outcomes.filter(({ status }) => status === "orchestrated")
        .length,
      submittedDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_submitted",
      ).length,
      recoveredDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_recovered",
      ).length,
      outcomes,
    };
  }

  async #resolve(target, signal) {
    throwIfLoopAborted(signal);
    if (target.type !== "role") return this.#orchestrator(target);
    const candidate = await withinAbortable(
      () => this.roleDirectory.resolve({ ...target }),
      this.resolveTimeoutMs,
      "ROLE_RESOLUTION_TIMEOUT",
      signal,
    );
    throwIfLoopAborted(signal);
    if (candidate === null || candidate === undefined) {
      return this.#orchestrator(target);
    }
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      candidate.roleId !== target.id ||
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.paused !== "boolean" ||
      typeof candidate.decide !== "function"
    ) {
      throw new TypeError("roleDirectory returned an invalid worker");
    }
    const workerId = boundedString(candidate.workerId, "workerId");
    const checkAvailability = optionalPortMethod(
      candidate,
      "checkAvailability",
      "roleDirectory returned an invalid worker",
    );
    if (!candidate.enabled || candidate.paused) {
      return {
        status: "paused",
        orchestrator: false,
        roleId: candidate.roleId,
        workerId,
      };
    }
    return {
      status: "active",
      orchestrator: false,
      roleId: candidate.roleId,
      workerId,
      decide: candidate.decide.bind(candidate),
      ...(checkAvailability === null ? {} : { checkAvailability }),
    };
  }

  #orchestrator(target) {
    return {
      status: "active",
      orchestrator: true,
      roleId: ORCHESTRATOR_ROLE_ID,
      workerId: ORCHESTRATOR_WORKER_ID,
      decide: async () => orchestratorDecision(target),
    };
  }

  async #checkAvailability(item, worker, signal) {
    if (
      worker.orchestrator ||
      typeof worker.checkAvailability !== "function"
    ) {
      return null;
    }
    try {
      await withinAbortable(
        (availabilitySignal) => worker.checkAvailability({
          item: workerItemDto(item),
          signal: availabilitySignal,
        }),
        this.resolveTimeoutMs,
        "ROLE_RESOLUTION_TIMEOUT",
        signal,
      );
      throwIfLoopAborted(signal);
      return null;
    } catch (error) {
      throwIfLoopAborted(signal);
      const code = stableFailureCode(error);
      if (brainFailureOwnerAttention(code) !== null) {
        return { status: "degraded", code };
      }
      return { status: "resolution_failed" };
    }
  }

  async #claim(item, worker, options) {
    throwIfLoopAborted(options.signal);
    try {
      const claimed = {
        status: "claimed",
        item: await this.ledger.claim({
          itemId: item.itemId,
          expectedRevision: item.revision,
          workerId: worker.workerId,
          leaseDurationMs: this.leaseDurationMs,
        }),
      };
      throwIfLoopAborted(options.signal);
      return claimed;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        throw error;
      }
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        observed &&
        observed.status === "working" &&
        observed.ownerId === worker.workerId &&
        observed.revision === item.revision + 1 &&
        observed.attempt === item.attempt + 1 &&
        observed.inputDigest === item.inputDigest
      ) {
        return { status: "claim_recovered", item: observed };
      }
      return {
        status: observed ? "claim_not_acquired" : "claim_uncertain",
        code: stableFailureCode(error),
        item: null,
      };
    }
  }

  async #assembleContext(item, worker, options) {
    return withinAbortable(
      (signal) => this.roleContextAssembler.assemble({
        roleId: worker.roleId,
        item,
        trigger: options.trigger,
        signal,
      }),
      this.resolveTimeoutMs,
      "ROLE_CONTEXT_TIMEOUT",
      options.signal,
    );
  }

  async #decide(item, worker, options, context) {
    return normalizeWorkDecision(
      await withinAbortable(
        (signal) => worker.decide({
          item: workerItemDto(item),
          trigger: options.trigger,
          ...(context === undefined ? {} : { context }),
          signal,
        }),
        this.decideTimeoutMs,
        "ROLE_DECISION_TIMEOUT",
        options.signal,
      ),
    );
  }

  async #decideWithMemory(item, worker, options, packet) {
    return withinAbortable(
      (signal) => this.#runDecisionPhaseWithMemory(
        item,
        worker,
        options,
        packet,
        signal,
      ),
      this.decisionPhaseTimeoutMs,
      "ROLE_DECISION_TIMEOUT",
      options.signal,
    );
  }

  async #runDecisionPhaseWithMemory(item, worker, options, packet, signal) {
    const decide = async (context) => {
      signal.throwIfAborted();
      const decision = normalizeWorkDecision(
        await withinAbortable(
          (stageSignal) => worker.decide({
            item: workerItemDto(item),
            trigger: options.trigger,
            context,
            signal: stageSignal,
          }),
          this.decideTimeoutMs,
          "ROLE_DECISION_TIMEOUT",
          signal,
        ),
      );
      signal.throwIfAborted();
      return decision;
    };
    const first = await decide(packet.context);
    if (first.intent.type !== "query_memory") {
      await this.#verifyDecisionAuthority(item, worker, packet, signal);
      return { decision: first, packet };
    }
    if (this.memoryQueryService === null) {
      throw Object.assign(
        new Error("Agent memory query is not configured"),
        { code: "AGENT_MEMORY_QUERY_UNAVAILABLE" },
      );
    }
    await this.#verifyDecisionAuthority(item, worker, packet, signal);
    await withinAbortable(
      (stageSignal) => this.memoryQueryService.execute({
        roleId: worker.roleId,
        workerId: worker.workerId,
        item,
        intent: first.intent,
        signal: stageSignal,
      }),
      this.decideTimeoutMs,
      "AGENT_MEMORY_QUERY_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    const refreshedPacket = await withinAbortable(
      (stageSignal) => this.roleContextAssembler.assemble({
        roleId: worker.roleId,
        item,
        trigger: options.trigger,
        signal: stageSignal,
      }),
      this.resolveTimeoutMs,
      "ROLE_CONTEXT_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    const second = await decide(refreshedPacket.context);
    if (second.intent.type === "query_memory") {
      throw Object.assign(
        new Error("Only one memory query is allowed per work iteration"),
        { code: "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED" },
      );
    }
    await this.#verifyDecisionAuthority(
      item,
      worker,
      refreshedPacket,
      signal,
    );
    return { decision: second, packet: refreshedPacket };
  }

  async #verifyDecisionAuthority(item, worker, packet, signal) {
    const current = await withinAbortable(
      (verificationSignal) =>
        this.#readCurrentDecisionItem(item.itemId, verificationSignal),
      this.resolveTimeoutMs,
      "ROLE_DECISION_INPUT_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    if (!this.#sameDecisionInput(item, current)) {
      throw Object.assign(
        new Error("Role decision input changed while the provider was running"),
        { code: "ROLE_DECISION_INPUT_STALE" },
      );
    }
    const memoryContext = packet?.context?.memory?.agentQuery;
    if (memoryContext === undefined) return;
    if (this.memoryQueryService === null) {
      throw Object.assign(
        new Error("Memory context cannot be verified"),
        { code: "AGENT_MEMORY_QUERY_UNAVAILABLE" },
      );
    }
    await withinAbortable(
      (verificationSignal) => this.memoryQueryService.verifyContext({
        roleId: worker.roleId,
        item,
        context: memoryContext,
        signal: verificationSignal,
      }),
      this.resolveTimeoutMs,
      "AGENT_MEMORY_QUERY_VERIFICATION_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
  }

  async #readCurrentDecisionItem(itemId, signal = null) {
    throwIfLoopAborted(signal);
    try {
      const current = this.readItemForReconciliation === null
        ? await this.#findItem(itemId, signal)
        : await this.readItemForReconciliation({ itemId });
      throwIfLoopAborted(signal);
      if (current == null) {
        throw new Error("Role decision work item disappeared");
      }
      return current;
    } catch (cause) {
      throwIfLoopAborted(signal);
      throw Object.assign(
        new Error("Unable to revalidate the role decision input", { cause }),
        { code: "ROLE_DECISION_INPUT_UNAVAILABLE" },
      );
    }
  }

  #sameDecisionInput(expected, current) {
    return (
      current.itemId === expected.itemId &&
      current.revision === expected.revision &&
      current.inputDigest === expected.inputDigest &&
      current.status === expected.status &&
      current.ownerId === expected.ownerId &&
      current.leaseId === expected.leaseId &&
      current.leaseUntil === expected.leaseUntil &&
      current.currentTarget?.type === expected.currentTarget?.type &&
      current.currentTarget?.id === expected.currentTarget?.id
    );
  }

  async #processConfiguredOrchestrator({
    item,
    worker,
    options,
    graphBlocked,
  }) {
    throwIfLoopAborted(options.signal);
    let packet;
    let decision;
    try {
      packet = await this.#assembleContext(item, worker, options);
      ({ decision, packet } = await this.#decideWithMemory(
        item,
        worker,
        options,
        packet,
      ));
    } catch (error) {
      throwIfLoopAborted(options.signal);
      const terminalState = terminalPullRequestState(error);
      if (terminalState !== null) {
        const claim = await this.#claim(item, worker, options);
        if (!claim.item) {
          return {
            claimAttempted: true,
            claimed: false,
            outcome: claimFailureOutcome(claim),
          };
        }
        return {
          claimAttempted: true,
          claimed: true,
          outcome: await this.#blockTerminalPullRequest(
            claim.item,
            worker.workerId,
            options,
            terminalState,
          ),
        };
      }
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        throw error;
      }
      const code = stableFailureCode(error);
      if (ROOT_DECISION_DEFERRED_ERROR_CODES.has(code) || isContextContention(error)) {
        return {
          claimAttempted: false,
          claimed: false,
          outcome: {
            status: "decision_deferred",
            workerId: worker.workerId,
            code,
          },
        };
      }
      const attention = ownerBrainAttentionDecision(error, worker.roleId);
      if (attention === null) throw error;
      const claim = await this.#claim(item, worker, options);
      if (!claim.item) {
        return {
          claimAttempted: true,
          claimed: false,
          outcome: claimFailureOutcome(claim),
        };
      }
      return {
        claimAttempted: true,
        claimed: true,
        outcome: await this.#stageDecision(
          claim.item,
          worker,
          options,
          attention,
        ),
      };
    }
    throwIfLoopAborted(options.signal);
    if (decision.intent.type === "orchestrate") {
      throwIfLoopAborted(options.signal);
      let executed;
      try {
        executed = await this.orchestratorService.execute({
          worker: { roleId: worker.roleId, workerId: worker.workerId },
          item,
          contextPacket: packet,
          intent: decision.intent,
        });
      } catch (error) {
        throwIfLoopAborted(options.signal);
        const code = stableFailureCode(error);
        if (isContextContention(error)) {
          return {
            claimAttempted: false,
            claimed: false,
            outcome: { status: "decision_deferred", workerId: worker.workerId, code },
          };
        }
        if (
          !(error instanceof OrchestratorServiceError) ||
          code !== "ORCHESTRATOR_AUTHORITY_DENIED"
        ) {
          throw error;
        }
        return {
          claimAttempted: false,
          claimed: false,
          outcome: {
            status: "orchestration_rejected",
            workerId: worker.workerId,
            code,
          },
        };
      }
      throwIfLoopAborted(options.signal);
      return {
        claimAttempted: false,
        claimed: false,
        outcome: {
          status: "orchestrated",
          workerId: worker.workerId,
          action: decision.intent.action.type,
          applied: executed.applied,
        },
      };
    }
    if (decision.intent.type === "submit_delivery") {
      throw Object.assign(
        new Error("The configured root orchestrator cannot submit a delivery"),
        { code: "ORCHESTRATOR_DELIVERY_NOT_SUPPORTED" },
      );
    }
    if (graphBlocked) {
      return {
        claimAttempted: false,
        claimed: false,
        outcome: { status: "graph_blocked", workerId: worker.workerId },
      };
    }
    const claim = await this.#claim(item, worker, options);
    if (!claim.item) {
      return {
        claimAttempted: true,
        claimed: false,
        outcome: claimFailureOutcome(claim),
      };
    }
    return {
      claimAttempted: true,
      claimed: true,
      outcome: await this.#stageDecision(
        claim.item,
        worker,
        options,
        decision,
      ),
    };
  }

  async #processSpecialist(item, worker, options) {
    throwIfLoopAborted(options.signal);
    let packet;
    let decision;
    let failureReasons = DECISION_FAILURE_REASONS;
    try {
      packet = await this.#assembleContext(item, worker, options);
      ({ decision, packet } = await this.#decideWithMemory(
        item,
        worker,
        options,
        packet,
      ));
      throwIfLoopAborted(options.signal);
      if (decision.intent.type === "submit_delivery") {
        failureReasons = DELIVERY_FAILURE_REASONS;
        throwIfLoopAborted(options.signal);
        const executed = await this.orchestratorService.execute({
          worker: { roleId: worker.roleId, workerId: worker.workerId },
          item,
          contextPacket: packet,
          intent: decision.intent,
        });
        throwIfLoopAborted(options.signal);
        return {
          status: executed.recovered
            ? "delivery_recovered"
            : "delivery_submitted",
          workerId: worker.workerId,
          deliveryRevision: executed.deliveryRevision,
        };
      }
      if (decision.intent.type === "orchestrate") {
        throw Object.assign(
          new Error("A specialist cannot execute an orchestration action"),
          { code: "SPECIALIST_ORCHESTRATION_NOT_PERMITTED" },
        );
      }
    } catch (error) {
      throwIfLoopAborted(options.signal);
      const terminalState = terminalPullRequestState(error);
      if (terminalState !== null) {
        return this.#blockTerminalPullRequest(
          item,
          worker.workerId,
          options,
          terminalState,
        );
      }
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        // Configuration cutover is not an employee failure. Keep the durable
        // claim intact so the item can be recomputed after restart.
        throw error;
      }
      const attention = ownerBrainAttentionDecision(error, worker.roleId);
      if (attention !== null) {
        return this.#stageDecision(
          item,
          worker,
          options,
          attention,
          failureReasons,
        );
      }
      return this.#recordFailure(
        item,
        worker.workerId,
        error,
        options,
        failureReasons,
      );
    }
    return this.#stageDecision(item, worker, options, decision);
  }

  async #blockTerminalPullRequest(item, actorId, options, terminalState) {
    throwIfLoopAborted(options.signal);
    try {
      await this.ledger.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId,
        toStatus: "blocked",
        reason: "pr_source_terminal",
        details: {
          code: "PR_FACTS_TERMINAL",
          outcome: terminalState,
        },
      });
      throwIfLoopAborted(options.signal);
      return {
        status: "blocked",
        workerId: actorId,
        code: "PR_FACTS_TERMINAL",
      };
    } catch {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        observed?.status === "blocked" &&
        observed.statusReason === "pr_source_terminal"
      ) {
        return {
          status: "blocked",
          workerId: actorId,
          code: "PR_FACTS_TERMINAL",
        };
      }
      return {
        status: observed
          ? "terminal_state_unchanged"
          : "terminal_state_uncertain",
        workerId: actorId,
        code: "PR_FACTS_TERMINAL",
      };
    }
  }

  async #decideAndStage(item, worker, options) {
    throwIfLoopAborted(options.signal);
    let decision;
    try {
      decision = await this.#decide(item, worker, options);
    } catch (error) {
      throwIfLoopAborted(options.signal);
      return this.#recordFailure(item, worker.workerId, error, options);
    }

    throwIfLoopAborted(options.signal);
    return this.#stageDecision(item, worker, options, decision);
  }

  async #stageDecision(
    item,
    worker,
    options,
    decision,
    failureReasons = DECISION_FAILURE_REASONS,
  ) {
    throwIfLoopAborted(options.signal);
    try {
      await this.ledger.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: worker.workerId,
        roleId: worker.roleId,
        intent: decision.intent,
      });
      throwIfLoopAborted(options.signal);
      return { status: "staged", workerId: worker.workerId };
    } catch (error) {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        ["dispatch_pending", "waiting_user"].includes(observed?.status) &&
        observed.inputDigest === item.inputDigest &&
        (observed.status === "waiting_user" ||
          observed.revision === item.revision + 1)
      ) {
        return { status: "stage_recovered", workerId: worker.workerId };
      }
      if (
        observed?.status === "working" &&
        observed.revision === item.revision &&
        observed.leaseId === item.leaseId
      ) {
        return this.#recordFailure(
          item,
          worker.workerId,
          error,
          options,
          failureReasons,
        );
      }
      return {
        status: observed ? "stage_state_changed" : "stage_uncertain",
        workerId: worker.workerId,
      };
    }
  }

  async #recordFailure(
    item,
    actorId,
    error,
    options,
    reasons = DECISION_FAILURE_REASONS,
  ) {
    throwIfLoopAborted(options.signal);
    const code = stableFailureCode(error);
    const contention = isContextContention(error);
    const input = {
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId,
      reason:
        contention ? "context_changed" : item.attempt >= this.maxAttempts
          ? reasons.exhausted
          : reasons.retry,
    };
    try {
      throwIfLoopAborted(options.signal);
      if (!contention && item.attempt >= this.maxAttempts) {
        await this.ledger.transition({
          ...input,
          toStatus: "blocked",
          details: { code },
        });
        throwIfLoopAborted(options.signal);
        return { status: "blocked", workerId: actorId, code };
      }
      const exponent = contention ? 0 : Math.min(item.attempt - 1, 30);
      const delay = Math.min(
        this.retryMaxMs,
        this.retryBaseMs * 2 ** exponent,
      );
      await this.ledger.scheduleRetry({
        ...input,
        ...(contention ? { consumeAttempt: false } : {}),
        details: { code },
        availableAt: new Date(
          Date.parse(normalizeLoopClock(this.clock)) + delay,
        ).toISOString(),
      });
      throwIfLoopAborted(options.signal);
      return { status: "retry_scheduled", workerId: actorId, code };
    } catch {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (observed?.status === "blocked") {
        return { status: "blocked", workerId: actorId, code };
      }
      if (observed?.status === "retry_wait") {
        return { status: "retry_scheduled", workerId: actorId, code };
      }
      return {
        status: observed ? "failure_state_unchanged" : "failure_uncertain",
        workerId: actorId,
        code,
      };
    }
  }

  async #retireInactiveIssueWork(intake, updatedBefore, now, signal) {
    if (this.retireInactiveIssues === null) return;
    const retirementKey = now.slice(0, 10);
    if (this.lastIssueRetirementKey !== retirementKey) {
      let startedSweep = false;
      if (this.issueRetirementSweep?.key !== retirementKey) {
        startedSweep = true;
        const promise = this.retireInactiveIssues({ updatedBefore })
          .then(() => {
            this.lastIssueRetirementKey = retirementKey;
          })
          .finally(() => {
            if (this.issueRetirementSweep?.promise === promise) {
              this.issueRetirementSweep = null;
            }
          });
        this.issueRetirementSweep = { key: retirementKey, promise };
      }
      await this.issueRetirementSweep.promise;
      throwIfLoopAborted(signal);
      if (startedSweep) return;
    }
    if (intake.itemIds.length === 0) return;
    await this.retireInactiveIssues({
      updatedBefore,
      itemIds: intake.itemIds,
    });
    throwIfLoopAborted(signal);
  }

  async #observeItem(itemId, intakeLimit, signal = null) {
    throwIfLoopAborted(signal);
    try {
      if (this.readItemForReconciliation !== null) {
        const observed = await this.readItemForReconciliation({ itemId });
        throwIfLoopAborted(signal);
        return observed;
      }
      await this.ledger.intake({ limit: Math.min(intakeLimit, 1) });
      throwIfLoopAborted(signal);
      return await this.#findItem(itemId, signal);
    } catch {
      throwIfLoopAborted(signal);
      return null;
    }
  }

  async #findItem(itemId, signal = null) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(signal);
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(signal);
      const found = result.items.find((item) => item.itemId === itemId);
      if (found) return found;
      if (!result.nextCursor) return null;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }

  async #listCandidateWindow(options, at) {
    const roleId = options.roleId !== null &&
        options.roleId !== ORCHESTRATOR_ROLE_ID
      ? options.roleId
      : null;
    if (this.listClaimCandidates === null) {
      const allItems = await this.#listAllItems(options.signal);
      const items = allItems.filter((item) =>
        isAvailable(item, at) &&
        (
          roleId === null ||
          (
            item.currentTarget.type === "role" &&
            item.currentTarget.id === roleId
          )
        )
      );
      return {
        items,
        graphBlocked: graphBlockedItemIds(allItems),
        activeQuestions: activeQuestionTargets(allItems),
        facts: candidatePriorityFacts(allItems),
      };
    }

    const items = [];
    const facts = new Map();
    const graphBlocked = new Set();
    const activeQuestions = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(options.signal);
      const result = await this.listClaimCandidates({
        at,
        limit: PAGE_SIZE,
        ...(roleId === null ? {} : { roleId }),
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(options.signal);
      if (
        !result ||
        !Array.isArray(result.items) ||
        !Array.isArray(result.facts) ||
        !Array.isArray(result.activeQuestionTargets) ||
        result.facts.length !== result.items.length
      ) {
        throw new TypeError("ledger listClaimCandidates result is invalid");
      }
      items.push(...result.items);
      for (const [index, fact] of result.facts.entries()) {
        if (
          !fact ||
          typeof fact.itemId !== "string" ||
          fact.itemId !== result.items[index]?.itemId ||
          typeof fact.graphBlocked !== "boolean" ||
          !Number.isSafeInteger(fact.submittedChildren) ||
          fact.submittedChildren < 0 ||
          !Number.isSafeInteger(fact.satisfiedChildren) ||
          fact.satisfiedChildren < 0
        ) {
          throw new TypeError("ledger listClaimCandidates result is invalid");
        }
        facts.set(fact.itemId, fact);
        if (fact.graphBlocked) graphBlocked.add(fact.itemId);
      }
      for (const target of result.activeQuestionTargets) {
        activeQuestions.add(targetKey(target));
      }
      if (!result.nextCursor) {
        return { items, graphBlocked, activeQuestions, facts };
      }
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }

  async #listAllItems(signal = null) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(signal);
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(signal);
      if (!result || !Array.isArray(result.items)) {
        throw new TypeError("ledger listItems result is invalid");
      }
      items.push(...result.items);
      if (!result.nextCursor) return items;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }
}
