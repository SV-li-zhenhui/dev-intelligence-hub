import {
  configurationDocumentImpact,
  createSafeDisabledConfiguration,
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";

export const CONFIGURATION_STATE_KEY = "configuration-state";
export const CONFIGURATION_STATE_SCHEMA_VERSION = 3;
const FIRST_CONFIGURATION_STATE_SCHEMA_VERSION = 1;
const SCHEMA_MIGRATIONS_INTRODUCED_VERSION = 2;
const IMPACT_POLICY_INTRODUCED_VERSION = 3;
const CURRENT_CONFIGURATION_IMPACT_POLICY_VERSION = 2;

export const DEFAULT_CONFIGURATION_LIMITS = Object.freeze({
  maximumVersions: 256,
  maximumDrafts: 256,
  maximumDraftRevisions: 2_048,
  maximumAuditEntries: 4_096,
  maximumOutboxEntries: 256,
  maximumStateBytes: 64 * 1024 * 1024,
});

const LIMIT_MAXIMUMS = Object.freeze({
  maximumVersions: 10_000,
  maximumDrafts: 10_000,
  maximumDraftRevisions: 100_000,
  maximumAuditEntries: 200_000,
  maximumOutboxEntries: 10_000,
  maximumStateBytes: 256 * 1024 * 1024,
});
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const VERSION_SOURCES = new Set([
  "bootstrap",
  "initialization",
  "draft",
  "rollback",
]);
const AUDIT_KINDS = new Set([
  "bootstrap_imported",
  "draft_created",
  "draft_revised",
  "configuration_initialized",
  "configuration_activated",
  "configuration_rolled_back",
]);

export class ConfigurationStoreError extends Error {
  constructor(code, message, statusCode, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigurationStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function configurationStoreError(code, message, statusCode, cause) {
  return new ConfigurationStoreError(code, message, statusCode, { cause });
}

function corrupted(path, detail = "无效", cause) {
  return configurationStoreError(
    "CONFIGURATION_STATE_CORRUPTED",
    `${path} ${detail}`,
    503,
    cause,
  );
}

function objectFields(value, path, allowed, required = allowed) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw corrupted(path, "必须是普通对象");
  }
  const keys = Reflect.ownKeys(value);
  const allowedSet = new Set(allowed);
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !allowedSet.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw corrupted(path, "包含未知字段、Symbol、访问器或危险键");
    }
    fields.set(key, descriptor.value);
  }
  if (required.some((name) => !fields.has(name))) {
    throw corrupted(path, "缺少必需字段");
  }
  return fields;
}

function denseArray(value, path, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw corrupted(path);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw corrupted(path, "必须是无附加字段的稠密数组");
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw corrupted(`${path}[${index}]`, "必须是数据字段");
    }
    return descriptor.value;
  });
}

function integer(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw corrupted(path);
  }
  return value;
}

function nullableInteger(value, path, minimum = 0) {
  return value === null ? null : integer(value, path, minimum);
}

function text(value, path, maximumBytes = 256, pattern) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_TEXT_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw corrupted(path);
  }
  return value;
}

function nullableText(value, path, maximumBytes, pattern) {
  return value === null ? null : text(value, path, maximumBytes, pattern);
}

