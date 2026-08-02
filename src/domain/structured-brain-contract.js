import { normalizeWorkDecision } from "./work-intent.js";

const DEFAULT_MAXIMUM_BYTES = 128 * 1024;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const UTF8_MAXIMUM_BYTES_PER_CHARACTER = 4;
const SAFE_TOKEN_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
const ISO_TIMESTAMP_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const VALID_TEXT_CHARACTER =
  "[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";
const NON_WHITESPACE_TEXT_CHARACTER =
  "[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";
const VALID_TEXT_PATTERN = `^${VALID_TEXT_CHARACTER}*$`;
const NONEMPTY_TEXT_PATTERN =
  `^${VALID_TEXT_CHARACTER}*${NON_WHITESPACE_TEXT_CHARACTER}` +
  `${VALID_TEXT_CHARACTER}*$`;

export class StructuredBrainContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "StructuredBrainContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function stringSchema(
  maximumBytes,
  { minimum = 1, ascii = false, pattern, format } = {},
) {
  const maxLength = ascii
    ? maximumBytes
    : Math.floor(maximumBytes / UTF8_MAXIMUM_BYTES_PER_CHARACTER);
  return {
    type: "string",
    minLength: minimum,
    maxLength,
    pattern:
      pattern ?? (minimum === 0 ? VALID_TEXT_PATTERN : NONEMPTY_TEXT_PATTERN),
    ...(format ? { format } : {}),
  };
}

function stringArraySchema(maxItems, maxLength, { minimum = 0 } = {}) {
  return {
    type: "array",
    minItems: minimum,
    maxItems,
    items: stringSchema(maxLength),
  };
}

function intentSchema(type, fields) {
  const properties = {
    schemaVersion: { type: "integer", const: 1 },
    type: { type: "string", const: type },
    summary: stringSchema(2_048),
    reason: stringSchema(4_096),
    ...fields,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const evidence = stringArraySchema(20, 2_048);
const intentVariants = [
  intentSchema("ask_user", {
    question: stringSchema(4_096),
    choices: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description"],
        properties: {
          id: stringSchema(64, { ascii: true, pattern: SAFE_TOKEN_PATTERN }),
          label: stringSchema(256),
          description: stringSchema(1_024, { minimum: 0 }),
        },
      },
    },
  }),
  intentSchema("wait_condition", {
    condition: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "notBefore"],
          properties: {
            kind: { type: "string", const: "time" },
            notBefore: stringSchema(64, {
              ascii: true,
              pattern: ISO_TIMESTAMP_PATTERN,
              format: "date-time",
            }),
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "fact", "oneOf"],
          properties: {
            kind: { type: "string", const: "workflow_fact" },
            fact: stringSchema(64, {
              ascii: true,
              pattern: SAFE_TOKEN_PATTERN,
            }),
            oneOf: {
              ...stringArraySchema(16, 256, { minimum: 1 }),
              uniqueItems: true,
            },
          },
        },
      ],
    },
    checkAfterSeconds: {
      type: "integer",
      minimum: 30,
      maximum: 86_400,
    },
  }),
  intentSchema("propose_github_review", {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes", "comment"],
    },
    body: stringSchema(32 * 1_024),
    evidence,
  }),
  intentSchema("propose_code_action", {
    operation: { type: "string", enum: ["inspect", "modify", "verify"] },
    objective: stringSchema(4_096),
    acceptanceCriteria: stringArraySchema(20, 2_048, { minimum: 1 }),
    evidence,
  }),
  intentSchema("handoff", {
    capability: {
      type: "string",
      enum: [
        "coordination",
        "requirements",
        "pr-review",
        "development",
        "testing",
      ],
    },
    brief: stringSchema(4_096),
    evidence,
  }),
  intentSchema("complete", {
    outcome: { type: "string", enum: ["done", "no-action"] },
    evidence,
  }),
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WORK_DECISION_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "confidence", "summary", "intent"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: stringSchema(4_096),
    intent: { oneOf: intentVariants },
  },
});

function maximumBytesFrom(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("structured brain parser options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => key !== "maximumBytes") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError("structured brain parser options are invalid");
  }
  const maximumBytes = Object.hasOwn(options, "maximumBytes")
    ? Object.getOwnPropertyDescriptor(options, "maximumBytes").value
    : DEFAULT_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new TypeError("maximumBytes is outside the supported range");
  }
  return maximumBytes;
}

export function parseStructuredWorkDecision(text, options = {}) {
  const maximumBytes = maximumBytesFrom(options);
  if (typeof text !== "string") {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_TOO_LARGE",
      "Structured brain response exceeds the configured limit",
      413,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
  try {
    return normalizeWorkDecision(value);
  } catch {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
}
