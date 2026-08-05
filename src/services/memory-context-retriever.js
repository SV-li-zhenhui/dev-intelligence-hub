import { normalizeMemoryAnswerRequest } from "../domain/memory-answer-contract.js";
import {
  memoryRecordDigest,
  normalizeMemoryRecord,
} from "../domain/memory-record.js";

const DEFAULT_MAXIMUM_RECORDS = 12;
const DEFAULT_MAXIMUM_CONTEXT_BYTES = 112 * 1024;
const RETRIEVAL_VERSION = "lexical-v1";
const PROMPT_VERSION = "cited-memory-v1";
const MEMORY_ID = /^memory-[a-f0-9]{64}$/;
const RECORD_KEYS = Object.freeze([
  "recordId",
  "contentDigest",
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
]);
const RAW_RECORD_KEYS = Object.freeze(
  RECORD_KEYS.filter((key) => !["recordId", "contentDigest"].includes(key)),
);
const CLASS_ORDER = Object.freeze(["requirements", "code", "memory"]);

export class MemoryContextRetrieverError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "MemoryContextRetrieverError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function retrieverError(code, message, statusCode, cause) {
  return new MemoryContextRetrieverError(
    code,
    message,
    statusCode,
    cause === undefined ? undefined : { cause },
  );
}

function dataEntries(value, name, errorFactory = () =>
  retrieverError("MEMORY_CONTEXT_INVALID", `${name} 无效`, 400)) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw errorFactory();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw errorFactory();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name, errorFactory) {
  const entries = dataEntries(value, name, errorFactory);
  const fields = new Map(entries);
  if (fields.size !== keys.length || keys.some((key) => !fields.has(key))) {
    throw (errorFactory?.() ??
      retrieverError("MEMORY_CONTEXT_INVALID", `${name} 字段无效`, 400));
  }
  return fields;
}

function bindPort(value, methods, name) {
  const error = () => new TypeError(`${name} is invalid`);
  const fields = new Map(dataEntries(value, name, error));
  if (
    fields.size !== methods.length ||
    methods.some((method) =>
      !fields.has(method) || typeof fields.get(method) !== "function")
  ) {
    throw error();
  }
  return Object.freeze(
    Object.fromEntries(methods.map((method) => [method, fields.get(method).bind(value)])),
  );
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function strictArray(value, maximum, name, errorFactory) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw errorFactory();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw errorFactory();
    }
    result.push(descriptor.value);
  }
  return result;
}

function normalizeInput(value) {
  const fields = exact(value, ["question", "retrieval"], "memory context request");
  return normalizeMemoryAnswerRequest({
    schemaVersion: 1,
    question: fields.get("question"),
    mode: "configured",
    retrieval: fields.get("retrieval"),
  });
}

function normalizeSearchResult(value, maximumRecords) {
  const invalid = () =>
    retrieverError(
      "MEMORY_SEARCH_RESULT_INVALID",
      "本地记忆检索结果无效",
      503,
    );
  const fields = exact(
    value,
    ["items", "nextCursor", "totalMatched", "indexHealthy"],
    "memory search result",
    invalid,
  );
  const items = strictArray(fields.get("items"), maximumRecords, "items", invalid);
  const recordIds = items.map((item) => {
    const itemFields = new Map(dataEntries(item, "memory search item", invalid));
    const id = itemFields.get("id");
    if (typeof id !== "string" || !MEMORY_ID.test(id)) throw invalid();
    return id;
  });
  if (
    new Set(recordIds).size !== recordIds.length ||
    !Number.isSafeInteger(fields.get("totalMatched")) ||
    fields.get("totalMatched") < recordIds.length ||
    typeof fields.get("indexHealthy") !== "boolean" ||
    !(
      fields.get("nextCursor") === null ||
      typeof fields.get("nextCursor") === "string"
    )
  ) {
    throw invalid();
  }
  return {
    recordIds,
    totalMatched: fields.get("totalMatched"),
    indexHealthy: fields.get("indexHealthy"),
    hasMore: fields.get("nextCursor") !== null,
  };
}

function rawRecord(value, invalid) {
  const fields = exact(value, RECORD_KEYS, "memory context record", invalid);
  let normalized;
  try {
    normalized = normalizeMemoryRecord(
      Object.fromEntries(RAW_RECORD_KEYS.map((key) => [key, fields.get(key)])),
    );
  } catch {
    throw invalid();
  }
  if (
    normalized.recordId !== fields.get("recordId") ||
    normalized.contentDigest !== fields.get("contentDigest")
  ) {
    throw invalid();
  }
  return normalized;
}

function labels(value, invalid) {
  const fields = exact(
    value,
    ["authority", "lifecycle"],
    "memory context labels",
    invalid,
  );
  if (
    !new Set(["raw", "derived"]).has(fields.get("authority")) ||
    !new Set(["current", "obsolete"]).has(fields.get("lifecycle"))
  ) {
    throw invalid();
  }
  return Object.freeze({
    authority: fields.get("authority"),
    lifecycle: fields.get("lifecycle"),
  });
}