function timestamp(value, path) {
  const normalized = text(value, path, 64);
  if (Number.isNaN(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    throw corrupted(path);
  }
  return normalized;
}

function digest(value, path) {
  return text(value, path, 64, DIGEST);
}

export function configurationContentDigest(value) {
  return canonicalJsonDigest(value);
}

export function configurationImpactDigest(impact) {
  return configurationContentDigest({
    changed: impact.changed,
    beforeDigest: impact.beforeDigest,
    afterDigest: impact.afterDigest,
    security_tightening: impact.security_tightening,
    authority_expansion: impact.authority_expansion,
    benign_claim_change: impact.benign_claim_change,
    restart_required: impact.restart_required,
  });
}

function normalizeIdentified(value, path, idName, prefix, contentNormalizer) {
  const fields = objectFields(
    value,
    path,
    [idName, "contentDigest", ...contentNormalizer.fields],
  );
  const content = contentNormalizer.normalize(fields, path);
  const contentDigest = configurationContentDigest(content);
  if (digest(fields.get("contentDigest"), `${path}.contentDigest`) !== contentDigest) {
    throw corrupted(`${path}.contentDigest`, "与内容不一致");
  }
  const expectedId = `${prefix}-${contentDigest}`;
  if (text(fields.get(idName), `${path}.${idName}`, 160) !== expectedId) {
    throw corrupted(`${path}.${idName}`, "与内容不一致");
  }
  return { [idName]: expectedId, contentDigest, ...content };
}

const VERSION_CONTENT = Object.freeze({
  fields: [
    "version",
    "configurationDigest",
    "configuration",
    "source",
    "previousVersion",
    "draftRevisionId",
    "rollbackOf",
    "activatedBy",
    "activatedAt",
    "impactDigest",
  ],
  normalize(fields, path) {
    const { configuration, configurationDigest } = normalizeStoredConfiguration(
      fields,
      path,
    );
    const source = text(fields.get("source"), `${path}.source`, 32);
    if (!VERSION_SOURCES.has(source)) throw corrupted(`${path}.source`);
    const draftRevisionId = nullableText(
      fields.get("draftRevisionId"),
      `${path}.draftRevisionId`,
      160,
    );
    const rollbackOf = nullableInteger(
      fields.get("rollbackOf"),
      `${path}.rollbackOf`,
      1,
    );
    if (
      (source === "bootstrap" && (draftRevisionId !== null || rollbackOf !== null)) ||
      (source === "initialization" &&
        (draftRevisionId === null || rollbackOf !== null)) ||
      (source === "draft" && (draftRevisionId === null || rollbackOf !== null)) ||
      (source === "rollback" && (draftRevisionId !== null || rollbackOf === null))
    ) {
      throw corrupted(path, "版本来源绑定不一致");
    }
    return {
      version: integer(fields.get("version"), `${path}.version`, 1),
      configurationDigest,
      configuration,
      source,
      previousVersion: nullableInteger(
        fields.get("previousVersion"),
        `${path}.previousVersion`,
        1,
      ),
      draftRevisionId,
      rollbackOf,
      activatedBy: text(fields.get("activatedBy"), `${path}.activatedBy`, 128),
      activatedAt: timestamp(fields.get("activatedAt"), `${path}.activatedAt`),
      impactDigest: digest(fields.get("impactDigest"), `${path}.impactDigest`),
    };
  },
});

const DRAFT_CONTENT = Object.freeze({
  fields: [
    "draftId",
    "revision",
    "baseVersion",
    "configurationDigest",
    "configuration",
    "proposedBy",
    "createdAt",
    "supersedesRevisionId",
  ],
  normalize(fields, path) {
    const { configuration, configurationDigest } = normalizeStoredConfiguration(
      fields,
      path,
    );
    return {
      draftId: text(fields.get("draftId"), `${path}.draftId`, 256, SAFE_ID),
      revision: integer(fields.get("revision"), `${path}.revision`, 1),
      baseVersion: integer(fields.get("baseVersion"), `${path}.baseVersion`),
      configurationDigest,
      configuration,
      proposedBy: text(fields.get("proposedBy"), `${path}.proposedBy`, 128),
      createdAt: timestamp(fields.get("createdAt"), `${path}.createdAt`),
      supersedesRevisionId: nullableText(
        fields.get("supersedesRevisionId"),
        `${path}.supersedesRevisionId`,
        160,
      ),
    };
  },
});

function normalizeStoredConfiguration(fields, path) {
  let configuration;
  try {
    configuration = normalizeConfigurationDocument(fields.get("configuration"));
  } catch (cause) {
    throw corrupted(`${path}.configuration`, "无效", cause);
  }
  const configurationDigest = configurationContentDigest(configuration);
  if (
    digest(fields.get("configurationDigest"), `${path}.configurationDigest`) !==
    configurationDigest
  ) {
    throw corrupted(`${path}.configurationDigest`, "与配置不一致");
  }
  return { configuration, configurationDigest };
}

const AUDIT_CONTENT = Object.freeze({
  fields: [
    "sequence",
    "stateRevision",
    "kind",
    "actor",
    "occurredAt",
    "draftId",
    "draftRevisionId",
    "configurationVersion",
    "configurationDigest",
    "targetVersion",
    "impactDigest",
  ],
  normalize(fields, path) {
    const kind = text(fields.get("kind"), `${path}.kind`, 64);
    if (!AUDIT_KINDS.has(kind)) throw corrupted(`${path}.kind`);
    return {
      sequence: integer(fields.get("sequence"), `${path}.sequence`, 1),
      stateRevision: integer(fields.get("stateRevision"), `${path}.stateRevision`, 1),
      kind,
      actor: text(fields.get("actor"), `${path}.actor`, 128),
      occurredAt: timestamp(fields.get("occurredAt"), `${path}.occurredAt`),
      draftId: nullableText(fields.get("draftId"), `${path}.draftId`, 256, SAFE_ID),
      draftRevisionId: nullableText(
        fields.get("draftRevisionId"),
        `${path}.draftRevisionId`,
        160,
      ),
      configurationVersion: nullableInteger(
        fields.get("configurationVersion"),
        `${path}.configurationVersion`,
        1,
      ),
      configurationDigest: nullableText(
        fields.get("configurationDigest"),
        `${path}.configurationDigest`,
        64,
        DIGEST,
      ),
      targetVersion: nullableInteger(
        fields.get("targetVersion"),
        `${path}.targetVersion`,
        1,
      ),
      impactDigest: nullableText(
        fields.get("impactDigest"),
        `${path}.impactDigest`,
        64,
        DIGEST,
      ),
    };
  },
});

const OUTBOX_CONTENT = Object.freeze({
  fields: [
    "sequence",
    "configurationVersion",
    "configurationDigest",
    "previousVersion",
    "impactDigest",
    "createdAt",
  ],
  normalize(fields, path) {
    return {
      sequence: integer(fields.get("sequence"), `${path}.sequence`, 1),
      configurationVersion: integer(
        fields.get("configurationVersion"),
        `${path}.configurationVersion`,
        1,
      ),
      configurationDigest: digest(
        fields.get("configurationDigest"),
        `${path}.configurationDigest`,
      ),
      previousVersion: nullableInteger(
        fields.get("previousVersion"),
        `${path}.previousVersion`,
        1,
      ),
      impactDigest: digest(fields.get("impactDigest"), `${path}.impactDigest`),
      createdAt: timestamp(fields.get("createdAt"), `${path}.createdAt`),
    };
  },
});

function normalizeMigration(value) {
  const fields = objectFields(
    value,
    "configurationState.migration",
    ["status", "importedAt", "importedBy", "sourceDigest"],
  );
  const status = text(fields.get("status"), "configurationState.migration.status", 32);
  if (!new Set(["pending", "imported"]).has(status)) {
    throw corrupted("configurationState.migration.status");
  }
  const migration = {
    status,
    importedAt: nullableText(
      fields.get("importedAt"),
      "configurationState.migration.importedAt",
      64,
    ),
    importedBy: nullableText(
      fields.get("importedBy"),
      "configurationState.migration.importedBy",
      128,
    ),
    sourceDigest: nullableText(
      fields.get("sourceDigest"),
      "configurationState.migration.sourceDigest",
      64,
      DIGEST,
    ),
  };
  if (migration.importedAt !== null) {
    migration.importedAt = timestamp(
      migration.importedAt,
      "configurationState.migration.importedAt",
    );
  }
  const values = [migration.importedAt, migration.importedBy, migration.sourceDigest];
  const empty = values.every((entry) => entry === null);
  const complete = values.every((entry) => entry !== null);
  if ((status === "pending" && !empty) || (status === "imported" && !complete)) {
    throw corrupted("configurationState.migration", "状态绑定不一致");
  }
  return migration;
}

function normalizeDraftHead(value, index) {
  const path = `configurationState.draftHeads[${index}]`;
  const fields = objectFields(value, path, ["draftId", "revision", "draftRevisionId"]);
  return {
    draftId: text(fields.get("draftId"), `${path}.draftId`, 256, SAFE_ID),
    revision: integer(fields.get("revision"), `${path}.revision`, 1),
    draftRevisionId: text(fields.get("draftRevisionId"), `${path}.draftRevisionId`, 160),
  };
}

export function normalizeConfigurationLimits(overrides = {}) {
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    Array.isArray(overrides) ||
    Object.getPrototypeOf(overrides) !== Object.prototype
  ) {
    throw new TypeError("configuration limits must be a plain object");
  }
  const unknown = Object.keys(overrides).filter(
    (name) => !Object.hasOwn(DEFAULT_CONFIGURATION_LIMITS, name),
  );
  if (unknown.length > 0) throw new TypeError("configuration limits contain unknown fields");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(DEFAULT_CONFIGURATION_LIMITS).map(([name, fallback]) => {
        const value = Object.hasOwn(overrides, name) ? overrides[name] : fallback;
        if (
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > LIMIT_MAXIMUMS[name]
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return [name, value];
      }),
    ),
  );
}

