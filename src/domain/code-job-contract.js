import { digestValue } from "./code-executor-contract.js";
import { normalizeWorkspacePath } from "./code-execution-policy.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const SAFE_CONFIRMATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ACTION = /^[a-z](?:[a-z_]{0,62}[a-z])?$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const CONTROL_CHARACTER = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CODE_OPERATIONS = new Set(["inspect", "modify", "verify"]);
const JOB_STATUSES = new Set(["queued"]);

export const CODE_JOB_ACTIONS_BY_OPERATION = Object.freeze({
  inspect: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "run_profile",
    "complete",
  ]),
  modify: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "write_text",
    "run_profile",
    "complete",
  ]),
  verify: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "run_profile",
    "complete",
  ]),
});

export class CodeJobError extends Error {
  constructor(code, message, statusCode = 400, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodeJobError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function codeJobError(code, message, statusCode = 400, options) {
  return new CodeJobError(code, message, statusCode, options);
}

function invalidGrant(message = "代码任务授权无效") {
  return codeJobError("INVALID_CODE_JOB_GRANT", message);
}

function invalidApproval(message = "代码任务批准绑定无效", options) {
  return codeJobError("INVALID_CODE_JOB_APPROVAL", message, 400, options);
}

function invalidJob(message = "代码任务记录无效") {
  return codeJobError("INVALID_CODE_JOB", message);
}

function plainDataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactObject(value, expectedKeys, error) {
  const entries = plainDataEntries(value, error);
  if (
    entries.length !== expectedKeys.length ||
    expectedKeys.some((key) => !entries.some(([actual]) => actual === key))
  ) {
    throw error;
  }
  return new Map(entries);
}

function denseArray(value, maximumLength, error, minimumLength = 0) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimumLength ||
    value.length > maximumLength ||
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

function text(
  value,
  name,
  { minimumBytes = 1, maximumBytes = 256, pattern = null, error } = {},
) {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) throw error;
  const size = Buffer.byteLength(value, "utf8");
  if (
    size < minimumBytes ||
    size > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

function safeInteger(value, name, { minimum = 0, maximum, error }) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw error;
  }
  return value;
}

function sha256(value, name, error) {
  return text(value, name, {
    maximumBytes: 64,
    pattern: SHA256,
    error,
  });
}

function safeId(value, name, error) {
  return text(value, name, {
    maximumBytes: 64,
    pattern: SAFE_ID,
    error,
  });
}

function safeReference(value, name, maximumBytes, error) {
  return text(value, name, {
    maximumBytes,
    pattern: SAFE_REFERENCE,
    error,
  });
}

function normalizedRepository(value, error) {
  const repository = text(value, "repository", {
    maximumBytes: 140,
    pattern: REPOSITORY,
    error,
  });
  const [, owner, name] = repository.match(REPOSITORY);
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw error;
  }
  return repository;
}

function normalizeRequestedBy(value, error) {
  const entries = exactObject(value, ["roleId", "workItemId"], error);
  return {
    roleId: text(entries.get("roleId"), "requestedBy.roleId", {
      maximumBytes: 128,
      pattern: SAFE_ROLE_ID,
      error,
    }),
    workItemId: text(entries.get("workItemId"), "requestedBy.workItemId", {
      maximumBytes: 256,
      error,
    }),
  };
}

function normalizeSource(value, error) {
  const entries = exactObject(value, ["assignmentId", "eventId"], error);
  return {
    assignmentId: text(entries.get("assignmentId"), "source.assignmentId", {
      maximumBytes: 256,
      error,
    }),
    eventId: text(entries.get("eventId"), "source.eventId", {
      maximumBytes: 256,
      error,
    }),
  };
}

function normalizeSubject(value, error) {
  const entries = exactObject(value, ["id", "repository", "number"], error);
  return {
    id: text(entries.get("id"), "subject.id", {
      maximumBytes: 512,
      error,
    }),
    repository: normalizedRepository(entries.get("repository"), error),
    number: safeInteger(entries.get("number"), "subject.number", {
      minimum: 1,
      error,
    }),
  };
}

