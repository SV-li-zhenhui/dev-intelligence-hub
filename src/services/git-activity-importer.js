import { normalizeMemoryRecord } from "../domain/memory-record.js";
import {
  bindMemoryAppendBatch,
  memoryAppendCount,
  strictDataArray,
  strictExactFields,
  strictOwnDataEntries,
} from "./memory-import-boundary.js";

const ACTIVITY_KEYS = Object.freeze(["schemaVersion", "repository", "commits"]);
const COMMIT_KEYS = Object.freeze([
  "oid",
  "occurredAt",
  "author",
  "subject",
  "body",
]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Git object IDs are SHA-1 (40 hex digits) or SHA-256 (64 hex digits).
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_COMMITS = 100;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 256;
const MAX_AUTHOR_BYTES = 512;
const MAX_SUBJECT_BYTES = 960;
const MAX_BODY_BYTES = 12 * 1_024;
const MEMORY_APPEND_BATCH_SIZE = 100;

export class GitActivityImporterError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "GitActivityImporterError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function inputError(message, statusCode = 400, cause) {
  return new GitActivityImporterError(
    statusCode === 413
      ? "GIT_ACTIVITY_IMPORT_TOO_LARGE"
      : "GIT_ACTIVITY_IMPORT_INVALID",
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

function text(value, name, maximumBytes, { empty = false, pattern } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && value.trim().length === 0) ||
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

function normalizeCommit(value, index) {
  const name = `commits[${index}]`;
  const fields = exactFields(value, COMMIT_KEYS, COMMIT_KEYS, name);
  const oid = text(fields.get("oid"), `${name}.oid`, 64, { pattern: OID });
  return {
    oid,
    occurredAt: timestamp(fields.get("occurredAt"), `${name}.occurredAt`),
    author: text(fields.get("author"), `${name}.author`, MAX_AUTHOR_BYTES),
    subject: text(fields.get("subject"), `${name}.subject`, MAX_SUBJECT_BYTES),
    body: text(fields.get("body"), `${name}.body`, MAX_BODY_BYTES, {
      empty: true,
    }),
  };
}

function normalizeActivity(value) {
  const fields = exactFields(
    value,
    ACTIVITY_KEYS,
    ACTIVITY_KEYS,
    "git activity",
  );
  if (fields.get("schemaVersion") !== 1) {
    throw inputError("schemaVersion 无效");
  }
  const repository = text(fields.get("repository"), "repository", MAX_REPOSITORY_BYTES, {
    pattern: REPOSITORY,
  });
  const supplied = strictArray(fields.get("commits"), MAX_COMMITS, "commits", {
    minimum: 1,
  });
  const commits = supplied.map(normalizeCommit);
  if (new Set(commits.map(({ oid }) => oid)).size !== commits.length) {
    throw inputError("commits 不得包含重复 oid");
  }
  const normalized = { schemaVersion: 1, repository, commits };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_IMPORT_BYTES) {
    throw inputError("Git 活动超过导入容量限制", 413);
  }
  return normalized;
}

function commitContent(activity, commit) {
  // This is deliberately a JSON data envelope. Commit messages are evidence,
  // not instructions, and never become executable fields or tool requests.
  return JSON.stringify({
    schemaVersion: 1,
    trust: "untrusted",
    repository: activity.repository,
    commit: {
      oid: commit.oid,
      occurredAt: commit.occurredAt,
      author: commit.author,
      subject: commit.subject,
      body: commit.body,
    },
  });
}

function memoryRecord(activity, commit) {
  return {
    schemaVersion: 1,
    source: {
      kind: "git-commit",
      id: `${activity.repository}:${commit.oid}`,
    },
    occurredAt: commit.occurredAt,
    roleId: null,
    repository: activity.repository,
    eventType: "git.commit",
    title: `${commit.oid.slice(0, 12)} ${commit.subject}`,
    summary: `${activity.repository} commit ${commit.oid}`,
    content: commitContent(activity, commit),
    evidence: [],
    tags: ["git", "code"],
    sourceUrl: null,
    subjectNumber: null,
  };
}

function preflightRecords(activity) {
  return activity.commits.map((commit) => {
    try {
      const normalized = normalizeMemoryRecord(memoryRecord(activity, commit));
      const { recordId, contentDigest: _contentDigest, ...record } = normalized;
      return { recordId, record: structuredClone(record) };
    } catch (cause) {
      throw inputError("Git 活动无法转换为记忆记录", 400, cause);
    }
  });
}

function constructorOptions(options) {
  const error = new TypeError("GitActivityImporter options are invalid");
  const entries = ownDataEntries(options, "GitActivityImporter options", error);
  if (entries.length !== 1 || entries[0][0] !== "memoryProducer") throw error;
  return entries[0][1];
}

export class GitActivityImporter {
  #appendBatch;

  constructor(options = {}) {
    this.#appendBatch = bindMemoryAppendBatch(
      constructorOptions(options),
    );
    Object.freeze(this);
  }

  async importCommits(value) {
    const activity = normalizeActivity(value);
    const records = preflightRecords(activity);
    let added = 0;
    for (
      let offset = 0;
      offset < records.length;
      offset += MEMORY_APPEND_BATCH_SIZE
    ) {
      const batch = records.slice(offset, offset + MEMORY_APPEND_BATCH_SIZE);
      const result = await this.#appendBatch({
        records: batch.map(({ record }) => structuredClone(record)),
      });
      added += memoryAppendCount(result, batch);
    }
    return Object.freeze({
      schemaVersion: 1,
      repository: activity.repository,
      commitCount: records.length,
      added,
      recordIds: Object.freeze(records.map(({ recordId }) => recordId)),
    });
  }
}