export function emptyConfigurationState() {
  return {
    schemaVersion: CONFIGURATION_STATE_SCHEMA_VERSION,
    schemaMigrations: [],
    impactPolicy: {
      version: CURRENT_CONFIGURATION_IMPACT_POLICY_VERSION,
      currentFromVersion: 1,
    },
    revision: 0,
    migration: {
      status: "pending",
      importedAt: null,
      importedBy: null,
      sourceDigest: null,
    },
    activeVersion: null,
    versions: [],
    draftRevisions: [],
    draftHeads: [],
    audit: [],
    projectionOutbox: [],
  };
}

function legacyRestartRequired(path) {
  return (
    path === "port" ||
    path === "githubLogin" ||
    path.startsWith("brainProviders.") ||
    path.startsWith("codeExecutor.") ||
    path.startsWith("changePackages.") ||
    path === "githubActions.enabled" ||
    path.startsWith("githubActions.actorAccountId") ||
    path.startsWith("githubActions.tokenEnv") ||
    path.startsWith("githubActions.ghCommand") ||
    path.startsWith("githubActions.networkEnv")
  );
}

function legacySafeDisabledConfiguration(configuration) {
  const safe = structuredClone(createSafeDisabledConfiguration(configuration));
  if (!Object.hasOwn(configuration, "githubRead")) delete safe.githubRead;
  return normalizeConfigurationDocument(safe);
}

