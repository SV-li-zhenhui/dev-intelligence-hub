import { createHash } from "node:crypto";
import {
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

const ACTION_KEYS = Object.freeze({
  list_files: ["type", "actionId", "expectedWorkspaceRevision", "path"],
  read_text: ["type", "actionId", "expectedWorkspaceRevision", "path"],
  search_text: [
    "type",
    "actionId",
    "expectedWorkspaceRevision",
    "path",
    "query",
  ],
  write_text: [
    "type",
    "actionId",
    "expectedWorkspaceRevision",
    "path",
    "content",
    "expectedSha256",
  ],
  run_profile: [
    "type",
    "actionId",
    "expectedWorkspaceRevision",
    "profileId",
  ],
  complete: ["type", "actionId", "expectedWorkspaceRevision"],
});

export class ControlledCodeExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlledCodeExecutorError";
    this.code = code;
  }
}

function invalidRequest(message = "代码执行请求无效") {
  return new ControlledCodeExecutorError(
    "INVALID_EXECUTION_REQUEST",
    message,
  );
}

function normalize(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ControlledCodeExecutorError) throw error;
    throw invalidRequest();
  }
}

function ownDataKeys(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidRequest();
  }

  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") throw invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidRequest();
    }
  }
  return keys;
}

function assertExactKeys(value, expectedKeys) {
  const actualKeys = ownDataKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw invalidRequest();
  }
  return value;
}

function assertOptionalKeys(value, allowedKeys) {
  const actualKeys = ownDataKeys(value);
  if (actualKeys.some((key) => !allowedKeys.includes(key))) {
    throw invalidRequest();
  }
  return value;
}

function assertSafeId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function assertSha256(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function assertString(value) {
  if (typeof value !== "string") throw invalidRequest();
  return value;
}

function assertWorkItemId(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw invalidRequest();
  }
  return value;
}

function normalizeRequestedBy(value) {
  assertExactKeys(value, ["roleId", "workItemId"]);
  if (typeof value.roleId !== "string" || !SAFE_ROLE_ID.test(value.roleId)) {
    throw invalidRequest();
  }
  return {
    roleId: value.roleId,
    workItemId: assertWorkItemId(value.workItemId),
  };
}

function normalizeInputBinding(value) {
  if (value === null) return null;
  let binding;
  try {
    binding = normalizePullRequestExecutionBinding(
      value,
      invalidRequest(),
    );
  } catch {
    throw invalidRequest();
  }
  if (!GIT_OID.test(binding.headRefOid)) throw invalidRequest();
  return binding;
}

function normalizeExecutionSource(value, inputBinding) {
  let source;
  try {
    source = normalizeCodeExecutionSource(value, invalidRequest());
  } catch {
    throw invalidRequest();
  }
  if (
    inputBinding === null ||
    !sameCodeExecutionSource(source, { ...source, inputBinding })
  ) {
    throw invalidRequest();
  }
  return source;
}

export function normalizeStartRequest(value) {
  return normalize(() => {
    const hasExecutionSource = Object.hasOwn(value ?? {}, "executionSource");
    assertExactKeys(value, [
      "sessionId",
      "workspaceId",
      "requestedBy",
      "inputBinding",
      ...(hasExecutionSource ? ["executionSource"] : []),
    ]);
    const inputBinding = normalizeInputBinding(value.inputBinding);
    return {
      sessionId: assertSafeId(value.sessionId),
      workspaceId: assertSafeId(value.workspaceId),
      requestedBy: normalizeRequestedBy(value.requestedBy),
      inputBinding,
      ...(hasExecutionSource
        ? {
            executionSource: normalizeExecutionSource(
              value.executionSource,
              inputBinding,
            ),
          }
        : {}),
    };
  });
}

function assertActionObject(value) {
  const actualKeys = ownDataKeys(value);
  if (!actualKeys.includes("type")) throw invalidRequest();

  const type = value.type;
  if (typeof type !== "string" || !Object.hasOwn(ACTION_KEYS, type)) {
    throw invalidRequest();
  }
  assertExactKeys(value, ACTION_KEYS[type]);
  return type;
}

function normalizeAction(value) {
  const type = assertActionObject(value);
  const common = {
    type,
    actionId: assertSafeId(value.actionId),
    expectedWorkspaceRevision: assertSha256(value.expectedWorkspaceRevision),
  };

  switch (type) {
    case "list_files":
    case "read_text":
      return { ...common, path: assertString(value.path) };
    case "search_text":
      return {
        ...common,
        path: assertString(value.path),
        query: assertString(value.query),
      };
    case "write_text":
      return {
        ...common,
        path: assertString(value.path),
        content: assertString(value.content),
        expectedSha256:
          value.expectedSha256 === null
            ? null
            : assertSha256(value.expectedSha256),
      };
    case "run_profile":
      return { ...common, profileId: assertSafeId(value.profileId) };
    case "complete":
      return common;
  }
}

export function normalizeActionRequest(value) {
  return normalize(() => {
    assertExactKeys(value, ["sessionId", "action"]);
    return {
      sessionId: assertSafeId(value.sessionId),
      action: normalizeAction(value.action),
    };
  });
}

function isAbortSignalLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

export function normalizeRuntimeOptions(value = {}) {
  return normalize(() => {
    assertOptionalKeys(value, ["signal"]);
    if (!Object.hasOwn(value, "signal")) return { signal: null };
    if (value.signal !== null && !isAbortSignalLike(value.signal)) {
      throw invalidRequest();
    }
    return { signal: value.signal };
  });
}

export function normalizeResumeRequest(value) {
  return normalize(() => {
    const hasExecutionSource = Object.hasOwn(value ?? {}, "executionSource");
    assertExactKeys(value, [
      "sessionId",
      "inputBinding",
      ...(hasExecutionSource ? ["executionSource"] : []),
    ]);
    const inputBinding = normalizeInputBinding(value.inputBinding);
    return {
      sessionId: assertSafeId(value.sessionId),
      inputBinding,
      ...(hasExecutionSource
        ? {
            executionSource: normalizeExecutionSource(
              value.executionSource,
              inputBinding,
            ),
          }
        : {}),
    };
  });
}

function canonicalJsonValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidRequest();
    return value;
  }
  if (Array.isArray(value)) return canonicalJsonArray(value, ancestors);
  if (typeof value === "object") return canonicalJsonObject(value, ancestors);
  throw invalidRequest();
}

function canonicalJsonArray(value, ancestors) {
  if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) {
    throw invalidRequest();
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) =>
    String(index),
  );
  if (
    ownKeys.length !== expectedKeys.length + 1 ||
    !ownKeys.includes("length") ||
    expectedKeys.some((key) => !ownKeys.includes(key))
  ) {
    throw invalidRequest();
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidRequest();
    }
  }

  ancestors.add(value);
  try {
    return expectedKeys.map((key) => canonicalJsonValue(value[key], ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJsonObject(value, ancestors) {
  const keys = ownDataKeys(value).sort();
  if (ancestors.has(value)) throw invalidRequest();

  ancestors.add(value);
  try {
    const normalized = Object.create(null);
    for (const key of keys) {
      normalized[key] = canonicalJsonValue(value[key], ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function digestValue(value) {
  return normalize(() => {
    const serialized = JSON.stringify(canonicalJsonValue(value, new Set()));
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  });
}