function normalizeReadResult(value, expectedIds) {
  const invalid = () =>
    retrieverError(
      "MEMORY_CONTEXT_READ_INVALID",
      "本地记忆原始记录读取结果无效",
      503,
    );
  const fields = exact(
    value,
    ["journalRevision", "items"],
    "memory context read result",
    invalid,
  );
  const revision = fields.get("journalRevision");
  const items = strictArray(fields.get("items"), expectedIds.length, "items", invalid);
  if (!Number.isSafeInteger(revision) || revision < 0 || items.length !== expectedIds.length) {
    throw invalid();
  }
  const records = items.map((item, index) => {
    const itemFields = exact(
      item,
      ["record", "labels"],
      "memory context item",
      invalid,
    );
    const record = rawRecord(itemFields.get("record"), invalid);
    if (record.recordId !== expectedIds[index]) throw invalid();
    return Object.freeze({
      ...structuredClone(record),
      labels: labels(itemFields.get("labels"), invalid),
    });
  });
  return { journalRevision: revision, records };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function digestContext(question, records) {
  return memoryRecordDigest({
    schemaVersion: 1,
    retrievalVersion: RETRIEVAL_VERSION,
    promptVersion: PROMPT_VERSION,
    question,
    records,
  });
}

function packRecords(question, records, maximumContextBytes) {
  const selected = [];
  for (const record of records) {
    const candidate = [...selected, record];
    if (
      serializedBytes({
        schemaVersion: 1,
        retrievalVersion: RETRIEVAL_VERSION,
        promptVersion: PROMPT_VERSION,
        question,
        records: candidate,
      }) > maximumContextBytes
    ) {
      break;
    }
    selected.push(record);
  }
  if (records.length > 0 && selected.length === 0) {
    throw retrieverError(
      "MEMORY_CONTEXT_TOO_LARGE",
      "单条记忆记录超过问答上下文限制",
      413,
    );
  }
  return selected;
}

function dataClasses(question, records) {
  const classes = new Set(["memory"]);
  // Questions and historical free-form records have no authoritative field-level
  // classification yet. Treat both as potentially containing requirements and
  // code so a remote brain must receive explicit authorization for every class.
  if (question || records.length > 0) {
    classes.add("requirements");
    classes.add("code");
  }
  return CLASS_ORDER.filter((name) => classes.has(name));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export class MemoryContextRetriever {
  #search;
  #readRecords;
  #maximumRecords;
  #maximumContextBytes;

  constructor({
    memorySearch,
    contextReader,
    maximumRecords = DEFAULT_MAXIMUM_RECORDS,
    maximumContextBytes = DEFAULT_MAXIMUM_CONTEXT_BYTES,
  } = {}) {
    this.#search = bindPort(memorySearch, ["search"], "memorySearch").search;
    this.#readRecords = bindPort(
      contextReader,
      ["readRecords"],
      "contextReader",
    ).readRecords;
    this.#maximumRecords = boundedInteger(
      maximumRecords,
      "maximumRecords",
      1,
      20,
    );
    this.#maximumContextBytes = boundedInteger(
      maximumContextBytes,
      "maximumContextBytes",
      96 * 1024,
      112 * 1024,
    );
    Object.freeze(this);
  }

  async retrieve(value) {
    const input = normalizeInput(value);
    let recordIds;
    let totalMatched;
    let indexHealthy;
    let searchTruncated = false;
    if (input.retrieval.kind === "query") {
      const filters = input.retrieval.filters;
      const searchResult = normalizeSearchResult(
        await this.#search({
          q: filters.query,
          roleId: filters.roleId,
          repository: filters.repository,
          eventType: filters.eventType,
          from: filters.from,
          to: filters.to,
          limit: this.#maximumRecords,
        }),
        this.#maximumRecords,
      );
      recordIds = searchResult.recordIds;
      totalMatched = searchResult.totalMatched;
      indexHealthy = searchResult.indexHealthy;
      searchTruncated = searchResult.hasMore;
    } else {
      if (input.retrieval.recordIds.length > this.#maximumRecords) {
        throw retrieverError(
          "MEMORY_CONTEXT_BINDING_INVALID",
          "记忆上下文记录数量超过当前限制",
          409,
        );
      }
      recordIds = [...input.retrieval.recordIds];
      totalMatched = recordIds.length;
      indexHealthy = null;
    }

    const hydrated = recordIds.length
      ? normalizeReadResult(
          await this.#readRecords({ recordIds }),
          recordIds,
        )
      : { journalRevision: null, records: [] };
    const records = packRecords(
      input.question,
      hydrated.records,
      this.#maximumContextBytes,
    );
    if (
      input.retrieval.kind === "context" &&
      records.length !== hydrated.records.length
    ) {
      throw retrieverError(
        "MEMORY_CONTEXT_BINDING_INVALID",
        "记忆上下文无法在当前限制内复现",
        409,
      );
    }
    const contextDigest = digestContext(input.question, records);
    if (
      input.retrieval.kind === "context" &&
      contextDigest !== input.retrieval.contextDigest
    ) {
      throw retrieverError(
        "MEMORY_CONTEXT_BINDING_STALE",
        "记忆上下文已变化，请重新检索",
        409,
      );
    }
    const packet = {
      schemaVersion: 1,
      retrievalVersion: RETRIEVAL_VERSION,
      promptVersion: PROMPT_VERSION,
      retrievalKind: input.retrieval.kind,
      question: input.question,
      contextDigest,
      journalRevision: hydrated.journalRevision,
      recordIds: records.map(({ recordId }) => recordId),
      records,
      dataClasses: dataClasses(input.question, records),
      citableRecordIds: records
        .filter(
          ({ labels: valueLabels }) =>
            valueLabels.authority === "raw" &&
            valueLabels.lifecycle === "current",
        )
        .map(({ recordId }) => recordId),
      totalMatched,
      truncated:
        searchTruncated ||
        totalMatched > records.length ||
        hydrated.records.length > records.length,
      indexHealthy,
    };
    return deepFreeze(packet);
  }
}