function impactDigest(before, after, { legacyRestartScope = false } = {}) {
  const impact = configurationDocumentImpact(before, after);
  return configurationImpactDigest(
    legacyRestartScope
      ? {
          ...impact,
          restart_required: impact.restart_required.filter(legacyRestartRequired),
        }
      : impact,
  );
}

function assertVersionConsistency(state, currentImpactPolicyFromVersion) {
  const draftByRevisionId = new Map(
    state.draftRevisions.map((entry) => [entry.draftRevisionId, entry]),
  );
  for (const [index, version] of state.versions.entries()) {
    const expectedVersion = index + 1;
    const previous = state.versions[index - 1] || null;
    const sourceDraft = version.draftRevisionId === null
      ? null
      : draftByRevisionId.get(version.draftRevisionId);
    const rollbackTarget = version.rollbackOf === null
      ? null
      : state.versions[version.rollbackOf - 1];
    const expectedImpactDigest = previous === null
      ? version.source === "bootstrap"
        ? configurationContentDigest({
            kind: "bootstrap",
            documentDigest: version.configurationDigest,
          })
        : impactDigest(
            createSafeDisabledConfiguration(version.configuration),
            version.configuration,
          )
      : impactDigest(previous.configuration, version.configuration);
    const legacyImpactDigest = previous === null
      ? version.source === "bootstrap"
        ? expectedImpactDigest
        : impactDigest(
            legacySafeDisabledConfiguration(version.configuration),
            version.configuration,
            { legacyRestartScope: true },
          )
      : impactDigest(previous.configuration, version.configuration, {
          legacyRestartScope: true,
        });
    const impactDigestMatches =
      version.impactDigest === expectedImpactDigest ||
      (version.version < currentImpactPolicyFromVersion &&
        version.impactDigest === legacyImpactDigest);
    const validInitialSource =
      expectedVersion !== 1 ||
      ["bootstrap", "initialization"].includes(version.source);
    const validLaterSource =
      expectedVersion === 1 ||
      !["bootstrap", "initialization"].includes(version.source);
    const validDraftSource =
      !["initialization", "draft"].includes(version.source) ||
      (sourceDraft &&
        sourceDraft.configurationDigest === version.configurationDigest &&
        (version.source === "initialization"
          ? sourceDraft.baseVersion === 0
          : sourceDraft.baseVersion >= 1));
    if (
      version.version !== expectedVersion ||
      version.previousVersion !== (expectedVersion === 1 ? null : expectedVersion - 1) ||
      !impactDigestMatches ||
      !validInitialSource ||
      !validLaterSource ||
      !validDraftSource ||
      (version.source === "rollback" &&
        (!rollbackTarget ||
          rollbackTarget.version >= version.version ||
          rollbackTarget.configurationDigest !== version.configurationDigest))
    ) {
      throw corrupted(`configurationState.versions[${index}]`, "引用不一致");
    }
  }
  const expectedActive = state.versions.length === 0 ? null : state.versions.length;
  if (state.activeVersion !== expectedActive) {
    throw corrupted("configurationState.activeVersion", "必须指向最新不可变版本");
  }
}

