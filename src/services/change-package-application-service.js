import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  createChangePackageApplicationConfirmationPlan,
  normalizeChangePackageApplicationEnvelope,
} from "../domain/change-package-application-confirmation.js";
import {
  CHANGE_PACKAGE_DEFAULT_LIMITS,
  normalizeChangePackageId,
  normalizeChangePackageManifest,
} from "../domain/change-package-contract.js";
import {
  CodeExecutionPolicy,
  normalizeWorkspacePath,
  validateWorkspaceId,
} from "../domain/code-execution-policy.js";
import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import { digestValue } from "../domain/code-executor-contract.js";
import { workspaceRevisionFromFileHashes } from "../domain/workspace-revision.js";
import { OperationQueue } from "../lib/operation-queue.js";

export const CHANGE_PACKAGE_APPLICATION_STATE_KEY =
  "change-package-applications";
const STATE_KEY = CHANGE_PACKAGE_APPLICATION_STATE_KEY;
const MAX_APPLICATIONS = 1_000;
const SHA256 = /^[a-f0-9]{64}$/;
const HEAD_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const STATUSES = new Set(["intent", "applied", "unknown"]);

export class ChangePackageApplicationError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChangePackageApplicationError";
    this.code = code;
  }
}

function applicationError(code, message, cause) {
  return new ChangePackageApplicationError(code, message, { cause });
}

function exactObject(value, keys, message = "change package application 无效") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION", message);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION", message);
  }
  return value;
}

function denseArray(value, maximum, message) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION", message);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION", message);
    }
    result.push(descriptor.value);
  }
  return result;
}

function sha256(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION", `${name} 无效`);
  }
  return value;
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function validClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value.toISOString();
}

function pathComparisonKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathComparisonKey(left) === pathComparisonKey(right);
}

function contentSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptFor(envelope, createdAt) {
  return {
    id: `change-package-application-${digestValue({
      confirmationId: envelope.id,
      approvalBindingDigest: envelope.approvalBindingDigest,
    })}`,
    createdAt,
  };
}

function normalizeReceipt(value, envelope, createdAt) {
  exactObject(value, ["id", "createdAt"], "application receipt 无效");
  const expected = receiptFor(envelope, createdAt);
  if (value.id !== expected.id || value.createdAt !== expected.createdAt) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION",
      "application receipt 绑定无效",
    );
  }
  return expected;
}

function normalizeFailure(value) {
  exactObject(value, ["code", "at"], "application failure 无效");
  if (!ERROR_CODE.test(value.code) || !canonicalTimestamp(value.at)) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION",
      "application failure 无效",
    );
  }
  return { code: value.code, at: value.at };
}

function normalizeApplicationRecord(value) {
  exactObject(
    value,
    ["envelope", "status", "createdAt", "updatedAt", "receipt", "failure"],
    "application record 无效",
  );
  let envelope;
  try {
    envelope = normalizeChangePackageApplicationEnvelope(value.envelope);
  } catch (cause) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION",
      "application envelope 无效",
      cause,
    );
  }
  if (
    !STATUSES.has(value.status) ||
    !canonicalTimestamp(value.createdAt) ||
    !canonicalTimestamp(value.updatedAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt)
  ) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION",
      "application record 无效",
    );
  }
  const receipt =
    value.receipt === null
      ? null
      : normalizeReceipt(value.receipt, envelope, value.createdAt);
  const failure = value.failure === null ? null : normalizeFailure(value.failure);
  if (
    (value.status === "intent" && (receipt !== null || failure !== null)) ||
    (value.status === "applied" && (receipt === null || failure !== null)) ||
    (value.status === "unknown" && (receipt !== null || failure === null))
  ) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION",
      "application record 状态无效",
    );
  }
  return {
    envelope,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    receipt,
    failure,
  };
}

function defaultState() {
  return { schemaVersion: 1, revision: 0, applications: [] };
}

function normalizeState(value) {
  try {
    exactObject(
      value,
      ["schemaVersion", "revision", "applications"],
      "application state 无效",
    );
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    ) {
      throw applicationError(
        "INVALID_CHANGE_PACKAGE_APPLICATION",
        "application state 无效",
      );
    }
    const applications = denseArray(
      value.applications,
      MAX_APPLICATIONS,
      "application state 无效",
    ).map(normalizeApplicationRecord);
    if (
      value.revision < applications.length ||
      new Set(applications.map(({ envelope }) => envelope.id)).size !==
        applications.length
    ) {
      throw applicationError(
        "INVALID_CHANGE_PACKAGE_APPLICATION",
        "application state 无效",
      );
    }
    return { schemaVersion: 1, revision: value.revision, applications };
  } catch (cause) {
    if (cause?.code === "CHANGE_PACKAGE_APPLICATION_STATE_CORRUPTED") {
      throw cause;
    }
    throw applicationError(
      "CHANGE_PACKAGE_APPLICATION_STATE_CORRUPTED",
      "change package application 持久化状态损坏",
      cause,
    );
  }
}

