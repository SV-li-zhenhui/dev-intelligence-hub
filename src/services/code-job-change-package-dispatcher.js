import {
  createChangePackage,
  normalizeChangePackageManifest,
} from "../domain/change-package-contract.js";
import { normalizeCodeJobChangePackageEvent } from "../domain/code-job-change-package-event.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ACK_STATUSES = new Set(["applied", "already"]);

export class CodeJobChangePackageDispatcherError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodeJobChangePackageDispatcherError";
    this.code = code;
    this.statusCode = 502;
  }
}

function protocolError(code, message, cause) {
  return new CodeJobChangePackageDispatcherError(
    code,
    message,
    cause === undefined ? undefined : { cause },
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
    entries.length !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

function methodDescriptor(value, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  let owner = value;
  while (
    owner !== null &&
    owner !== Object.prototype &&
    owner !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function bindPort(value, methods, name) {
  const captured = methods.map((method) => {
    const descriptor = methodDescriptor(value, method);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    return [method, descriptor.value];
  });
  return Object.freeze(
    Object.fromEntries(
      captured.map(([method, implementation]) => [
        method,
        (...args) => Reflect.apply(implementation, value, args),
      ]),
    ),
  );
}

function nonNegativeInteger(value, error) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw error;
  }
  return value;
}

function denseArray(value, maximum, error) {
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

function cycleLimit(value = {}) {
  const error = new TypeError("runCycle options are invalid");
  const entries = dataEntries(value, error);
  if (entries.length > 1 || entries.some(([key]) => key !== "limit")) {
    throw error;
  }
  const fields = new Map(entries);
  const limit = fields.has("limit") ? fields.get("limit") : DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeBatch(value, limit) {
  const error = protocolError(
    "CODE_JOB_CHANGE_PACKAGE_SOURCE_INVALID",
    "code job change package delivery batch is invalid",
  );
  const fields = exactObject(value, ["cursor", "highWatermark", "items"], error);
  const cursor = nonNegativeInteger(fields.get("cursor"), error);
  const highWatermark = nonNegativeInteger(fields.get("highWatermark"), error);
  if (highWatermark < cursor) throw error;
  const supplied = denseArray(fields.get("items"), limit, error);
  let items;
  try {
    items = supplied.map((event) => normalizeCodeJobChangePackageEvent(event));
  } catch (cause) {
    throw protocolError(
      "CODE_JOB_CHANGE_PACKAGE_SOURCE_INVALID",
      "code job change package delivery batch is invalid",
      cause,
    );
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

function prepareDraft(event, exported) {
  const error = protocolError(
    "CODE_JOB_COMPLETED_CHANGE_EXPORT_INVALID",
    "completed code job change export is invalid",
  );
  const fields = exactObject(
    exported,
    ["workspace", "passedProfiles", "created", "modified", "deleted"],
    error,
  );
  const draft = {
    job: { ...event.job },
    proposal: { ...event.proposal },
    grant: { ...event.grant },
    workspace: fields.get("workspace"),
    passedProfiles: fields.get("passedProfiles"),
    created: fields.get("created"),
    modified: fields.get("modified"),
    deleted: fields.get("deleted"),
  };
  try {
    return { draft, expectedManifest: createChangePackage(draft).manifest };
  } catch (cause) {
    throw protocolError(
      "CODE_JOB_COMPLETED_CHANGE_EXPORT_INVALID",
      "completed code job change export is invalid",
      cause,
    );
  }
}

function normalizeCreatedManifest(value, event, expectedManifest) {
  let manifest;
  try {
    manifest = normalizeChangePackageManifest(value);
  } catch (cause) {
    throw protocolError(
      "CODE_JOB_CHANGE_PACKAGE_CREATE_RECEIPT_INVALID",
      "change package create receipt is invalid",
      cause,
    );
  }
  if (
    manifest.packageId !== expectedManifest.packageId ||
    manifest.packageDigest !== expectedManifest.packageDigest ||
    manifest.job.id !== event.job.id ||
    manifest.job.revision !== event.job.revision ||
    manifest.job.recordDigest !== event.job.recordDigest ||
    manifest.proposal.id !== event.proposal.id ||
    manifest.proposal.contentDigest !== event.proposal.contentDigest ||
    manifest.grant.digest !== event.grant.digest ||
    manifest.workspace.workspaceRevision !==
      event.exportRequest.expectedWorkspaceRevision
  ) {
    throw protocolError(
      "CODE_JOB_CHANGE_PACKAGE_CREATE_RECEIPT_INVALID",
      "change package create receipt is not bound to its source event",
    );
  }
  return manifest;
}

function normalizeAckResult(value, event, minimumHighWatermark) {
  const error = protocolError(
    "CODE_JOB_CHANGE_PACKAGE_ACK_INVALID",
    "code job change package acknowledgement is invalid",
  );
  const fields = exactObject(value, ["status", "cursor", "highWatermark"], error);
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

function cycleResult({ observed, created, acknowledged, cursor, highWatermark }) {
  return Object.freeze({
    observed,
    created,
    acknowledged,
    cursor,
    highWatermark,
    pending: highWatermark - cursor,
  });
}

export class CodeJobChangePackageDispatcher {
  #readBatch;
  #ack;
  #export;
  #create;
  #inFlight = null;

  constructor(value = {}) {
    const error = new TypeError("code job change package dispatcher options are invalid");
    const fields = exactObject(
      value,
      ["deliverySource", "completedChangeExporter", "packageProducer"],
      error,
    );
    const source = bindPort(
      fields.get("deliverySource"),
      ["readBatch", "ack"],
      "code job change package delivery source",
    );
    this.#readBatch = source.readBatch;
    this.#ack = source.ack;
    this.#export = bindPort(
      fields.get("completedChangeExporter"),
      ["export"],
      "completed change exporter",
    ).export;
    this.#create = bindPort(
      fields.get("packageProducer"),
      ["create"],
      "change package producer",
    ).create;
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
    let cursor = batch.cursor;
    let highWatermark = batch.highWatermark;
    let created = 0;
    let acknowledged = 0;
    for (const event of batch.items) {
      const exported = await this.#export({ ...event.exportRequest });
      const { draft, expectedManifest } = prepareDraft(event, exported);
      const manifest = normalizeCreatedManifest(
        await this.#create(draft),
        event,
        expectedManifest,
      );
      created += 1;
      const acknowledgement = normalizeAckResult(
        await this.#ack({
          sequence: event.sequence,
          eventId: event.eventId,
          eventDigest: event.eventDigest,
          jobId: event.job.id,
          sourceRecordDigest: event.job.recordDigest,
          packageId: manifest.packageId,
          packageDigest: manifest.packageDigest,
        }),
        event,
        highWatermark,
      );
      cursor = acknowledgement.cursor;
      highWatermark = acknowledgement.highWatermark;
      acknowledged += 1;
    }
    return cycleResult({
      observed: batch.items.length,
      created,
      acknowledged,
      cursor,
      highWatermark,
    });
  }
}
