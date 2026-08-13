import { types as utilTypes } from "node:util";

import { digestValue } from "./code-executor-contract.js";
import { normalizeConfirmationPlan } from "./confirmation-contract.js";

const KIND = "local.configuration-activate";
const PROVIDER = "local-configuration";
const OWNER_ROLE = "configuration-owner";
const OWNER_ACCOUNT = "owner:local";
const RESOURCE_ID = "active-configuration";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_IDENTIFIER =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_IMPACT_PATHS = 256;
const MAX_DISPLAY_IMPACT_PATHS = 12;
const CREDENTIAL_RECOVERY_IMPACT_PATHS = Object.freeze({
  securityTightening: Object.freeze(["githubActions.credentialMode"]),
  authorityExpansion: Object.freeze(["githubActions.credentialMode"]),
  benignClaimChange: Object.freeze([]),
  restartRequired: Object.freeze([
    "githubActions.credentialMode",
    "githubActions.tokenEnv",
  ]),
});

const PREPARED_KEYS = Object.freeze({
  "configuration.initialize": [
    "kind",
    "expectedStateRevision",
    "expectedActiveVersion",
    "activeDigest",
    "baselineDigest",
    "draftId",
    "draftRevision",
    "draftRevisionId",
    "documentDigest",
    "validationDigest",
    "impactDigest",
    "impact",
  ],
  "configuration.activate": [
    "kind",
    "expectedStateRevision",
    "expectedActiveVersion",
    "activeDigest",
    "draftId",
    "draftRevision",
    "draftRevisionId",
    "documentDigest",
    "validationDigest",
    "impactDigest",
    "impact",
  ],
  "configuration.rollback": [
    "kind",
    "expectedStateRevision",
    "expectedActiveVersion",
    "activeDigest",
    "targetVersion",
    "targetDigest",
    "documentDigest",
    "validationDigest",
    "impactDigest",
    "impact",
  ],
});

const ACTION_KEYS = Object.freeze({
  initialize_from_draft: PREPARED_KEYS["configuration.initialize"].filter(
    (key) => key !== "kind" && key !== "impact",
  ),
  activate_draft: PREPARED_KEYS["configuration.activate"].filter(
    (key) => key !== "kind" && key !== "impact",
  ),
  activate_rollback: PREPARED_KEYS["configuration.rollback"].filter(
    (key) => key !== "kind" && key !== "impact",
  ),
});

export class ConfigurationActivationConfirmationError extends Error {
  constructor(
    message = "configuration activation confirmation is invalid",
    { cause } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigurationActivationConfirmationError";
    this.code = "INVALID_CONFIGURATION_ACTIVATION_CONFIRMATION";
    this.statusCode = 400;
  }
}

function invalid(detail, cause) {
  return new ConfigurationActivationConfirmationError(
    `configuration activation ${detail} is invalid`,
    { cause },
  );
}

function exactObject(value, expectedKeys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(name);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !expectedKeys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw invalid(name);
  }
  return value;
}

function text(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(name);
  }
  return value;
}

function sha256(value, name) {
  return text(value, name, 64, SHA256);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid(name);
  return value;
}

function denseArray(value, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_IMPACT_PATHS
  ) {
    throw invalid(name);
  }
  const keys = Reflect.ownKeys(value);
  const indexes = Array.from({ length: value.length }, (_, index) => String(index));
  if (
    keys.length !== indexes.length + 1 ||
    !keys.includes("length") ||
    indexes.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw invalid(name);
  }
  return indexes.map((key) =>
    text(Object.getOwnPropertyDescriptor(value, key).value, name, 512),
  );
}