export function normalizeChangePackageApplicationPersistedState(value) {
  return normalizeState(value);
}

function requirePort(value, methods, name) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  return Object.freeze(
    Object.fromEntries(methods.map((method) => [method, value[method].bind(value)])),
  );
}

function normalizePathList(value, name) {
  return denseArray(value, 1_000, `${name} 无效`).map((entry) => {
    try {
      return normalizeWorkspacePath(entry);
    } catch (cause) {
      throw applicationError("INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG", `${name} 无效`, cause);
    }
  });
}

function normalizeTarget(value) {
  exactObject(
    value,
    [
      "workspaceId",
      "sourceRoot",
      "targetAuthorityDigest",
      "writablePaths",
      "excludePaths",
    ],
    "trusted target 配置无效",
  );
  let workspaceId;
  try {
    workspaceId = validateWorkspaceId(value.workspaceId);
  } catch (cause) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
      "trusted target workspaceId 无效",
      cause,
    );
  }
  if (
    typeof value.sourceRoot !== "string" ||
    !path.isAbsolute(value.sourceRoot) ||
    value.sourceRoot.includes("\0")
  ) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
      "trusted target sourceRoot 无效",
    );
  }
  const writablePaths = normalizePathList(value.writablePaths, "writablePaths");
  if (writablePaths.length === 0) {
    throw applicationError(
      "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
      "trusted target 必须声明 writablePaths",
    );
  }
  const excludePaths = normalizePathList(value.excludePaths, "excludePaths");
  return Object.freeze({
    workspaceId,
    sourceRoot: path.resolve(value.sourceRoot),
    targetAuthorityDigest: sha256(
      value.targetAuthorityDigest,
      "targetAuthorityDigest",
    ),
    policy: new CodeExecutionPolicy({ writablePaths, excludePaths }),
  });
}

function normalizeTargets(value) {
  const targets = denseArray(
    value,
    100,
    "trustedTargets 配置无效",
  ).map(normalizeTarget);
  const ids = new Set();
  const roots = new Set();
  for (const target of targets) {
    const rootKey = pathComparisonKey(target.sourceRoot);
    if (ids.has(target.workspaceId) || roots.has(rootKey)) {
      throw applicationError(
        "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
        "trusted target 配置重复",
      );
    }
    ids.add(target.workspaceId);
    roots.add(rootKey);
  }
  return new Map(targets.map((target) => [target.workspaceId, target]));
}

function normalizeGitInspection(value) {
  exactObject(value, ["headOid", "clean"], "Git checkout inspection 无效");
  if (
    typeof value.headOid !== "string" ||
    !HEAD_OID.test(value.headOid) ||
    typeof value.clean !== "boolean"
  ) {
    throw applicationError(
      "CHANGE_PACKAGE_GIT_INSPECTION_FAILED",
      "Git checkout inspection 无效",
    );
  }
  return { headOid: value.headOid, clean: value.clean };
}

function stableCode(error, fallback) {
  try {
    return typeof error?.code === "string" && ERROR_CODE.test(error.code)
      ? error.code
      : fallback;
  } catch {
    return fallback;
  }
}

function unknown(code = "CHANGE_PACKAGE_APPLICATION_OUTCOME_UNKNOWN") {
  return { status: "error", error: { trust: "unknown", code } };
}

function findRecord(state, confirmationId) {
  return (
    state.applications.find(({ envelope }) => envelope.id === confirmationId) ??
    null
  );
}

function sameBinding(record, envelope) {
  return (
    record.envelope.approvalBindingDigest === envelope.approvalBindingDigest &&
    record.envelope.id === envelope.id
  );
}

function resultProjection(record) {
  return {
    confirmationId: record.envelope.id,
    status: record.status,
    packageId: record.envelope.action.packageId,
    workspaceId: record.envelope.action.workspace.id,
    ...(record.receipt ? { receipt: { ...record.receipt } } : {}),
    ...(record.failure ? { failure: { ...record.failure } } : {}),
  };
}

