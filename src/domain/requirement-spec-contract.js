import { createHash } from "node:crypto";

const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,190}[A-Za-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SPEC_BYTES = 16 * 1_024;
const MAX_REQUIREMENTS = 64;
const MAX_ACCEPTANCE_CRITERIA = 64;
const MAX_OPEN_QUESTIONS = 32;
const MAX_ACCEPTED_INPUTS = 64;
const MAX_EVIDENCE_DIGESTS = 32;

export class RequirementSpecError extends Error {
  constructor(message = "需求规格无效") {
    super(message);
    this.name = "RequirementSpecError";
    this.code = "REQUIREMENT_SPEC_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new RequirementSpecError(message);
}

function plainDataEntries(value, name) {
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

function exactObject(value, keys, name) {
  const entries = plainDataEntries(value, name);
  const actual = new Set(entries.map(([key]) => key));
  if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) {
    invalid(`${name} 无效`);
  }
  return new Map(entries);
}

function denseArray(value, maximum, name, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalid(`${name} 无效`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    invalid(`${name} 无效`);
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${name} 无效`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function boundedText(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function boundedTaskId(value, name) {
  const taskId = boundedText(value, name, 192);
  if (!SAFE_TASK_ID.test(taskId)) invalid(`${name} 无效`);
  return taskId;
}

function boundedDeliverableId(value) {
  const deliverableId = boundedText(
    value,
    "acceptedInputs.deliverableId",
    128,
  );
  if (!SAFE_TOKEN.test(deliverableId)) {
    invalid("acceptedInputs.deliverableId 无效");
  }
  return deliverableId;
}

function positiveRevision(value, name, { zero = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < (zero ? 0 : 1)
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeUniqueTextList(
  value,
  name,
  maximumItems,
  { minimum = 0 } = {},
) {
  const entries = denseArray(value, maximumItems, name, { minimum })
    .map((entry) => boundedText(entry, name, 2_048));
  if (new Set(entries).size !== entries.length) invalid(`${name} 重复`);
  return entries.sort(compareText);
}

function draftContent(value) {
  const draft = exactObject(value, [
    "title",
    "problem",
    "requirements",
    "acceptanceCriteria",
    "openQuestions",
  ], "requirement spec draft");
  const normalized = {
    title: boundedText(draft.get("title"), "title", 256),
    problem: boundedText(draft.get("problem"), "problem", 4_096),
    requirements: normalizeUniqueTextList(
      draft.get("requirements"),
      "requirements",
      MAX_REQUIREMENTS,
      { minimum: 1 },
    ),
    acceptanceCriteria: normalizeUniqueTextList(
      draft.get("acceptanceCriteria"),
      "acceptanceCriteria",
      MAX_ACCEPTANCE_CRITERIA,
      { minimum: 1 },
    ),
    openQuestions: normalizeUniqueTextList(
      draft.get("openQuestions"),
      "openQuestions",
      MAX_OPEN_QUESTIONS,
    ),
  };
  assertSerializedLimit(normalized);
  return normalized;
}

function normalizeSourceTask(value) {
  const source = exactObject(value, [
    "taskId",
    "taskRevision",
    "graphRevision",
  ], "sourceTask");
  return {
    taskId: boundedTaskId(source.get("taskId"), "sourceTask.taskId"),
    taskRevision: positiveRevision(
      source.get("taskRevision"),
      "sourceTask.taskRevision",
    ),
    graphRevision: positiveRevision(
      source.get("graphRevision"),
      "sourceTask.graphRevision",
      { zero: true },
    ),
  };
}

function normalizeEvidenceDigests(value) {
  const digests = denseArray(
    value,
    MAX_EVIDENCE_DIGESTS,
    "acceptedInputs.evidenceDigests",
    { minimum: 1 },
  ).map((digest) => {
    if (typeof digest !== "string" || !SHA256.test(digest)) {
      invalid("acceptedInputs.evidenceDigests 无效");
    }
    return digest;
  });
  if (new Set(digests).size !== digests.length) {
    invalid("acceptedInputs.evidenceDigests 重复");
  }
  return digests.sort(compareText);
}

function normalizeAcceptedInput(value) {
  const input = exactObject(value, [
    "taskId",
    "deliverableId",
    "taskRevision",
    "contractRevision",
    "submittedDeliveryRevision",
    "decisionRevision",
    "evidenceDigests",
  ], "accepted input");
  const submittedDeliveryRevision = positiveRevision(
    input.get("submittedDeliveryRevision"),
    "acceptedInputs.submittedDeliveryRevision",
  );
  const decisionRevision = positiveRevision(
    input.get("decisionRevision"),
    "acceptedInputs.decisionRevision",
  );
  if (decisionRevision !== submittedDeliveryRevision + 1) {
    invalid("acceptedInputs delivery revision 绑定无效");
  }
  return {
    taskId: boundedTaskId(input.get("taskId"), "acceptedInputs.taskId"),
    deliverableId: boundedDeliverableId(input.get("deliverableId")),
    taskRevision: positiveRevision(
      input.get("taskRevision"),
      "acceptedInputs.taskRevision",
    ),
    contractRevision: positiveRevision(
      input.get("contractRevision"),
      "acceptedInputs.contractRevision",
    ),
    submittedDeliveryRevision,
    decisionRevision,
    evidenceDigests: normalizeEvidenceDigests(input.get("evidenceDigests")),
  };
}

function normalizeAcceptedInputs(value) {
  const inputs = denseArray(
    value,
    MAX_ACCEPTED_INPUTS,
    "acceptedInputs",
  ).map(normalizeAcceptedInput);
  const bindings = inputs.map(
    ({ taskId, deliverableId }) => `${taskId}\u0000${deliverableId}`,
  );
  if (new Set(bindings).size !== bindings.length) {
    invalid("acceptedInputs taskId/deliverableId 重复");
  }
  return inputs.sort((left, right) => {
    const taskOrder = compareText(left.taskId, right.taskId);
    return taskOrder || compareText(left.deliverableId, right.deliverableId);
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function contentDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function assertSerializedLimit(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SPEC_BYTES) {
    invalid("需求规格超过 16 KiB 限制");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function buildRequirementSpec({ draft, revision, sourceTask, acceptedInputs }) {
  const content = {
    schemaVersion: 1,
    revision: positiveRevision(revision, "revision"),
    sourceTask: normalizeSourceTask(sourceTask),
    acceptedInputs: normalizeAcceptedInputs(acceptedInputs),
    ...draftContent(draft),
  };
  const spec = { ...content, contentDigest: contentDigest(content) };
  assertSerializedLimit(spec);
  return deepFreeze(spec);
}

export function normalizeRequirementSpecDraft(value) {
  return deepFreeze(draftContent(value));
}

export function assertRequirementSpecAcceptedInputsBudget(value) {
  const acceptedInputs = normalizeAcceptedInputs(value);
  buildRequirementSpec({
    draft: {
      title: "x",
      problem: "x",
      requirements: ["x"],
      acceptanceCriteria: ["x"],
      openQuestions: [],
    },
    revision: 1,
    sourceTask: {
      taskId: "r".repeat(192),
      taskRevision: 1,
      graphRevision: 0,
    },
    acceptedInputs,
  });
  return true;
}

export function createRequirementSpec(value) {
  const input = exactObject(value, [
    "draft",
    "revision",
    "sourceTask",
    "acceptedInputs",
  ], "requirement spec creation input");
  return buildRequirementSpec({
    draft: input.get("draft"),
    revision: input.get("revision"),
    sourceTask: input.get("sourceTask"),
    acceptedInputs: input.get("acceptedInputs"),
  });
}

export function normalizeRequirementSpec(value) {
  const entries = exactObject(value, [
    "schemaVersion",
    "revision",
    "sourceTask",
    "acceptedInputs",
    "title",
    "problem",
    "requirements",
    "acceptanceCriteria",
    "openQuestions",
    "contentDigest",
  ], "requirement spec");
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const normalized = buildRequirementSpec({
    revision: entries.get("revision"),
    sourceTask: entries.get("sourceTask"),
    acceptedInputs: entries.get("acceptedInputs"),
    draft: {
      title: entries.get("title"),
      problem: entries.get("problem"),
      requirements: entries.get("requirements"),
      acceptanceCriteria: entries.get("acceptanceCriteria"),
      openQuestions: entries.get("openQuestions"),
    },
  });
  if (entries.get("contentDigest") !== normalized.contentDigest) {
    invalid("contentDigest 与需求规格内容不匹配");
  }
  return normalized;
}

export function requirementSpecDigest(value) {
  return normalizeRequirementSpec(value).contentDigest;
}

const VALID_TEXT_PATTERN =
  "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*" +
  "[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]" +
  "[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$";
const UTF8_MAXIMUM_BYTES_PER_CHARACTER = 4;

function stringSchema(maximumBytes, pattern = VALID_TEXT_PATTERN) {
  const ascii = pattern !== VALID_TEXT_PATTERN;
  return {
    type: "string",
    minLength: 1,
    maxLength: ascii
      ? maximumBytes
      : Math.floor(maximumBytes / UTF8_MAXIMUM_BYTES_PER_CHARACTER),
    pattern,
  };
}

function uniqueTextArraySchema(maxItems, { minimum = 0 } = {}) {
  return {
    type: "array",
    minItems: minimum,
    maxItems,
    uniqueItems: true,
    items: stringSchema(2_048),
  };
}

const draftProperties = {
  title: stringSchema(256),
  problem: stringSchema(4_096),
  requirements: uniqueTextArraySchema(MAX_REQUIREMENTS, { minimum: 1 }),
  acceptanceCriteria: uniqueTextArraySchema(MAX_ACCEPTANCE_CRITERIA, {
    minimum: 1,
  }),
  openQuestions: uniqueTextArraySchema(MAX_OPEN_QUESTIONS),
};

export const REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: Object.keys(draftProperties),
  properties: draftProperties,
});

const revisionSchema = { type: "integer", minimum: 1 };
const acceptedInputProperties = {
  taskId: stringSchema(192, SAFE_TASK_ID.source),
  deliverableId: stringSchema(128, SAFE_TOKEN.source),
  taskRevision: revisionSchema,
  contractRevision: revisionSchema,
  submittedDeliveryRevision: revisionSchema,
  decisionRevision: revisionSchema,
  evidenceDigests: {
    type: "array",
    minItems: 1,
    maxItems: MAX_EVIDENCE_DIGESTS,
    uniqueItems: true,
    items: stringSchema(64, SHA256.source),
  },
};

const specProperties = {
  schemaVersion: { type: "integer", const: 1 },
  revision: revisionSchema,
  sourceTask: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "taskRevision", "graphRevision"],
    properties: {
      taskId: stringSchema(192, SAFE_TASK_ID.source),
      taskRevision: revisionSchema,
      graphRevision: { type: "integer", minimum: 0 },
    },
  },
  acceptedInputs: {
    type: "array",
    maxItems: MAX_ACCEPTED_INPUTS,
    items: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(acceptedInputProperties),
      properties: acceptedInputProperties,
    },
  },
  ...draftProperties,
  contentDigest: stringSchema(64, SHA256.source),
};

export const REQUIREMENT_SPEC_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: Object.keys(specProperties),
  properties: specProperties,
});
