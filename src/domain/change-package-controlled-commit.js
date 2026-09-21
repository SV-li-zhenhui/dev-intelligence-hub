import { types as utilTypes } from "node:util";

import {
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import { digestValue } from "./code-executor-contract.js";
import { normalizeControlledCommitEvidence } from "./controlled-commit-evidence.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const EVENT_ID = /^code-job-change-package-event-[a-f0-9]{64}$/u;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^controlled-git-commit-[a-f0-9]{64}$/u;
const DELIVERY_ID = /^change-package-controlled-commit-[a-f0-9]{64}$/u;
const RECEIPT_ID = /^change-package-controlled-commit-receipt-[a-f0-9]{64}$/u;
const REQUEST_KEYS = Object.freeze([
  "eventId",
  "eventDigest",
  "packageId",
  "packageDigest",
  "executionSource",
  "recordedAt",
]);
const RECEIPT_CORE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "deliveryId",
  "bindingDigest",
  "eventId",
  "eventDigest",
  "packageId",
  "packageDigest",
  "executionSourceDigest",
  "recordedAt",
  "evidenceId",
  "evidenceDigest",
  "commitOid",
]);
const RECEIPT_KEYS = Object.freeze([
  ...RECEIPT_CORE_KEYS,
  "receiptDigest",
  "receiptId",
]);

export class ChangePackageControlledCommitError extends Error {
  constructor(message = "change package controlled commit 绑定无效", options) {
    super(message, options);
    this.name = "ChangePackageControlledCommitError";
    this.code = "INVALID_CHANGE_PACKAGE_CONTROLLED_COMMIT";
  }
}

