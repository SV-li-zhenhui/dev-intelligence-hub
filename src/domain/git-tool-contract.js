import { types as utilTypes } from "node:util";

const UNSAFE_DISPLAY_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/;
const GIT_TARGET_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "sourceAccountId",
  "baseRepository",
  "baseRefName",
  "baseRefOid",
  "headRepository",
  "headRefName",
  "headRefOid",
]);

export class GitToolContractError extends Error {
  constructor(message = "Git tool contract is invalid") {
    super(message);
    this.name = "GitToolContractError";
    this.code = "INVALID_GIT_TOOL_CONTRACT";
  }
}

function invalid(name = "Git target") {
  return new GitToolContractError(`${name} 无效`);
}

function exactDataObject(value, expectedKeys, error) {
  const fields = dataMap(value, error);
  const keys = [...fields.keys()];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

function dataMap(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function boundedText(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    UNSAFE_DISPLAY_CODE_POINT.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(name);
  }
  return value;
}

function githubLogin(value) {
  const normalized = boundedText(
    value,
    "sourceAccountId",
    39,
    GITHUB_LOGIN,
  ).toLowerCase();
  if (normalized.includes("--")) throw invalid("sourceAccountId");
  return normalized;
}

function repository(value, name) {
  const normalized = boundedText(value, name, 140, REPOSITORY);
  const [, owner, repo] = normalized.match(REPOSITORY);
  if (
    owner.includes("--") ||
    repo.includes("..") ||
    repo.startsWith(".") ||
    repo.endsWith(".")
  ) {
    throw invalid(name);
  }
  return normalized;
}

function refName(value, name) {
  const normalized = boundedText(value, name, 255);
  const segments = normalized.split("/");
  if (
    normalized.normalize("NFC") !== normalized ||
    normalized === "@" ||
    normalized.startsWith("-") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("//") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    /[ ~^:?*[\\]/u.test(normalized) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.startsWith(".") ||
        segment.endsWith(".lock"),
    )
  ) {
    throw invalid(name);
  }
  return normalized;
}

function oid(value, name) {
  return boundedText(value, name, 64, GIT_OID);
}

export function normalizePullRequestGitTarget(value) {
  const error = invalid();
  const fields = exactDataObject(value, GIT_TARGET_KEYS, error);
  if (fields.get("schemaVersion") !== 1 || fields.get("provider") !== "github") {
    throw error;
  }
  const baseRefOid = oid(fields.get("baseRefOid"), "baseRefOid");
  const headRefOid = oid(fields.get("headRefOid"), "headRefOid");
  if (baseRefOid.length !== headRefOid.length) {
    throw invalid("Git object format");
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: githubLogin(fields.get("sourceAccountId")),
    baseRepository: repository(fields.get("baseRepository"), "baseRepository"),
    baseRefName: refName(fields.get("baseRefName"), "baseRefName"),
    baseRefOid,
    headRepository: repository(fields.get("headRepository"), "headRepository"),
    headRefName: refName(fields.get("headRefName"), "headRefName"),
    headRefOid,
  });
}

export function samePullRequestGitTarget(left, right) {
  let normalizedLeft;
  let normalizedRight;
  try {
    normalizedLeft = normalizePullRequestGitTarget(left);
    normalizedRight = normalizePullRequestGitTarget(right);
  } catch {
    return false;
  }
  return GIT_TARGET_KEYS.every(
    (key) => normalizedLeft[key] === normalizedRight[key],
  );
}

export function pullRequestGitTargetFromEvent(event) {
  const error = invalid("PR Git facts");
  const eventFields = dataMap(event, error);
  const payload = dataMap(eventFields.get("payload"), error);
  const subject = dataMap(eventFields.get("subject"), error);
  const duplicatedFlatFacts = [
    "githubAccount",
    "baseRepository",
    "baseRefName",
    "baseRefOid",
    "headRepository",
    "headRefName",
  ];
  if (payload.has("gitTargetAvailable")) {
    const available = payload.get("gitTargetAvailable");
    if (available === false) {
      if (
        payload.has("gitTarget") ||
        duplicatedFlatFacts.some((key) => payload.has(key)) ||
        !String(eventFields.get("eventType") || "").startsWith("pull_request.")
      ) {
        throw error;
      }
      return null;
    }
    if (available !== true || !payload.has("gitTarget")) throw error;
  }
  if (payload.has("gitTarget")) {
    if (
      duplicatedFlatFacts.some((key) => payload.has(key)) ||
      !String(eventFields.get("eventType") || "").startsWith("pull_request.")
    ) {
      throw error;
    }
    const target = normalizePullRequestGitTarget(payload.get("gitTarget"));
    if (
      subject.get("repository") !== target.baseRepository ||
      payload.get("headRefOid") !== target.headRefOid
    ) {
      throw error;
    }
    return target;
  }
  const fields = {
    sourceAccountId: payload.get("githubAccount"),
    baseRepository: payload.get("baseRepository"),
    baseRefName: payload.get("baseRefName"),
    baseRefOid: payload.get("baseRefOid"),
    headRepository: payload.get("headRepository"),
    headRefName: payload.get("headRefName"),
    headRefOid: payload.get("headRefOid"),
  };
  const indicatorKeys = [
    "githubAccount",
    "baseRepository",
    "baseRefName",
    "baseRefOid",
    "headRepository",
    "headRefName",
  ];
  const present = indicatorKeys.filter((key) => payload.has(key)).length;
  if (present === 0) return null;
  if (
    present !== indicatorKeys.length ||
    typeof fields.headRefOid !== "string" ||
    fields.headRefOid.length === 0 ||
    subject.get("repository") !== fields.baseRepository
  ) {
    throw invalid("PR Git facts");
  }
  return normalizePullRequestGitTarget({
    schemaVersion: 1,
    provider: "github",
    ...fields,
  });
}

export function pullRequestGitTargetMatchesEvent(target, event) {
  let observed;
  try {
    observed = pullRequestGitTargetFromEvent(event);
  } catch {
    return false;
  }
  return observed !== null && samePullRequestGitTarget(target, observed);
}
