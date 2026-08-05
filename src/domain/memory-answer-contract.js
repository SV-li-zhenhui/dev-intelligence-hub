const MEMORY_ID = /^memory-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const FILTER_KEYS = Object.freeze([
  "query",
  "roleId",
  "repository",
  "eventType",
  "from",
  "to",
]);
const MAX_CLAIMS = 12;
const MAX_CITATIONS_PER_CLAIM = 8;
const MAX_STATEMENT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export const MEMORY_ANSWER_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "status", "claims"],
  properties: {
    schemaVersion: { const: 1 },
    status: { enum: ["answered", "insufficient_evidence"] },
    claims: {
      type: "array",
      maxItems: MAX_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "citationIds"],
        properties: {
          statement: {
            type: "string",
            minLength: 1,
            maxLength: MAX_STATEMENT_BYTES,
          },
          citationIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CITATIONS_PER_CLAIM,
            uniqueItems: true,
            items: { type: "string", pattern: "^memory-[a-f0-9]{64}$" },
          },
        },
      },
    },
  },
});

export class MemoryAnswerContractError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "MemoryAnswerContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message, options) {
  throw new MemoryAnswerContractError(
    "MEMORY_ANSWER_CONTRACT_INVALID",
    message,
    400,
    options,
  );
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
  const fields = new Map(entries);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    invalid(`${name} 字段无效`);
  }
  return fields;
}

function allowed(value, keys, name) {
  const entries = dataEntries(value, name);
  if (entries.some(([key]) => !keys.includes(key))) {
    invalid(`${name} 字段无效`);
  }
  return new Map(entries);
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

function strictArray(value, name, maximumItems) {
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
    result.push(descriptor.value);
  }
  return result;
}

function isoTimestamp(value, name) {
  const normalized = text(value, name, 64);
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    invalid(`${name} 无效`);
  }
  return normalized;
}

function filters(value) {
  const fields = allowed(value, FILTER_KEYS, "retrieval.filters");
  const result = Object.fromEntries(
    FILTER_KEYS.map((key) => [
      key,
      fields.has(key)
        ? text(fields.get(key), `retrieval.filters.${key}`, key === "query" ? 1_024 : 256, {
            empty: true,
          })
        : "",
    ]),
  );
  for (const key of ["from", "to"]) {
    if (result[key]) result[key] = isoTimestamp(result[key], `retrieval.filters.${key}`);
  }
  if (result.from && result.to && result.from > result.to) {
    invalid("retrieval.filters 时间范围无效");
  }
  return Object.freeze(result);
}

function memoryIds(value, name, maximumItems = 20) {
  const ids = strictArray(value, name, maximumItems).map((entry) => {
    const id = text(entry, name, 71);
    if (!MEMORY_ID.test(id)) invalid(`${name} 无效`);
    return id;
  });
  if (!ids.length || new Set(ids).size !== ids.length) {
    invalid(`${name} 无效`);
  }
  return Object.freeze(ids);
}

function retrieval(value) {
  const entries = dataEntries(value, "retrieval");
  const fields = new Map(entries);
  if (fields.get("kind") === "query") {
    if (
      fields.size !== 2 ||
      !fields.has("filters")
    ) {
      invalid("retrieval 字段无效");
    }
    return Object.freeze({
      kind: "query",
      filters: filters(fields.get("filters")),
    });
  }
  if (fields.get("kind") === "context") {
    if (
      fields.size !== 3 ||
      !fields.has("contextDigest") ||
      !fields.has("recordIds")
    ) {
      invalid("retrieval 字段无效");
    }
    const contextDigest = text(
      fields.get("contextDigest"),
      "retrieval.contextDigest",
      64,
    );
    if (!SHA256.test(contextDigest)) invalid("retrieval.contextDigest 无效");
    return Object.freeze({
      kind: "context",
      contextDigest,
      recordIds: memoryIds(fields.get("recordIds"), "retrieval.recordIds"),
    });
  }
  invalid("retrieval.kind 无效");
}

export function normalizeMemoryAnswerRequest(value) {
  const fields = exact(
    value,
    ["schemaVersion", "question", "mode", "retrieval"],
    "memory answer request",
  );
  if (fields.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const mode = fields.get("mode");
  if (!new Set(["configured", "local"]).has(mode)) invalid("mode 无效");
  return Object.freeze({
    schemaVersion: 1,
    question: text(fields.get("question"), "question", 4_096),
    mode,
    retrieval: retrieval(fields.get("retrieval")),
  });
}

function claim(value) {
  const fields = exact(value, ["statement", "citationIds"], "claim");
  return Object.freeze({
    statement: text(
      fields.get("statement"),
      "claim.statement",
      MAX_STATEMENT_BYTES,
    ),
    citationIds: memoryIds(
      fields.get("citationIds"),
      "claim.citationIds",
      MAX_CITATIONS_PER_CLAIM,
    ),
  });
}

export function parseStructuredMemoryAnswer(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES
  ) {
    invalid("memory answer response 无效");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    invalid("memory answer response 不是有效 JSON", { cause });
  }
  const fields = exact(
    parsed,
    ["schemaVersion", "status", "claims"],
    "memory answer response",
  );
  if (fields.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const status = fields.get("status");
  if (!new Set(["answered", "insufficient_evidence"]).has(status)) {
    invalid("status 无效");
  }
  const claims = strictArray(
    fields.get("claims"),
    "claims",
    MAX_CLAIMS,
  ).map(claim);
  if (
    (status === "answered" && claims.length === 0) ||
    (status === "insufficient_evidence" && claims.length !== 0)
  ) {
    invalid("status 与 claims 不一致");
  }
  return Object.freeze({ schemaVersion: 1, status, claims: Object.freeze(claims) });
}
