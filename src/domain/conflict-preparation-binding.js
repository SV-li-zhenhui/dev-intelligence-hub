import { types as utilTypes } from "node:util";

import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "./git-tool-contract.js";
import { CodeExecutionPolicy } from "./code-execution-policy.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_CONFLICTS = 32;
const CONFLICT_PATH_POLICY = new CodeExecutionPolicy();
const BINDING_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "preparationId",
  "gitTarget",
  "status",
  "mergeBaseOid",
  "resultTreeOid",
  "conflicts",
  "boundaryDigest",
  "evidenceDigest",
  "resultObjectDigest",
  "materialization",
]);
const PREPARATION_KEYS = Object.freeze([
  "schemaVersion",
  "preparationId",
  "status",
  "baseCommitOid",
  "headCommitOid",
  "mergeBaseOid",
  "resultTreeOid",
  "conflicts",
  "boundaryDigest",
  "evidenceDigest",
  "resultObjectDigest",
  "materialization",
]);

export class ConflictPreparationBindingError extends Error {
  constructor(message = "Conflict preparation binding 无效", options) {
    super(message, options);
    this.name = "ConflictPreparationBindingError";
    this.code = "INVALID_CONFLICT_PREPARATION_BINDING";
  }
}

function invalid(message, cause) {
  return new ConflictPreparationBindingError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const result = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    result.push([key, descriptor.value]);
  }
  return result;
}

function exact(value, keys, error) {
  const entries = dataEntries(value, error);
  const fields = new Map(entries);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

function denseArray(value, error) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > MAX_CONFLICTS ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function sha256(value, error) {
  if (typeof value !== "string" || !SHA256.test(value)) throw error;
  return value;
}

function oid(value, length, error) {
  if (
    typeof value !== "string" ||
    !GIT_OID.test(value) ||
    value.length !== length
  ) {
    throw error;
  }
  return value;
}

function normalizeConflicts(value, error) {
  const conflicts = denseArray(value, error).map((entry) => {
    const fields = exact(entry, ["path", "mode"], error);
    let conflictPath;
    try {
      conflictPath = CONFLICT_PATH_POLICY.assertAccessible(fields.get("path"));
    } catch {
      throw error;
    }
    if (
      conflictPath !== fields.get("path") ||
      fields.get("mode") !== "100644"
    ) {
      throw error;
    }
    return { path: conflictPath, mode: "100644" };
  });
  let previousPath = null;
  const portablePaths = new Set();
  for (const conflict of conflicts) {
    const portablePath = conflict.path.toLowerCase();
    if (
      (previousPath !== null &&
        previousPath.localeCompare(conflict.path, "en") >= 0) ||
      portablePaths.has(portablePath)
    ) {
      throw error;
    }
    previousPath = conflict.path;
    portablePaths.add(portablePath);
  }
  return conflicts;
}

function normalizeBinding(value, error) {
  const fields = exact(value, BINDING_KEYS, error);
  if (
    fields.get("schemaVersion") !== 1 ||
    fields.get("kind") !== "controlled_git_conflict" ||
    fields.get("status") !== "conflicted" ||
    fields.get("materialization") !== "full-tree"
  ) {
    throw error;
  }
  let gitTarget;
  try {
    gitTarget = normalizePullRequestGitTarget(fields.get("gitTarget"));
  } catch (cause) {
    throw invalid("Conflict preparation Git target 无效", cause);
  }
  const oidLength = gitTarget.headRefOid.length;
  return {
    schemaVersion: 1,
    kind: "controlled_git_conflict",
    preparationId: sha256(fields.get("preparationId"), error),
    gitTarget: { ...gitTarget },
    status: "conflicted",
    mergeBaseOid: oid(fields.get("mergeBaseOid"), oidLength, error),
    resultTreeOid: oid(fields.get("resultTreeOid"), oidLength, error),
    conflicts: normalizeConflicts(fields.get("conflicts"), error),
    boundaryDigest: sha256(fields.get("boundaryDigest"), error),
    evidenceDigest: sha256(fields.get("evidenceDigest"), error),
    resultObjectDigest: sha256(fields.get("resultObjectDigest"), error),
    materialization: "full-tree",
  };
}

export function normalizeConflictPreparationBinding(value, error = invalid()) {
  try {
    return normalizeBinding(value, error);
  } catch (cause) {
    if (cause === error || cause instanceof ConflictPreparationBindingError) {
      throw cause;
    }
    throw invalid(undefined, cause);
  }
}

export function createConflictPreparationBinding(value) {
  const error = invalid();
  const input = exact(value, ["preparation", "gitTarget"], error);
  let gitTarget;
  try {
    gitTarget = normalizePullRequestGitTarget(input.get("gitTarget"));
  } catch (cause) {
    throw invalid("Conflict preparation Git target 无效", cause);
  }
  const preparation = exact(
    input.get("preparation"),
    PREPARATION_KEYS,
    error,
  );
  if (
    preparation.get("schemaVersion") !== 1 ||
    preparation.get("status") !== "conflicted" ||
    preparation.get("baseCommitOid") !== gitTarget.baseRefOid ||
    preparation.get("headCommitOid") !== gitTarget.headRefOid ||
    preparation.get("materialization") !== "full-tree"
  ) {
    throw error;
  }
  return normalizeConflictPreparationBinding(
    {
      schemaVersion: 1,
      kind: "controlled_git_conflict",
      preparationId: preparation.get("preparationId"),
      gitTarget,
      status: "conflicted",
      mergeBaseOid: preparation.get("mergeBaseOid"),
      resultTreeOid: preparation.get("resultTreeOid"),
      conflicts: preparation.get("conflicts"),
      boundaryDigest: preparation.get("boundaryDigest"),
      evidenceDigest: preparation.get("evidenceDigest"),
      resultObjectDigest: preparation.get("resultObjectDigest"),
      materialization: "full-tree",
    },
    error,
  );
}

export function sameConflictPreparationBinding(left, right) {
  try {
    const normalizedLeft = normalizeConflictPreparationBinding(left);
    const normalizedRight = normalizeConflictPreparationBinding(right);
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  } catch {
    return false;
  }
}

export function conflictPreparationBindingMatchesPullRequest(
  preparationBinding,
  pullRequestBinding,
) {
  try {
    const preparation = normalizeConflictPreparationBinding(
      preparationBinding,
    );
    const pullRequest = normalizePullRequestExecutionBinding(
      pullRequestBinding,
    );
    return (
      pullRequest.schemaVersion === 2 &&
      samePullRequestGitTarget(preparation.gitTarget, pullRequest.gitTarget)
    );
  } catch {
    return false;
  }
}

export function conflictPreparationWritablePaths(value) {
  return normalizeConflictPreparationBinding(value).conflicts.map(
    ({ path: conflictPath }) => conflictPath,
  );
}
