import {
  memoryRecordForWorkGraphMemoryEvent,
  normalizeWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../domain/work-graph-memory-event.js";
import { normalizeMemoryRecord } from "../domain/memory-record.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const WRITE_BATCH = 100;
const SAFE_ROLE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GRAPH_BATCH_LIMIT = 100;

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function plainData(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safeText(value, maximum = 8_192) {
  if (typeof value !== "string") return "";
  let result = "";
  let bytes = 0;
  for (const character of value.replace(INVALID_CONTROL, " ")) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximum) break;
    bytes += size;
    result += character;
  }
  return result;
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function safeTimestamp(...values) {
  return values.find(validTimestamp) || null;
}

function safeRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value) ? value : null;
}

function safeRole(value) {
  return typeof value === "string" && SAFE_ROLE.test(value) ? value : null;
}

function safeToken(value, fallback) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringList(value, maximum = 20) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return [];
  }
  const result = [];
  for (let index = 0; index < Math.min(value.length, maximum); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) return [];
    const entry = safeText(descriptor.value, 2_048);
    if (entry.trim()) result.push(entry);
  }
  return result;
}

function dataList(value, maximum, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return null;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function safeJson(value, maximum = 32 * 1024) {
  try {
    return safeText(JSON.stringify(value), maximum);
  } catch {
    return "";
  }
}

function githubUrl(repository, number, eventType) {
  if (!repository || !number) return null;
  const kind = eventType?.startsWith("pull_request.") ? "pull" : "issues";
  return `https://github.com/${repository}/${kind}/${number}`;
}

function workItemRecord(raw) {
  const item = plainData(raw);
  const event = plainData(currentWorkItemEvent(item));
  const subject = plainData(event?.subject);
  const target = plainData(item?.currentTarget);
  const payload = plainData(event?.payload);
  const occurredAt = safeTimestamp(item?.updatedAt, item?.createdAt, event?.occurredAt);
  const itemId = safeText(item?.itemId, 256);
  if (!itemId || !occurredAt) return null;
  const repository = safeRepository(subject?.repository);
  const number = safeNumber(subject?.number);
  const status = safeToken(item.status, "unknown");
  const targetRole = target?.type === "role" ? safeRole(target.id) : null;
  return {
    schemaVersion: 1,
    source: {
      kind: "work-item",
      id: `${itemId}:revision:${Number.isSafeInteger(item.revision) ? item.revision : 0}`,
    },
    occurredAt,
    roleId: targetRole,
    repository,
    eventType: `work.${status}`,
    title: safeText(payload?.title || subject?.id || itemId, 1_024),
    summary: safeText(
      `${status} · ${target?.type || "target"}:${target?.id || "unknown"}${item.statusReason ? ` · ${item.statusReason}` : ""}`,
      8_192,
    ),
    content: safeJson({
      assignmentId: item.assignmentId,
      eventType: event?.eventType,
      target,
      status,
      attempt: item.attempt,
      decisionContext: item.decisionContext,
    }),
    evidence: [],
    tags: ["work", status, ...(targetRole ? [targetRole] : [])],
    sourceUrl: githubUrl(repository, number, event?.eventType),
    subjectNumber: number,
  };
}

function timelineRecord(raw, itemById) {
  const entry = plainData(raw);
  const timelineId = safeText(entry?.timelineId, 256);
  const occurredAt = safeTimestamp(entry?.at);
  if (!timelineId || !occurredAt) return null;
  const item = itemById.get(entry.itemId);
  const event = plainData(currentWorkItemEvent(item));
  const subject = plainData(event?.subject);
  const repository = safeRepository(subject?.repository);
  const number = safeNumber(subject?.number);
  const type = safeToken(entry.type, "unknown");
  return {
    schemaVersion: 1,
    source: { kind: "work-timeline", id: timelineId },
    occurredAt,
    roleId: safeRole(entry.actorId),
    repository,
    eventType: `timeline.${type}`,
    title: `工作时间线：${type}`,
    summary: safeText(entry.itemId || "全局工作事件", 8_192),
    content: safeJson(entry.details),
    evidence: [],
    tags: ["timeline", type],
    sourceUrl: githubUrl(repository, number, event?.eventType),
    subjectNumber: number,
  };
}

function legacyRecord(raw) {
  const memory = plainData(raw);
  const id = safeText(memory?.id, 512);
  const occurredAt = safeTimestamp(memory?.createdAt);
  if (!id || !occurredAt) return null;
  const repository = safeRepository(memory.repository);
  const number = safeNumber(memory.number);
  const eventType = safeToken(memory.event, "observation");
  let sourceUrl = null;
  try {
    if (typeof memory.sourceUrl === "string") {
      const url = new URL(memory.sourceUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        sourceUrl = url.toString();
      }
    }
  } catch {
    sourceUrl = null;
  }
  return {
    schemaVersion: 1,
    source: { kind: "legacy-pr-memory", id },
    occurredAt,
    roleId: safeRole(memory.roleId) || "pr-reviewer",
    repository,
    eventType,
    title: safeText(memory.title || id, 1_024),
    summary: safeText(memory.summary, 8_192),
    content: safeJson({
      steps: stringList(memory.steps, 20),
      reviewBody: safeText(memory.reviewBody, 8_192),
      decision: safeText(memory.decision, 1_024),
      sourceId: safeText(memory.sourceId, 512),
      brain: plainData(memory.brain),
    }),
    evidence: stringList(memory.evidence, 20),
    tags: ["legacy", "pr-reviewer", "derived"],
    sourceUrl,
    subjectNumber: number,
  };
}

function validPage(value) {
  const page = plainData(value);
  if (!page || !Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
    throw new TypeError("memory projection source page is invalid");
  }
  return page;
}

function exactProjectionObject(value, keys, message) {
  const data = plainData(value);
  if (
    data === null ||
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) {
    throw new TypeError(message);
  }
  return data;
}

function nonNegativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(message);
  return value;
}

