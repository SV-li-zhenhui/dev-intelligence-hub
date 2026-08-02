import { createHash } from "node:crypto";
import { OperationQueue } from "../lib/operation-queue.js";
import {
  normalizeMemoryRecord,
  projectMemoryRecord,
} from "../domain/memory-record.js";

export const MEMORY_JOURNAL_KEY = "unified-memory-records";
export const MEMORY_INDEX_KEY = "unified-memory-index";
const MAX_BATCH = 100;
const DEFAULT_MAX_RECORDS = 20_000;
const DEFAULT_MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_ASSOCIATIONS = 250_000;
const MAX_RECORD_INDEX_TOKENS = 4_096;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SOURCE_KIND = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const INVALID_RECEIPT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const RECEIPT_KEYS = ["recordId", "contentDigest", "source"];
const RECEIPT_SOURCE_KEYS = ["kind", "id"];
const QUERY_KEYS = [
  "q",
  "roleId",
  "repository",
  "eventType",
  "from",
  "to",
  "limit",
  "cursor",
];

function memoryError(code, message, statusCode = 400, cause) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, statusCode },
  );
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, allowed, name) {
  const entries = dataEntries(value, name);
  if (entries.some(([key]) => !allowed.includes(key))) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 字段无效`);
  }
  return Object.fromEntries(entries);
}

function receiptUnverified() {
  return memoryError(
    "MEMORY_RECEIPT_UNVERIFIED",
    "无法验证持久记忆凭据",
    409,
  );
}

function receiptReference(value) {
  const error = receiptUnverified();
  try {
    const entries = new Map(dataEntries(value, "memory receipt"));
    const sourceEntries = new Map(
      dataEntries(entries.get("source"), "memory receipt source"),
    );
    if (
      entries.size !== RECEIPT_KEYS.length ||
      RECEIPT_KEYS.some((key) => !entries.has(key)) ||
      sourceEntries.size !== RECEIPT_SOURCE_KEYS.length ||
      RECEIPT_SOURCE_KEYS.some((key) => !sourceEntries.has(key))
    ) {
      throw error;
    }
    const recordId = entries.get("recordId");
    const contentDigest = entries.get("contentDigest");
    const kind = sourceEntries.get("kind");
    const id = sourceEntries.get("id");
    if (
      typeof contentDigest !== "string" ||
      !SHA256.test(contentDigest) ||
      recordId !== `memory-${contentDigest}` ||
      typeof kind !== "string" ||
      !SAFE_SOURCE_KIND.test(kind) ||
      typeof id !== "string" ||
      id.trim().length === 0 ||
      Buffer.byteLength(id, "utf8") > 512 ||
      INVALID_RECEIPT_CONTROL.test(id)
    ) {
      throw error;
    }
    return { recordId, contentDigest, source: { kind, id } };
  } catch {
    throw error;
  }
}

function strictArray(value, maximum, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} 无效`);
  }
  return value;
}

function emptyJournal() {
  return { schemaVersion: 1, revision: 0, records: [] };
}

function journalDigest(records) {
  return createHash("sha256")
    .update(records.map(({ recordId }) => recordId).join("\n"), "utf8")
    .digest("hex");
}

function storedRecord(value) {
  const entries = new Map(dataEntries(value, "stored memory record"));
  const recordId = entries.get("recordId");
  const contentDigest = entries.get("contentDigest");
  entries.delete("recordId");
  entries.delete("contentDigest");
  const normalized = normalizeMemoryRecord(Object.fromEntries(entries));
  if (
    normalized.recordId !== recordId ||
    normalized.contentDigest !== contentDigest
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录摘要不一致",
      503,
    );
  }
  return normalized;
}

function normalizeJournal(value, limits) {
  if (value === null) return emptyJournal();
  const state = exact(
    value,
    ["schemaVersion", "revision", "records"],
    "memory journal",
  );
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆状态无效",
      503,
    );
  }
  let rawRecords;
  try {
    rawRecords = strictArray(state.records, limits.maximumRecords, "records");
  } catch (error) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录集合无效",
      503,
      error,
    );
  }
  const records = rawRecords.map(storedRecord);
  if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录重复",
      503,
    );
  }
  const normalized = { schemaVersion: 1, revision: state.revision, records };
  if (serializedBytes(normalized) > limits.maximumStateBytes) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆状态超过容量限制",
      503,
    );
  }
  return normalized;
}

function serializedBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizedSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en");
}

function lexicalTerms(value) {
  return normalizedSearchText(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function indexTokens(value, maximum = Number.POSITIVE_INFINITY) {
  const tokens = new Set();
  let complete = true;
  const add = (token) => {
    if (tokens.has(token)) return true;
    if (tokens.size >= maximum) {
      complete = false;
      return false;
    }
    tokens.add(token);
    return true;
  };
  terms:
  for (const term of lexicalTerms(value)) {
    if (!/\p{Script=Han}/u.test(term)) {
      if (Buffer.byteLength(term, "utf8") <= 256 && !add(term)) break;
      continue;
    }
    const characters = [...term];
    for (const character of characters) {
      if (!add(character)) break terms;
    }
    for (const width of [2, 3]) {
      for (let index = 0; index + width <= characters.length; index += 1) {
        if (!add(characters.slice(index, index + width).join(""))) {
          break terms;
        }
      }
    }
  }
  return { tokens, complete };
}

function recordText(record) {
  return normalizedSearchText(
    [
      record.title,
      record.summary,
      record.content,
      ...record.evidence,
      ...record.tags,
      record.roleId,
      record.repository,
      record.eventType,
      record.source.kind,
      record.source.id,
    ].join("\n"),
  );
}

function buildIndex(records, revision) {
  const tokenMap = new Map();
  let associations = 0;
  let complete = true;
  records:
  for (const record of records) {
    const generated = indexTokens(recordText(record), MAX_RECORD_INDEX_TOKENS);
    if (!generated.complete) complete = false;
    for (const token of generated.tokens) {
      if (associations >= MAX_INDEX_ASSOCIATIONS) {
        complete = false;
        break records;
      }
      const ids = tokenMap.get(token) || [];
      ids.push(record.recordId);
      tokenMap.set(token, ids);
      associations += 1;
    }
  }
  const entries = Object.fromEntries(
    [...tokenMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([token, ids]) => [token, ids]),
  );
  return {
    persisted: {
      schemaVersion: 1,
      journalRevision: revision,
      journalDigest: journalDigest(records),
      complete,
      entries,
    },
    tokenMap,
    complete,
  };
}

function indexMatches(value, expected) {
  try {
    const index = exact(
      value,
      [
        "schemaVersion",
        "journalRevision",
        "journalDigest",
        "complete",
        "entries",
      ],
      "memory index",
    );
    return (
      index.schemaVersion === 1 &&
      index.journalRevision === expected.journalRevision &&
      index.journalDigest === expected.journalDigest &&
      index.complete === expected.complete &&
      index.entries !== null &&
      typeof index.entries === "object" &&
      !Array.isArray(index.entries)
    );
  } catch {
    return false;
  }
}

function isoFilter(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw memoryError("MEMORY_QUERY_INVALID", `${name} 无效`);
  }
  return value;
}

function optionalFilter(value, name, maximum = 256) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw memoryError("MEMORY_QUERY_INVALID", `${name} 无效`);
  }
  return value;
}