function assertDraftConsistency(state) {
  const byDraft = new Map();
  const ids = new Set();
  for (const [index, draft] of state.draftRevisions.entries()) {
    if (
      ids.has(draft.draftRevisionId) ||
      draft.baseVersion > state.versions.length ||
      (draft.baseVersion === 0 &&
        state.versions.length > 0 &&
        state.versions[0].source !== "initialization")
    ) {
      throw corrupted(`configurationState.draftRevisions[${index}]`, "引用重复或悬空");
    }
    ids.add(draft.draftRevisionId);
    const revisions = byDraft.get(draft.draftId) || [];
    const previous = revisions.at(-1);
    if (
      draft.revision !== revisions.length + 1 ||
      draft.supersedesRevisionId !== (previous?.draftRevisionId || null) ||
      (previous && draft.baseVersion !== previous.baseVersion)
    ) {
      throw corrupted(`configurationState.draftRevisions[${index}]`, "修订链不连续");
    }
    revisions.push(draft);
    byDraft.set(draft.draftId, revisions);
  }
  if (state.draftHeads.length !== byDraft.size) {
    throw corrupted("configurationState.draftHeads", "与草稿修订不一致");
  }
  const headIds = new Set();
  for (const [index, head] of state.draftHeads.entries()) {
    const latest = byDraft.get(head.draftId)?.at(-1);
    if (
      headIds.has(head.draftId) ||
      !latest ||
      head.revision !== latest.revision ||
      head.draftRevisionId !== latest.draftRevisionId
    ) {
      throw corrupted(`configurationState.draftHeads[${index}]`, "不是最新草稿修订");
    }
    headIds.add(head.draftId);
  }
}