function strictProjectionList(value, maximum, message) {
  const result = dataList(value, maximum);
  if (result === null) throw new TypeError(message);
  return result;
}

function normalizeGraphProjectionBatch(value) {
  const message = "task graph memory projection source batch is invalid";
  const batch = exactProjectionObject(
    value,
    ["cursor", "highWatermark", "items"],
    message,
  );
  const cursor = nonNegativeInteger(batch.cursor, message);
  const highWatermark = nonNegativeInteger(batch.highWatermark, message);
  if (highWatermark < cursor) throw new TypeError(message);
  let items;
  try {
    items = strictProjectionList(batch.items, GRAPH_BATCH_LIMIT, message)
      .map((event) => normalizeWorkGraphMemoryEvent(event));
  } catch {
    throw new TypeError(message);
  }
  if (items.length === 0) {
    if (cursor !== highWatermark) throw new TypeError(message);
    return { cursor, highWatermark, items };
  }
  for (let index = 0; index < items.length; index += 1) {
    const event = items[index];
    if (event.sequence !== cursor + index + 1) throw new TypeError(message);
    if (index > 0 && event.previousDigest !== items[index - 1].eventDigest) {
      throw new TypeError(message);
    }
  }
  if (items.at(-1).sequence > highWatermark) throw new TypeError(message);
  return { cursor, highWatermark, items };
}

function normalizeGraphAppendResult(value, expectedRecords) {
  const message = "task graph memory append receipt is invalid";
  const result = plainData(value);
  if (
    result === null ||
    Object.keys(result).some((key) => !["added", "items", "health"].includes(key)) ||
    !Object.hasOwn(result, "added") ||
    !Object.hasOwn(result, "items")
  ) {
    throw new TypeError(message);
  }
  const added = nonNegativeInteger(result.added, message);
  const receipts = strictProjectionList(
    result.items,
    expectedRecords.length,
    message,
  );
  if (receipts.length !== expectedRecords.length || added > receipts.length) {
    throw new TypeError(message);
  }
  let created = 0;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = exactProjectionObject(
      receipts[index],
      ["recordId", "created"],
      message,
    );
    if (
      receipt.recordId !== expectedRecords[index].recordId ||
      typeof receipt.created !== "boolean"
    ) {
      throw new TypeError(message);
    }
    if (receipt.created) created += 1;
  }
  if (created !== added) throw new TypeError(message);
  return { added };
}

