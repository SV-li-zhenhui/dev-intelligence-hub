import { digestValue } from "./code-executor-contract.js";
import { normalizeChangePackageManifest } from "./change-package-contract.js";
import { normalizeConfirmationPlan } from "./confirmation-contract.js";

const KIND = "local.change-package-apply";
const PROVIDER = "local-code";
const ACTOR_ACCOUNT = "change-package-application-service";
const SHA256 = /^[a-f0-9]{64}$/;
const HEAD_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class ChangePackageApplicationConfirmationError extends Error {
  constructor(message = "change package 应用确认无效", { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChangePackageApplicationConfirmationError";
    this.code = "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIRMATION";
    this.statusCode = 400;
  }
}

function invalid(message, cause) {
  return new ChangePackageApplicationConfirmationError(message, { cause });
}

function exactObject(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function text(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function sha256(value, name) {
  return text(value, name, 64, SHA256);
}

function safeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function normalizeRequestedBy(value) {
  exactObject(value, ["roleId", "workItemId"], "requestedBy");
  return {
    roleId: text(value.roleId, "requestedBy.roleId", 128, SAFE_ID),
    workItemId: text(value.workItemId, "requestedBy.workItemId", 256),
  };
}

function normalizeTrustedTarget(value) {
  exactObject(
    value,
    ["workspaceId", "targetAuthorityDigest", "expectedHeadOid"],
    "target",
  );
  return {
    workspaceId: text(value.workspaceId, "target.workspaceId", 128, SAFE_ID),
    targetAuthorityDigest: sha256(
      value.targetAuthorityDigest,
      "target.targetAuthorityDigest",
    ),
    expectedHeadOid: text(
      value.expectedHeadOid,
      "target.expectedHeadOid",
      64,
      HEAD_OID,
    ),
  };
}

function normalizeManifest(value) {
  try {
    return normalizeChangePackageManifest(value);
  } catch (error) {
    throw invalid("manifest 无效", error);
  }
}

function applicationAction(manifest, target) {
  return {
    type: "apply_change_package",
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    job: { ...manifest.job },
    proposal: { ...manifest.proposal },
    grant: { ...manifest.grant },
    workspace: { ...manifest.workspace },
    changeSetDigest: digestValue(manifest.changes),
    testEvidenceDigest: digestValue(manifest.passedProfiles),
    targetAuthorityDigest: target.targetAuthorityDigest,
    expectedHeadOid: target.expectedHeadOid,
  };
}

function confirmationIdForAction(action, requestedBy) {
  return `confirmation-change-package-apply-${digestValue({ requestedBy, action })}`;
}

function normalizePlanInput(manifestValue, targetValue) {
  const manifest = normalizeManifest(manifestValue);
  const target = normalizeTrustedTarget(targetValue);
  if (target.workspaceId !== manifest.workspace.id) {
    throw invalid("target.workspaceId 与 package workspace 不一致");
  }
  return { manifest, target, action: applicationAction(manifest, target) };
}

export function changePackageApplicationConfirmationId(
  manifestValue,
  optionsValue,
) {
  exactObject(optionsValue, ["requestedBy", "target"], "options");
  const requestedBy = normalizeRequestedBy(optionsValue.requestedBy);
  const { action } = normalizePlanInput(manifestValue, optionsValue.target);
  return confirmationIdForAction(action, requestedBy);
}

function queuePlan(value) {
  try {
    const normalized = normalizeConfirmationPlan(value);
    const {
      displayedPayloadDigest: _displayedPayloadDigest,
      approvalBindingDigest: _approvalBindingDigest,
      ...plan
    } = normalized;
    return deepFreeze(plan);
  } catch (error) {
    if (error?.code === "INVALID_CONFIRMATION_REQUEST") {
      throw invalid("确认计划无效", error);
    }
    throw error;
  }
}

export function createChangePackageApplicationConfirmationPlan(
  manifestValue,
  optionsValue,
) {
  exactObject(optionsValue, ["requestedBy", "target"], "options");
  const requestedBy = normalizeRequestedBy(optionsValue.requestedBy);
  const { manifest, target: trustedTarget, action } = normalizePlanInput(
    manifestValue,
    optionsValue.target,
  );
  const actor = { provider: PROVIDER, accountId: ACTOR_ACCOUNT };
  const target = {
    provider: PROVIDER,
    resourceId: trustedTarget.workspaceId,
    version: trustedTarget.expectedHeadOid,
  };
  const counts = Object.fromEntries(
    Object.entries(manifest.changes).map(([kind, values]) => [kind, values.length]),
  );

  return queuePlan({
    id: confirmationIdForAction(action, requestedBy),
    kind: KIND,
    requestedBy,
    actor,
    target,
    action,
    display: {
      title: "应用已验证的本地变更包",
      summary: `将 ${counts.created + counts.modified + counts.deleted} 项文件变更应用到已选择的本地 checkout。`,
      actionLabel: "确认并应用变更包",
      evidence: [
        `新增 ${counts.created} · 修改 ${counts.modified} · 删除 ${counts.deleted}`,
        `已通过 ${manifest.passedProfiles.length} 个固定测试配置`,
        `变更包摘要 ${manifest.packageDigest}`,
        `预期 Head ${trustedTarget.expectedHeadOid}`,
      ],
      payload: { actor, target, action },
    },
  });
}

function normalizeJob(value) {
  exactObject(value, ["id", "revision", "recordDigest"], "action.job");
  return {
    id: text(value.id, "action.job.id", 128, SAFE_ID),
    revision: safeInteger(value.revision, "action.job.revision", 1),
    recordDigest: sha256(value.recordDigest, "action.job.recordDigest"),
  };
}

function normalizeProposal(value) {
  exactObject(value, ["id", "contentDigest"], "action.proposal");
  return {
    id: text(value.id, "action.proposal.id", 512),
    contentDigest: sha256(
      value.contentDigest,
      "action.proposal.contentDigest",
    ),
  };
}

function normalizeGrant(value) {
  exactObject(value, ["digest"], "action.grant");
  return { digest: sha256(value.digest, "action.grant.digest") };
}

function normalizeWorkspace(value) {
  exactObject(
    value,
    ["id", "sourceRevision", "workspaceRevision"],
    "action.workspace",
  );
  return {
    id: text(value.id, "action.workspace.id", 128, SAFE_ID),
    sourceRevision: sha256(
      value.sourceRevision,
      "action.workspace.sourceRevision",
    ),
    workspaceRevision: sha256(
      value.workspaceRevision,
      "action.workspace.workspaceRevision",
    ),
  };
}

function normalizeAction(value) {
  exactObject(
    value,
    [
      "type",
      "packageId",
      "packageDigest",
      "job",
      "proposal",
      "grant",
      "workspace",
      "changeSetDigest",
      "testEvidenceDigest",
      "targetAuthorityDigest",
      "expectedHeadOid",
    ],
    "action",
  );
  if (value.type !== "apply_change_package") throw invalid("action.type 无效");
  const action = {
    type: value.type,
    packageId: text(
      value.packageId,
      "action.packageId",
      128,
      /^change-package-[a-f0-9]{64}$/,
    ),
    packageDigest: sha256(value.packageDigest, "action.packageDigest"),
    job: normalizeJob(value.job),
    proposal: normalizeProposal(value.proposal),
    grant: normalizeGrant(value.grant),
    workspace: normalizeWorkspace(value.workspace),
    changeSetDigest: sha256(value.changeSetDigest, "action.changeSetDigest"),
    testEvidenceDigest: sha256(
      value.testEvidenceDigest,
      "action.testEvidenceDigest",
    ),
    targetAuthorityDigest: sha256(
      value.targetAuthorityDigest,
      "action.targetAuthorityDigest",
    ),
    expectedHeadOid: text(
      value.expectedHeadOid,
      "action.expectedHeadOid",
      64,
      HEAD_OID,
    ),
  };
  if (action.packageId !== `change-package-${action.packageDigest}`) {
    throw invalid("action package 摘要绑定无效");
  }
  return action;
}

function normalizeActor(value) {
  exactObject(value, ["provider", "accountId"], "actor");
  if (value.provider !== PROVIDER || value.accountId !== ACTOR_ACCOUNT) {
    throw invalid("actor 无效");
  }
  return { provider: value.provider, accountId: value.accountId };
}

function normalizeTarget(value) {
  exactObject(value, ["provider", "resourceId", "version"], "target");
  if (value.provider !== PROVIDER) throw invalid("target.provider 无效");
  return {
    provider: value.provider,
    resourceId: text(value.resourceId, "target.resourceId", 128, SAFE_ID),
    version: text(value.version, "target.version", 64, HEAD_OID),
  };
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function normalizeExecution(value) {
  exactObject(value, ["requestId", "attempt", "startedAt"], "execution");
  if (!canonicalTimestamp(value.startedAt)) throw invalid("execution.startedAt 无效");
  return {
    requestId: text(value.requestId, "execution.requestId", 128, REQUEST_ID),
    attempt: safeInteger(value.attempt, "execution.attempt", 1),
    startedAt: value.startedAt,
  };
}

export function normalizeChangePackageApplicationEnvelope(value) {
  exactObject(
    value,
    [
      "schemaVersion",
      "id",
      "idempotencyKey",
      "kind",
      "requestedBy",
      "actor",
      "target",
      "action",
      "displayedPayloadDigest",
      "approvalBindingDigest",
      "execution",
    ],
    "envelope",
  );
  if (value.schemaVersion !== 1 || value.kind !== KIND) {
    throw invalid("envelope kind 或 schemaVersion 无效");
  }
  const requestedBy = normalizeRequestedBy(value.requestedBy);
  const actor = normalizeActor(value.actor);
  const target = normalizeTarget(value.target);
  const action = normalizeAction(value.action);
  const execution = normalizeExecution(value.execution);
  const displayedPayloadDigest = sha256(
    value.displayedPayloadDigest,
    "displayedPayloadDigest",
  );
  const approvalBindingDigest = sha256(
    value.approvalBindingDigest,
    "approvalBindingDigest",
  );
  const id = text(value.id, "id", 128, SAFE_ID);
  const idempotencyKey = text(
    value.idempotencyKey,
    "idempotencyKey",
    128,
    SAFE_ID,
  );
  const expectedBindingDigest = digestValue({
    id,
    kind: KIND,
    requestedBy,
    actor,
    target,
    action,
    displayedPayloadDigest,
  });
  if (
    id !== confirmationIdForAction(action, requestedBy) ||
    idempotencyKey !== `confirmation-${approvalBindingDigest}` ||
    approvalBindingDigest !== expectedBindingDigest ||
    target.resourceId !== action.workspace.id ||
    target.version !== action.expectedHeadOid
  ) {
    throw invalid("envelope binding 无效");
  }
  return deepFreeze({
    schemaVersion: 1,
    id,
    idempotencyKey,
    kind: KIND,
    requestedBy,
    actor,
    target,
    action,
    displayedPayloadDigest,
    approvalBindingDigest,
    execution,
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
