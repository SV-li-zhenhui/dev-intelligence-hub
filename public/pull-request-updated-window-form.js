const LOCAL_DATE = /^(\d{4})(\d{2})(\d{2})$/u;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;

export class PullRequestUpdatedWindowFormError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "PullRequestUpdatedWindowFormError";
  }
}

function invalid(message) {
  return new PullRequestUpdatedWindowFormError(message);
}

function exactFields(value, fields) {
  const keys = Object.keys(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  ) {
    throw invalid("PR 更新时间窗口字段与模式不匹配");
  }
}

function utcTimestamp({ year, month, day }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function parseLocalDate(value, label) {
  const match = typeof value === "string" ? LOCAL_DATE.exec(value) : null;
  if (!match) throw invalid(`${label}必须是 8 位 YYYYMMDD 日期`);
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const timestamp = utcTimestamp(parts);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() + 1 !== parts.month ||
    date.getUTCDate() !== parts.day
  ) {
    throw invalid(`${label}不是有效的公历日期`);
  }
  return { ...parts, timestamp, text: value };
}

function supportedTimeZone(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw invalid("时区必须是受支持的 IANA 时区");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw invalid("时区必须是受支持的 IANA 时区");
  }
  return value;
}

function localParts(timestamp, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function offsetAt(timestamp, timeZone) {
  const parts = localParts(timestamp, timeZone);
  return (
    utcTimestamp({
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    }) +
    Number(parts.hour) * 60 * 60 * 1_000 +
    Number(parts.minute) * 60 * 1_000 +
    Number(parts.second) * 1_000 +
    Number(parts.fractionalSecond) -
    timestamp
  );
}

function isRequestedMidnight(timestamp, date, timeZone) {
  const parts = localParts(timestamp, timeZone);
  return (
    parts.year === `${date.year}`.padStart(4, "0") &&
    parts.month === `${date.month}`.padStart(2, "0") &&
    parts.day === `${date.day}`.padStart(2, "0") &&
    parts.hour === "00" &&
    parts.minute === "00" &&
    parts.second === "00" &&
    parts.fractionalSecond === "000"
  );
}

function localMidnightInstant(date, timeZone) {
  const offsets = new Set();
  for (
    let sample = date.timestamp - TWO_DAYS_MS;
    sample <= date.timestamp + TWO_DAYS_MS;
    sample += SIX_HOURS_MS
  ) {
    offsets.add(offsetAt(sample, timeZone));
  }
  const matches = [...offsets]
    .map((offset) => date.timestamp - offset)
    .filter((timestamp) => isRequestedMidnight(timestamp, date, timeZone));
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    throw invalid(`${date.text} 在所选时区没有唯一可转换的当地午夜`);
  }
  return uniqueMatches[0];
}

function nextLocalDate(date) {
  const timestamp = date.timestamp + 24 * 60 * 60 * 1_000;
  const next = new Date(timestamp);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    timestamp,
    text: `${next.getUTCFullYear()}`.padStart(4, "0") +
      `${next.getUTCMonth() + 1}`.padStart(2, "0") +
      `${next.getUTCDate()}`.padStart(2, "0"),
  };
}

function localDateText(timestamp, timeZone) {
  const parts = localParts(timestamp, timeZone);
  return `${parts.year}${parts.month}${parts.day}`;
}

function previousDateText(timestamp, timeZone) {
  const boundaryDate = parseLocalDate(localDateText(timestamp, timeZone), "结束边界");
  const previous = new Date(boundaryDate.timestamp - 24 * 60 * 60 * 1_000);
  return `${previous.getUTCFullYear()}`.padStart(4, "0") +
    `${previous.getUTCMonth() + 1}`.padStart(2, "0") +
    `${previous.getUTCDate()}`.padStart(2, "0");
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) {
    throw invalid(`${label}必须是规范 UTC 时间`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw invalid(`${label}必须是规范 UTC 时间`);
  }
  return timestamp;
}

