import { types as utilTypes } from "node:util";

import { OperationQueue } from "./lib/operation-queue.js";
import { BackupService } from "./services/backup-service.js";
import { DataDirectoryCheckpointService } from "./services/data-directory-checkpoint-service.js";
import { OfflineRestoreActivationService } from "./services/offline-restore-activation-service.js";
import { OperationalQuiescenceGate } from "./services/operational-quiescence-gate.js";
import {
  createProductionRestoreMigrationRegistry,
} from "./services/production-restore-migration-registry.js";
import {
  createTrustedRestoreMigration,
} from "./services/trusted-restore-migration.js";

const OPTION_KEYS = new Set([
  "activeDirectory",
  "backupDirectory",
  "controlDirectory",
  "migration",
  "writerLease",
]);
const DEPENDENCY_KEYS = new Set([
  "activationServiceFactory",
  "backupServiceFactory",
  "checkpointServiceFactory",
  "operationQueueFactory",
  "quiescenceGateFactory",
]);

function plainEntries(value, allowed, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} must be a plain data record`);
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
      throw new TypeError(`${name} must be a plain data record`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function factory(entries, name, fallback) {
  const value = entries.has(name) ? entries.get(name) : fallback;
  if (typeof value !== "function" || utilTypes.isProxy(value)) {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
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

export function createOfflineRestoreRuntime(options = {}, dependencies = {}) {
  const entries = plainEntries(options, OPTION_KEYS, "offline restore options");
  const dependencyEntries = plainEntries(
    dependencies,
    DEPENDENCY_KEYS,
    "offline restore dependencies",
  );
  for (const name of ["activeDirectory", "backupDirectory", "controlDirectory"]) {
    if (!entries.has(name)) throw new TypeError(`${name} is required`);
  }
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
  const activationServiceFactory = factory(
    dependencyEntries,
    "activationServiceFactory",
    (value) => new OfflineRestoreActivationService(value),
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

  const gate = port(
    quiescenceGateFactory(),
    ["run", "enter", "leave", "readStatus"],
    "offline quiescence gate",
  );
  const checkpoint = port(
    checkpointServiceFactory({
      sourceDirectory: entries.get("activeDirectory"),
      gate,
    }),
    ["enter", "leave", "capture", "reconcile"],
    "offline checkpoint service",
  );
  const backup = port(
    backupServiceFactory({
      sourceDirectory: entries.get("activeDirectory"),
      backupDirectory: entries.get("backupDirectory"),
      quiescence: checkpoint,
      canonicalization: checkpoint,
      reconciliation: checkpoint,
      operationQueue: port(
        operationQueueFactory(),
        ["enqueue"],
        "offline backup operation queue",
      ),
      migration,
    }),
    ["restore", "listBackups"],
    "offline backup service",
  );
  const activation = port(
    activationServiceFactory({
      activeDirectory: entries.get("activeDirectory"),
      backupDirectory: entries.get("backupDirectory"),
      controlDirectory: entries.get("controlDirectory"),
      backupService: backup,
      operationQueue: port(
        operationQueueFactory(),
        ["enqueue"],
        "offline activation operation queue",
      ),
      ...(entries.has("writerLease")
        ? {
            writerLease: port(
              entries.get("writerLease"),
              ["assertHeld"],
              "offline writer lease",
            ),
          }
        : {}),
    }),
    ["recover", "activate"],
    "offline activation service",
  );

  const recover = () => activation.recover();
  const activate = async (request) => {
    await activation.recover();
    return activation.activate(request);
  };
  return Object.freeze({
    recover,
    activate,
    listBackups: backup.listBackups,
  });
}
