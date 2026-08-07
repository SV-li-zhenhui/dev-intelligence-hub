import { createHash } from "node:crypto";
import { normalizeCodeJobGrant } from "./code-job-contract.js";
import {
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import { normalizeConfirmationPlan } from "./confirmation-contract.js";
import { digestValue } from "./code-executor-contract.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import {
  assertWorkProposalAuthorityBinding,
  assertWorkProposalExactKeys,
  boundedWorkProposalText,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  safeWorkProposalInteger,
  workProposalArrayValues,
  workProposalDataEntries,
  workProposalError,
} from "./work-proposal-contract.js";

const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const OPERATIONS = new Set(["inspect", "modify", "verify"]);

function invalid(message = "代码工作提案无法进入确认队列") {
  return workProposalError("INVALID_CODE_ACTION_PROPOSAL", message);
}

function exactRecord(value, keys, name) {
  assertWorkProposalExactKeys(value, keys, invalid(`${name} 无效`));
  return value;
}

function text(value, name, maximumBytes, pattern = null) {
  return boundedWorkProposalText(value, name, {
    maximumBytes,
    pattern,
    error: invalid(`${name} 无效`),
  });
}

function stringList(value, name, { maximumItems = 20 } = {}) {
  return workProposalArrayValues(
    value,
    maximumItems,
    invalid(`${name} 无效`),
  ).map((entry) => text(entry, name, 2_048));
}

function normalizedStoredProposal(value) {
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    invalid(),
  );
  const normalized = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    normalizeWorkProposalDigest(value.contentDigest, invalid()) !==
    normalized.contentDigest
  ) {
    throw invalid("工作提案摘要不匹配");
  }
  return normalized;
}

function normalizeProposalDetails(proposal) {
  if (proposal.kind !== "code_action_proposal") {
    throw invalid("工作提案类型无效");
  }
  const binding = exactRecord(
    proposal.binding,
    [
      "eventId",
      "subject",
      "repository",
      "workspaceId",
      "inputBinding",
      ...(Object.hasOwn(proposal.binding, "executionSource")
        ? ["executionSource"]
        : []),
      ...(Object.hasOwn(proposal.binding, "evidenceTarget")
        ? ["evidenceTarget"]
        : []),
      ...(Object.hasOwn(proposal.binding, "dispatchIntentId")
        ? ["dispatchIntentId"]
        : []),
    ],
    "binding",
  );
  assertWorkProposalAuthorityBinding(
    proposal,
    binding,
    invalid("binding 权威信息无效"),
  );
  const payload = exactRecord(
    proposal.payload,
    [
      "operation",
      "objective",
      "acceptanceCriteria",
      "evidence",
      "summary",
      "reason",
    ],
    "payload",
  );
  const eventId = text(binding.eventId, "binding.eventId", 256);
  if (eventId !== proposal.source.eventId) {
    throw invalid("binding.eventId 与 source.eventId 不一致");
  }
  const repository = text(
    binding.repository,
    "binding.repository",
    140,
    REPOSITORY,
  );
  const workspaceId = text(
    binding.workspaceId,
    "binding.workspaceId",
    64,
    SAFE_ID,
  );
  const subject = exactRecord(
    binding.subject,
    ["id", "repository", "number"],
    "binding.subject",
  );
  const subjectRepository = text(
    subject.repository,
    "binding.subject.repository",
    140,
    REPOSITORY,
  );
  if (subjectRepository !== repository) {
    throw invalid("binding.subject 与仓库绑定不一致");
  }
  const normalizedSubject = {
    id: text(subject.id, "binding.subject.id", 512),
    repository: subjectRepository,
    number: safeWorkProposalInteger(subject.number, "binding.subject.number", {
      minimum: 1,
      error: invalid("binding.subject.number 无效"),
    }),
  };
  let inputBinding = null;
  if (binding.inputBinding !== null) {
    try {
      inputBinding = normalizePullRequestExecutionBinding(
        binding.inputBinding,
        invalid("binding.inputBinding 无效"),
      );
    } catch {
      throw invalid("binding.inputBinding 无效");
    }
    if (inputBinding.schemaVersion !== 2) {
      throw invalid("旧版 PR 输入绑定只能恢复查看，不能创建新的代码任务确认");
    }
    if (
      inputBinding.repository !== repository ||
      inputBinding.pullRequestNumber !== normalizedSubject.number ||
      inputBinding.eventId !== eventId
    ) {
      throw invalid("binding.inputBinding 与提案来源不匹配");
    }
  }
  if (!OPERATIONS.has(payload.operation)) {
    throw invalid("payload.operation 无效");
  }
  let executionSource = null;
  if (Object.hasOwn(binding, "executionSource")) {
    try {
      executionSource = normalizeCodeExecutionSource(
        binding.executionSource,
      );
    } catch {
      throw invalid("binding.executionSource 无效");
    }
    if (
      inputBinding === null ||
      payload.operation !== "modify" ||
      !sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding,
      })
    ) {
      throw invalid("binding.executionSource 与提案权限不匹配");
    }
  }
  const acceptanceCriteria = stringList(
    payload.acceptanceCriteria,
    "payload.acceptanceCriteria",
  );
  if (acceptanceCriteria.length === 0) {
    throw invalid("payload.acceptanceCriteria 不能为空");
  }
  return {
    eventId,
    subject: normalizedSubject,
    repository,
    workspaceId,
    inputBinding,
    executionSource,
    operation: payload.operation,
    objective: text(payload.objective, "payload.objective", 4_096),
    acceptanceCriteria,
    evidence: stringList(payload.evidence, "payload.evidence"),
    summary: text(payload.summary, "payload.summary", 2_048),
    reason: text(payload.reason, "payload.reason", 4_096),
  };
}

