import {
  MAX_MEMORY_RECORD_BYTES,
  MAX_MEMORY_RECORD_CONTENT_BYTES,
  normalizeMemoryRecord,
} from "../domain/memory-record.js";
import {
  bindMemoryAppendBatch,
  memoryAppendCount,
  strictDataArray,
  strictExactFields,
  strictOwnDataEntries,
} from "./memory-import-boundary.js";

const SESSION_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "sessionId",
  "occurredAt",
  "title",
  "roleId",
  "repository",
  "entries",
]);
const REQUIRED_SESSION_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "sessionId",
  "occurredAt",
  "title",
  "entries",
]);
const ENTRY_KEYS = Object.freeze(["role", "occurredAt", "content"]);
const ENTRY_ROLES = new Set(["user", "assistant", "system", "tool"]);
const SAFE_PROVIDER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SAFE_SESSION_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const SAFE_ROLE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_SESSION_ENTRIES = 5_000;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_RECORDS = 160;
const PROBE_INDEX = 999_999;

export class LocalSessionImporterError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "LocalSessionImporterError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function inputError(message, statusCode = 400, cause) {
  return new LocalSessionImporterError(
    statusCode === 413
      ? "LOCAL_SESSION_IMPORT_TOO_LARGE"
      : "LOCAL_SESSION_IMPORT_INVALID",
    message,
    statusCode,
    cause === undefined ? undefined : { cause },
  );
}

function ownDataEntries(value, name, error = inputError(`${name} 无效`)) {
  return strictOwnDataEntries(value, error);
}

function exactFields(
  value,
  allowed,
  required,
  name,
  error = inputError(`${name} 字段无效`),
) {
  return strictExactFields(value, allowed, required, error);
}

function strictArray(
  value,
  maximum,
  name,
  { minimum = 0, error = inputError(`${name} 无效`) } = {},
) {
  return strictDataArray(value, maximum, { minimum, error });
}

function text(value, name, maximumBytes, pattern) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw inputError(`${name} 无效`);
  }
  return value;
}

function timestamp(value, name) {
  const result = text(value, name, 64);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    throw inputError(`${name} 无效`);
  }
  return result;
}

function optionalRole(fields) {
  if (!fields.has("roleId") || fields.get("roleId") === null) return null;
  return text(fields.get("roleId"), "roleId", 128, SAFE_ROLE);
}

function optionalRepository(fields) {
  if (!fields.has("repository") || fields.get("repository") === null) {
    return null;
  }
  return text(fields.get("repository"), "repository", 256, REPOSITORY);
}

function normalizeEntry(value, index) {
  const name = `entries[${index}]`;
  const fields = exactFields(value, ENTRY_KEYS, ENTRY_KEYS, name);
  const role = fields.get("role");
  if (!ENTRY_ROLES.has(role)) throw inputError(`${name}.role 无效`);
  const content = fields.get("content");
  if (typeof content !== "string") {
    throw inputError(`${name}.content 无效`);
  }
  return {
    role,
    occurredAt: timestamp(fields.get("occurredAt"), `${name}.occurredAt`),
    content,
  };
}

function normalizeEntries(value) {
  const supplied = strictArray(value, MAX_SESSION_ENTRIES, "entries", {
    minimum: 1,
  });
  return supplied.map(normalizeEntry);
}

function normalizeSession(value) {
  const fields = exactFields(
    value,
    SESSION_KEYS,
    REQUIRED_SESSION_KEYS,
    "local session",
  );
  if (fields.get("schemaVersion") !== 1) {
    throw inputError("schemaVersion 无效");
  }
  const session = {
    schemaVersion: 1,
    provider: text(fields.get("provider"), "provider", 64, SAFE_PROVIDER),
    sessionId: text(
      fields.get("sessionId"),
      "sessionId",
      256,
      SAFE_SESSION_ID,
    ),
    occurredAt: timestamp(fields.get("occurredAt"), "occurredAt"),
    title: text(fields.get("title"), "title", 1_024),
    roleId: optionalRole(fields),
    repository: optionalRepository(fields),
    entries: normalizeEntries(fields.get("entries")),
  };
  if (Buffer.byteLength(JSON.stringify(session), "utf8") > MAX_SESSION_BYTES) {
    throw inputError("本地会话超过导入容量限制", 413);
  }
  return session;
}

function transcriptContent(session, chunkIndex, entries) {
  return JSON.stringify({
    schemaVersion: 1,
    trust: "untrusted",
    provider: session.provider,
    sessionId: session.sessionId,
    sessionOccurredAt: session.occurredAt,
    chunkIndex,
    entries,
  });
}

function fragment(entry, entryIndex, partIndex, partCount, content) {
  return {
    entryIndex,
    partIndex,
    partCount,
    role: entry.role,
    occurredAt: entry.occurredAt,
    content,
  };
}

