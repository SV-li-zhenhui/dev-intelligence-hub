import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { normalizeSessionKey } from "../lib/session-key.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const DATA_CLASSES = Object.freeze(["requirements", "code", "memory"]);
const REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export class BrainRouterError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "BrainRouterError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function routerError(code, message, statusCode) {
  return new BrainRouterError(code, message, statusCode);
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactData(value, keys, name) {
  const entries = dataEntries(value, name);
  const actual = new Set(entries.map(([key]) => key));
  if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(entries);
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeModel(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new TypeError("brain.model is invalid");
  }
  return value;
}

function normalizeRemoteData(value) {
  const normalized = exactData(value, DATA_CLASSES, "brain.remoteData");
  if (DATA_CLASSES.some((name) => typeof normalized[name] !== "boolean")) {
    throw new TypeError("brain.remoteData is invalid");
  }
  return Object.freeze(
    Object.fromEntries(DATA_CLASSES.map((name) => [name, normalized[name]])),
  );
}

export function normalizeBrainConfig(value) {
  const entries = dataEntries(value, "brain");
  const actual = new Set(entries.map(([key]) => key));
  const required = ["provider", "model", "remoteData"];
  const allowed = new Set([...required, "reasoningEffort"]);
  if (
    required.some((key) => !actual.has(key)) ||
    [...actual].some((key) => !allowed.has(key))
  ) {
    throw new TypeError("brain is invalid");
  }
  const config = Object.fromEntries(entries);
  if (
    Object.hasOwn(config, "reasoningEffort") &&
    !REASONING_EFFORTS.has(config.reasoningEffort)
  ) {
    throw new TypeError("brain.reasoningEffort is invalid");
  }
  return Object.freeze({
    provider: safeId(config.provider, "brain.provider"),
    model: safeModel(config.model),
    ...(Object.hasOwn(config, "reasoningEffort")
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    remoteData: normalizeRemoteData(config.remoteData),
  });
}

function normalizeDataClasses(value = []) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    value.some((entry) => !DATA_CLASSES.includes(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("dataClasses are invalid");
  }
  return [...value];
}

function normalizeProvider(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("brain provider is invalid");
  }
  const id = safeId(value.id, "provider.id");
  if (
    typeof value.remote !== "boolean" ||
    typeof value.generate !== "function"
  ) {
    throw new TypeError("brain provider is invalid");
  }
  const attemptDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "singleAttempt",
  );
  const availability = value.checkAvailability;
  if (
    attemptDescriptor &&
    (!("value" in attemptDescriptor) ||
      typeof attemptDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider is invalid");
  }
  if (availability !== undefined && typeof availability !== "function") {
    throw new TypeError("brain provider is invalid");
  }
  if (
    value.supportsEntitySessions !== undefined &&
    typeof value.supportsEntitySessions !== "boolean"
  ) {
    throw new TypeError("brain provider is invalid");
  }
  return Object.freeze({
    id,
    remote: value.remote,
    singleAttempt: attemptDescriptor?.value === true,
    supportsEntitySessions: value.supportsEntitySessions === true,
    generate: value.generate.bind(value),
    ...(availability
      ? { checkAvailability: availability.bind(value) }
      : {}),
  });
}

function frozenDescription(provider, brain) {
  return Object.freeze({
    provider: provider.id,
    model: brain.model,
    ...(brain.reasoningEffort
      ? { reasoningEffort: brain.reasoningEffort }
      : {}),
    remote: provider.remote,
    remoteData: Object.freeze({ ...brain.remoteData }),
    ...(provider.singleAttempt ? { singleAttempt: true } : {}),
  });
}

export class BrainRouter {
  #providers;

  constructor({ providers = [] } = {}) {
    if (
      !Array.isArray(providers) ||
      Object.getPrototypeOf(providers) !== Array.prototype
    ) {
      throw new TypeError("providers are invalid");
    }
    this.#providers = new Map();
    for (const value of providers) {
      const provider = normalizeProvider(value);
      if (this.#providers.has(provider.id)) {
        throw new TypeError(`brain provider is duplicated: ${provider.id}`);
      }
      this.#providers.set(provider.id, provider);
    }
    Object.freeze(this);
  }

  async generate({
    brain: brainValue,
    messages,
    schema,
    dataClasses = [],
    sessionKey: sessionKeyValue = null,
    signal = null,
  } = {}) {
    const brain = normalizeBrainConfig(brainValue);
    const provider = this.#provider(brain.provider);
    const classes = normalizeDataClasses(dataClasses);
    const requestSignal = normalizeAbortSignal(signal);
    if (requestSignal?.aborted) {
      throw routerError(
        "BRAIN_REQUEST_CANCELLED",
        "Brain request was cancelled",
        499,
      );
    }
    if (provider.remote) {
      if (classes.length === 0) {
        throw routerError(
          "REMOTE_DATA_CLASSIFICATION_REQUIRED",
          "Remote brain requires explicit data classification",
          403,
        );
      }
      const denied = classes.find((name) => brain.remoteData[name] !== true);
      if (denied) {
        throw routerError(
          "REMOTE_DATA_NOT_AUTHORIZED",
          `Remote brain is not authorized for ${denied} data`,
          403,
        );
      }
    }
    return provider.generate({
      model: brain.model,
      ...(brain.reasoningEffort
        ? { reasoningEffort: brain.reasoningEffort }
        : {}),
      messages,
      schema,
      ...(sessionKeyValue === null || !provider.supportsEntitySessions
        ? {}
        : { sessionKey: normalizeSessionKey(sessionKeyValue) }),
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
  }

  async checkAvailability(brainValue, { signal = null } = {}) {
    const brain = normalizeBrainConfig(brainValue);
    const provider = this.#provider(brain.provider);
    const requestSignal = normalizeAbortSignal(signal);
    if (requestSignal?.aborted) {
      throw routerError(
        "BRAIN_REQUEST_CANCELLED",
        "Brain request was cancelled",
        499,
      );
    }
    if (typeof provider.checkAvailability !== "function") return;
    await provider.checkAvailability({
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
  }

  describe(brainValue) {
    const brain = normalizeBrainConfig(brainValue);
    return frozenDescription(this.#provider(brain.provider), brain);
  }

  #provider(id) {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw routerError(
        "BRAIN_PROVIDER_NOT_CONFIGURED",
        "Configured brain provider is unavailable",
        503,
      );
    }
    return provider;
  }
}