function assertAuditConsistency(state) {
  if (state.audit.length !== state.revision) {
    throw corrupted("configurationState.audit", "必须覆盖每次状态变更");
  }
  const versionByNumber = new Map(state.versions.map((entry) => [entry.version, entry]));
  const draftByRevisionId = new Map(
    state.draftRevisions.map((entry) => [entry.draftRevisionId, entry]),
  );
  const auditedVersions = new Set();
  const auditedDrafts = new Set();
  const initializationSequence = state.audit.find(
    (entry) => entry.kind === "configuration_initialized",
  )?.sequence;
  for (const [index, entry] of state.audit.entries()) {
    const expected = index + 1;
    const version = entry.configurationVersion === null
      ? null
      : versionByNumber.get(entry.configurationVersion);
    if (
      entry.sequence !== expected ||
      entry.stateRevision !== expected ||
      (entry.draftRevisionId !== null && !draftByRevisionId.has(entry.draftRevisionId)) ||
      (entry.configurationVersion !== null && !version) ||
      (version && entry.configurationDigest !== version.configurationDigest) ||
      (entry.targetVersion !== null && !versionByNumber.has(entry.targetVersion))
    ) {
      throw corrupted(`configurationState.audit[${index}]`, "引用不一致");
    }
    const draft = entry.draftRevisionId === null
      ? null
      : draftByRevisionId.get(entry.draftRevisionId);
    if (entry.kind === "bootstrap_imported") {
      if (
        entry.sequence !== 1 ||
        version?.source !== "bootstrap" ||
        entry.draftId !== null ||
        entry.draftRevisionId !== null ||
        entry.targetVersion !== null ||
        entry.impactDigest !== version.impactDigest ||
        entry.actor !== version.activatedBy ||
        entry.occurredAt !== version.activatedAt
      ) {
        throw corrupted(`configurationState.audit[${index}]`, "启动导入语义不一致");
      }
      auditedVersions.add(version.version);
      continue;
    }
    if (entry.kind === "draft_created" || entry.kind === "draft_revised") {
      const expectedKind = draft?.revision === 1 ? "draft_created" : "draft_revised";
      if (
        !draft ||
        entry.kind !== expectedKind ||
        entry.draftId !== draft.draftId ||
        entry.configurationVersion !== null ||
        entry.configurationDigest !== null ||
        entry.targetVersion !== null ||
        entry.impactDigest !== null ||
        entry.actor !== draft.proposedBy ||
        entry.occurredAt !== draft.createdAt ||
        (draft.baseVersion === 0 &&
          initializationSequence !== undefined &&
          entry.sequence >= initializationSequence)
      ) {
        throw corrupted(`configurationState.audit[${index}]`, "草稿审计语义不一致");
      }
      auditedDrafts.add(draft.draftRevisionId);
      continue;
    }
    if (entry.kind === "configuration_initialized") {
      if (
        !draft ||
        version?.version !== 1 ||
        version.source !== "initialization" ||
        version.draftRevisionId !== draft.draftRevisionId ||
        draft.baseVersion !== 0 ||
        entry.draftId !== draft.draftId ||
        entry.targetVersion !== null ||
        entry.impactDigest !== version.impactDigest ||
        entry.actor !== version.activatedBy ||
        entry.occurredAt !== version.activatedAt
      ) {
        throw corrupted(
          `configurationState.audit[${index}]`,
          "初始化审计语义不一致",
        );
      }
      auditedVersions.add(version.version);
      continue;
    }
    if (entry.kind === "configuration_activated") {
      if (
        !draft ||
        version?.source !== "draft" ||
        version.draftRevisionId !== draft.draftRevisionId ||
        entry.draftId !== draft.draftId ||
        entry.targetVersion !== null ||
        entry.impactDigest !== version.impactDigest ||
        entry.actor !== version.activatedBy ||
        entry.occurredAt !== version.activatedAt
      ) {
        throw corrupted(`configurationState.audit[${index}]`, "配置激活语义不一致");
      }
      auditedVersions.add(version.version);
      continue;
    }
    if (
      entry.kind !== "configuration_rolled_back" ||
      version?.source !== "rollback" ||
      entry.draftId !== null ||
      entry.draftRevisionId !== null ||
      entry.targetVersion !== version.rollbackOf ||
      entry.impactDigest !== version.impactDigest ||
      entry.actor !== version.activatedBy ||
      entry.occurredAt !== version.activatedAt
    ) {
      throw corrupted(`configurationState.audit[${index}]`, "配置回滚语义不一致");
    }
    auditedVersions.add(version.version);
  }
  if (
    auditedVersions.size !== state.versions.length ||
    auditedDrafts.size !== state.draftRevisions.length
  ) {
    throw corrupted("configurationState.audit", "缺少版本或草稿审计");
  }
}

function assertOutboxConsistency(state) {
  if (state.projectionOutbox.length !== state.versions.length) {
    throw corrupted("configurationState.projectionOutbox", "必须覆盖每个激活版本");
  }
  for (const [index, entry] of state.projectionOutbox.entries()) {
    const version = state.versions[index];
    if (
      entry.sequence !== index + 1 ||
      entry.configurationVersion !== version.version ||
      entry.configurationDigest !== version.configurationDigest ||
      entry.previousVersion !== version.previousVersion ||
      entry.impactDigest !== version.impactDigest ||
      entry.createdAt !== version.activatedAt
    ) {
      throw corrupted(`configurationState.projectionOutbox[${index}]`, "版本绑定不一致");
    }
  }
}