function normalizeImpact(value) {
  exactObject(
    value,
    [
      "changed",
      "beforeDigest",
      "afterDigest",
      "security_tightening",
      "authority_expansion",
      "benign_claim_change",
      "restart_required",
    ],
    "impact",
  );
  if (typeof value.changed !== "boolean") throw invalid("impact.changed");
  const paths = {
    securityTightening: denseArray(
      value.security_tightening,
      "impact.security_tightening",
    ),
    authorityExpansion: denseArray(
      value.authority_expansion,
      "impact.authority_expansion",
    ),
    benignClaimChange: denseArray(
      value.benign_claim_change,
      "impact.benign_claim_change",
    ),
    restartRequired: denseArray(
      value.restart_required,
      "impact.restart_required",
    ),
  };
  return {
    display: {
      changed: value.changed,
      beforeDigest: sha256(value.beforeDigest, "impact.beforeDigest"),
      afterDigest: sha256(value.afterDigest, "impact.afterDigest"),
      securityTightening: impactCategory(paths.securityTightening),
      authorityExpansion: impactCategory(paths.authorityExpansion),
      benignClaimChange: impactCategory(paths.benignClaimChange),
      restartRequired: impactCategory(paths.restartRequired),
    },
    changedPathCount: new Set(Object.values(paths).flat()).size,
  };
}

function impactCategory(paths) {
  return {
    count: paths.length,
    paths: paths.slice(0, MAX_DISPLAY_IMPACT_PATHS),
  };
}

function plainDataObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactPlainDataObject(value, expectedKeys) {
  if (
    !plainDataObject(value)
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" &&
      descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, "value");
  });
}

function ownDataValue(value, name) {
  if (!plainDataObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function exactStringList(value, expected) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    value.length !== expected.length
  ) {
    return false;
  }
  return expected.every((entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === entry;
  });
}

function exactImpactCategory(value, expectedPaths) {
  return exactPlainDataObject(value, ["count", "paths"]) &&
    value.count === expectedPaths.length &&
    exactStringList(value.paths, expectedPaths);
}

export function isGitHubCredentialRecoveryActivationPlan(value) {
  try {
    const kind = ownDataValue(value, "kind");
    const requestedBy = ownDataValue(value, "requestedBy");
    const actor = ownDataValue(value, "actor");
    const target = ownDataValue(value, "target");
    const action = ownDataValue(value, "action");
    const display = ownDataValue(value, "display");
    if (
      kind !== KIND ||
      !exactPlainDataObject(requestedBy, ["roleId", "workItemId"]) ||
      requestedBy.roleId !== OWNER_ROLE ||
      !exactPlainDataObject(actor, ["provider", "accountId"]) ||
      actor.provider !== PROVIDER ||
      actor.accountId !== OWNER_ACCOUNT ||
      !exactPlainDataObject(target, ["provider", "resourceId", "version"]) ||
      target.provider !== PROVIDER ||
      target.resourceId !== RESOURCE_ID ||
      !exactPlainDataObject(display, [
        "title",
        "summary",
        "actionLabel",
        "evidence",
        "payload",
      ])
    ) {
      return false;
    }
    if (
      !exactPlainDataObject(action, ["type", ...ACTION_KEYS.activate_draft]) ||
      action.type !== "activate_draft" ||
      target.version !== action.validationDigest
    ) {
      return false;
    }
    const payload = display.payload;
    if (
      !exactPlainDataObject(payload, ["actor", "target", "action", "impact"]) ||
      digestValue(payload.actor) !== digestValue(actor) ||
      digestValue(payload.target) !== digestValue(target) ||
      digestValue(payload.action) !== digestValue(action)
    ) {
      return false;
    }
    const impact = payload.impact;
    if (
      !exactPlainDataObject(impact, [
        "changed",
        "beforeDigest",
        "afterDigest",
        "securityTightening",
        "authorityExpansion",
        "benignClaimChange",
        "restartRequired",
      ]) ||
      impact.changed !== true ||
      impact.beforeDigest !== action.activeDigest ||
      impact.afterDigest !== action.documentDigest ||
      !exactImpactCategory(
        impact.securityTightening,
        CREDENTIAL_RECOVERY_IMPACT_PATHS.securityTightening,
      ) ||
      !exactImpactCategory(
        impact.authorityExpansion,
        CREDENTIAL_RECOVERY_IMPACT_PATHS.authorityExpansion,
      ) ||
      !exactImpactCategory(
        impact.benignClaimChange,
        CREDENTIAL_RECOVERY_IMPACT_PATHS.benignClaimChange,
      ) ||
      !exactImpactCategory(
        impact.restartRequired,
        CREDENTIAL_RECOVERY_IMPACT_PATHS.restartRequired,
      )
    ) {
      return false;
    }
    return action.impactDigest === digestValue({
      changed: impact.changed,
      beforeDigest: impact.beforeDigest,
      afterDigest: impact.afterDigest,
      security_tightening: impact.securityTightening.paths,
      authority_expansion: impact.authorityExpansion.paths,
      benign_claim_change: impact.benignClaimChange.paths,
      restart_required: impact.restartRequired.paths,
    });
  } catch {
    return false;
  }
}

