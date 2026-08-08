import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  createPullRequestReadIdentity,
  normalizePullRequestReadFacts,
  projectPullRequestReadFactsContext,
  pullRequestReadFactsMatch,
} from "../domain/pull-request-read-facts.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";

export const PR_ENGINEER_READ_FACTS_STATE_KEY = "pr-engineer-read-facts";
const STATE_KEY = PR_ENGINEER_READ_FACTS_STATE_KEY;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_AGE_MS = 2 * 60 * 1_000;
const DEFAULT_MAXIMUM_RECORDS = 32;
const MAXIMUM_PERSISTED_RECORDS = 64;

export class PrEngineerServiceError extends Error {
  constructor(code, message, statusCode = 503, options) {
    super(message, options);
    this.name = "PrEngineerServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function serviceError(code, message, statusCode, options) {
  return new PrEngineerServiceError(code, message, statusCode, options);
}

function operationSignal(options) {
  if (options === undefined) return null;
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    utilTypes.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("PR fact operation options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.length === 0) return null;
  const descriptor = keys.length === 1 && keys[0] === "signal"
    ? Object.getOwnPropertyDescriptor(options, "signal")
    : null;
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new TypeError("PR fact operation options are invalid");
  }
  return normalizeAbortSignal(descriptor.value);
}

function exactRecord(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", `${name} is invalid`);
  }
  const entries = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw serviceError("PR_FACT_STATE_CORRUPTED", `${name} is invalid`);
    }
    entries.set(key, descriptor.value);
  }
  if (entries.size !== keys.length || keys.some((key) => !entries.has(key))) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", `${name} is invalid`);
  }
  return entries;
}

function denseArray(value, maximum, name) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", `${name} is invalid`);
  }
  return value.map((_entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw serviceError("PR_FACT_STATE_CORRUPTED", `${name} is invalid`);
    }
    return descriptor.value;
  });
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function stateContent(revision, records) {
  return { schemaVersion: 1, revision, records };
}

function createState(revision, records) {
  const content = stateContent(revision, records);
  return { ...content, contentDigest: sha256(content) };
}

function defaultState() {
  return createState(0, []);
}

function normalizeState(value, maximumRecords) {
  const fields = exactRecord(
    value,
    ["schemaVersion", "revision", "records", "contentDigest"],
    "PR fact state",
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    !Number.isSafeInteger(fields.get("revision")) ||
    fields.get("revision") < 0 ||
    typeof fields.get("contentDigest") !== "string" ||
    !/^[a-f0-9]{64}$/.test(fields.get("contentDigest"))
  ) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", "PR fact state is invalid");
  }
  const records = denseArray(
    fields.get("records"),
    maximumRecords,
    "PR fact records",
  ).map((entry) => {
    try {
      return normalizePullRequestReadFacts(entry);
    } catch (cause) {
      throw serviceError(
        "PR_FACT_STATE_CORRUPTED",
        "Stored PR facts are invalid",
        503,
        { cause },
      );
    }
  });
  const identities = records.map(({ identity }) => identity.identityDigest);
  if (new Set(identities).size !== identities.length) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", "Stored PR facts are duplicated");
  }
  const sortedIdentities = [...records]
    .sort(compareRecords)
    .map(({ identity }) => identity.identityDigest);
  if (
    identities.some((identityDigest, index) =>
      identityDigest !== sortedIdentities[index]
    ) ||
    (fields.get("revision") === 0 && records.length !== 0)
  ) {
    throw serviceError(
      "PR_FACT_STATE_CORRUPTED",
      "Stored PR facts are not canonical",
    );
  }
  const content = stateContent(fields.get("revision"), records);
  if (
    fields.get("contentDigest") !== sha256(content) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_STATE_BYTES
  ) {
    throw serviceError("PR_FACT_STATE_CORRUPTED", "PR fact state digest is invalid");
  }
  return { ...content, contentDigest: fields.get("contentDigest") };
}

