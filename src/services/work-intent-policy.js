import { createHash } from "node:crypto";
import {
  normalizeStoredWorkflowEvent,
  normalizeWorkflowEvent,
} from "../domain/workflow-events.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const CAPABILITIES = new Set([
  "coordination",
  "requirements",
  "pr-review",
  "development",
  "testing",
]);
const ACTIVE_PR_EVENTS = new Set([
  "pull_request.observed",
  "pull_request.created",
  "pull_request.updated",
  "pull_request.classified",
  "pull_request.status",
]);
const CODE_OPERATIONS = Object.freeze(["inspect", "modify", "verify"]);

export class WorkIntentPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkIntentPolicyError";
    this.code = code;
    this.statusCode = code === "WORK_INTENT_CONTEXT_INVALID" ? 400 : 409;
  }
}

function contextError(message = "员工工作上下文无效") {
  throw new WorkIntentPolicyError("WORK_INTENT_CONTEXT_INVALID", message);
}

function denied(message = "岗位无权提出该工作意图") {
  throw new WorkIntentPolicyError("WORK_INTENT_POLICY_DENIED", message);
}

function plainEntries(value, onError = contextError) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    onError();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      onError();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, onError = contextError) {
  const entries = plainEntries(value, onError);
  const actual = entries.map(([key]) => key);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  ) {
    onError();
  }
  return new Map(entries);
}

function safeId(value, name, onError = contextError) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    onError(`${name} 无效`);
  }
  return value;
}

function boundedId(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    contextError(`${name} 无效`);
  }
  return value;
}

function strictArray(value, maximum, onError) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    onError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) onError();
  }
  return value;
}

function normalizeRoleList(value, name) {
  const roles = strictArray(value, 100, () => contextError(`${name} 无效`)).map(
    (roleId) => safeId(roleId, name),
  );
  if (new Set(roles).size !== roles.length) contextError(`${name} 重复`);
  return new Set(roles);
}

function normalizeCapabilityRoles(value) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [capability, roleId] of entries) {
    if (!CAPABILITIES.has(capability) || result.has(capability)) {
      contextError("capabilityRoles 无效");
    }
    result.set(capability, safeId(roleId, "capabilityRoles.roleId"));
  }
  return result;
}

function normalizeWorkspaces(value) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [repository, workspaceId] of entries) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      result.has(repository)
    ) {
      contextError("workspaceByRepository.repository 无效");
    }
    result.set(repository, safeId(workspaceId, "workspaceId"));
  }
  return result;
}