function normalizeStringList(
  value,
  name,
  { maximumLength, minimumLength = 0, maximumBytes, error },
) {
  return denseArray(value, maximumLength, error, minimumLength).map((entry) =>
    text(entry, name, { maximumBytes, error }),
  );
}

function normalizeAllowedActions(value, operation, error) {
  const expected = CODE_JOB_ACTIONS_BY_OPERATION[operation];
  const actual = denseArray(value, expected.length, error, expected.length).map(
    (entry) =>
      text(entry, "allowedActions", {
        maximumBytes: 64,
        pattern: SAFE_ACTION,
        error,
      }),
  );
  if (
    new Set(actual).size !== actual.length ||
    expected.some((action) => !actual.includes(action))
  ) {
    throw error;
  }
  return [...expected];
}

function normalizeRequiredProfiles(value, error) {
  const profiles = denseArray(value, 32, error, 1).map((entry) => {
    const fields = exactObject(entry, ["id", "configDigest"], error);
    return {
      id: safeId(fields.get("id"), "requiredProfiles.id", error),
      configDigest: sha256(
        fields.get("configDigest"),
        "requiredProfiles.configDigest",
        error,
      ),
    };
  });
  profiles.sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw error;
  return profiles;
}

function normalizeWritablePaths(value, operation, error) {
  const paths = denseArray(value, 64, error).map((entry) => {
    try {
      return normalizeWorkspacePath(entry);
    } catch {
      throw error;
    }
  });
  paths.sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(paths).size !== paths.length) throw error;
  if (operation === "modify" ? paths.length === 0 : paths.length !== 0) {
    throw error;
  }
  return paths;
}

const GRANT_KEYS = Object.freeze([
  "proposalId",
  "contentDigest",
  "policyVersion",
  "requestedBy",
  "source",
  "subject",
  "repository",
  "workspaceId",
  "workspaceAuthorityDigest",
  "operation",
  "objective",
  "acceptanceCriteria",
  "evidence",
  "summary",
  "reason",
  "allowedActions",
  "writablePaths",
  "requiredProfiles",
  "brainDigest",
]);

function normalizeGrantContent(value, error) {
  const entries = exactObject(value, GRANT_KEYS, error);
  const operation = entries.get("operation");
  if (!CODE_OPERATIONS.has(operation)) throw error;
  const repository = normalizedRepository(entries.get("repository"), error);
  const subject = normalizeSubject(entries.get("subject"), error);
  if (subject.repository !== repository) throw error;
  return {
    proposalId: safeReference(
      entries.get("proposalId"),
      "proposalId",
      192,
      error,
    ),
    contentDigest: sha256(entries.get("contentDigest"), "contentDigest", error),
    policyVersion: safeInteger(entries.get("policyVersion"), "policyVersion", {
      minimum: 1,
      error,
    }),
    requestedBy: normalizeRequestedBy(entries.get("requestedBy"), error),
    source: normalizeSource(entries.get("source"), error),
    subject,
    repository,
    workspaceId: safeId(entries.get("workspaceId"), "workspaceId", error),
    workspaceAuthorityDigest: sha256(
      entries.get("workspaceAuthorityDigest"),
      "workspaceAuthorityDigest",
      error,
    ),
    operation,
    objective: text(entries.get("objective"), "objective", {
      maximumBytes: 4_096,
      error,
    }),
    acceptanceCriteria: normalizeStringList(
      entries.get("acceptanceCriteria"),
      "acceptanceCriteria",
      { maximumLength: 20, minimumLength: 1, maximumBytes: 2_048, error },
    ),
    evidence: normalizeStringList(entries.get("evidence"), "evidence", {
      maximumLength: 20,
      maximumBytes: 2_048,
      error,
    }),
    summary: text(entries.get("summary"), "summary", {
      maximumBytes: 2_048,
      error,
    }),
    reason: text(entries.get("reason"), "reason", {
      maximumBytes: 4_096,
      error,
    }),
    allowedActions: normalizeAllowedActions(
      entries.get("allowedActions"),
      operation,
      error,
    ),
    writablePaths: normalizeWritablePaths(
      entries.get("writablePaths"),
      operation,
      error,
    ),
    requiredProfiles: normalizeRequiredProfiles(
      entries.get("requiredProfiles"),
      error,
    ),
    brainDigest: sha256(entries.get("brainDigest"), "brainDigest", error),
  };
}