function encodeCursor(record) {
  return Buffer.from(
    JSON.stringify([record.occurredAt, record.recordId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw memoryError("MEMORY_QUERY_INVALID", "cursor 无效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      typeof parsed[1] !== "string" ||
      !/^memory-[a-f0-9]{64}$/.test(parsed[1])
    ) {
      throw new Error("invalid cursor");
    }
    return { occurredAt: parsed[0], recordId: parsed[1] };
  } catch {
    throw memoryError("MEMORY_QUERY_INVALID", "cursor 无效");
  }
}

function queryOptions(value) {
  const input = exact(value, QUERY_KEYS, "memory query");
  const limitValue = input.limit === undefined ? 30 : Number(input.limit);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    throw memoryError("MEMORY_QUERY_INVALID", "limit 无效");
  }
  const q = optionalFilter(input.q, "q", 1_024) || "";
  const from = isoFilter(input.from, "from");
  const to = isoFilter(input.to, "to");
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw memoryError("MEMORY_QUERY_INVALID", "时间范围无效");
  }
  return {
    q,
    roleId: optionalFilter(input.roleId, "roleId", 128),
    repository: optionalFilter(input.repository, "repository"),
    eventType: optionalFilter(input.eventType, "eventType", 128),
    from,
    to,
    limit: limitValue,
    cursor: decodeCursor(input.cursor),
  };
}

function newestFirst(left, right) {
  return (
    right.occurredAt.localeCompare(left.occurredAt, "en") ||
    right.recordId.localeCompare(left.recordId, "en")
  );
}

function candidateIds(index, q, indexComplete) {
  if (!indexComplete) return null;
  const tokens = [...indexTokens(q).tokens];
  if (!tokens.length) return null;
  let candidates = null;
  for (const token of tokens) {
    const ids = new Set(index.get(token) || []);
    candidates = candidates === null
      ? ids
      : new Set([...candidates].filter((id) => ids.has(id)));
    if (!candidates.size) break;
  }
  return candidates;
}

export class LocalMemoryJournal {
  #store;
  #exclusiveLease;
  #operationQueue;
  #limits;
  #journal = emptyJournal();
  #index = new Map();
  #indexComplete = true;
  #ready = false;
  #recovering = null;
  #lastIndexError = "";

