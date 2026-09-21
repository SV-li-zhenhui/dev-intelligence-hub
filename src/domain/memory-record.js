import { createHash } from "node:crypto";

const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ROLE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const MAX_MEMORY_RECORD_CONTENT_BYTES = 32 * 1024;
export const MAX_MEMORY_RECORD_BYTES = 64 * 1024;

export class MemoryRecordError extends Error {
  constructor(message = "统一记忆记录无效") {
    super(message);
    this.name = "MemoryRecordError";
    this.code = "MEMORY_RECORD_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new MemoryRecordError(message);
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name) {
  const entries = dataEntries(value, name);
  const found = new Map(entries);
  if (
    found.size !== keys.length ||
    keys.some((key) => !found.has(key))
  ) {
    invalid(`${name} 字段无效`);
  }
  return found;
}

function text(value, name, maximumBytes, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    (!empty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function optionalText(value, name, maximumBytes) {
  return value === null ? null : text(value, name, maximumBytes);
}

function timestamp(value) {
  const normalized = text(value, "occurredAt", 64);
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    invalid("occurredAt 无效");
  }
  return normalized;
}

function strictStrings(value, name, maximumItems, maximumBytes) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumItems ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    invalid(`${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${name} 无效`);
    }
    result.push(text(descriptor.value, name, maximumBytes));
  }
  return result;
}

function normalizeSource(value) {
  const entries = exact(value, ["kind", "id"], "source");
  const kind = text(entries.get("kind"), "source.kind", 128);
  if (!SAFE_TOKEN.test(kind)) invalid("source.kind 无效");
  return {
    kind,
    id: text(entries.get("id"), "source.id", 512),
  };
}

function normalizeUrl(value) {
  if (value === null) return null;
  const raw = text(value, "sourceUrl", 2_048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    invalid("sourceUrl 无效");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    invalid("sourceUrl 无效");
  }
  return parsed.toString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function memoryRecordDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
}

export function normalizeMemoryRecord(value) {
  const keys = [
    "schemaVersion",
    "source",
    "occurredAt",
    "roleId",
    "repository",
    "eventType",
    "title",
    "summary",
    "content",
    "evidence",
    "tags",
    "sourceUrl",
    "subjectNumber",
  ];
  const entries = exact(value, keys, "memory record");
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const roleId = optionalText(entries.get("roleId"), "roleId", 128);
  if (roleId !== null && !SAFE_ROLE.test(roleId)) invalid("roleId 无效");
  const repository = optionalText(
    entries.get("repository"),
    "repository",
    256,
  );
  if (repository !== null && !REPOSITORY.test(repository)) {
    invalid("repository 无效");
  }
  const eventType = text(entries.get("eventType"), "eventType", 128);
  if (!SAFE_TOKEN.test(eventType)) invalid("eventType 无效");
  const subjectNumber = entries.get("subjectNumber");
  if (
    subjectNumber !== null &&
    (!Number.isSafeInteger(subjectNumber) || subjectNumber < 1)
  ) {
    invalid("subjectNumber 无效");
  }
  const normalized = {
    schemaVersion: 1,
    source: normalizeSource(entries.get("source")),
    occurredAt: timestamp(entries.get("occurredAt")),
    roleId,
    repository,
    eventType,
    title: text(entries.get("title"), "title", 1_024),
    summary: text(entries.get("summary"), "summary", 8_192, { empty: true }),
    content: text(
      entries.get("content"),
      "content",
      MAX_MEMORY_RECORD_CONTENT_BYTES,
      {
        empty: true,
      },
    ),
    evidence: strictStrings(entries.get("evidence"), "evidence", 20, 2_048),
    tags: strictStrings(entries.get("tags"), "tags", 20, 128).map((tag) => {
      if (!SAFE_TOKEN.test(tag)) invalid("tags 无效");
      return tag;
    }),
    sourceUrl: normalizeUrl(entries.get("sourceUrl")),
    subjectNumber,
  };
  if (new Set(normalized.tags).size !== normalized.tags.length) {
    invalid("tags 重复");
  }
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
    MAX_MEMORY_RECORD_BYTES
  ) {
    invalid("统一记忆记录过大");
  }
  const digest = memoryRecordDigest(normalized);
  return Object.freeze({
    recordId: `memory-${digest}`,
    contentDigest: digest,
    ...structuredClone(normalized),
  });
}

export function projectMemoryRecord(record) {
  return structuredClone({
    id: record.recordId,
    title: record.title,
    summary: record.summary,
    repository: record.repository || "",
    number: record.subjectNumber,
    event: record.eventType,
    createdAt: record.occurredAt,
    sourceUrl: record.sourceUrl,
    roleId: record.roleId,
    tags: record.tags,
    source: record.source,
  });
}
