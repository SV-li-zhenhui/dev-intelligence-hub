import path from "node:path";
import { types as utilTypes } from "node:util";

import { OperationQueue } from "./lib/operation-queue.js";
import { BackupService } from "./services/backup-service.js";
import { DataDirectoryCheckpointService } from "./services/data-directory-checkpoint-service.js";
import { OperationalQuiescenceGate } from "./services/operational-quiescence-gate.js";
import {
  createProductionRestoreMigrationRegistry,
} from "./services/production-restore-migration-registry.js";
import { ReadinessService } from "./services/readiness-service.js";
import {
  createTrustedRestoreMigration,
} from "./services/trusted-restore-migration.js";
import {
  normalizeEffectivePullRequestUpdatedWindow,
} from "./domain/pull-request-updated-window.js";

const OPTION_KEYS = new Set([
  "dataDirectory",
  "backupDirectory",
  "externalActionStatus",
  "migration",
  "probeTimeoutMs",
  "snapshotReader",
]);

const DEPENDENCY_KEYS = new Set([
  "backupServiceFactory",
  "checkpointServiceFactory",
  "operationQueueFactory",
  "quiescenceGateFactory",
  "readinessServiceFactory",
]);

function plainEntries(value, allowed, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} must be a plain record`);
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${name} must be a plain record`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function absoluteDirectory(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute directory`);
  }
  return path.resolve(value);
}

function port(value, methods, name) {
  if (!value || utilTypes.isProxy(value)) throw new TypeError(`${name} is invalid`);
  const result = {};
  for (const methodName of methods) {
    let current = value;
    let implementation = null;
    while (current !== null && !utilTypes.isProxy(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, methodName);
      if (descriptor) {
        implementation = "value" in descriptor &&
            typeof descriptor.value === "function" &&
            !utilTypes.isProxy(descriptor.value)
          ? descriptor.value.bind(value)
          : null;
        break;
      }
      current = Object.getPrototypeOf(current);
    }
    if (implementation === null) throw new TypeError(`${name} is invalid`);
    result[methodName] = implementation;
  }
  return Object.freeze(result);
}

function factory(entries, name, fallback) {
  const value = entries.has(name) ? entries.get(name) : fallback;
  if (typeof value !== "function" || utilTypes.isProxy(value)) {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function externalActionProbe(value) {
  if (value === undefined || value === null) {
    return async () => Object.freeze({ unknownActionTypes: Object.freeze([]) });
  }
  const recoveryStatus = port(
    value,
    ["readRecoveryStatus"],
    "externalActionStatus",
  );
  return async () => {
    const result = await recoveryStatus.readRecoveryStatus();
    return { unknownActionTypes: result?.kinds };
  };
}

function backupProjection(manifest) {
  return Object.freeze({
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    checkpointId: manifest.checkpoint.checkpointId,
    fileCount: manifest.totals.fileCount,
    totalBytes: manifest.totals.totalBytes,
  });
}

const UNAVAILABLE_PULL_REQUEST_DISCOVERY = Object.freeze({
  available: false,
  enabled: false,
  refreshedAt: "",
  complete: false,
  stale: true,
  effectiveUpdatedWindow: null,
});

function ownDataValue(record, field) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    utilTypes.isProxy(record) ||
    Object.getPrototypeOf(record) !== Object.prototype
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor?.enumerable && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function pullRequestDiscoveryProjection(snapshot) {
  const refreshedAt = ownDataValue(snapshot, "refreshedAt");
  const sourceStatus = ownDataValue(snapshot, "sourceStatus");
  const pullRequests = ownDataValue(sourceStatus, "githubPullRequests");
  const enabled = ownDataValue(pullRequests, "enabled");
  const complete = ownDataValue(pullRequests, "complete");
  const stale = ownDataValue(pullRequests, "stale");
  const effective = ownDataValue(pullRequests, "effectiveUpdatedWindow");
  const refreshedTimestamp = typeof refreshedAt === "string"
    ? Date.parse(refreshedAt)
    : Number.NaN;
  if (
    !Number.isFinite(refreshedTimestamp) ||
    new Date(refreshedTimestamp).toISOString() !== refreshedAt ||
    typeof enabled !== "boolean" ||
    typeof complete !== "boolean" ||
    typeof stale !== "boolean" ||
    (enabled && complete === stale) ||
    (!enabled && (complete || stale))
  ) {
    return UNAVAILABLE_PULL_REQUEST_DISCOVERY;
  }
  try {
    return Object.freeze({
      available: true,
      enabled,
      refreshedAt,
      complete,
      stale,
      effectiveUpdatedWindow:
        normalizeEffectivePullRequestUpdatedWindow(effective),
    });
  } catch {
    return UNAVAILABLE_PULL_REQUEST_DISCOVERY;
  }
}

export function createOperationsRuntime(options = {}, dependencies = {}) {
  const entries = plainEntries(options, OPTION_KEYS, "operations options");
  const dependencyEntries = plainEntries(
    dependencies,
    DEPENDENCY_KEYS,
    "operations dependencies",
  );
  const dataDirectory = absoluteDirectory(
    entries.get("dataDirectory"),
    "dataDirectory",
  );
  const backupDirectory = absoluteDirectory(
    entries.get("backupDirectory"),
    "backupDirectory",
  );
  const quiescenceGateFactory = factory(
    dependencyEntries,
    "quiescenceGateFactory",
    () => new OperationalQuiescenceGate(),
  );
  const checkpointServiceFactory = factory(
    dependencyEntries,
    "checkpointServiceFactory",
    (value) => new DataDirectoryCheckpointService(value),
  );
  const operationQueueFactory = factory(
    dependencyEntries,
    "operationQueueFactory",
    () => new OperationQueue(),
  );
  const backupServiceFactory = factory(
    dependencyEntries,
    "backupServiceFactory",
    (value) => new BackupService(value),
  );
  const readinessServiceFactory = factory(
    dependencyEntries,
    "readinessServiceFactory",
    (value) => new ReadinessService(value),
  );
  const trustedRestoreMigration = port(
    createProductionRestoreMigrationRegistry(),
    ["migrate"],
    "trusted restore migration registry",
  );
  const candidateMigrationExtension = entries.has("migration")
    ? port(entries.get("migration"), ["migrate"], "migration")
    : null;
  const migration = createTrustedRestoreMigration({
    trustedRegistry: trustedRestoreMigration,
    candidateExtension: candidateMigrationExtension,
  });
  const snapshotReader = entries.has("snapshotReader")
    ? port(entries.get("snapshotReader"), ["read"], "snapshotReader")
    : null;

  const gate = port(
    quiescenceGateFactory(),
    ["run", "enter", "leave", "readStatus"],
    "quiescence gate",
  );
  const checkpoint = port(
    checkpointServiceFactory({ sourceDirectory: dataDirectory, gate }),
    ["enter", "leave", "capture", "reconcile", "capacity", "recovery"],
    "checkpoint service",
  );
  const backup = port(
    backupServiceFactory({
      sourceDirectory: dataDirectory,
      backupDirectory,
      quiescence: checkpoint,
      canonicalization: checkpoint,
      reconciliation: checkpoint,
      operationQueue: port(
        operationQueueFactory(),
        ["enqueue"],
        "backup operation queue",
      ),
      migration,
    }),
    ["createBackup", "verifyBackup", "listBackups", "restore"],
    "backup service",
  );
  const readiness = port(
    readinessServiceFactory({
      probes: [
        { id: "recovery_state", kind: "recovery", check: checkpoint.recovery },
        {
          id: "external_actions",
          kind: "external_action",
          check: externalActionProbe(entries.get("externalActionStatus")),
        },
        { id: "storage_capacity", kind: "capacity", check: checkpoint.capacity },
      ],
      ...(entries.has("probeTimeoutMs")
        ? { probeTimeoutMs: entries.get("probeTimeoutMs") }
        : {}),
    }),
    ["liveness", "readiness"],
    "readiness service",
  );
  const readStatus = async () => {
    const snapshotRead = snapshotReader === null
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => snapshotReader.read("snapshot", null))
          .catch(() => null);
    const [readinessState, backupCatalog, snapshot] = await Promise.all([
      readiness.readiness(),
      backup.listBackups(),
      snapshotRead,
    ]);
    return Object.freeze({
      schemaVersion: 1,
      liveness: readiness.liveness(),
      readiness: readinessState,
      maintenance: gate.readStatus(),
      pullRequestDiscovery: pullRequestDiscoveryProjection(snapshot),
      backups: Object.freeze({
        available: true,
        items: backupCatalog.items,
        incompleteCount: backupCatalog.incompleteCount,
        unrecognizedCount: backupCatalog.unrecognizedCount,
      }),
    });
  };
  const createBackup = async () => {
    const created = await backup.createBackup();
    return backupProjection(created.manifest);
  };

  return Object.freeze({
    admission: Object.freeze({ run: gate.run }),
    maintenance: Object.freeze({ readStatus: gate.readStatus }),
    backup,
    browser: Object.freeze({ readStatus, createBackup }),
    liveness: readiness.liveness,
    readiness: readiness.readiness,
  });
}