export function fixedPullRequestUpdatedWindowFromLocalDates(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("固定日期窗口输入无效");
  }
  const timeZone = supportedTimeZone(input.timeZone);
  const fromDate = parseLocalDate(input.fromDate, "开始日期");
  const throughDate = parseLocalDate(input.throughDate, "结束日期");
  if (fromDate.timestamp > throughDate.timestamp) {
    throw invalid("开始日期不能晚于结束日期");
  }
  const fromInclusive = localMidnightInstant(fromDate, timeZone);
  const untilExclusive = localMidnightInstant(nextLocalDate(throughDate), timeZone);
  if (fromInclusive >= untilExclusive) {
    throw invalid("固定日期窗口必须包含至少一个当地日期");
  }
  const fromText = new Date(fromInclusive).toISOString();
  const untilText = new Date(untilExclusive).toISOString();
  if (!CANONICAL_UTC.test(fromText) || !CANONICAL_UTC.test(untilText)) {
    throw invalid("日期范围超出可保存的四位年份 UTC 边界");
  }
  return {
    mode: "fixed",
    fromInclusive: fromText,
    untilExclusive: untilText,
    timeZone,
  };
}

export function validatePullRequestUpdatedWindowFormValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("PR 更新时间窗口无效");
  }
  if (value.mode === "rolling") {
    exactFields(value, ["mode", "days"]);
    if (!Number.isSafeInteger(value.days) || value.days < 1 || value.days > 3_650) {
      throw invalid("最近天数必须是 1 到 3650 的整数");
    }
    return { mode: "rolling", days: value.days };
  }
  if (value.mode !== "fixed") throw invalid("PR 更新时间窗口模式无效");
  exactFields(value, ["mode", "fromInclusive", "untilExclusive", "timeZone"]);
  const timeZone = supportedTimeZone(value.timeZone);
  const fromTimestamp = canonicalTimestamp(value.fromInclusive, "开始边界");
  const untilTimestamp = canonicalTimestamp(value.untilExclusive, "结束边界");
  if (fromTimestamp >= untilTimestamp) throw invalid("开始边界必须早于结束边界");
  if (
    !isRequestedMidnight(
      fromTimestamp,
      parseLocalDate(localDateText(fromTimestamp, timeZone), "开始日期"),
      timeZone,
    ) ||
    !isRequestedMidnight(
      untilTimestamp,
      parseLocalDate(localDateText(untilTimestamp, timeZone), "结束日期"),
      timeZone,
    )
  ) {
    throw invalid("UTC 边界必须对应所选时区的当地午夜");
  }
  return {
    mode: "fixed",
    fromInclusive: value.fromInclusive,
    untilExclusive: value.untilExclusive,
    timeZone,
  };
}

export function pullRequestUpdatedWindowFormPresentation(value) {
  if (value === undefined) return { mode: "unlimited", recommendationDays: 7 };
  const normalized = validatePullRequestUpdatedWindowFormValue(value);
  if (normalized.mode === "rolling") {
    return { mode: "rolling", days: normalized.days };
  }
  const fromTimestamp = Date.parse(normalized.fromInclusive);
  const untilTimestamp = Date.parse(normalized.untilExclusive);
  return {
    mode: "fixed",
    fromDate: localDateText(fromTimestamp, normalized.timeZone),
    throughDate: previousDateText(untilTimestamp, normalized.timeZone),
    timeZone: normalized.timeZone,
    preview: `${normalized.fromInclusive} ≤ updatedAt < ${normalized.untilExclusive}`,
  };
}

export function pullRequestUpdatedWindowOperationFromForm(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("PR 更新时间表单输入无效");
  }
  const path = ["githubRead", "pullRequestUpdatedWindow"];
  if (input.mode === "unlimited") {
    return input.existing === true ? { operation: "remove", path } : null;
  }
  let value;
  if (input.mode === "rolling") {
    if (typeof input.days !== "string" || !/^\d+$/u.test(input.days)) {
      throw invalid("最近天数必须是 1 到 3650 的整数");
    }
    value = validatePullRequestUpdatedWindowFormValue({
      mode: "rolling",
      days: Number(input.days),
    });
  } else if (input.mode === "fixed") {
    value = fixedPullRequestUpdatedWindowFromLocalDates({
      fromDate: input.fromDate,
      throughDate: input.throughDate,
      timeZone: input.timeZone,
    });
  } else {
    throw invalid("请选择受支持的 PR 更新时间范围");
  }
  return {
    operation: input.existing === true ? "replace" : "add",
    path,
    value,
  };
}
