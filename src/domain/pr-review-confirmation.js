import { normalizeConfirmationPlan } from "./confirmation-contract.js";

const SAFE_JOB_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,113}[A-Za-z0-9])$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const HEAD_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REVIEW_EVENTS = Object.freeze({
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
});

export class PrReviewConfirmationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrReviewConfirmationError";
    this.code = "INVALID_PR_REVIEW_CONFIRMATION";
    this.statusCode = 400;
  }
}

function invalid(field) {
  return new PrReviewConfirmationError(`无法创建 PR Review 确认计划：${field} 无效`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataField(value, field, owner) {
  if (!isPlainObject(value)) throw invalid(owner);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw invalid(`${owner}.${field}`);
  }
  return descriptor.value;
}

function boundedString(
  value,
  field,
  {
    minimumBytes = 1,
    maximumBytes = 512,
    pattern = null,
    allowBlank = true,
  } = {},
) {
  if (typeof value !== "string" || INVALID_CONTROL.test(value)) {
    throw invalid(field);
  }
  const size = Buffer.byteLength(value, "utf8");
  if (
    size < minimumBytes ||
    size > maximumBytes ||
    (!allowBlank && !value.trim()) ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(field);
  }
  return value;
}

function normalizeRepository(value) {
  const repository = boundedString(value, "job.repo", {
    maximumBytes: 140,
    pattern: REPOSITORY,
  });
  const [, owner, name] = repository.match(REPOSITORY);
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw invalid("job.repo");
  }
  return repository;
}

function normalizeEvidence(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 50
  ) {
    throw invalid("job.evidence");
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  if (
    keys.length !== expected.length + 1 ||
    !keys.includes("length") ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw invalid("job.evidence");
  }
  return expected.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid("job.evidence");
    }
    return boundedString(descriptor.value, "job.evidence", {
      minimumBytes: 0,
      maximumBytes: 2_048,
      allowBlank: false,
    });
  });
}

function queuePlan(value) {
  const normalized = normalizeConfirmationPlan(value);
  const {
    displayedPayloadDigest: _displayedPayloadDigest,
    approvalBindingDigest: _approvalBindingDigest,
    ...plan
  } = normalized;
  return plan;
}

export function createPrReviewConfirmationPlan(job, options = undefined) {
  const githubActions = dataField(options, "githubActions", "options");
  const actorAccountId = boundedString(
    dataField(githubActions, "actorAccountId", "githubActions"),
    "githubActions.actorAccountId",
    { maximumBytes: 39, pattern: GITHUB_LOGIN },
  );

  const id = boundedString(dataField(job, "id", "job"), "job.id", {
    maximumBytes: 115,
    pattern: SAFE_JOB_ID,
  });
  if (dataField(job, "workType", "job") !== "review_draft") {
    throw invalid("job.workType");
  }
  if (dataField(job, "status", "job") !== "ready_for_human") {
    throw invalid("job.status");
  }
  if (dataField(job, "requiresApproval", "job") !== true) {
    throw invalid("job.requiresApproval");
  }

  const repository = normalizeRepository(dataField(job, "repo", "job"));
  const number = dataField(job, "number", "job");
  if (!Number.isSafeInteger(number) || number < 1) throw invalid("job.number");
  const headRefOid = boundedString(
    dataField(job, "headRefOid", "job"),
    "job.headRefOid",
    { maximumBytes: 64, pattern: HEAD_OID },
  );
  const summary = boundedString(dataField(job, "summary", "job"), "job.summary", {
    maximumBytes: 2_048,
    allowBlank: false,
  });
  const title = boundedString(dataField(job, "title", "job"), "job.title", {
    maximumBytes: 512,
    allowBlank: false,
  });
  const evidence = normalizeEvidence(dataField(job, "evidence", "job"));
  const reviewVerdict = boundedString(
    dataField(job, "reviewVerdict", "job"),
    "job.reviewVerdict",
    {
      maximumBytes: 32,
      pattern: /^(?:approve|request_changes|comment)$/,
    },
  );
  const reviewEvent = REVIEW_EVENTS[reviewVerdict];
  if (!Object.hasOwn(REVIEW_EVENTS, reviewVerdict)) {
    throw invalid("job.reviewVerdict");
  }
  const body = boundedString(dataField(job, "reviewBody", "job"), "job.reviewBody", {
    maximumBytes: 8 * 1_024,
    allowBlank: false,
  });

  const actor = { provider: "github", accountId: actorAccountId };
  const target = {
    provider: "github",
    resourceId: `${repository}#${number}`,
    version: headRefOid,
  };
  const action = {
    type: "pull_request_review",
    reviewEvent,
    body,
  };

  return queuePlan({
    id: `confirmation-${id}`,
    kind: "github.pull-request-review",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: id,
    },
    actor,
    target,
    action,
    display: {
      title: `${repository} #${number} · ${title}`,
      summary,
      actionLabel: "确认并发布到 GitHub",
      evidence,
      payload: {
        actor,
        target,
        action,
      },
    },
  });
}
