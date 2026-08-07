import { types as utilTypes } from "node:util";

import {
  conflictPreparationBindingMatchesPullRequest,
  conflictPreparationWritablePaths,
  normalizeConflictPreparationBinding,
} from "./conflict-preparation-binding.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

const SOURCE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "inputBinding",
  "preparationBinding",
  "writeScope",
]);
const WRITE_SCOPE_KEYS = Object.freeze(["mode", "paths"]);
const MAX_EXECUTION_PATH_BYTES = 512;
const MAX_EXECUTION_SEGMENT_BYTES = 255;
const CONTROL_CHARACTER = /\p{Cc}/u;

export class CodeExecutionSourceError extends Error {
  constructor(message = "代码执行来源无效", cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodeExecutionSourceError";
    this.code = "INVALID_CODE_EXECUTION_SOURCE";
  }
}

function invalid(message, cause) {
  return new CodeExecutionSourceError(message, cause);
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
  if (
    entries.length !== keys.length ||
    keys.some((key) => !entries.some(([actual]) => actual === key))
  ) {
    throw error;
  }
  return new Map(entries);
}

function exactStringArray(value, expected, error) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expected.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (!/^\d+$/u.test(String(key)) || Number(key) >= value.length)
    )
  ) {
    throw error;
  }
  return expected.map((expectedPath, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      descriptor.value !== expectedPath
    ) {
      throw error;
    }
    return expectedPath;
  });
}

function normalize(value, error) {
  const source = exact(value, SOURCE_KEYS, error);
  if (
    source.get("schemaVersion") !== 1 ||
    source.get("kind") !== "conflict_preparation"
  ) {
    throw error;
  }

  const inputBinding = normalizePullRequestExecutionBinding(
    source.get("inputBinding"),
    error,
  );
  if (inputBinding.schemaVersion !== 2) throw error;
  const preparationBinding = normalizeConflictPreparationBinding(
    source.get("preparationBinding"),
    error,
  );
  if (
    !conflictPreparationBindingMatchesPullRequest(
      preparationBinding,
      inputBinding,
    )
  ) {
    throw error;
  }

  const expectedPaths = conflictPreparationWritablePaths(preparationBinding);
  if (
    expectedPaths.some(
      (relativePath) =>
        Buffer.byteLength(relativePath, "utf8") > MAX_EXECUTION_PATH_BYTES ||
        CONTROL_CHARACTER.test(relativePath) ||
        relativePath.split("/").some(
          (segment) =>
            Buffer.byteLength(segment, "utf8") > MAX_EXECUTION_SEGMENT_BYTES,
        ),
    )
  ) {
    throw error;
  }
  const writeScope = exact(
    source.get("writeScope"),
    WRITE_SCOPE_KEYS,
    error,
  );
  if (writeScope.get("mode") !== "exact_files") throw error;
  const paths = exactStringArray(
    writeScope.get("paths"),
    expectedPaths,
    error,
  );

  return {
    schemaVersion: 1,
    kind: "conflict_preparation",
    inputBinding,
    preparationBinding,
    writeScope: { mode: "exact_files", paths },
  };
}

export function normalizeCodeExecutionSource(
  value,
  error = invalid(),
) {
  try {
    return normalize(value, error);
  } catch (cause) {
    if (cause === error) throw error;
    throw error;
  }
}

export function createConflictCodeExecutionSource(value) {
  const error = invalid();
  let entries;
  try {
    entries = exact(value, ["inputBinding", "preparationBinding"], error);
  } catch (cause) {
    if (cause === error) throw error;
    throw invalid(undefined, cause);
  }
  let preparationBinding;
  try {
    preparationBinding = normalizeConflictPreparationBinding(
      entries.get("preparationBinding"),
      error,
    );
  } catch {
    throw error;
  }
  return normalizeCodeExecutionSource(
    {
      schemaVersion: 1,
      kind: "conflict_preparation",
      inputBinding: entries.get("inputBinding"),
      preparationBinding,
      writeScope: {
        mode: "exact_files",
        paths: conflictPreparationWritablePaths(preparationBinding),
      },
    },
    error,
  );
}

export function sameCodeExecutionSource(left, right) {
  try {
    return JSON.stringify(normalizeCodeExecutionSource(left)) ===
      JSON.stringify(normalizeCodeExecutionSource(right));
  } catch {
    return false;
  }
}

export function codeExecutionSourceWritablePaths(value) {
  return [...normalizeCodeExecutionSource(value).writeScope.paths];
}
