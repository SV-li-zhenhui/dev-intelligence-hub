import { types as utilTypes } from "node:util";

const ROLLING_WINDOW_FIELDS = Object.freeze(["mode", "days"]);
const FIXED_WINDOW_FIELDS = Object.freeze([
  "mode",
  "fromInclusive",
  "untilExclusive",
  "timeZone",
]);
const EFFECTIVE_UNLIMITED_FIELDS = Object.freeze([
  "mode",
  "refreshStartedAt",
]);
const EFFECTIVE_ROLLING_FIELDS = Object.freeze([
  "mode",
  "days",
  "refreshStartedAt",
  "fromInclusive",
]);
const EFFECTIVE_FIXED_FIELDS = Object.freeze([
  "mode",
  "fromInclusive",
  "untilExclusive",
  "timeZone",
  "refreshStartedAt",
]);
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HOUR_MS = 60 * 60 * 1_000;
const TWO_DAYS_MS = 2 * 24 * HOUR_MS;

export class PullRequestUpdatedWindowError extends TypeError {
  constructor(message = "invalid pull request updated window", { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PullRequestUpdatedWindowError";
  }
}

function invalid(message, cause) {
  return new PullRequestUpdatedWindowError(message, { cause });
}

function exactDataRecord(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid("window must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw invalid("window fields do not match its mode");
  }
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`window ${field} must be an enumerable data property`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function canonicalUtcInstant(value, field) {
  if (typeof value !== "string" || !CANONICAL_UTC_INSTANT.test(value)) {
    throw invalid(`${field} must be a canonical UTC instant`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw invalid(`${field} must be a canonical UTC instant`);
  }
  return timestamp;
}

function supportedTimeZone(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw invalid("timeZone must be a supported IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch (cause) {
    throw invalid("timeZone must be a supported IANA time zone", cause);
  }
  return value;
}

function localTimeParts(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(timestamp)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function localDateTimestamp(parts) {
  const date = new Date(0);
  date.setUTCFullYear(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  );
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function localOffsetAt(timestamp, timeZone) {
  const parts = localTimeParts(timestamp, timeZone);
  return (
    localDateTimestamp(parts) +
    Number(parts.hour) * HOUR_MS +
    Number(parts.minute) * 60 * 1_000 +
    Number(parts.second) * 1_000 +
    Number(parts.fractionalSecond) -
    timestamp
  );
}

function sameLocalMidnight(timestamp, expectedParts, timeZone) {
  const parts = localTimeParts(timestamp, timeZone);
  return (
    parts.year === expectedParts.year &&
    parts.month === expectedParts.month &&
    parts.day === expectedParts.day &&
    parts.hour === "00" &&
    parts.minute === "00" &&
    parts.second === "00" &&
    parts.fractionalSecond === "000"
  );
}

function assertUniqueLocalMidnight(timestamp, timeZone, field) {
  const expectedParts = localTimeParts(timestamp, timeZone);
  if (
    expectedParts.hour !== "00" ||
    expectedParts.minute !== "00" ||
    expectedParts.second !== "00" ||
    expectedParts.fractionalSecond !== "000"
  ) {
    throw invalid(`${field} must be local midnight in timeZone`);
  }
  const nominalTimestamp = localDateTimestamp(expectedParts);
  const offsets = new Set();
  for (
    let sample = nominalTimestamp - TWO_DAYS_MS;
    sample <= nominalTimestamp + TWO_DAYS_MS;
    sample += HOUR_MS
  ) {
    offsets.add(localOffsetAt(sample, timeZone));
  }
  const candidates = [...new Set(
    [...offsets]
      .map((offset) => nominalTimestamp - offset)
      .filter((candidate) =>
        sameLocalMidnight(candidate, expectedParts, timeZone),
      ),
  )];
  if (candidates.length !== 1 || candidates[0] !== timestamp) {
    throw invalid(`${field} must be an unambiguous local midnight in timeZone`);
  }
}

function normalizeRollingWindow(value) {
  const window = exactDataRecord(value, ROLLING_WINDOW_FIELDS);
  if (window.mode !== "rolling") throw invalid("unsupported window mode");
  if (
    !Number.isSafeInteger(window.days) ||
    window.days < 1 ||
    window.days > 3_650
  ) {
    throw invalid("rolling days must be an integer from 1 through 3650");
  }
  return Object.freeze({ mode: "rolling", days: window.days });
}

function normalizeFixedWindow(value) {
  const window = exactDataRecord(value, FIXED_WINDOW_FIELDS);
  if (window.mode !== "fixed") throw invalid("unsupported window mode");
  const timeZone = supportedTimeZone(window.timeZone);
  const fromTimestamp = canonicalUtcInstant(
    window.fromInclusive,
    "fromInclusive",
  );
  const untilTimestamp = canonicalUtcInstant(
    window.untilExclusive,
    "untilExclusive",
  );
  if (fromTimestamp >= untilTimestamp) {
    throw invalid("fixed window must have a positive duration");
  }
  assertUniqueLocalMidnight(fromTimestamp, timeZone, "fromInclusive");
  assertUniqueLocalMidnight(untilTimestamp, timeZone, "untilExclusive");
  return Object.freeze({
    mode: "fixed",
    fromInclusive: window.fromInclusive,
    untilExclusive: window.untilExclusive,
    timeZone,
  });
}

export function normalizePullRequestUpdatedWindow(value) {
  try {
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
      throw invalid("window must not be a proxy");
    }
    const modeDescriptor =
      value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "mode")
        : null;
    if (!modeDescriptor?.enumerable || !("value" in modeDescriptor)) {
      throw invalid("window mode must be an enumerable data property");
    }
    if (modeDescriptor.value === "rolling") return normalizeRollingWindow(value);
    if (modeDescriptor.value === "fixed") return normalizeFixedWindow(value);
    throw invalid("unsupported window mode");
  } catch (cause) {
    if (cause instanceof PullRequestUpdatedWindowError) throw cause;
    throw invalid("invalid pull request updated window", cause);
  }
}

function fixedWindowDirection(before, after) {
  const afterWithinBefore =
    after.fromInclusive >= before.fromInclusive &&
    after.untilExclusive <= before.untilExclusive;
  const beforeWithinAfter =
    before.fromInclusive >= after.fromInclusive &&
    before.untilExclusive <= after.untilExclusive;
  return {
    tightening: afterWithinBefore && !beforeWithinAfter,
    expansion: beforeWithinAfter && !afterWithinBefore,
    ...(!afterWithinBefore && !beforeWithinAfter
      ? { tightening: true, expansion: true }
      : {}),
  };
}

export function pullRequestUpdatedWindowSetDirection(before, after) {
  if (before === undefined) {
    return Object.freeze({ tightening: after !== undefined, expansion: false });
  }
  if (after === undefined) {
    return Object.freeze({ tightening: false, expansion: true });
  }
  if (before.mode !== after.mode) {
    return Object.freeze({ tightening: true, expansion: true });
  }
  if (before.mode === "rolling") {
    return Object.freeze({
      tightening: after.days < before.days,
      expansion: after.days > before.days,
    });
  }
  return Object.freeze(fixedWindowDirection(before, after));
}

function canonicalRefreshStartedAt(value) {
  if (typeof value !== "string") {
    throw invalid("refreshStartedAt must be a canonical UTC instant");
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value ||
    !CANONICAL_UTC_INSTANT.test(value)
  ) {
    throw invalid("refreshStartedAt must be a canonical UTC instant");
  }
  return timestamp;
}

export function resolveEffectivePullRequestUpdatedWindow(
  configuredWindow,
  refreshStartedAt,
) {
  const refreshTimestamp = canonicalRefreshStartedAt(refreshStartedAt);
  if (configuredWindow === undefined) {
    return Object.freeze({ mode: "unlimited", refreshStartedAt });
  }
  const configured = normalizePullRequestUpdatedWindow(configuredWindow);
  if (configured.mode === "rolling") {
    const fromInclusive = new Date(
      refreshTimestamp - configured.days * 24 * HOUR_MS,
    ).toISOString();
    if (!CANONICAL_UTC_INSTANT.test(fromInclusive)) {
      throw invalid("rolling window exceeds canonical UTC range");
    }
    return Object.freeze({
      mode: "rolling",
      days: configured.days,
      refreshStartedAt,
      fromInclusive,
    });
  }
  return Object.freeze({
    mode: "fixed",
    fromInclusive: configured.fromInclusive,
    untilExclusive: configured.untilExclusive,
    timeZone: configured.timeZone,
    refreshStartedAt,
  });
}

export function normalizeEffectivePullRequestUpdatedWindow(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw invalid("effective window must be a plain object");
  }
  const mode = Object.getOwnPropertyDescriptor(value, "mode")?.value;
  if (mode === "unlimited") {
    const window = exactDataRecord(value, EFFECTIVE_UNLIMITED_FIELDS);
    canonicalRefreshStartedAt(window.refreshStartedAt);
    return Object.freeze({
      mode: "unlimited",
      refreshStartedAt: window.refreshStartedAt,
    });
  }
  if (mode === "rolling") {
    const window = exactDataRecord(value, EFFECTIVE_ROLLING_FIELDS);
    const expected = resolveEffectivePullRequestUpdatedWindow(
      { mode: "rolling", days: window.days },
      window.refreshStartedAt,
    );
    if (window.fromInclusive !== expected.fromInclusive) {
      throw invalid("effective rolling window does not match its refresh instant");
    }
    return expected;
  }
  if (mode === "fixed") {
    const window = exactDataRecord(value, EFFECTIVE_FIXED_FIELDS);
    return resolveEffectivePullRequestUpdatedWindow(
      {
        mode: "fixed",
        fromInclusive: window.fromInclusive,
        untilExclusive: window.untilExclusive,
        timeZone: window.timeZone,
      },
      window.refreshStartedAt,
    );
  }
  throw invalid("unsupported effective window mode");
}