function normalizeDraftBinding(value, { initialization }) {
  const expectedActiveVersion = initialization
    ? requireNull(value.expectedActiveVersion, "expectedActiveVersion")
    : integer(value.expectedActiveVersion, "expectedActiveVersion", 1);
  const activeDigest = initialization
    ? requireNull(value.activeDigest, "activeDigest")
    : sha256(value.activeDigest, "activeDigest");
  return {
    expectedStateRevision: integer(
      value.expectedStateRevision,
      "expectedStateRevision",
    ),
    expectedActiveVersion,
    activeDigest,
    ...(initialization
      ? { baselineDigest: sha256(value.baselineDigest, "baselineDigest") }
      : {}),
    draftId: text(value.draftId, "draftId", 256, SAFE_IDENTIFIER),
    draftRevision: integer(value.draftRevision, "draftRevision", 1),
    draftRevisionId: text(
      value.draftRevisionId,
      "draftRevisionId",
      160,
      SAFE_IDENTIFIER,
    ),
    documentDigest: sha256(value.documentDigest, "documentDigest"),
    validationDigest: sha256(value.validationDigest, "validationDigest"),
    impactDigest: sha256(value.impactDigest, "impactDigest"),
  };
}

function requireNull(value, name) {
  if (value !== null) throw invalid(name);
  return null;
}

function normalizeRollbackBinding(value) {
  const targetDigest = sha256(value.targetDigest, "targetDigest");
  const documentDigest = sha256(value.documentDigest, "documentDigest");
  if (targetDigest !== documentDigest) throw invalid("rollback target binding");
  return {
    expectedStateRevision: integer(
      value.expectedStateRevision,
      "expectedStateRevision",
    ),
    expectedActiveVersion: integer(
      value.expectedActiveVersion,
      "expectedActiveVersion",
      1,
    ),
    activeDigest: sha256(value.activeDigest, "activeDigest"),
    targetVersion: integer(value.targetVersion, "targetVersion", 1),
    targetDigest,
    documentDigest,
    validationDigest: sha256(value.validationDigest, "validationDigest"),
    impactDigest: sha256(value.impactDigest, "impactDigest"),
  };
}

function normalizePrepared(value) {
  const kindDescriptor =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : null;
  if (!kindDescriptor?.enumerable || !("value" in kindDescriptor)) {
    throw invalid("prepared binding");
  }
  const keys = PREPARED_KEYS[kindDescriptor.value];
  if (!keys) throw invalid("prepared kind");
  exactObject(value, keys, "prepared binding");

  const binding = kindDescriptor.value === "configuration.rollback"
    ? normalizeRollbackBinding(value)
    : normalizeDraftBinding(value, {
        initialization: kindDescriptor.value === "configuration.initialize",
      });
  const impact = normalizeImpact(value.impact);
  return {
    kind: kindDescriptor.value,
    actionType: {
      "configuration.initialize": "initialize_from_draft",
      "configuration.activate": "activate_draft",
      "configuration.rollback": "activate_rollback",
    }[kindDescriptor.value],
    binding,
    impact: impact.display,
    changedPathCount: impact.changedPathCount,
  };
}

function actionForPrepared(prepared) {
  return { type: prepared.actionType, ...prepared.binding };
}

function confirmationId(action) {
  return `confirmation-configuration-${digestValue(action)}`;
}

