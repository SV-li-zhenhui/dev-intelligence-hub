import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../domain/code-job-contract.js";
import { digestValue } from "../domain/code-executor-contract.js";
import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";
import {
  assertWorkProposalExactKeys,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  workProposalArrayValues,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { normalizeBrainConfig } from "./brain-router.js";

const OPERATIONS = Object.freeze(["inspect", "modify", "verify"]);
const OPERATION_SET = new Set(OPERATIONS);
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(message = "代码任务授权配置无效") {
  return workProposalError("INVALID_CODE_JOB_AUTHORITY", message);
}

function plainRecord(value, name) {
  const entries = workProposalDataEntries(value, invalid(`${name} 无效`));
  return Object.fromEntries(entries);
}

function exactRecord(value, keys, name) {
  assertWorkProposalExactKeys(value, keys, invalid(`${name} 无效`));
  return value;
}

function safeRoleId(value, name) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function safeWorkspaceId(value, name) {
  if (typeof value !== "string" || !SAFE_WORKSPACE_ID.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function sha256(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function normalizeWorkspaceBindings(value) {
  const result = new Map();
  for (const [repository, workspaceIdValue] of workProposalDataEntries(
    value,
    invalid("workspaceByRepository 无效"),
  )) {
    if (!SAFE_REPOSITORY.test(repository) || result.has(repository)) {
      throw invalid("workspaceByRepository.repository 无效");
    }
    result.set(
      repository,
      safeWorkspaceId(workspaceIdValue, "workspaceByRepository.workspaceId"),
    );
  }
  return result;
}

function normalizeStringArray(value, maximum, name, { minimum = 0 } = {}) {
  const entries = workProposalArrayValues(value, maximum, invalid(`${name} 无效`));
  if (
    entries.length < minimum ||
    entries.some((entry) => typeof entry !== "string") ||
    new Set(entries).size !== entries.length
  ) {
    throw invalid(`${name} 无效`);
  }
  return [...entries];
}

function normalizeAuthority(value) {
  exactRecord(value, ["workspaces"], "executorAuthority");
  const workspaces = workProposalArrayValues(
    value.workspaces,
    64,
    invalid("executorAuthority.workspaces 无效"),
  );
  if (workspaces.length === 0) {
    throw invalid("executorAuthority.workspaces 不能为空");
  }
  const result = new Map();
  for (const workspaceValue of workspaces) {
    const workspace = exactRecord(
      workspaceValue,
      ["id", "writablePaths", "requiredProfiles", "authorityDigest"],
      "executorAuthority.workspace",
    );
    const id = safeWorkspaceId(workspace.id, "executorAuthority.workspace.id");
    if (result.has(id)) throw invalid("executorAuthority.workspace 重复");
    const writablePaths = normalizeStringArray(
      workspace.writablePaths,
      64,
      "executorAuthority.workspace.writablePaths",
    ).map((entry) => {
      try {
        return normalizeWorkspacePath(entry);
      } catch {
        throw invalid("executorAuthority.workspace.writablePaths 无效");
      }
    });
    if (new Set(writablePaths).size !== writablePaths.length) {
      throw invalid("executorAuthority.workspace.writablePaths 重复");
    }
    const requiredProfiles = workProposalArrayValues(
      workspace.requiredProfiles,
      32,
      invalid("executorAuthority.workspace.requiredProfiles 无效"),
    ).map((profile) => {
      exactRecord(
        profile,
        ["id", "configDigest"],
        "executorAuthority.workspace.requiredProfile",
      );
      return {
        id: safeWorkspaceId(
          profile.id,
          "executorAuthority.workspace.requiredProfile.id",
        ),
        configDigest: sha256(
          profile.configDigest,
          "executorAuthority.workspace.requiredProfile.configDigest",
        ),
      };
    });
    if (requiredProfiles.length === 0) {
      throw invalid("executorAuthority.workspace.requiredProfiles 不能为空");
    }
    if (new Set(requiredProfiles.map(({ id: profileId }) => profileId)).size !== requiredProfiles.length) {
      throw invalid("executorAuthority.workspace.requiredProfiles 重复");
    }
    result.set(id, {
      id,
      writablePaths,
      requiredProfiles,
      authorityDigest: sha256(
        workspace.authorityDigest,
        "executorAuthority.workspace.authorityDigest",
      ),
    });
  }
  return result;
}

function normalizeOperationsByRole(value) {
  const result = new Map();
  for (const [roleIdValue, rawOperations] of workProposalDataEntries(
    value,
    invalid("codeOperationsByRole 无效"),
  )) {
    const roleId = safeRoleId(roleIdValue, "codeOperationsByRole.roleId");
    const operations = normalizeStringArray(
      rawOperations,
      OPERATIONS.length,
      "codeOperationsByRole.operations",
      { minimum: 1 },
    );
    if (operations.some((operation) => !OPERATION_SET.has(operation))) {
      throw invalid("codeOperationsByRole.operations 无效");
    }
    result.set(roleId, operations.sort());
  }
  if (result.size === 0) throw invalid("codeOperationsByRole 不能为空");
  return result;
}

function normalizeCodeActionRoles(value) {
  return new Set(
    normalizeStringArray(value, 100, "codeActionRoles", { minimum: 1 }).map(
      (roleId) => safeRoleId(roleId, "codeActionRoles.roleId"),
    ),
  );
}

function authorizedOperations(value, authorizedRoles) {
  const result = new Map(
    [...value.entries()].filter(([roleId]) => authorizedRoles.has(roleId)),
  );
  if (result.size === 0) {
    throw invalid("codeActionRoles 与 codeOperationsByRole 没有交集");
  }
  return result;
}

export function codeJobBrainDigest({
  roleId: roleIdValue,
  brain: rawBrain,
  brainProviders,
} = {}) {
  const roleId = safeRoleId(roleIdValue, "roleId");
  const providers = plainRecord(brainProviders, "brainProviders");
  let brain;
  try {
    brain = normalizeBrainConfig(rawBrain);
  } catch (cause) {
    throw invalid(`岗位 ${roleId} 的大脑配置无效`, { cause });
  }
  if (!Object.hasOwn(providers, brain.provider)) {
    throw invalid(`岗位 ${roleId} 的大脑提供方未配置`);
  }
  const provider = plainRecord(
    providers[brain.provider],
    `brainProviders.${brain.provider}`,
  );
  return digestValue({ schemaVersion: 1, roleId, brain, provider });
}

function normalizeBrainDigests(brainByRoleValue, providersValue, roleIds) {
  const brainByRole = plainRecord(brainByRoleValue, "brainByRole");
  const providers = plainRecord(providersValue, "brainProviders");
  const result = new Map();
  for (const roleId of roleIds) {
    if (!Object.hasOwn(brainByRole, roleId)) {
      throw invalid(`岗位 ${roleId} 缺少大脑配置`);
    }
    result.set(
      roleId,
      codeJobBrainDigest({
        roleId,
        brain: brainByRole[roleId],
        brainProviders: providers,
      }),
    );
  }
  return result;
}

function normalizeStoredProposal(value) {
  exactRecord(
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
    "proposal",
  );
  const proposal = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    proposal.kind !== "code_action_proposal" ||
    normalizeWorkProposalDigest(value.contentDigest, invalid()) !==
      proposal.contentDigest
  ) {
    throw invalid("代码工作提案绑定无效");
  }
  exactRecord(
    proposal.binding,
    ["eventId", "subject", "repository", "workspaceId"],
    "proposal.binding",
  );
  exactRecord(
    proposal.payload,
    [
      "operation",
      "objective",
      "acceptanceCriteria",
      "evidence",
      "summary",
      "reason",
    ],
    "proposal.payload",
  );
  return proposal;
}

function publicRoleOperations(operationsByRole) {
  return Object.freeze(
    Object.fromEntries(
      [...operationsByRole.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([roleId, operations]) => [roleId, Object.freeze([...operations])]),
    ),
  );
}

export class CodeJobGrantFactory {
  #workspaces;
  #policyVersion;
  #workspaceByRepository;
  #operationsByRole;
  #brainDigests;
  #publicOperations;

  constructor({
    executorAuthority,
    policyVersion,
    workspaceByRepository,
    codeActionRoles,
    codeOperationsByRole,
    brainByRole,
    brainProviders,
  } = {}) {
    this.#workspaces = normalizeAuthority(executorAuthority);
    this.#policyVersion = positiveInteger(policyVersion, "policyVersion");
    this.#workspaceByRepository = normalizeWorkspaceBindings(
      workspaceByRepository,
    );
    this.#operationsByRole = authorizedOperations(
      normalizeOperationsByRole(codeOperationsByRole),
      normalizeCodeActionRoles(codeActionRoles),
    );
    this.#brainDigests = normalizeBrainDigests(
      brainByRole,
      brainProviders,
      this.#operationsByRole.keys(),
    );
    this.#publicOperations = publicRoleOperations(this.#operationsByRole);
    Object.freeze(this);
  }

  create(value) {
    const proposal = normalizeStoredProposal(value);
    const operation = proposal.payload.operation;
    const roleId = proposal.requestedBy.roleId;
    const workspace = this.#currentAuthority({
      policyVersion: proposal.policyVersion,
      repository: proposal.binding.repository,
      workspaceId: proposal.binding.workspaceId,
      roleId,
      operation,
    });
    const grant = createCodeJobGrant({
      proposalId: proposal.proposalId,
      contentDigest: proposal.contentDigest,
      policyVersion: proposal.policyVersion,
      requestedBy: proposal.requestedBy,
      source: proposal.source,
      subject: proposal.binding.subject,
      repository: proposal.binding.repository,
      workspaceId: proposal.binding.workspaceId,
      workspaceAuthorityDigest: workspace.authorityDigest,
      operation,
      objective: proposal.payload.objective,
      acceptanceCriteria: proposal.payload.acceptanceCriteria,
      evidence: proposal.payload.evidence,
      summary: proposal.payload.summary,
      reason: proposal.payload.reason,
      allowedActions: CODE_JOB_ACTIONS_BY_OPERATION[operation],
      writablePaths: operation === "modify" ? workspace.writablePaths : [],
      requiredProfiles: workspace.requiredProfiles,
      brainDigest: this.#brainDigests.get(roleId),
    });
    return Object.freeze({
      grant,
      allowedOperationsByRole: this.#publicOperations,
    });
  }

  verify(value) {
    let grant;
    try {
      grant = normalizeCodeJobGrant(value);
    } catch {
      throw invalid("代码任务授权封印无效");
    }
    const roleId = grant.requestedBy.roleId;
    const workspace = this.#currentAuthority({
      policyVersion: grant.policyVersion,
      repository: grant.repository,
      workspaceId: grant.workspaceId,
      roleId,
      operation: grant.operation,
    });
    const expected = {
      workspaceAuthorityDigest: workspace.authorityDigest,
      allowedActions: CODE_JOB_ACTIONS_BY_OPERATION[grant.operation],
      writablePaths:
        grant.operation === "modify" ? workspace.writablePaths : [],
      requiredProfiles: workspace.requiredProfiles,
      brainDigest: this.#brainDigests.get(roleId),
    };
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, grant[key]]),
    );
    if (digestValue(actual) !== digestValue(expected)) {
      throw invalid("代码任务授权已不符合当前执行配置");
    }
    return grant;
  }

  #currentAuthority({
    policyVersion,
    repository,
    workspaceId,
    roleId,
    operation,
  }) {
    const allowedOperations = this.#operationsByRole.get(roleId);
    const boundWorkspace = this.#workspaceByRepository.get(repository);
    const workspace = this.#workspaces.get(workspaceId);
    if (policyVersion !== this.#policyVersion) {
      throw invalid("工作提案引用了已失效的策略版本");
    }
    if (boundWorkspace === undefined || boundWorkspace !== workspaceId) {
      throw invalid("工作提案引用了已撤销的仓库工作区绑定");
    }
    if (!allowedOperations?.includes(operation)) {
      throw invalid("岗位无权创建该类型的代码任务");
    }
    if (!workspace) throw invalid("工作提案引用了未知代码工作区");
    return workspace;
  }
}