export function prettySerializedConfigurationBytes(state) {
  return Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function assertConfigurationCapacity(state, limits) {
  if (
    state.versions.length > limits.maximumVersions ||
    state.draftHeads.length > limits.maximumDrafts ||
    state.draftRevisions.length > limits.maximumDraftRevisions ||
    state.audit.length > limits.maximumAuditEntries ||
    state.projectionOutbox.length > limits.maximumOutboxEntries ||
    prettySerializedConfigurationBytes(state) > limits.maximumStateBytes
  ) {
    throw configurationStoreError(
      "CONFIGURATION_CAPACITY_EXCEEDED",
      "配置历史容量已满，未删除任何被引用版本",
      507,
    );
  }
}

function normalizeSchemaMigrations(value, schemaVersion) {
  const migrations = denseArray(
    value,
    "configurationState.schemaMigrations",
    schemaVersion - 1,
  ).map((entry, index) => {
    const path = `configurationState.schemaMigrations[${index}]`;
    const fields = objectFields(entry, path, ["from", "to"]);
    const from = integer(
      fields.get("from"),
      `${path}.from`,
      FIRST_CONFIGURATION_STATE_SCHEMA_VERSION,
      schemaVersion - 1,
    );
    const to = integer(
      fields.get("to"),
      `${path}.to`,
      2,
      schemaVersion,
    );
    if (to !== from + 1) throw corrupted(path, "迁移版本不连续");
    return { from, to };
  });
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].to !== migrations[index].from) {
      throw corrupted(
        "configurationState.schemaMigrations",
        "迁移历史不连续",
      );
    }
  }
  if (
    migrations.length > 0 &&
    migrations.at(-1).to !== schemaVersion
  ) {
    throw corrupted(
      "configurationState.schemaMigrations",
      "迁移历史未到达当前版本",
    );
  }
  return migrations;
}

function normalizeImpactPolicy(value, maximumVersion) {
  const path = "configurationState.impactPolicy";
  const fields = objectFields(value, path, ["version", "currentFromVersion"]);
  return {
    version: integer(
      fields.get("version"),
      `${path}.version`,
      CURRENT_CONFIGURATION_IMPACT_POLICY_VERSION,
      CURRENT_CONFIGURATION_IMPACT_POLICY_VERSION,
    ),
    currentFromVersion: integer(
      fields.get("currentFromVersion"),
      `${path}.currentFromVersion`,
      1,
      maximumVersion + 1,
    ),
  };
}

function normalizeConfigurationStateVersion(value, limits, schemaVersion) {
  const hasSchemaMigrations =
    schemaVersion >= SCHEMA_MIGRATIONS_INTRODUCED_VERSION;
  const hasImpactPolicy = schemaVersion >= IMPACT_POLICY_INTRODUCED_VERSION;
  const fields = objectFields(value, "configurationState", [
    "schemaVersion",
    ...(hasSchemaMigrations ? ["schemaMigrations"] : []),
    ...(hasImpactPolicy ? ["impactPolicy"] : []),
    "revision",
    "migration",
    "activeVersion",
    "versions",
    "draftRevisions",
    "draftHeads",
    "audit",
    "projectionOutbox",
  ]);
  integer(
    fields.get("schemaVersion"),
    "configurationState.schemaVersion",
    schemaVersion,
    schemaVersion,
  );
  const state = {
    schemaVersion,
    ...(hasSchemaMigrations
      ? {
          schemaMigrations: normalizeSchemaMigrations(
            fields.get("schemaMigrations"),
            schemaVersion,
          ),
        }
      : {}),
    revision: integer(fields.get("revision"), "configurationState.revision"),
    migration: normalizeMigration(fields.get("migration")),
    activeVersion: nullableInteger(
      fields.get("activeVersion"),
      "configurationState.activeVersion",
      1,
    ),
    versions: denseArray(
      fields.get("versions"),
      "configurationState.versions",
      limits.maximumVersions,
    ).map((entry, index) =>
      normalizeIdentified(
        entry,
        `configurationState.versions[${index}]`,
        "versionId",
        "configuration-version",
        VERSION_CONTENT,
      ),
    ),
    draftRevisions: denseArray(
      fields.get("draftRevisions"),
      "configurationState.draftRevisions",
      limits.maximumDraftRevisions,
    ).map((entry, index) =>
      normalizeIdentified(
        entry,
        `configurationState.draftRevisions[${index}]`,
        "draftRevisionId",
        "configuration-draft-revision",
        DRAFT_CONTENT,
      ),
    ),
    draftHeads: denseArray(
      fields.get("draftHeads"),
      "configurationState.draftHeads",
      limits.maximumDrafts,
    ).map(normalizeDraftHead),
    audit: denseArray(
      fields.get("audit"),
      "configurationState.audit",
      limits.maximumAuditEntries,
    ).map((entry, index) =>
      normalizeIdentified(
        entry,
        `configurationState.audit[${index}]`,
        "auditId",
        "configuration-audit",
        AUDIT_CONTENT,
      ),
    ),
    projectionOutbox: denseArray(
      fields.get("projectionOutbox"),
      "configurationState.projectionOutbox",
      limits.maximumOutboxEntries,
    ).map((entry, index) =>
      normalizeIdentified(
        entry,
        `configurationState.projectionOutbox[${index}]`,
        "outboxId",
        "configuration-outbox",
        OUTBOX_CONTENT,
      ),
    ),
  };
  const impactPolicy = hasImpactPolicy
    ? normalizeImpactPolicy(fields.get("impactPolicy"), state.versions.length)
    : {
        version: 1,
        currentFromVersion: state.versions.length + 1,
      };
  if (hasImpactPolicy) state.impactPolicy = impactPolicy;
  if (
    (state.migration.status === "pending" && state.versions.length !== 0) ||
    (state.migration.status === "imported" &&
      (state.versions.length === 0 ||
        state.migration.sourceDigest !== state.versions[0].configurationDigest ||
        state.migration.importedAt !== state.versions[0].activatedAt ||
        state.migration.importedBy !== state.versions[0].activatedBy ||
        !["bootstrap", "initialization"].includes(state.versions[0].source)))
  ) {
    throw corrupted("configurationState.migration", "与版本历史不一致");
  }
  assertDraftConsistency(state);
  assertVersionConsistency(state, impactPolicy.currentFromVersion);
  assertAuditConsistency(state);
  assertOutboxConsistency(state);
  if (prettySerializedConfigurationBytes(state) > limits.maximumStateBytes) {
    throw corrupted("configurationState", "超过容量上限");
  }
  return state;
}