export function createCodeJobGrant(value) {
  const content = normalizeGrantContent(value, invalidGrant());
  return { ...content, grantDigest: digestValue(content) };
}

export function normalizeCodeJobGrant(value) {
  const error = invalidGrant();
  const entries = exactObject(value, [...GRANT_KEYS, "grantDigest"], error);
  const content = normalizeGrantContent(
    Object.fromEntries(GRANT_KEYS.map((key) => [key, entries.get(key)])),
    error,
  );
  const grantDigest = sha256(entries.get("grantDigest"), "grantDigest", error);
  if (grantDigest !== digestValue(content)) throw error;
  return { ...content, grantDigest };
}

export function normalizeApprovedCodeJobRequest(value) {
  const error = invalidApproval();
  const entries = exactObject(
    value,
    [
      "confirmationId",
      "requestId",
      "displayedPayloadDigest",
      "approvalBindingDigest",
      "grant",
    ],
    error,
  );
  let grant;
  try {
    grant = normalizeCodeJobGrant(entries.get("grant"));
  } catch (cause) {
    throw invalidApproval("代码任务批准中的授权无效", { cause });
  }
  return {
    confirmationId: text(entries.get("confirmationId"), "confirmationId", {
      maximumBytes: 128,
      pattern: SAFE_CONFIRMATION_ID,
      error,
    }),
    requestId: text(entries.get("requestId"), "requestId", {
      minimumBytes: 8,
      maximumBytes: 128,
      pattern: SAFE_CONFIRMATION_ID,
      error,
    }),
    displayedPayloadDigest: sha256(
      entries.get("displayedPayloadDigest"),
      "displayedPayloadDigest",
      error,
    ),
    approvalBindingDigest: sha256(
      entries.get("approvalBindingDigest"),
      "approvalBindingDigest",
      error,
    ),
    grant,
  };
}

export function codeJobIdForGrant(value) {
  const grant = normalizeCodeJobGrant(value);
  const digest = digestValue({
    proposalId: grant.proposalId,
    proposalContentDigest: grant.contentDigest,
    grantDigest: grant.grantDigest,
  });
  return `code-job-${digest.slice(0, 55)}`;
}

export function normalizeCodeJobTimestamp(value, error = invalidJob()) {
  let timestamp;
  try {
    timestamp = value instanceof Date ? value.toISOString() : value;
  } catch {
    throw error;
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw error;
  }
  return timestamp;
}

export function createQueuedCodeJob(
  value,
  { sequence, revision, createdAt } = {},
) {
  const approval = normalizeApprovedCodeJobRequest(value);
  const at = normalizeCodeJobTimestamp(createdAt);
  const content = {
    jobId: codeJobIdForGrant(approval.grant),
    status: "queued",
    sequence: safeInteger(sequence, "sequence", {
      minimum: 1,
      error: invalidJob(),
    }),
    revision: safeInteger(revision, "revision", {
      minimum: 1,
      error: invalidJob(),
    }),
    approval: {
      confirmationId: approval.confirmationId,
      requestId: approval.requestId,
      displayedPayloadDigest: approval.displayedPayloadDigest,
      approvalBindingDigest: approval.approvalBindingDigest,
    },
    proposal: {
      proposalId: approval.grant.proposalId,
      contentDigest: approval.grant.contentDigest,
    },
    grant: approval.grant,
    createdAt: at,
    updatedAt: at,
  };
  return { ...content, recordDigest: digestValue(content) };
}