function confirmationIdentity(action) {
  const actor = { provider: PROVIDER, accountId: OWNER_ACCOUNT };
  const target = {
    provider: PROVIDER,
    resourceId: RESOURCE_ID,
    version: action.validationDigest,
  };
  const requestedBy = {
    roleId: OWNER_ROLE,
    workItemId: `configuration-${action.validationDigest}`,
  };
  return { requestedBy, actor, target };
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
      throw invalid("confirmation plan", error);
    }
    throw error;
  }
}

export function createConfigurationActivationConfirmationPlan(value) {
  const prepared = normalizePrepared(value);
  const action = actionForPrepared(prepared);
  const { requestedBy, actor, target } = confirmationIdentity(action);
  const changedCount = prepared.changedPathCount;

  return queuePlan({
    id: confirmationId(action),
    kind: KIND,
    requestedBy,
    actor,
    target,
    action,
    display: {
      title: "激活版本化配置",
      summary: `该配置影响 ${changedCount} 个已识别路径。`,
      actionLabel: "确认并激活配置",
      evidence: [
        `配置文档摘要 ${action.documentDigest}`,
        `验证摘要 ${action.validationDigest}`,
        `影响摘要 ${action.impactDigest}`,
      ],
      payload: { actor, target, action, impact: prepared.impact },
    },
  });
}

function normalizeRequestedBy(value) {
  exactObject(value, ["roleId", "workItemId"], "requestedBy");
  if (value.roleId !== OWNER_ROLE) throw invalid("requestedBy.roleId");
  return {
    roleId: value.roleId,
    workItemId: text(value.workItemId, "requestedBy.workItemId", 256),
  };
}

function normalizeActor(value) {
  exactObject(value, ["provider", "accountId"], "actor");
  if (value.provider !== PROVIDER || value.accountId !== OWNER_ACCOUNT) {
    throw invalid("actor");
  }
  return { provider: value.provider, accountId: value.accountId };
}

function normalizeTarget(value) {
  exactObject(value, ["provider", "resourceId", "version"], "target");
  if (value.provider !== PROVIDER || value.resourceId !== RESOURCE_ID) {
    throw invalid("target");
  }
  return {
    provider: value.provider,
    resourceId: value.resourceId,
    version: sha256(value.version, "target.version"),
  };
}

function normalizeAction(value) {
  const typeDescriptor =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "type")
      : null;
  if (!typeDescriptor?.enumerable || !("value" in typeDescriptor)) {
    throw invalid("action");
  }
  const bindingKeys = ACTION_KEYS[typeDescriptor.value];
  if (!bindingKeys) throw invalid("action.type");
  exactObject(value, ["type", ...bindingKeys], "action");
  const binding = typeDescriptor.value === "activate_rollback"
    ? normalizeRollbackBinding(value)
    : normalizeDraftBinding(value, {
        initialization: typeDescriptor.value === "initialize_from_draft",
      });
  return { type: typeDescriptor.value, ...binding };
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function normalizeExecution(value) {
  exactObject(value, ["requestId", "attempt", "startedAt"], "execution");
  if (!canonicalTimestamp(value.startedAt)) throw invalid("execution.startedAt");
  return {
    requestId: text(value.requestId, "execution.requestId", 128, REQUEST_ID),
    attempt: integer(value.attempt, "execution.attempt", 1),
    startedAt: value.startedAt,
  };
}

export function normalizeConfigurationActivationEnvelope(value) {
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
    throw invalid("envelope kind or schemaVersion");
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
  const id = text(value.id, "id", 128, SAFE_TOKEN);
  const idempotencyKey = text(
    value.idempotencyKey,
    "idempotencyKey",
    128,
    SAFE_TOKEN,
  );
  const expectedApprovalBinding = digestValue({
    id,
    kind: KIND,
    requestedBy,
    actor,
    target,
    action,
    displayedPayloadDigest,
  });
  if (
    id !== confirmationId(action) ||
    idempotencyKey !== `confirmation-${approvalBindingDigest}` ||
    approvalBindingDigest !== expectedApprovalBinding ||
    requestedBy.workItemId !== `configuration-${action.validationDigest}` ||
    target.version !== action.validationDigest
  ) {
    throw invalid("envelope binding");
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