function normalizeCodeOperations(value, codeRoles) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [roleId, rawOperations] of entries) {
    const normalizedRoleId = safeId(roleId, "codeOperationsByRole.roleId");
    if (!codeRoles.has(normalizedRoleId) || result.has(normalizedRoleId)) {
      contextError("codeOperationsByRole.roleId 无效");
    }
    const operations = strictArray(rawOperations, CODE_OPERATIONS.length, () =>
      contextError("codeOperationsByRole.operations 无效"),
    );
    if (
      operations.length < 1 ||
      operations.some((operation) => !CODE_OPERATIONS.includes(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      contextError("codeOperationsByRole.operations 无效");
    }
    result.set(normalizedRoleId, new Set(operations));
  }
  return result;
}

function cloneAndFreeze(value) {
  const cloned = structuredClone(value);
  const freeze = (entry) => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(cloned);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function normalizeContext(value) {
  const entries = exact(value, ["assignmentId", "workItemId", "roleId", "event"]);
  const suppliedEvent = entries.get("event");
  const event =
    suppliedEvent && typeof suppliedEvent === "object" && Object.hasOwn(suppliedEvent, "eventId")
      ? normalizeStoredWorkflowEvent(suppliedEvent)
      : normalizeWorkflowEvent(suppliedEvent);
  return {
    assignmentId: boundedId(entries.get("assignmentId"), "assignmentId"),
    workItemId: boundedId(entries.get("workItemId"), "workItemId"),
    roleId: safeId(entries.get("roleId"), "roleId"),
    event,
  };
}

function baseBound(context, version, kind, binding, payload) {
  const value = {
    policyVersion: version,
    kind,
    requestedBy: {
      roleId: context.roleId,
      workItemId: context.workItemId,
    },
    source: {
      assignmentId: context.assignmentId,
      eventId: context.event.eventId,
    },
    binding,
    payload,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
  return cloneAndFreeze({ intentId: `work-intent-${digest}`, ...value });
}

function eventBinding(event) {
  return { eventId: event.eventId, subject: structuredClone(event.subject) };
}

export function createWorkIntentPolicy({
  version = 1,
  capabilityRoles = {},
  githubReviewRoles = [],
  codeActionRoles = [],
  workspaceByRepository = {},
  codeOperationsByRole = {},
} = {}) {
  if (!Number.isSafeInteger(version) || version < 1) {
    contextError("policy version 无效");
  }
  const trustedCapabilities = normalizeCapabilityRoles(capabilityRoles);
  const trustedGithubRoles = normalizeRoleList(
    githubReviewRoles,
    "githubReviewRoles",
  );
  const trustedCodeRoles = normalizeRoleList(codeActionRoles, "codeActionRoles");
  const trustedWorkspaces = normalizeWorkspaces(workspaceByRepository);
  const trustedCodeOperations = normalizeCodeOperations(
    codeOperationsByRole,
    trustedCodeRoles,
  );

  function bind({ context: contextValue, intent: intentValue } = {}) {
    const context = normalizeContext(contextValue);
    const intent = normalizeWorkIntent(intentValue);
    const commonPayload = { summary: intent.summary, reason: intent.reason };

    if (intent.type === "ask_user") {
      return baseBound(
        context,
        version,
        "attention_request",
        eventBinding(context.event),
        {
          question: intent.question,
          choices: intent.choices,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "wait_condition") {
      return baseBound(
        context,
        version,
        "wait_condition",
        eventBinding(context.event),
        {
          condition: intent.condition,
          checkAfterSeconds: intent.checkAfterSeconds,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_github_review") {
      if (!trustedGithubRoles.has(context.roleId)) denied();
      if (!ACTIVE_PR_EVENTS.has(context.event.eventType)) {
        denied("只有活动 PR 事件可以提出 Review");
      }
      const headRefOid = context.event.payload?.headRefOid;
      if (typeof headRefOid !== "string" || !headRefOid) {
        denied("PR 事件缺少可信 Head");
      }
      return baseBound(
        context,
        version,
        "github_review_proposal",
        {
          ...eventBinding(context.event),
          repository: context.event.subject.repository,
          pullRequestNumber: context.event.subject.number,
          headRefOid,
        },
        {
          verdict: intent.verdict,
          body: intent.body,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_code_action") {
      if (!trustedCodeRoles.has(context.roleId)) denied();
      const allowedOperations = trustedCodeOperations.get(context.roleId);
      if (allowedOperations && !allowedOperations.has(intent.operation)) {
        denied("岗位无权提出该代码操作");
      }
      const repository = context.event.subject.repository;
      const workspaceId = trustedWorkspaces.get(repository);
      if (!workspaceId) denied("事件仓库没有受信工作区映射");
      return baseBound(
        context,
        version,
        "code_action_proposal",
        { ...eventBinding(context.event), repository, workspaceId },
        {
          operation: intent.operation,
          objective: intent.objective,
          acceptanceCriteria: intent.acceptanceCriteria,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "handoff") {
      const targetRoleId = trustedCapabilities.get(intent.capability);
      if (!targetRoleId) denied("能力没有受信岗位映射");
      return baseBound(
        context,
        version,
        "handoff",
        { ...eventBinding(context.event), targetRoleId },
        {
          capability: intent.capability,
          brief: intent.brief,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    return baseBound(
      context,
      version,
      "complete",
      eventBinding(context.event),
      {
        outcome: intent.outcome,
        evidence: intent.evidence,
        ...commonPayload,
      },
    );
  }

  return Object.freeze({ bind });
}
