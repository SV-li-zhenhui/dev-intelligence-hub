const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const BINDING_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "repository",
  "pullRequestNumber",
  "rootItemId",
  "workKey",
  "inputRevision",
  "headRevision",
  "headRefOid",
  "eventId",
  "eventDigest",
  "inputDigest",
]);

function defaultError() {
  return new TypeError("pull request execution binding is invalid");
}

function entries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
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

function exact(value, expected, error) {
  const actual = entries(value, error).map(([key]) => key);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw error;
  }
  return value;
}

function text(value, maximumBytes, error, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

function positiveInteger(value, error) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw error;
  }
  return value;
}

export function normalizePullRequestExecutionBinding(
  value,
  error = defaultError(),
) {
  exact(value, BINDING_KEYS, error);
  if (value.schemaVersion !== 1 || value.kind !== "pull_request") {
    throw error;
  }
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: text(value.repository, 140, error, REPOSITORY),
    pullRequestNumber: positiveInteger(value.pullRequestNumber, error),
    rootItemId: text(value.rootItemId, 192, error),
    workKey: text(value.workKey, 128, error),
    inputRevision: positiveInteger(value.inputRevision, error),
    headRevision: positiveInteger(value.headRevision, error),
    headRefOid: text(value.headRefOid, 256, error),
    eventId: text(value.eventId, 192, error),
    eventDigest: text(value.eventDigest, 64, error, SHA256),
    inputDigest: text(value.inputDigest, 64, error, SHA256),
  };
}

export function createPullRequestExecutionBinding({ sourceBinding, event }) {
  const error = defaultError();
  exact(
    sourceBinding,
    [
      "kind",
      "rootItemId",
      "workKey",
      "inputRevision",
      "headRevision",
      "headRefOid",
      "eventId",
      "eventDigest",
      "inputDigest",
    ],
    error,
  );
  exact(
    event,
    [
      "schemaVersion",
      "eventId",
      "contentDigest",
      "eventType",
      "occurredAt",
      "source",
      "subject",
      "payload",
    ],
    error,
  );
  exact(event.subject, ["id", "repository", "number"], error);
  if (
    sourceBinding.kind !== "pull_request" ||
    !event.eventType.startsWith("pull_request.") ||
    sourceBinding.eventId !== event.eventId ||
    sourceBinding.eventDigest !== event.contentDigest ||
    sourceBinding.headRefOid !== event.payload?.headRefOid
  ) {
    throw error;
  }
  return normalizePullRequestExecutionBinding(
    {
      schemaVersion: 1,
      kind: "pull_request",
      repository: event.subject.repository,
      pullRequestNumber: event.subject.number,
      rootItemId: sourceBinding.rootItemId,
      workKey: sourceBinding.workKey,
      inputRevision: sourceBinding.inputRevision,
      headRevision: sourceBinding.headRevision,
      headRefOid: sourceBinding.headRefOid,
      eventId: sourceBinding.eventId,
      eventDigest: sourceBinding.eventDigest,
      inputDigest: sourceBinding.inputDigest,
    },
    error,
  );
}

export function samePullRequestExecutionBinding(left, right) {
  const normalizedLeft = normalizePullRequestExecutionBinding(left);
  const normalizedRight = normalizePullRequestExecutionBinding(right);
  return BINDING_KEYS.every(
    (key) => normalizedLeft[key] === normalizedRight[key],
  );
}