export class ChangePackageApplicationService {
  #packageReader;
  #targets;
  #gitInspector;
  #verifyApplicationAuthority;
  #store;
  #exclusiveLease;
  #operationQueue;
  #clock;
  #limits;
  #state = defaultState();
  #ready = false;

  constructor({
    packageReader,
    trustedTargets = [],
    gitInspector,
    applicationAuthorityVerifier,
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    clock = () => new Date(),
    limits = {},
  } = {}) {
    this.#packageReader = requirePort(
      packageReader,
      ["get", "readFile"],
      "packageReader",
    );
    this.#targets = normalizeTargets(trustedTargets);
    this.#gitInspector = requirePort(gitInspector, ["inspect"], "gitInspector");
    this.#verifyApplicationAuthority = requirePort(
      applicationAuthorityVerifier,
      ["verify"],
      "applicationAuthorityVerifier",
    ).verify;
    this.#store = requirePort(store, ["read", "write"], "store");
    this.#exclusiveLease = requirePort(
      exclusiveLease,
      ["run"],
      "exclusiveLease",
    );
    this.#operationQueue = requirePort(
      operationQueue,
      ["enqueue"],
      "operationQueue",
    );
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#clock = clock;
    const allowedLimits = ["maxFiles", "maxFileBytes", "maxTotalBytes"];
    if (
      limits === null ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(limits))
    ) {
      throw applicationError(
        "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
        "workspace limits 无效",
      );
    }
    const limitValues = {};
    for (const key of Reflect.ownKeys(limits)) {
      const descriptor = Object.getOwnPropertyDescriptor(limits, key);
      if (
        typeof key !== "string" ||
        !allowedLimits.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw applicationError(
          "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
          "workspace limits 无效",
        );
      }
      limitValues[key] = descriptor.value;
    }
    this.#limits = Object.freeze({
      maxFiles:
        limitValues.maxFiles ?? CHANGE_PACKAGE_DEFAULT_LIMITS.maxFiles,
      maxFileBytes:
        limitValues.maxFileBytes ?? CHANGE_PACKAGE_DEFAULT_LIMITS.maxBlobBytes,
      maxTotalBytes:
        limitValues.maxTotalBytes ??
        CHANGE_PACKAGE_DEFAULT_LIMITS.maxTotalBlobBytes,
    });
    if (
      Object.values(this.#limits).some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1,
      )
    ) {
      throw applicationError(
        "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIG",
        "workspace limits 无效",
      );
    }
  }

  producer() {
    return Object.freeze({
      prepareConfirmation: this.prepareConfirmation.bind(this),
    });
  }

  executor() {
    return Object.freeze({
      execute: this.execute.bind(this),
      reconcile: this.reconcile.bind(this),
    });
  }

  reader() {
    return Object.freeze({ getResult: this.getResult.bind(this) });
  }

  recover() {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#ready = false;
        await this.#reload();
        this.#ready = true;
        return { applications: this.#state.applications.length };
      }),
    );
  }

  prepareConfirmation(value) {
    return this.#run(async () => {
      exactObject(value, ["packageId", "requestedBy"], "prepare request 无效");
      let packageId;
      try {
        packageId = normalizeChangePackageId(value.packageId);
      } catch (cause) {
        throw applicationError(
          "INVALID_CHANGE_PACKAGE_APPLICATION",
          "packageId 无效",
          cause,
        );
      }
      const manifest = await this.#loadManifest(packageId);
      await this.#assertApplicationAuthority(manifest);
      const target = this.#target(manifest.workspace.id);
      const mutations = await this.#loadMutations(manifest, target);
      const observation = await this.#observe(target);
      if (!observation.clean) {
        throw applicationError(
          "CHANGE_PACKAGE_TARGET_DIRTY",
          "目标 checkout 存在未提交变更",
        );
      }
      if (
        this.#classify(manifest, mutations, observation, observation.headOid) !==
        "pre"
      ) {
        throw applicationError(
          "CHANGE_PACKAGE_TARGET_STALE",
          "目标 checkout 与变更包源版本不一致",
        );
      }
      this.#assertPredictedRevision(manifest, mutations, observation);
      await this.#assertPreTopology(target, mutations);
      return createChangePackageApplicationConfirmationPlan(manifest, {
        requestedBy: value.requestedBy,
        target: {
          workspaceId: target.workspaceId,
          targetAuthorityDigest: target.targetAuthorityDigest,
          expectedHeadOid: observation.headOid,
        },
      });
    });
  }

  execute(value) {
    return this.#runConfirmed(value, (envelope) => this.#execute(envelope));
  }

  reconcile(value) {
    return this.#runConfirmed(value, (envelope) => this.#reconcile(envelope));
  }

  #runConfirmed(value, operation) {
    let envelope;
    try {
      envelope = normalizeChangePackageApplicationEnvelope(value);
    } catch {
      return Promise.resolve(
        unknown("INVALID_CHANGE_PACKAGE_APPLICATION_CONFIRMATION"),
      );
    }
    return this.#run(() => operation(envelope)).catch((error) =>
      unknown(stableCode(error, "CHANGE_PACKAGE_APPLICATION_OUTCOME_UNKNOWN")),
    );
  }

  getResult(confirmationId) {
    return this.#run(async () => {
      if (typeof confirmationId !== "string" || confirmationId.length === 0) {
        throw applicationError(
          "INVALID_CHANGE_PACKAGE_APPLICATION",
          "confirmationId 无效",
        );
      }
      const record = findRecord(this.#state, confirmationId);
      if (!record) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_NOT_FOUND",
          "change package application 不存在",
        );
      }
      return resultProjection(record);
    });
  }

  #run(operation) {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#assertReady();
        await this.#reload();
        return operation();
      }),
    );
  }

  async #execute(envelope) {
    let record = findRecord(this.#state, envelope.id);
    if (record && !sameBinding(record, envelope)) {
      return unknown("CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT");
    }

    let context;
    try {
      context = await this.#verifiedBindingContext(envelope, {
        requireCurrentAuthority: true,
      });
    } catch (error) {
      if (error?.code === "CHANGE_PACKAGE_APPLICATION_STALE") {
        return { status: "stale" };
      }
      const code = stableCode(
        error,
        "CHANGE_PACKAGE_APPLICATION_CONTEXT_UNAVAILABLE",
      );
      return record ? unknown(code) : { status: "absent", code };
    }
    if (record?.status === "applied") {
      return { status: "already", receipt: { ...record.receipt } };
    }
    if (record?.status === "unknown") return unknown(record.failure.code);

    try {
      context = await this.#withMutations(context);
    } catch (error) {
      if (error?.code === "CHANGE_PACKAGE_APPLICATION_STALE") {
        return { status: "stale" };
      }
      const code = stableCode(
        error,
        "CHANGE_PACKAGE_APPLICATION_CONTEXT_UNAVAILABLE",
      );
      return record ? unknown(code) : { status: "absent", code };
    }

    let before;
    try {
      before = await this.#observe(context.target);
    } catch (error) {
      const code = stableCode(
        error,
        "CHANGE_PACKAGE_APPLICATION_CONTEXT_UNAVAILABLE",
      );
      return record ? unknown(code) : { status: "absent", code };
    }
    const beforeState = this.#classify(
      context.manifest,
      context.mutations,
      before,
      envelope.action.expectedHeadOid,
    );
    if (!record && (beforeState !== "pre" || !before.clean)) {
      return { status: "stale" };
    }
    if (beforeState === "pre") {
      try {
        this.#assertPredictedRevision(
          context.manifest,
          context.mutations,
          before,
        );
        await this.#assertPreTopology(context.target, context.mutations);
      } catch {
        if (!record) return { status: "stale" };
        return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
      }
    }
    if (record) {
      if (beforeState === "post") {
        return this.#completeApplied(record, envelope, "already");
      }
      if (beforeState !== "pre" || !before.clean) {
        return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
      }
    }

    const now = validClock(this.#clock);
    const intent = {
      envelope,
      status: "intent",
      createdAt: record?.createdAt ?? envelope.execution.startedAt,
      updatedAt: now,
      receipt: null,
      failure: null,
    };
    try {
      await this.#replace(record, intent);
      record = findRecord(this.#state, envelope.id);
    } catch {
      await this.#reloadAfterFailure();
      return {
        status: "absent",
        code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
      };
    }

    const rechecked = await this.#observe(context.target);
    const recheckedState = this.#classify(
      context.manifest,
      context.mutations,
      rechecked,
      envelope.action.expectedHeadOid,
    );
    if (recheckedState === "post") {
      return this.#completeApplied(record, envelope, "already");
    }
    if (recheckedState !== "pre" || !rechecked.clean) {
      return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
    }
    try {
      this.#assertPredictedRevision(
        context.manifest,
        context.mutations,
        rechecked,
      );
      await this.#assertPreTopology(context.target, context.mutations);
    } catch {
      return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
    }

    try {
      await this.#applyMutations(context.target, context.mutations);
    } catch {
      return this.#reconcileIntent(record, context);
    }
    const after = await this.#observe(context.target);
    const afterState = this.#classify(
      context.manifest,
      context.mutations,
      after,
      envelope.action.expectedHeadOid,
    );
    if (afterState !== "post") {
      if (afterState === "pre" && after.clean) {
        return {
          status: "absent",
          code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
        };
      }
      return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
    }
    return this.#completeApplied(record, envelope, "applied");
  }

  async #reconcile(envelope) {
    const record = findRecord(this.#state, envelope.id);
    if (!record) {
      return {
        status: "absent",
        code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
      };
    }
    if (!sameBinding(record, envelope)) {
      return unknown("CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT");
    }
    if (record.status === "applied") {
      return { status: "already", receipt: { ...record.receipt } };
    }
    if (record.status === "unknown") return unknown(record.failure.code);

    let context;
    try {
      context = await this.#verifiedContext(envelope);
    } catch (error) {
      return unknown(
        stableCode(error, "CHANGE_PACKAGE_APPLICATION_CONTEXT_UNAVAILABLE"),
      );
    }
    return this.#reconcileIntent(record, context);
  }

  async #reconcileIntent(record, context) {
    let observation;
    try {
      observation = await this.#observe(context.target);
    } catch (error) {
      return unknown(
        stableCode(error, "CHANGE_PACKAGE_APPLICATION_OUTCOME_UNKNOWN"),
      );
    }
    const state = this.#classify(
      context.manifest,
      context.mutations,
      observation,
      record.envelope.action.expectedHeadOid,
    );
    if (state === "pre" && observation.clean) {
      return {
        status: "absent",
        code: "CHANGE_PACKAGE_APPLICATION_NOT_STARTED",
      };
    }
    if (state === "post") {
      return this.#completeApplied(record, record.envelope, "already");
    }
    return this.#fence(record, "CHANGE_PACKAGE_APPLICATION_MIXED_STATE");
  }

  async #verifiedBindingContext(
    envelope,
    { requireCurrentAuthority = false } = {},
  ) {
    const manifest = await this.#loadManifest(envelope.action.packageId);
    if (requireCurrentAuthority) {
      await this.#assertApplicationAuthority(manifest);
    }
    const target = this.#target(manifest.workspace.id);
    if (target.targetAuthorityDigest !== envelope.action.targetAuthorityDigest) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "目标 checkout 授权已变化",
      );
    }
    const expectedPlan = createChangePackageApplicationConfirmationPlan(manifest, {
      requestedBy: envelope.requestedBy,
      target: {
        workspaceId: target.workspaceId,
        targetAuthorityDigest: target.targetAuthorityDigest,
        expectedHeadOid: envelope.action.expectedHeadOid,
      },
    });
    const queued = normalizeConfirmationPlan(expectedPlan);
    if (
      queued.id !== envelope.id ||
      queued.displayedPayloadDigest !== envelope.displayedPayloadDigest ||
      queued.approvalBindingDigest !== envelope.approvalBindingDigest ||
      digestValue(queued.action) !== digestValue(envelope.action)
    ) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "change package application 绑定已变化",
      );
    }
    return { manifest, target };
  }

  async #verifiedContext(envelope) {
    return this.#withMutations(await this.#verifiedBindingContext(envelope));
  }

  async #withMutations(context) {
    return {
      ...context,
      mutations: await this.#loadMutations(context.manifest, context.target),
    };
  }

  async #assertApplicationAuthority(manifest) {
    try {
      const verified = await this.#verifyApplicationAuthority(
        structuredClone(manifest),
      );
      if (verified !== true) throw new Error("source authority not confirmed");
    } catch (cause) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "变更包来源授权已失效",
        cause,
      );
    }
  }

  async #loadManifest(packageId) {
    try {
      const manifest = normalizeChangePackageManifest(
        await this.#packageReader.get(packageId),
      );
      if (manifest.packageId !== packageId) throw new Error("package id mismatch");
      if (manifest.workspace.sourceRevision === manifest.workspace.workspaceRevision) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_STALE",
          "变更包没有可应用的有效变化",
        );
      }
      return manifest;
    } catch (cause) {
      if (cause instanceof ChangePackageApplicationError) throw cause;
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE",
        "change package 无法验证",
        cause,
      );
    }
  }

  async #loadMutations(manifest, target) {
    const mutations = [];
    for (const entry of manifest.changes.deleted) {
      target.policy.assertWritable(entry.path);
      mutations.push({
        kind: "delete",
        path: entry.path,
        beforeSha256: entry.beforeSha256,
        afterSha256: null,
        content: null,
      });
    }
    for (const [kind, entries] of [
      ["modify", manifest.changes.modified],
      ["create", manifest.changes.created],
    ]) {
      for (const entry of entries) {
        target.policy.assertWritable(entry.path);
        const content = await this.#packageReader.readFile({
          packageId: manifest.packageId,
          path: entry.path,
        });
        if (!(Buffer.isBuffer(content) || content instanceof Uint8Array)) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE",
            "change package blob 无法验证",
          );
        }
        const snapshot = Buffer.from(content);
        if (
          snapshot.length !== entry.blob.bytes ||
          contentSha256(snapshot) !== entry.blob.sha256
        ) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE",
            "change package blob 无法验证",
          );
        }
        mutations.push({
          kind,
          path: entry.path,
          beforeSha256: kind === "create" ? null : entry.beforeSha256,
          afterSha256: entry.blob.sha256,
          content: snapshot,
        });
      }
    }
    return mutations;
  }

  #target(workspaceId) {
    const target = this.#targets.get(workspaceId);
    if (!target) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "没有可用的可信目标 checkout",
      );
    }
    return target;
  }

  async #observe(target) {
    const before = normalizeGitInspection(
      await this.#gitInspector.inspect({ sourceRoot: target.sourceRoot }),
    );
    const workspace = await this.#scanWorkspace(target);
    const after = normalizeGitInspection(
      await this.#gitInspector.inspect({ sourceRoot: target.sourceRoot }),
    );
    return {
      headOid: before.headOid === after.headOid ? before.headOid : null,
      clean: before.clean && after.clean,
      revision: workspaceRevisionFromFileHashes(workspace.files),
      files: workspace.files,
      sizes: workspace.sizes,
      totalBytes: workspace.totalBytes,
    };
  }

  #classify(manifest, mutations, observation, expectedHeadOid) {
    if (observation.headOid !== expectedHeadOid) return "mixed";
    const matches = (field) =>
      mutations.every((mutation) => {
        const expected = mutation[field];
        const actual = observation.files.get(mutation.path) ?? null;
        return actual === expected;
      });
    const pre =
      observation.revision === manifest.workspace.sourceRevision &&
      matches("beforeSha256");
    const post =
      observation.revision === manifest.workspace.workspaceRevision &&
      matches("afterSha256");
    if (pre && !post) return "pre";
    if (post && !pre) return "post";
    return "mixed";
  }

  #assertPredictedRevision(manifest, mutations, observation) {
    if (mutations.length === 0) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "变更包没有可应用的文件变化",
      );
    }
    const predicted = new Map(observation.files);
    const predictedSizes = new Map(observation.sizes);
    for (const mutation of mutations) {
      if (mutation.afterSha256 === null) {
        predicted.delete(mutation.path);
        predictedSizes.delete(mutation.path);
      } else {
        predicted.set(mutation.path, mutation.afterSha256);
        predictedSizes.set(mutation.path, mutation.content.length);
      }
    }
    const predictedPaths = [...predicted.keys()]
      .map((relativePath) =>
        process.platform === "win32" ? relativePath.toLowerCase() : relativePath,
      )
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (
      predictedPaths.some(
        (relativePath, index) =>
          index + 1 < predictedPaths.length &&
          (predictedPaths[index + 1] === relativePath ||
            predictedPaths[index + 1].startsWith(`${relativePath}/`)),
      )
    ) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "变更包目标文件拓扑冲突",
      );
    }
    const predictedBytes = [...predictedSizes.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    );
    if (
      predicted.size > this.#limits.maxFiles ||
      [...predictedSizes.values()].some(
        (bytes) => bytes > this.#limits.maxFileBytes,
      ) ||
      predictedBytes > this.#limits.maxTotalBytes
    ) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "应用后的 checkout 将超过限制",
      );
    }
    if (
      workspaceRevisionFromFileHashes(predicted) !==
      manifest.workspace.workspaceRevision
    ) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_STALE",
        "变更包目标 revision 与文件变化不一致",
      );
    }
  }

  async #assertPreTopology(target, mutations) {
    const deletedPaths = new Set(
      mutations
        .filter(({ kind }) => kind === "delete")
        .map(({ path: relativePath }) => relativePath),
    );
    for (const mutation of mutations) {
      if (mutation.kind !== "create") continue;
      const inspected = await this.#inspectPath(target, mutation.path, {
        allowMissing: true,
      });
      if (inspected.exists) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_STALE",
          "新文件路径已经存在",
        );
      }
      if (inspected.blockedAt !== undefined) {
        const blockedPath = mutation.path
          .split("/")
          .slice(0, inspected.blockedAt + 1)
          .join("/");
        if (!deletedPaths.has(blockedPath)) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_STALE",
            "新文件父路径与现有文件冲突",
          );
        }
      }
    }
  }

  async #scanWorkspace(target) {
    await this.#assertRoot(target);
    const files = new Map();
    const sizes = new Map();
    const totals = { files: 0, bytes: 0 };
    const visit = async (directory, relativeDirectory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const entry of entries) {
        const candidate = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        let relativePath;
        try {
          relativePath = normalizeWorkspacePath(candidate);
        } catch (cause) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
            "目标 checkout 包含不安全路径",
            cause,
          );
        }
        if (target.policy.isExcluded(relativePath)) continue;
        const absolutePath = path.join(
          target.sourceRoot,
          ...relativePath.split("/"),
        );
        const stats = await lstat(absolutePath);
        if (stats.isSymbolicLink()) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
            "目标 checkout 包含符号链接或 junction",
          );
        }
        if (stats.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (!stats.isFile() || stats.nlink > 1) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
            "目标 checkout 包含不支持的文件类型",
          );
        }
        totals.files += 1;
        if (
          totals.files > this.#limits.maxFiles ||
          stats.size > this.#limits.maxFileBytes
        ) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_LIMIT_EXCEEDED",
            "目标 checkout 超过扫描限制",
          );
        }
        const content = await this.#readStableFile(absolutePath, stats);
        totals.bytes += content.length;
        if (totals.bytes > this.#limits.maxTotalBytes) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_LIMIT_EXCEEDED",
            "目标 checkout 超过扫描限制",
          );
        }
        files.set(relativePath, contentSha256(content));
        sizes.set(relativePath, content.length);
      }
    };
    await visit(target.sourceRoot, "");
    await this.#assertRoot(target);
    return { files, sizes, totalBytes: totals.bytes };
  }

  async #assertRoot(target) {
    const stats = await lstat(target.sourceRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_UNSAFE_ROOT",
        "目标 checkout 根目录不安全",
      );
    }
    const resolved = await realpath(target.sourceRoot);
    if (!samePath(resolved, target.sourceRoot)) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_UNSAFE_ROOT",
        "目标 checkout 根目录身份已变化",
      );
    }
  }

  async #readStableFile(absolutePath, expectedStats = null) {
    const handle = await open(absolutePath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink > 1) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
          "目标文件不是独占普通文件",
        );
      }
      if (
        before.size > this.#limits.maxFileBytes ||
        (expectedStats && !this.#sameFileIdentity(expectedStats, before))
      ) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
          "目标文件读取期间已变化",
        );
      }
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== before.size) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
          "目标文件读取期间已变化",
        );
      }
      const content = Buffer.from(buffer.subarray(0, offset));
      const after = await handle.stat();
      if (
        content.length !== before.size ||
        !this.#sameFileIdentity(before, after)
      ) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
          "目标文件读取期间已变化",
        );
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  #sameFileIdentity(left, right) {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.nlink === right.nlink
    );
  }

  async #applyMutations(target, mutations) {
    const deletions = mutations
      .filter(({ kind }) => kind === "delete")
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
    const writes = mutations.filter(({ kind }) => kind !== "delete");
    for (const mutation of deletions) await this.#deleteFile(target, mutation);
    for (const mutation of writes) {
      if (mutation.beforeSha256 === mutation.afterSha256) continue;
      await this.#writeFile(target, mutation);
    }
  }

  async #deleteFile(target, mutation) {
    const inspected = await this.#inspectPath(target, mutation.path);
    if (!inspected.exists || !inspected.stats.isFile() || inspected.stats.nlink > 1) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
        "待删除文件已变化",
      );
    }
    const content = await this.#readStableFile(
      inspected.absolutePath,
      inspected.stats,
    );
    if (contentSha256(content) !== mutation.beforeSha256) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
        "待删除文件已变化",
      );
    }
    await unlink(inspected.absolutePath);
  }

  async #writeFile(target, mutation) {
    await this.#assertMutationVersion(target, mutation);
    await this.#ensureParents(target, mutation.path);
    await this.#assertMutationVersion(target, mutation);
    const absolutePath = path.join(
      target.sourceRoot,
      ...mutation.path.split("/"),
    );
    const temporary = path.join(
      path.dirname(absolutePath),
      `.change-package-apply-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(mutation.content);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, absolutePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const verified = await this.#inspectPath(target, mutation.path);
    const content = await this.#readStableFile(
      verified.absolutePath,
      verified.stats,
    );
    if (contentSha256(content) !== mutation.afterSha256) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_WRITE_FAILED",
        "写入后的文件摘要不匹配",
      );
    }
  }

  async #assertMutationVersion(target, mutation) {
    const inspected = await this.#inspectPath(target, mutation.path, {
      allowMissing: true,
    });
    if (!inspected.exists) {
      if (mutation.beforeSha256 !== null) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
          "待写入文件已变化",
        );
      }
      return;
    }
    if (
      mutation.beforeSha256 === null ||
      !inspected.stats.isFile() ||
      inspected.stats.nlink > 1
    ) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
        "待写入文件已变化",
      );
    }
    const content = await this.#readStableFile(
      inspected.absolutePath,
      inspected.stats,
    );
    if (contentSha256(content) !== mutation.beforeSha256) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
        "待写入文件已变化",
      );
    }
  }

  async #inspectPath(target, relativePath, { allowMissing = false } = {}) {
    target.policy.assertWritable(relativePath);
    await this.#assertRoot(target);
    let current = target.sourceRoot;
    let stats = await lstat(current);
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try {
        stats = await lstat(current);
      } catch (error) {
        if (allowMissing && error?.code === "ENOENT") {
          return { exists: false, absolutePath: current, missingAt: index };
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
          "目标路径包含符号链接或 junction",
        );
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        if (allowMissing) {
          return { exists: false, absolutePath: current, blockedAt: index };
        }
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
          "目标父路径不是目录",
        );
      }
    }
    return { exists: true, absolutePath: current, stats };
  }

  async #ensureParents(target, relativePath) {
    const segments = relativePath.split("/").slice(0, -1);
    let current = target.sourceRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw applicationError(
            "CHANGE_PACKAGE_APPLICATION_UNSAFE_PATH",
            "目标父路径不安全",
          );
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
  }

  async #markApplied(record, envelope) {
    const applied = {
      envelope,
      status: "applied",
      createdAt: record.createdAt,
      updatedAt: validClock(this.#clock),
      receipt: receiptFor(envelope, record.createdAt),
      failure: null,
    };
    try {
      await this.#replace(record, applied);
      return findRecord(this.#state, envelope.id);
    } catch {
      await this.#reloadAfterFailure();
      const recovered = findRecord(this.#state, envelope.id);
      return recovered?.status === "applied" && sameBinding(recovered, envelope)
        ? recovered
        : null;
    }
  }

  async #completeApplied(record, envelope, status) {
    const applied = await this.#markApplied(record, envelope);
    return applied
      ? { status, receipt: { ...applied.receipt } }
      : unknown();
  }

  async #fence(record, code) {
    const failureCode = ERROR_CODE.test(code)
      ? code
      : "CHANGE_PACKAGE_APPLICATION_OUTCOME_UNKNOWN";
    const at = validClock(this.#clock);
    const unknownRecord = {
      ...record,
      status: "unknown",
      updatedAt: at,
      receipt: null,
      failure: { code: failureCode, at },
    };
    try {
      await this.#replace(record, unknownRecord);
    } catch {
      await this.#reloadAfterFailure();
    }
    return unknown(failureCode);
  }

  async #replace(previous, replacement) {
    let applications;
    if (previous === null) {
      if (this.#state.applications.length >= MAX_APPLICATIONS) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_CAPACITY",
          "change package application 已达到容量上限",
        );
      }
      applications = [...this.#state.applications, replacement];
    } else {
      const index = this.#state.applications.findIndex(
        ({ envelope }) => envelope.id === previous.envelope.id,
      );
      if (index < 0) {
        throw applicationError(
          "CHANGE_PACKAGE_APPLICATION_STATE_CORRUPTED",
          "application record 丢失",
        );
      }
      applications = [...this.#state.applications];
      applications[index] = replacement;
    }
    const state = normalizeState({
      schemaVersion: 1,
      revision: this.#state.revision + 1,
      applications,
    });
    await this.#store.write(STATE_KEY, state);
    this.#state = state;
  }

  async #reloadAfterFailure() {
    try {
      await this.#reload();
    } catch {
      this.#ready = false;
    }
  }

  async #reload() {
    this.#state = normalizeState(
      await this.#store.read(STATE_KEY, defaultState()),
    );
  }

  #assertReady() {
    if (!this.#ready) {
      throw applicationError(
        "CHANGE_PACKAGE_APPLICATION_NOT_READY",
        "change package application 尚未完成恢复",
      );
    }
  }
}