function normalizeGraphAckResult(value, event, minimumHighWatermark) {
  const message = "task graph memory acknowledgement is invalid";
  const result = exactProjectionObject(
    value,
    ["status", "cursor", "highWatermark"],
    message,
  );
  const cursor = nonNegativeInteger(result.cursor, message);
  const highWatermark = nonNegativeInteger(result.highWatermark, message);
  if (
    !["applied", "already"].includes(result.status) ||
    cursor !== event.sequence ||
    highWatermark < minimumHighWatermark ||
    highWatermark < cursor
  ) {
    throw new TypeError(message);
  }
  return { cursor, highWatermark };
}

export class MemoryProjector {
  #appendBatch;
  #graphAckBatch;
  #graphReadBatch;
  #ledger;
  #store;
  #inFlight = null;

  constructor({
    memoryProducer,
    ledgerView,
    graphProjectionSource,
    store,
  } = {}) {
    this.#appendBatch = requirePort(
      memoryProducer,
      ["appendBatch"],
      "memoryProducer",
    ).appendBatch;
    this.#ledger = requirePort(
      ledgerView,
      ["listItems", "listTimeline"],
      "ledgerView",
    );
    const graphSource = requirePort(
      graphProjectionSource,
      ["readBatch", "ackBatch"],
      "graphProjectionSource",
    );
    this.#graphReadBatch = graphSource.readBatch;
    this.#graphAckBatch = graphSource.ackBatch;
    if (!store || typeof store.read !== "function") {
      throw new TypeError("MemoryProjector requires a store");
    }
    this.#store = store;
  }

  runCycle() {
    if (this.#inFlight) return this.#inFlight;
    const execution = Promise.resolve().then(() => this.#run());
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run() {
    const [items, timeline, legacy, graphBatch] = await Promise.all([
      this.#readAll(this.#ledger.listItems),
      this.#readAll(this.#ledger.listTimeline),
      this.#store.read("pr-employee-memory", []),
      this.#graphReadBatch({ limit: GRAPH_BATCH_LIMIT }),
    ]);
    const graph = normalizeGraphProjectionBatch(graphBatch);
    const itemById = new Map(items.map((item) => [item.itemId, item]));
    const projected = [
      ...items.map(workItemRecord),
      ...timeline.map((entry) => timelineRecord(entry, itemById)),
      ...(Array.isArray(legacy) ? legacy.map(legacyRecord) : []),
    ].filter(Boolean);
    let added = 0;
    for (let index = 0; index < projected.length; index += WRITE_BATCH) {
      const result = await this.#appendBatch({
        records: projected.slice(index, index + WRITE_BATCH),
      });
      added += Number(result?.added) || 0;
    }
    let graphAdded = 0;
    let graphCursor = graph.cursor;
    let graphHighWatermark = graph.highWatermark;
    if (graph.items.length > 0) {
      const records = graph.items.map(memoryRecordForWorkGraphMemoryEvent);
      const expectedRecords = records.map((record) => normalizeMemoryRecord(record));
      graphAdded = normalizeGraphAppendResult(
        await this.#appendBatch({ records }),
        expectedRecords,
      ).added;
      const acknowledgement = normalizeGraphAckResult(
        await this.#graphAckBatch({
          receipts: graph.items.map(workGraphMemoryRecordReceipt),
        }),
        graph.items.at(-1),
        graphHighWatermark,
      );
      graphCursor = acknowledgement.cursor;
      graphHighWatermark = acknowledgement.highWatermark;
    }
    return {
      observed: projected.length + graph.items.length,
      added: added + graphAdded,
      workItems: items.length,
      timeline: timeline.length,
      legacy: Array.isArray(legacy) ? legacy.length : 0,
      graph: {
        observed: graph.items.length,
        added: graphAdded,
        acknowledged: graphCursor - graph.cursor,
        cursor: graphCursor,
        highWatermark: graphHighWatermark,
        pending: graphHighWatermark - graphCursor,
      },
    };
  }

  async #readAll(method) {
    const result = [];
    let cursor;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = validPage(await method({
        limit: PAGE_SIZE,
        order: "oldest",
        ...(cursor ? { cursor } : {}),
      }));
      result.push(...page.items);
      if (page.nextCursor === null) return result;
      if (seen.has(page.nextCursor)) {
        throw new TypeError("memory projection pagination did not advance");
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new TypeError("memory projection exceeded its page bound");
  }
}