function fragmentFits(session, entry, entryIndex, content) {
  const probe = fragment(
    entry,
    entryIndex,
    PROBE_INDEX,
    PROBE_INDEX,
    content,
  );
  return transcriptFitsRecord(session, PROBE_INDEX, [probe]);
}

function transcriptFitsRecord(session, chunkIndex, entries) {
  const content = transcriptContent(session, chunkIndex, entries);
  return (
    Buffer.byteLength(content, "utf8") <= MAX_MEMORY_RECORD_CONTENT_BYTES &&
    Buffer.byteLength(
      JSON.stringify(memoryRecord(session, content, chunkIndex - 1)),
      "utf8",
    ) <= MAX_MEMORY_RECORD_BYTES
  );
}

function splitEntryContent(session, entry, entryIndex, content) {
  if (fragmentFits(session, entry, entryIndex, content)) return [content];
  const characters = [...content];
  const parts = [];
  let offset = 0;
  while (offset < characters.length) {
    let lower = 1;
    let upper = Math.min(
      characters.length - offset,
      MAX_MEMORY_RECORD_CONTENT_BYTES,
    );
    let fittingLength = 0;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = characters.slice(offset, offset + middle).join("");
      if (fragmentFits(session, entry, entryIndex, candidate)) {
        fittingLength = middle;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    if (fittingLength === 0) {
      throw inputError("会话条目无法放入记忆记录", 413);
    }
    parts.push(
      characters.slice(offset, offset + fittingLength).join(""),
    );
    offset += fittingLength;
  }
  return parts;
}

function transcriptFragments(session) {
  return session.entries.flatMap((entry, entryIndex) => {
    const parts = splitEntryContent(
      session,
      entry,
      entryIndex,
      entry.content,
    );
    return parts.map((content, partIndex) =>
      fragment(
        entry,
        entryIndex,
        partIndex,
        parts.length,
        content,
      )
    );
  });
}

function chunkTranscript(session) {
  const chunks = [];
  let entries = [];
  let chunkIndex = 1;
  for (const entry of transcriptFragments(session)) {
    const candidate = [...entries, entry];
    if (transcriptFitsRecord(session, chunkIndex, candidate)) {
      entries = candidate;
      continue;
    }
    if (entries.length === 0) {
      throw inputError("会话条目无法放入记忆记录", 413);
    }
    chunks.push(transcriptContent(session, chunkIndex, entries));
    chunkIndex += 1;
    entries = [entry];
  }
  if (entries.length > 0) {
    chunks.push(transcriptContent(session, chunkIndex, entries));
  }
  return chunks;
}

function sourceId(session, chunkIndex) {
  return `${session.provider}:${session.sessionId}:chunk:${String(
    chunkIndex,
  ).padStart(6, "0")}`;
}

function memoryRecord(session, content, chunkIndex) {
  const chunkNumber = chunkIndex + 1;
  return {
    schemaVersion: 1,
    source: {
      kind: "local-session",
      id: sourceId(session, chunkNumber),
    },
    occurredAt: session.occurredAt,
    roleId: session.roleId,
    repository: session.repository,
    eventType: "session.imported",
    title: session.title,
    summary: `Imported untrusted ${session.provider} session transcript chunk ${
      chunkNumber
    }`,
    content,
    evidence: [],
    tags: ["session", "untrusted"],
    sourceUrl: null,
    subjectNumber: null,
  };
}

function preflightRecords(session) {
  const chunks = chunkTranscript(session);
  if (chunks.length > MAX_SESSION_RECORDS) {
    throw inputError("本地会话需要过多记忆记录", 413);
  }
  return chunks.map((content, chunkIndex) => {
    try {
      const normalized = normalizeMemoryRecord(
        memoryRecord(session, content, chunkIndex),
      );
      const { recordId, contentDigest: _contentDigest, ...record } = normalized;
      return { recordId, record: structuredClone(record) };
    } catch (cause) {
      throw inputError("本地会话无法转换为记忆记录", 400, cause);
    }
  });
}

function constructorMemoryProducer(options) {
  const error = new TypeError("LocalSessionImporter options are invalid");
  const entries = ownDataEntries(options, "LocalSessionImporter options", error);
  if (entries.length !== 1 || entries[0][0] !== "memoryProducer") throw error;
  return entries[0][1];
}

export class LocalSessionImporter {
  #appendBatch;

  constructor(options = {}) {
    this.#appendBatch = bindMemoryAppendBatch(constructorMemoryProducer(options));
    Object.freeze(this);
  }

  async importSession(value) {
    const session = normalizeSession(value);
    const records = preflightRecords(session);
    const result = await this.#appendBatch({
      records: records.map(({ record }) => structuredClone(record)),
    });
    const added = memoryAppendCount(result, records);
    return Object.freeze({
      schemaVersion: 1,
      provider: session.provider,
      sessionId: session.sessionId,
      chunkCount: records.length,
      added,
      recordIds: Object.freeze(records.map(({ recordId }) => recordId)),
    });
  }
}
