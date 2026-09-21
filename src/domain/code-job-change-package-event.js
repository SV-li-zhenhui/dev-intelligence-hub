import { types as utilTypes } from "node:util";

import { normalizeCodeJob } from "./code-job-contract.js";
import {
  codeExecutionSourceWritablePaths,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import { digestValue } from "./code-executor-contract.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const CONTROL_CHARACTER = /\p{Cc}/u;
const EVENT_PREFIX = "code-job-change-package-event-";
const MAX_V1_EVENT_BYTES = 4 * 1024;
const MAX_V2_EVENT_BYTES = 96 * 1024;
const EVENT_V1_KEYS = Object.freeze([
  "schemaVersion",
  "sequence",
  "previousDigest",
  "job",
  "proposal",
  "grant",
  "exportRequest",
  "eventId",
  "eventDigest",
]);
const EVENT_V2_KEYS = Object.freeze([
  ...EVENT_V1_KEYS.slice(0, -2),
  "executionSource",
  ...EVENT_V1_KEYS.slice(-2),
]);
const EVENT_V3_KEYS = Object.freeze([
  ...EVENT_V1_KEYS.slice(0, -2),
  "executionSource",
  "recordedAt",
  ...EVENT_V1_KEYS.slice(-2),
]);

export class CodeJobChangePackageEventError extends Error {
  constructor(message = "代码任务 change package 事件无效", options) {
    super(message, options);
    this.name = "CodeJobChangePackageEventError";
    this.code = "INVALID_CODE_JOB_CHANGE_PACKAGE_EVENT";
    this.statusCode = 400;
  }
}

function invalid(message, cause) {
  return new CodeJobChangePackageEventError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name) {
  const entries = dataEntries(value, name);
  const fields = new Map(entries);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} 字段无效`);
  }
  return fields;
}

function text(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function digest(value, name) {
  return text(value, name, 64, SHA256);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function canonicalTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function normalizePreviousDigest(sequence, value) {
  const previousDigest = value === null ? null : digest(value, "previousDigest");
  if ((sequence === 1) !== (previousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  return previousDigest;
}

function normalizeJobReference(value) {
  const fields = exact(value, ["id", "revision", "recordDigest"], "job");
  return {
    id: text(fields.get("id"), "job.id", 128, SAFE_ID),
    revision: positiveInteger(fields.get("revision"), "job.revision"),
    recordDigest: digest(fields.get("recordDigest"), "job.recordDigest"),
  };
}

function normalizeProposalReference(value) {
  const fields = exact(value, ["id", "contentDigest"], "proposal");
  return {
    id: text(fields.get("id"), "proposal.id", 512),
    contentDigest: digest(
      fields.get("contentDigest"),
      "proposal.contentDigest",
    ),
  };
}

function normalizeGrantReference(value) {
  const fields = exact(value, ["digest"], "grant");
  return { digest: digest(fields.get("digest"), "grant.digest") };
}

function normalizeExportRequest(value) {
  const fields = exact(
    value,
    ["sessionId", "completedActionId", "expectedWorkspaceRevision"],
    "exportRequest",
  );
  return {
    sessionId: text(fields.get("sessionId"), "exportRequest.sessionId", 128, SAFE_ID),
    completedActionId: text(
      fields.get("completedActionId"),
      "exportRequest.completedActionId",
      128,
      SAFE_ID,
    ),
    expectedWorkspaceRevision: digest(
      fields.get("expectedWorkspaceRevision"),
      "exportRequest.expectedWorkspaceRevision",
    ),
  };
}

function eventContent(value) {
  return {
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    previousDigest: value.previousDigest,
    job: value.job,
    proposal: value.proposal,
    grant: value.grant,
    exportRequest: value.exportRequest,
    ...(value.schemaVersion >= 2
      ? { executionSource: value.executionSource }
      : {}),
    ...(value.schemaVersion === 3 ? { recordedAt: value.recordedAt } : {}),
  };
}

function assertEventSize(event) {
  const maximum = event.schemaVersion >= 2
    ? MAX_V2_EVENT_BYTES
    : MAX_V1_EVENT_BYTES;
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > maximum) {
    throw invalid("代码任务 change package 事件过大");
  }
}

function completeObservation(job) {
  const observation = job.execution.observations.findLast(
    ({ actionType, status }) =>
      actionType === "complete" && status === "succeeded",
  );
  if (!observation) throw invalid("完成任务缺少成功的 complete observation");
  return observation;
}

function completionSource(job) {
  const memory = job.execution.memoryProjection;
  return memory === null
    ? { revision: job.revision, recordDigest: job.recordDigest }
    : {
      revision: memory.sourceRevision,
      recordDigest: memory.sourceRecordDigest,
    };
}

function normalizeCreationInput(value) {
  const fields = exact(
    value,
    ["sequence", "previousDigest", "job"],
    "code job change package event input",
  );
  let job;
  try {
    job = normalizeCodeJob(fields.get("job"));
  } catch (cause) {
    throw invalid("代码任务记录无效", cause);
  }
  if (job.status !== "completed") throw invalid("代码任务尚未完成");
  const sequence = positiveInteger(fields.get("sequence"), "sequence");
  return {
    job,
    sequence,
    previousDigest: normalizePreviousDigest(
      sequence,
      fields.get("previousDigest"),
    ),
  };
}

function eventForCompletedJob(
  { job, sequence, previousDigest },
  { legacyConflict = false } = {},
) {
  const observation = completeObservation(job);
  const source = completionSource(job);
  const executionSource = job.grant.schemaVersion === 3
    ? normalizeCodeExecutionSource(job.grant.executionSource)
    : undefined;
  const content = eventContent({
    schemaVersion: executionSource === undefined
      ? 1
      : legacyConflict
      ? 2
      : 3,
    sequence,
    previousDigest,
    job: {
      id: job.jobId,
      revision: source.revision,
      recordDigest: source.recordDigest,
    },
    proposal: {
      id: job.proposal.proposalId,
      contentDigest: job.proposal.contentDigest,
    },
    grant: { digest: job.grant.grantDigest },
    exportRequest: {
      sessionId: job.execution.sessionId,
      completedActionId: observation.actionId,
      expectedWorkspaceRevision: job.execution.workspaceRevision,
    },
    ...(executionSource === undefined
      ? {}
      : {
          executionSource,
          ...(legacyConflict ? {} : { recordedAt: observation.recordedAt }),
        }),
  });
  const eventDigest = digestValue(content);
  const event = {
    ...content,
    eventId: `${EVENT_PREFIX}${eventDigest}`,
    eventDigest,
  };
  assertEventSize(event);
  return event;
}

export function canCreateCodeJobChangePackageEvent(job) {
  const grant = job?.grant;
  if (
    grant?.schemaVersion === 2 &&
    Object.hasOwn(grant, "inputBinding")
  ) {
    return grant.inputBinding === null || grant.inputBinding.schemaVersion === 2;
  }
  if (
    grant?.schemaVersion !== 3 ||
    grant.operation !== "modify" ||
    !Object.hasOwn(grant, "inputBinding") ||
    grant.inputBinding?.schemaVersion !== 2 ||
    !Object.hasOwn(grant, "executionSource")
  ) {
    return false;
  }
  try {
    const executionSource = normalizeCodeExecutionSource(
      grant.executionSource,
    );
    return (
      sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding: grant.inputBinding,
      }) &&
      JSON.stringify(codeExecutionSourceWritablePaths(executionSource)) ===
        JSON.stringify(grant.writablePaths)
    );
  } catch {
    return false;
  }
}

export function createCodeJobChangePackageEvent(value) {
  const input = normalizeCreationInput(value);
  if (!canCreateCodeJobChangePackageEvent(input.job)) {
    throw invalid("旧版 PR 代码任务只能恢复已有结果，不能创建新的变更包事件");
  }
  return eventForCompletedJob(input);
}

export function reconstructCodeJobChangePackageEventForRecovery(
  value,
  { expectedEventDigest } = {},
) {
  const input = normalizeCreationInput(value);
  const current = eventForCompletedJob(input);
  if (
    expectedEventDigest === undefined ||
    current.eventDigest === expectedEventDigest
  ) {
    return current;
  }
  if (input.job.grant.schemaVersion === 3) {
    const legacy = eventForCompletedJob(input, { legacyConflict: true });
    if (legacy.eventDigest === expectedEventDigest) return legacy;
  }
  throw invalid("持久事件摘要与完成任务不一致");
}

export function normalizeCodeJobChangePackageEvent(value) {
  try {
    const supplied = new Map(
      dataEntries(value, "code job change package event"),
    );
    const schemaVersion = supplied.get("schemaVersion");
    const keys = schemaVersion === 3
      ? EVENT_V3_KEYS
      : schemaVersion === 2
      ? EVENT_V2_KEYS
      : EVENT_V1_KEYS;
    const fields = exact(value, keys, "code job change package event");
    if (![1, 2, 3].includes(schemaVersion)) throw invalid("schemaVersion 无效");
    const sequence = positiveInteger(fields.get("sequence"), "sequence");
    const content = eventContent({
      schemaVersion,
      sequence,
      previousDigest: normalizePreviousDigest(
        sequence,
        fields.get("previousDigest"),
      ),
      job: normalizeJobReference(fields.get("job")),
      proposal: normalizeProposalReference(fields.get("proposal")),
      grant: normalizeGrantReference(fields.get("grant")),
      exportRequest: normalizeExportRequest(fields.get("exportRequest")),
      ...(schemaVersion >= 2
        ? {
            executionSource: normalizeCodeExecutionSource(
              fields.get("executionSource"),
              invalid("executionSource 无效"),
            ),
          }
        : {}),
      ...(schemaVersion === 3
        ? {
            recordedAt: canonicalTimestamp(
              fields.get("recordedAt"),
              "recordedAt",
            ),
          }
        : {}),
    });
    const eventDigest = digest(fields.get("eventDigest"), "eventDigest");
    const eventId = text(fields.get("eventId"), "eventId", 96);
    if (
      eventDigest !== digestValue(content) ||
      eventId !== `${EVENT_PREFIX}${eventDigest}`
    ) {
      throw invalid("事件摘要绑定无效");
    }
    const event = { ...content, eventId, eventDigest };
    assertEventSize(event);
    return event;
  } catch (error) {
    if (error instanceof CodeJobChangePackageEventError) throw error;
    throw invalid(undefined, error);
  }
}
