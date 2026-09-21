import {
  memoryRecordForCodeJobEvent,
  normalizeCodeJobMemoryEvent,
} from "../domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../domain/memory-record.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const APPEND_RESULT_KEYS = new Set(["added", "items", "health"]);
const RECEIPT_KEYS = ["recordId", "created"];
const ACK_RESULT_KEYS = ["status", "cursor", "highWatermark"];
const ACK_STATUSES = new Set(["applied", "already"]);

export class CodeJobMemoryProjectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeJobMemoryProjectorError";
    this.code = code;
    this.statusCode = 502;
  }
}

function protocolError(code, message) {
  return new CodeJobMemoryProjectorError(code, message);
}

function bindPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactObject(value, keys, error) {
  const entries = dataEntries(value, error);
  const fields = new Map(entries);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

function strictArray(value, maximum, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function nonNegativeInteger(value, error) {
  if (!Number.isSafeInteger(value) || value < 0) throw error;
  return value;
}

function cycleLimit(value = {}) {
  const error = new TypeError("runCycle options are invalid");
  const fields = dataEntries(value, error);
  if (fields.some(([key]) => key !== "limit")) throw error;
  const supplied = new Map(fields);
  const limit = supplied.has("limit") ? supplied.get("limit") : DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeBatch(value, limit) {
  const error = protocolError(
    "CODE_JOB_MEMORY_SOURCE_INVALID",
    "code job memory projection source batch is invalid",
  );
  const fields = exactObject(
    value,
    ["cursor", "highWatermark", "items"],
    error,
  );
  const cursor = nonNegativeInteger(fields.get("cursor"), error);
  const highWatermark = nonNegativeInteger(fields.get("highWatermark"), error);
  if (highWatermark < cursor) throw error;
  const supplied = strictArray(fields.get("items"), limit, error);
  let items;
  try {
    items = supplied.map((event) => normalizeCodeJobMemoryEvent(event));
  } catch {
    throw error;
  }
  if (items.length === 0) {
    if (cursor !== highWatermark) throw error;
    return { cursor, highWatermark, items };
  }
  for (let index = 0; index < items.length; index += 1) {
    const event = items[index];
    if (event.sequence !== cursor + index + 1) throw error;
    if (index > 0 && event.previousDigest !== items[index - 1].eventDigest) {
      throw error;
    }
  }
  if (items.at(-1).sequence > highWatermark) throw error;
  return { cursor, highWatermark, items };
}

function normalizeAppendResult(value, expectedRecords) {
  const error = protocolError(
    "CODE_JOB_MEMORY_APPEND_RECEIPT_INVALID",
    "code job memory append receipt is invalid",
  );
  const entries = dataEntries(value, error);
  if (
    entries.some(([key]) => !APPEND_RESULT_KEYS.has(key)) ||
    !entries.some(([key]) => key === "added") ||
    !entries.some(([key]) => key === "items")
  ) {
    throw error;
  }
  const fields = new Map(entries);
  const added = nonNegativeInteger(fields.get("added"), error);
  const supplied = strictArray(fields.get("items"), expectedRecords.length, error);
  if (supplied.length !== expectedRecords.length || added > supplied.length) {
    throw error;
  }
  const items = supplied.map((value, index) => {
    const receipt = exactObject(value, RECEIPT_KEYS, error);
    const recordId = receipt.get("recordId");
    const created = receipt.get("created");
    if (
      recordId !== expectedRecords[index].recordId ||
      typeof created !== "boolean"
    ) {
      throw error;
    }
    return { recordId, created };
  });
  if (items.filter(({ created }) => created).length !== added) throw error;
  return { added, items };
}

function normalizeAckResult(value, event, minimumHighWatermark) {
  const error = protocolError(
    "CODE_JOB_MEMORY_ACK_INVALID",
    "code job memory projection acknowledgement is invalid",
  );
  const fields = exactObject(value, ACK_RESULT_KEYS, error);
  const status = fields.get("status");
  const cursor = nonNegativeInteger(fields.get("cursor"), error);
  const highWatermark = nonNegativeInteger(fields.get("highWatermark"), error);
  if (
    !ACK_STATUSES.has(status) ||
    cursor !== event.sequence ||
    highWatermark < minimumHighWatermark ||
    highWatermark < cursor
  ) {
    throw error;
  }
  return { status, cursor, highWatermark };
}

function projectionResult({
  observed,
  appended,
  acknowledged,
  cursor,
  highWatermark,
}) {
  return Object.freeze({
    observed,
    appended,
    acknowledged,
    cursor,
    highWatermark,
    pending: highWatermark - cursor,
  });
}

export class CodeJobMemoryProjector {
  #readBatch;
  #ack;
  #appendBatch;
  #inFlight = null;

  constructor({ projectionSource, memoryProducer } = {}) {
    const source = bindPort(
      projectionSource,
      ["readBatch", "ack"],
      "code job memory projection source",
    );
    this.#readBatch = source.readBatch;
    this.#ack = source.ack;
    this.#appendBatch = bindPort(
      memoryProducer,
      ["appendBatch"],
      "code job memory producer",
    ).appendBatch;
  }

  runCycle(value = {}) {
    const limit = cycleLimit(value);
    if (this.#inFlight) return this.#inFlight;
    const execution = Promise.resolve().then(() => this.#run(limit));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run(limit) {
    const batch = normalizeBatch(await this.#readBatch({ limit }), limit);
    if (batch.items.length === 0) {
      return projectionResult({
        observed: 0,
        appended: 0,
        acknowledged: 0,
        cursor: batch.cursor,
        highWatermark: batch.highWatermark,
      });
    }

    const records = batch.items.map((event) =>
      memoryRecordForCodeJobEvent(event),
    );
    const expectedRecords = records.map((record) => normalizeMemoryRecord(record));
    const appendResult = normalizeAppendResult(
      await this.#appendBatch({ records }),
      expectedRecords,
    );

    let cursor = batch.cursor;
    let highWatermark = batch.highWatermark;
    let acknowledged = 0;
    for (let index = 0; index < batch.items.length; index += 1) {
      const event = batch.items[index];
      const memoryRecord = expectedRecords[index];
      const result = normalizeAckResult(
        await this.#ack({
          sequence: event.sequence,
          eventId: event.eventId,
          eventDigest: event.eventDigest,
          jobId: event.jobId,
          sourceRecordDigest: event.sourceRecordDigest,
          memoryRecordId: memoryRecord.recordId,
          memoryRecordDigest: memoryRecord.contentDigest,
        }),
        event,
        highWatermark,
      );
      cursor = result.cursor;
      highWatermark = result.highWatermark;
      acknowledged += 1;
    }
    return projectionResult({
      observed: batch.items.length,
      appended: appendResult.added,
      acknowledged,
      cursor,
      highWatermark,
    });
  }
}