export function normalizeCodeJob(value) {
  const error = invalidJob();
  const entries = exactObject(
    value,
    [
      "jobId",
      "status",
      "sequence",
      "revision",
      "approval",
      "proposal",
      "grant",
      "createdAt",
      "updatedAt",
      "recordDigest",
    ],
    error,
  );
  if (!JOB_STATUSES.has(entries.get("status"))) throw error;
  const approvalFields = exactObject(
    entries.get("approval"),
    [
      "confirmationId",
      "requestId",
      "displayedPayloadDigest",
      "approvalBindingDigest",
    ],
    error,
  );
  const proposalFields = exactObject(
    entries.get("proposal"),
    ["proposalId", "contentDigest"],
    error,
  );
  const grant = normalizeCodeJobGrant(entries.get("grant"));
  const content = {
    jobId: safeId(entries.get("jobId"), "jobId", error),
    status: entries.get("status"),
    sequence: safeInteger(entries.get("sequence"), "sequence", {
      minimum: 1,
      error,
    }),
    revision: safeInteger(entries.get("revision"), "revision", {
      minimum: 1,
      error,
    }),
    approval: {
      confirmationId: text(
        approvalFields.get("confirmationId"),
        "approval.confirmationId",
        { maximumBytes: 128, pattern: SAFE_CONFIRMATION_ID, error },
      ),
      requestId: text(approvalFields.get("requestId"), "approval.requestId", {
        minimumBytes: 8,
        maximumBytes: 128,
        pattern: SAFE_CONFIRMATION_ID,
        error,
      }),
      displayedPayloadDigest: sha256(
        approvalFields.get("displayedPayloadDigest"),
        "approval.displayedPayloadDigest",
        error,
      ),
      approvalBindingDigest: sha256(
        approvalFields.get("approvalBindingDigest"),
        "approval.approvalBindingDigest",
        error,
      ),
    },
    proposal: {
      proposalId: safeReference(
        proposalFields.get("proposalId"),
        "proposal.proposalId",
        192,
        error,
      ),
      contentDigest: sha256(
        proposalFields.get("contentDigest"),
        "proposal.contentDigest",
        error,
      ),
    },
    grant,
    createdAt: normalizeCodeJobTimestamp(entries.get("createdAt"), error),
    updatedAt: normalizeCodeJobTimestamp(entries.get("updatedAt"), error),
  };
  const recordDigest = sha256(entries.get("recordDigest"), "recordDigest", error);
  if (
    content.jobId !== codeJobIdForGrant(grant) ||
    content.proposal.proposalId !== grant.proposalId ||
    content.proposal.contentDigest !== grant.contentDigest ||
    content.createdAt !== content.updatedAt ||
    recordDigest !== digestValue(content)
  ) {
    throw error;
  }
  return { ...content, recordDigest };
}

export function projectCodeJobForBrowser(value) {
  const job = normalizeCodeJob(value);
  return structuredClone({
    jobId: job.jobId,
    status: job.status,
    revision: job.revision,
    proposalId: job.proposal.proposalId,
    proposalContentDigest: job.proposal.contentDigest,
    grantDigest: job.grant.grantDigest,
    requestedBy: job.grant.requestedBy,
    subject: job.grant.subject,
    repository: job.grant.repository,
    workspaceId: job.grant.workspaceId,
    operation: job.grant.operation,
    objective: job.grant.objective,
    acceptanceCriteria: job.grant.acceptanceCriteria,
    evidence: job.grant.evidence,
    summary: job.grant.summary,
    reason: job.grant.reason,
    allowedActions: job.grant.allowedActions,
    writablePaths: job.grant.writablePaths,
    requiredProfiles: job.grant.requiredProfiles.map(({ id }) => id),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}

export function cloneCodeJobValue(value) {
  return structuredClone(value);
}