  constructor({
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    maximumRecords = DEFAULT_MAX_RECORDS,
    maximumStateBytes = DEFAULT_MAX_STATE_BYTES,
  } = {}) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
      throw new TypeError("LocalMemoryJournal requires a durable store");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("LocalMemoryJournal requires an exclusive lease");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("operationQueue is invalid");
    }
    this.#store = store;
    this.#exclusiveLease = exclusiveLease;
    this.#operationQueue = operationQueue;
    this.#limits = Object.freeze({
      maximumRecords: positiveInteger(
        maximumRecords,
        "maximumRecords",
        100_000,
      ),
      maximumStateBytes: positiveInteger(
        maximumStateBytes,
        "maximumStateBytes",
        256 * 1024 * 1024,
      ),
    });
  }

  recover() {
    if (this.#ready) return Promise.resolve(this.getHealth());
    this.#recovering ||= this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        const stored = await this.#store.read(MEMORY_JOURNAL_KEY, null);
        const journal = normalizeJournal(stored, this.#limits);
        const built = buildIndex(journal.records, journal.revision);
        const storedIndex = await this.#store.read(MEMORY_INDEX_KEY, null);
        this.#journal = journal;
        this.#index = built.tokenMap;
        this.#indexComplete = built.complete;
        this.#lastIndexError = "";
        if (!indexMatches(storedIndex, built.persisted)) {
          await this.#persistIndex(built.persisted);
        }
        this.#ready = true;
        return this.getHealth();
      }),
    );
    return this.#recovering.finally(() => {
      this.#recovering = null;
    });
  }

  append(value) {
    return this.appendBatch({ records: [value] }).then(({ items }) => items[0]);
  }

  appendBatch(value) {
    const input = exact(value, ["records"], "append batch");
    if (!Object.hasOwn(input, "records")) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const supplied = strictArray(input.records, MAX_BATCH, "records");
    if (!supplied.length) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const normalized = supplied.map(normalizeMemoryRecord);
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => this.#append(normalized)),
    );
  }

  getHealth() {
    this.#assertReady();
    return Object.freeze({
      ready: true,
      revision: this.#journal.revision,
      recordCount: this.#journal.records.length,
      indexHealthy: !this.#lastIndexError,
      lastIndexError: this.#lastIndexError,
    });
  }

  search(value = {}) {
    this.#assertReady();
    const options = queryOptions(value);
    const candidates = candidateIds(
      this.#index,
      options.q,
      this.#indexComplete,
    );
    const queryTerms = lexicalTerms(options.q);
    const cursor = options.cursor;
    const matched = this.#journal.records
      .filter((record) => !candidates || candidates.has(record.recordId))
      .filter((record) => !options.roleId || record.roleId === options.roleId)
      .filter(
        (record) => !options.repository || record.repository === options.repository,
      )
      .filter(
        (record) => !options.eventType || record.eventType === options.eventType,
      )
      .filter(
        (record) => !options.from || record.occurredAt >= options.from,
      )
      .filter((record) => !options.to || record.occurredAt <= options.to)
      .filter((record) => {
        const haystack = recordText(record);
        return queryTerms.every((term) => haystack.includes(term));
      })
      .sort(newestFirst);
    const available = matched.filter(
      (record) => !cursor || newestFirst(record, cursor) > 0,
    );
    const selected = available.slice(0, options.limit);
    return {
      items: selected.map(projectMemoryRecord),
      nextCursor:
        available.length > selected.length && selected.length
          ? encodeCursor(selected.at(-1))
          : null,
      totalMatched: matched.length,
      indexHealthy: !this.#lastIndexError,
    };
  }

  verifyReceipt(value) {
    this.#assertReady();
    const expected = receiptReference(value);
    const record = this.#journal.records.find(
      ({ recordId }) => recordId === expected.recordId,
    );
    if (
      record?.contentDigest !== expected.contentDigest ||
      record.source.kind !== expected.source.kind ||
      record.source.id !== expected.source.id
    ) {
      throw receiptUnverified();
    }
    return structuredClone({ ...expected, persisted: true });
  }

  rebuildIndex() {
    this.#assertReady();
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        const built = buildIndex(
          this.#journal.records,
          this.#journal.revision,
        );
        await this.#store.write(MEMORY_INDEX_KEY, built.persisted);
        this.#index = built.tokenMap;
        this.#indexComplete = built.complete;
        this.#lastIndexError = "";
        return this.getHealth();
      }),
    );
  }

  async #append(records) {
    this.#assertReady();
    const byId = new Map(this.#journal.records.map((record) => [record.recordId, record]));
    const receipts = [];
    let added = 0;
    for (const record of records) {
      const existing = byId.get(record.recordId);
      if (existing) {
        if (existing.contentDigest !== record.contentDigest) {
          throw memoryError("MEMORY_ID_CONFLICT", "统一记忆 ID 冲突", 409);
        }
        receipts.push({ recordId: record.recordId, created: false });
        continue;
      }
      byId.set(record.recordId, record);
      receipts.push({ recordId: record.recordId, created: true });
      added += 1;
    }
    if (!added) {
      return { added: 0, items: structuredClone(receipts), health: this.getHealth() };
    }
    const candidate = {
      schemaVersion: 1,
      revision: this.#journal.revision + 1,
      records: [...byId.values()],
    };
    if (
      candidate.records.length > this.#limits.maximumRecords ||
      serializedBytes(candidate) > this.#limits.maximumStateBytes
    ) {
      throw memoryError(
        "MEMORY_CAPACITY_EXCEEDED",
        "统一记忆已达到本地容量上限",
        507,
      );
    }
    await this.#store.write(MEMORY_JOURNAL_KEY, candidate);
    this.#journal = candidate;
    const built = buildIndex(candidate.records, candidate.revision);
    this.#index = built.tokenMap;
    this.#indexComplete = built.complete;
    this.#lastIndexError = "";
    await this.#persistIndex(built.persisted);
    return {
      added,
      items: structuredClone(receipts),
      health: this.getHealth(),
    };
  }

  async #persistIndex(value) {
    try {
      await this.#store.write(MEMORY_INDEX_KEY, value);
    } catch (error) {
      this.#lastIndexError = String(error?.message || error).slice(0, 1_024);
    }
  }

  #assertReady() {
    if (!this.#ready) {
      throw memoryError(
        "MEMORY_NOT_READY",
        "统一记忆尚未恢复",
        503,
      );
    }
  }
}