export function normalizePrEngineerReadFactsPersistedState(value) {
  return normalizeState(value, MAXIMUM_PERSISTED_RECORDS);
}

function bindPort(value, method, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !Object.hasOwn(descriptor, "value") ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  throw new TypeError(`${name} is invalid`);
}

function timestamp(value, name) {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (
    typeof normalized !== "string" ||
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function freshness(observedAt, now, maximumAgeMs) {
  const age = Date.parse(now) - Date.parse(observedAt);
  return Number.isFinite(age) && age >= -60_000 && age <= maximumAgeMs;
}

function compareRecords(left, right) {
  const observed = right.observedAt.localeCompare(left.observedAt, "en");
  return (
    observed ||
    left.identity.identityDigest.localeCompare(
      right.identity.identityDigest,
      "en",
    )
  );
}

function retainRequiredRecord(records, maximumRecords, requiredIdentityDigest) {
  const retained = records.slice(0, maximumRecords);
  if (
    retained.some(
      ({ identity }) => identity.identityDigest === requiredIdentityDigest,
    )
  ) {
    return retained;
  }
  const required = records.find(
    ({ identity }) => identity.identityDigest === requiredIdentityDigest,
  );
  if (!required) {
    throw serviceError(
      "PR_FACT_STATE_CORRUPTED",
      "Refreshed PR facts lost their execution identity",
    );
  }
  return retained
    .slice(0, Math.max(0, maximumRecords - 1))
    .concat(required)
    .sort(compareRecords);
}

function stateWithinCapacity(revision, records, requiredIdentityDigest) {
  const retained = [...records];
  while (
    retained.length > 1 &&
    Buffer.byteLength(JSON.stringify(createState(revision, retained)), "utf8") >
      MAX_STATE_BYTES
  ) {
    let evictionIndex = retained.length - 1;
    while (
      evictionIndex >= 0 &&
      retained[evictionIndex].identity.identityDigest === requiredIdentityDigest
    ) {
      evictionIndex -= 1;
    }
    if (evictionIndex < 0) break;
    retained.splice(evictionIndex, 1);
  }
  const state = createState(revision, retained);
  if (
    !retained.some(
      ({ identity }) => identity.identityDigest === requiredIdentityDigest,
    ) ||
    Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES
  ) {
    throw serviceError("PR_FACT_STATE_CAPACITY_EXCEEDED", "PR fact state is full", 507);
  }
  return state;
}

export class PrEngineerService {
  #readState;
  #writeState;
  #loadFacts;
  #clock;
  #maximumAgeMs;
  #maximumRecords;
  #queue;
  #exclusiveLease;
  #inFlight = new Map();

  constructor({
    store,
    pullRequestFactsLoader,
    exclusiveLease,
    clock = () => new Date(),
    maximumAgeMs = DEFAULT_MAXIMUM_AGE_MS,
    maximumRecords = DEFAULT_MAXIMUM_RECORDS,
    operationQueue,
  } = {}) {
    this.#readState = bindPort(store, "read", "store");
    this.#writeState = bindPort(store, "write", "store");
    this.#loadFacts = bindPort(
      pullRequestFactsLoader,
      "loadPullRequestFacts",
      "pullRequestFactsLoader",
    );
    this.#exclusiveLease = Object.freeze({
      run: bindPort(exclusiveLease, "run", "exclusiveLease"),
    });
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    if (
      !Number.isSafeInteger(maximumAgeMs) ||
      maximumAgeMs < 1_000 ||
      maximumAgeMs > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError("maximumAgeMs is invalid");
    }
    if (
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 1 ||
      maximumRecords > 64
    ) {
      throw new TypeError("maximumRecords is invalid");
    }
    const mutationQueue = operationQueue ?? new OperationQueue();
    this.#queue = Object.freeze({
      enqueue: bindPort(mutationQueue, "enqueue", "operationQueue"),
    });
    this.#clock = clock;
    this.#maximumAgeMs = maximumAgeMs;
    this.#maximumRecords = maximumRecords;
    Object.freeze(this);
  }

  async recover() {
    const state = await this.#state();
    return Object.freeze({
      revision: state.revision,
      records: state.records.length,
    });
  }

  async get(input) {
    const identity = createPullRequestReadIdentity(input);
    const state = await this.#state();
    return (
      state.records.find(
        (record) => record.identity.identityDigest === identity.identityDigest,
      ) ?? null
    );
  }

  async observe(input, options) {
    const signal = operationSignal(options);
    signal?.throwIfAborted();
    const identity = createPullRequestReadIdentity(input);
    const stored = await this.get(input);
    signal?.throwIfAborted();
    const now = timestamp(this.#clock(), "clock");
    if (
      stored !== null &&
      freshness(stored.observedAt, now, this.#maximumAgeMs)
    ) {
      return stored;
    }
    const key = identity.identityDigest;
    const running = this.#inFlight.get(key);
    if (running) return running;
    const execution = this.#refresh(input, identity, signal);
    const tracked = execution.finally(() => {
      if (this.#inFlight.get(key) === tracked) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, tracked);
    return tracked;
  }

  async context(input, options) {
    return projectPullRequestReadFactsContext(await this.observe(input, options));
  }

  async #refresh(input, identity, signal) {
    let response;
    try {
      response = await this.#loadFacts(
        structuredClone(input),
        signal === null ? undefined : { signal },
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw serviceError(
        "PR_FACT_REFRESH_FAILED",
        "Unable to refresh bounded PR facts",
        503,
        { cause },
      );
    }
    signal?.throwIfAborted();
    let loaded;
    try {
      loaded = normalizePullRequestReadFacts(response);
    } catch (cause) {
      throw serviceError(
        "PR_FACT_REFRESH_FAILED",
        "PR facts loader returned an invalid result",
        502,
        { cause },
      );
    }
    if (!pullRequestReadFactsMatch(loaded, identity)) {
      throw serviceError(
        "PR_FACT_EXECUTION_STALE",
        "PR facts do not match the current execution identity",
        409,
      );
    }
    const completionNow = timestamp(this.#clock(), "clock");
    if (!freshness(loaded.observedAt, completionNow, this.#maximumAgeMs)) {
      throw serviceError(
        "PR_FACT_REFRESH_STALE",
        "Refreshed PR facts are outside the allowed freshness window",
        503,
      );
    }
    return this.#transaction(async () => {
      signal?.throwIfAborted();
      const state = await this.#currentState();
      signal?.throwIfAborted();
      const existing = state.records.find(
        (record) => record.identity.identityDigest === identity.identityDigest,
      );
      if (
        existing &&
        (existing.contentDigest === loaded.contentDigest ||
          (existing.observedAt > loaded.observedAt &&
            freshness(
              existing.observedAt,
              completionNow,
              this.#maximumAgeMs,
            )))
      ) {
        return existing;
      }
      const records = state.records
        .filter(
          (record) =>
            record.identity.identityDigest !== identity.identityDigest,
        )
        .concat(loaded)
        .sort(compareRecords);
      const retained = retainRequiredRecord(
        records,
        this.#maximumRecords,
        identity.identityDigest,
      );
      const candidate = stateWithinCapacity(
        state.revision + 1,
        retained,
        identity.identityDigest,
      );
      signal?.throwIfAborted();
      await this.#writeState(STATE_KEY, candidate);
      return loaded;
    });
  }

  #state() {
    return this.#transaction(() => this.#currentState());
  }

  #transaction(operation) {
    return this.#queue.enqueue(() => this.#exclusiveLease.run(operation));
  }

  async #currentState() {
    const state = normalizeState(
      await this.#readState(STATE_KEY, defaultState()),
      MAXIMUM_PERSISTED_RECORDS,
    );
    if (state.records.length <= this.#maximumRecords) return state;
    const migrated = createState(
      state.revision + 1,
      state.records.slice(0, this.#maximumRecords),
    );
    await this.#writeState(STATE_KEY, migrated);
    return migrated;
  }
}