function normalizedGrant(value) {
  try {
    return normalizeCodeJobGrant(value);
  } catch {
    throw invalid("代码任务授权无效");
  }
}

function normalizeRoleOperations(value) {
  const permissions = new Map();
  for (const [roleIdValue, operationsValue] of workProposalDataEntries(
    value,
    invalid("allowedOperationsByRole 无效"),
  )) {
    const roleId = text(
      roleIdValue,
      "allowedOperationsByRole.roleId",
      128,
      SAFE_ROLE_ID,
    );
    const operations = workProposalArrayValues(
      operationsValue,
      OPERATIONS.size,
      invalid("allowedOperationsByRole.operations 无效"),
    );
    if (
      operations.some((operation) => !OPERATIONS.has(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      throw invalid("allowedOperationsByRole.operations 无效");
    }
    permissions.set(roleId, new Set(operations));
  }
  return permissions;
}

function normalizeOptions(value) {
  const options = exactRecord(
    value,
    ["grant", "allowedOperationsByRole"],
    "options",
  );
  return {
    grant: normalizedGrant(options.grant),
    allowedOperationsByRole: normalizeRoleOperations(
      options.allowedOperationsByRole,
    ),
  };
}

function assertGrantMatchesProposal(proposal, details, grant) {
  if (
    (details.executionSource === null && grant.schemaVersion !== 2) ||
    (details.executionSource !== null && grant.schemaVersion !== 3)
  ) {
    throw invalid("代码任务授权版本与工作提案不匹配");
  }
  const expected = {
    proposalId: proposal.proposalId,
    contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion,
    requestedBy: proposal.requestedBy,
    source: proposal.source,
    subject: details.subject,
    repository: details.repository,
    workspaceId: details.workspaceId,
    inputBinding: details.inputBinding,
    ...(details.executionSource === null
      ? {}
      : { executionSource: details.executionSource }),
    operation: details.operation,
    objective: details.objective,
    acceptanceCriteria: details.acceptanceCriteria,
    evidence: details.evidence,
    summary: details.summary,
    reason: details.reason,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, grant[key]]),
  );
  if (digestValue(actual) !== digestValue(expected)) {
    throw invalid("代码任务授权与工作提案不匹配");
  }
}

function assertRoleAllowsOperation(proposal, operation, permissions) {
  if (!permissions.get(proposal.requestedBy.roleId)?.has(operation)) {
    throw invalid("岗位无权创建该类型的代码任务");
  }
}

function queuePlan(value) {
  let normalized;
  try {
    normalized = normalizeConfirmationPlan(value);
  } catch (error) {
    if (error?.code === "INVALID_CONFIRMATION_REQUEST") {
      throw invalid("确认计划超过容量或格式限制");
    }
    throw error;
  }
  const {
    displayedPayloadDigest: _displayedPayloadDigest,
    approvalBindingDigest: _approvalBindingDigest,
    ...plan
  } = normalized;
  return plan;
}

function confirmationId(proposalId, contentDigest) {
  const digest = createHash("sha256")
    .update(proposalId, "utf8")
    .update("\0", "utf8")
    .update(contentDigest, "utf8")
    .digest("hex");
  return `confirmation-code-job-${digest}`;
}

export function codeJobConfirmationIdForGrant(value) {
  const grant = normalizedGrant(value);
  return confirmationId(grant.proposalId, grant.contentDigest);
}

export function codeJobConfirmationIdForProposal(value) {
  const proposal = normalizedStoredProposal(value);
  return confirmationId(proposal.proposalId, proposal.contentDigest);
}

export function createCodeActionProposalConfirmationPlan(value, optionsValue) {
  const proposal = normalizedStoredProposal(value);
  const details = normalizeProposalDetails(proposal);
  const { grant, allowedOperationsByRole } = normalizeOptions(optionsValue);
  assertGrantMatchesProposal(proposal, details, grant);
  assertRoleAllowsOperation(
    proposal,
    details.operation,
    allowedOperationsByRole,
  );

  const actor = {
    provider: "local-code",
    accountId: "controlled-code-executor",
  };
  const target = {
    provider: "local-code",
    resourceId: details.workspaceId,
    version: proposal.contentDigest,
  };
  const action = { type: "create_code_job", grant };

  return queuePlan({
    id: codeJobConfirmationIdForGrant(grant),
    kind: "local.code-job-create",
    requestedBy: proposal.requestedBy,
    actor,
    target,
    action,
    display: {
      title: `${details.repository} · ${proposal.requestedBy.roleId} 代码任务`,
      summary: details.summary,
      actionLabel: "确认并创建本地代码任务（不会立即执行）",
      evidence: details.evidence,
      payload: { actor, target, action },
    },
  });
}