function declaredConfigurationStateSchemaVersion(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw corrupted("configurationState", "必须是普通对象");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw corrupted("configurationState.schemaVersion");
  }
  return integer(
    descriptor.value,
    "configurationState.schemaVersion",
    FIRST_CONFIGURATION_STATE_SCHEMA_VERSION,
  );
}

export function normalizeConfigurationState(value, limits) {
  return normalizeConfigurationStateVersion(
    value,
    limits,
    CONFIGURATION_STATE_SCHEMA_VERSION,
  );
}

export function migrateConfigurationState(value, limits) {
  const schemaVersion = declaredConfigurationStateSchemaVersion(value);
  if (schemaVersion === CONFIGURATION_STATE_SCHEMA_VERSION) {
    return {
      migratedFrom: null,
      state: normalizeConfigurationState(value, limits),
    };
  }
  if (
    schemaVersion < FIRST_CONFIGURATION_STATE_SCHEMA_VERSION ||
    schemaVersion >= CONFIGURATION_STATE_SCHEMA_VERSION
  ) {
    throw corrupted("configurationState.schemaVersion", "不受支持");
  }
  const legacy = normalizeConfigurationStateVersion(
    value,
    limits,
    schemaVersion,
  );
  const priorMigrations = legacy.schemaMigrations || [];
  const schemaMigrations = [...priorMigrations];
  for (
    let from = schemaVersion;
    from < CONFIGURATION_STATE_SCHEMA_VERSION;
    from += 1
  ) {
    schemaMigrations.push({ from, to: from + 1 });
  }
  const state = normalizeConfigurationState({
    ...legacy,
    schemaVersion: CONFIGURATION_STATE_SCHEMA_VERSION,
    schemaMigrations,
    impactPolicy: {
      version: CURRENT_CONFIGURATION_IMPACT_POLICY_VERSION,
      currentFromVersion: legacy.versions.length + 1,
    },
  }, limits);
  return {
    migratedFrom: schemaVersion,
    state,
  };
}

export function configurationStateDigest(state) {
  return configurationContentDigest(state);
}

export function identifiedConfigurationRecord(idName, prefix, content) {
  const contentDigest = configurationContentDigest(content);
  return {
    [idName]: `${prefix}-${contentDigest}`,
    contentDigest,
    ...content,
  };
}

export function deepFreezeConfigurationValue(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeConfigurationValue(child);
    Object.freeze(value);
  }
  return value;
}

export function cloneFrozenConfigurationValue(value) {
  return deepFreezeConfigurationValue(structuredClone(value));
}