function invalid(message, cause) {
  return new ChangePackageControlledCommitError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exact(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const entries = Reflect.ownKeys(value);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !entries.includes(key)) ||
    entries.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor);
    })
  ) {
    throw invalid(`${name} 字段无效`);
  }
  return new Map(entries.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(value, key).value,
  ]));
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function identifier(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function timestamp(value, name = "recordedAt") {
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

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function bindingContent(value) {
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    eventDigest: value.eventDigest,
    packageId: value.packageId,
    packageDigest: value.packageDigest,
    executionSourceDigest: value.executionSourceDigest,
    recordedAt: value.recordedAt,
  };
}

function bindRequest(value) {
  const content = bindingContent(value);
  const bindingDigest = digestValue(content);
  return {
    ...value,
    bindingDigest,
    deliveryId: `change-package-controlled-commit-${bindingDigest}`,
  };
}

function normalizeRequestDocument(value) {
  const fields = exact(value, REQUEST_KEYS, "controlled commit delivery request");
  const eventDigest = digest(fields.get("eventDigest"), "eventDigest");
  const eventId = identifier(fields.get("eventId"), EVENT_ID, "eventId");
  const packageDigest = digest(fields.get("packageDigest"), "packageDigest");
  const packageId = identifier(fields.get("packageId"), PACKAGE_ID, "packageId");
  if (
    eventId !== `code-job-change-package-event-${eventDigest}` ||
    packageId !== `change-package-${packageDigest}`
  ) {
    throw invalid("event 或 package 摘要绑定无效");
  }
  let executionSource;
  try {
    executionSource = normalizeCodeExecutionSource(fields.get("executionSource"));
  } catch (cause) {
    throw invalid("executionSource 无效", cause);
  }
  return bindRequest({
    eventId,
    eventDigest,
    packageId,
    packageDigest,
    executionSource,
    executionSourceDigest: digestValue(executionSource),
    recordedAt: timestamp(fields.get("recordedAt")),
  });
}

function receiptCore(value) {
  return Object.fromEntries(RECEIPT_CORE_KEYS.map((key) => [key, value[key]]));
}

function normalizeReceiptDocument(value) {
  const fields = exact(value, RECEIPT_KEYS, "controlled commit delivery receipt");
  if (
    fields.get("schemaVersion") !== 1 ||
    fields.get("kind") !== "change_package_controlled_commit"
  ) {
    throw invalid("receipt kind 或 schemaVersion 无效");
  }
  const eventDigest = digest(fields.get("eventDigest"), "eventDigest");
  const packageDigest = digest(fields.get("packageDigest"), "packageDigest");
  const bindingDigest = digest(fields.get("bindingDigest"), "bindingDigest");
  const evidenceDigest = digest(fields.get("evidenceDigest"), "evidenceDigest");
  const executionSourceDigest = digest(
    fields.get("executionSourceDigest"),
    "executionSourceDigest",
  );
  const content = {
    schemaVersion: 1,
    kind: "change_package_controlled_commit",
    deliveryId: identifier(fields.get("deliveryId"), DELIVERY_ID, "deliveryId"),
    bindingDigest,
    eventId: identifier(fields.get("eventId"), EVENT_ID, "eventId"),
    eventDigest,
    packageId: identifier(fields.get("packageId"), PACKAGE_ID, "packageId"),
    packageDigest,
    executionSourceDigest,
    recordedAt: timestamp(fields.get("recordedAt")),
    evidenceId: identifier(fields.get("evidenceId"), EVIDENCE_ID, "evidenceId"),
    evidenceDigest,
    commitOid: identifier(fields.get("commitOid"), GIT_OID, "commitOid"),
  };
  const expectedBindingDigest = digestValue(bindingContent(content));
  const receiptDigest = digest(fields.get("receiptDigest"), "receiptDigest");
  const receiptId = identifier(fields.get("receiptId"), RECEIPT_ID, "receiptId");
  if (
    content.eventId !== `code-job-change-package-event-${eventDigest}` ||
    content.packageId !== `change-package-${packageDigest}` ||
    content.evidenceId !== `controlled-git-commit-${evidenceDigest}` ||
    bindingDigest !== expectedBindingDigest ||
    content.deliveryId !== `change-package-controlled-commit-${bindingDigest}` ||
    receiptDigest !== digestValue(content) ||
    receiptId !== `change-package-controlled-commit-receipt-${receiptDigest}`
  ) {
    throw invalid("controlled commit delivery receipt 摘要绑定无效");
  }
  return deepFreeze({ ...content, receiptDigest, receiptId });
}

export function normalizeChangePackageControlledCommitRequest(value) {
  try {
    return deepFreeze(normalizeRequestDocument(value));
  } catch (cause) {
    if (cause instanceof ChangePackageControlledCommitError) throw cause;
    throw invalid(undefined, cause);
  }
}

export function createChangePackageControlledCommitReceipt(
  requestValue,
  evidenceValue,
) {
  const request = normalizeChangePackageControlledCommitRequest(requestValue);
  let evidence;
  try {
    evidence = normalizeControlledCommitEvidence(evidenceValue);
  } catch (cause) {
    throw invalid("controlled commit evidence 无效", cause);
  }
  if (
    evidence.executionSourceDigest !== request.executionSourceDigest ||
    !sameCodeExecutionSource(evidence.executionSource, request.executionSource) ||
    evidence.package.packageId !== request.packageId ||
    evidence.package.packageDigest !== request.packageDigest ||
    evidence.createdAt !== request.recordedAt
  ) {
    throw invalid("controlled commit evidence 与 delivery request 不一致");
  }
  const content = {
    schemaVersion: 1,
    kind: "change_package_controlled_commit",
    deliveryId: request.deliveryId,
    bindingDigest: request.bindingDigest,
    eventId: request.eventId,
    eventDigest: request.eventDigest,
    packageId: request.packageId,
    packageDigest: request.packageDigest,
    executionSourceDigest: request.executionSourceDigest,
    recordedAt: request.recordedAt,
    evidenceId: evidence.evidenceId,
    evidenceDigest: evidence.evidenceDigest,
    commitOid: evidence.commit.oid,
  };
  const receiptDigest = digestValue(content);
  return normalizeReceiptDocument({
    ...content,
    receiptDigest,
    receiptId: `change-package-controlled-commit-receipt-${receiptDigest}`,
  });
}

export function normalizeChangePackageControlledCommitReceipt(value) {
  try {
    return normalizeReceiptDocument(value);
  } catch (cause) {
    if (cause instanceof ChangePackageControlledCommitError) throw cause;
    throw invalid(undefined, cause);
  }
}

export function sameChangePackageControlledCommitReceipt(left, right) {
  try {
    return normalizeChangePackageControlledCommitReceipt(left).receiptDigest ===
      normalizeChangePackageControlledCommitReceipt(right).receiptDigest;
  } catch {
    return false;
  }
}
