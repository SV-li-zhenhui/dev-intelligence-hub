import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA,
  REQUIREMENT_SPEC_JSON_SCHEMA,
  RequirementSpecError,
  assertRequirementSpecAcceptedInputsBudget,
  createRequirementSpec,
  normalizeRequirementSpec,
  normalizeRequirementSpecDraft,
  requirementSpecDigest,
} from "../src/domain/requirement-spec-contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function draft() {
  return {
    title: "实现共享岗位协作",
    problem: "岗位必须读取同一任务树上的已接受交付物。",
    requirements: ["测试只能读取已接受实现", "开发必须读取已接受需求"],
    acceptanceCriteria: ["旧输入提交失败", "所有交付物具有证据摘要"],
    openQuestions: ["是否需要性能测试？"],
  };
}

function sourceTask() {
  return {
    taskId: "work-item-requirements",
    taskRevision: 9,
    graphRevision: 20,
  };
}

function acceptedInput(taskId, overrides = {}) {
  return {
    taskId,
    deliverableId: "requirement-spec",
    taskRevision: 7,
    contractRevision: 1,
    submittedDeliveryRevision: 3,
    decisionRevision: 4,
    evidenceDigests: [SHA_B, SHA_A],
    ...overrides,
  };
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof RequirementSpecError &&
      error.code === "REQUIREMENT_SPEC_INVALID",
  );
}

test("normalizes an exact immutable requirement specification draft", () => {
  const input = draft();
  const normalized = normalizeRequirementSpecDraft(input);

  assert.deepEqual(normalized.requirements, [
    "开发必须读取已接受需求",
    "测试只能读取已接受实现",
  ]);
  assert.deepEqual(normalized.acceptanceCriteria, [
    "所有交付物具有证据摘要",
    "旧输入提交失败",
  ]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.requirements), true);
  assert.equal(REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(Object.isFrozen(REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA), true);
  assert.equal(
    REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA.properties.title.maxLength,
    64,
  );

  input.requirements[0] = "调用者篡改";
  assert.equal(normalized.requirements.includes("调用者篡改"), false);
});

test("accepted input admission proves a minimum specification fits before graph creation", () => {
  assert.equal(
    assertRequirementSpecAcceptedInputsBudget([
      acceptedInput("work-item-small"),
    ]),
    true,
  );
  const tooMany = Array.from({ length: 65 }, (_, index) =>
    acceptedInput(`work-item-${index}`, {
      deliverableId: `delivery-${index}`,
    })
  );
  const oversized = Array.from({ length: 64 }, (_, index) =>
    acceptedInput(`work-item-${index}-${"x".repeat(150)}`, {
      deliverableId: `delivery-${index}`,
      evidenceDigests: [index.toString(16).padStart(64, "0")],
    })
  );

  assertInvalid(() => assertRequirementSpecAcceptedInputsBudget(tooMany));
  assertInvalid(() => assertRequirementSpecAcceptedInputsBudget(oversized));
});

test("trusted construction binds source and accepted input revisions deterministically", () => {
  const spec = createRequirementSpec({
    draft: draft(),
    revision: 2,
    sourceTask: sourceTask(),
    acceptedInputs: [
      acceptedInput("work-item-z", { deliverableId: "test-report" }),
      acceptedInput("work-item-a", { deliverableId: "implementation" }),
      acceptedInput("work-item-a", {
        taskRevision: 5,
        submittedDeliveryRevision: 1,
        decisionRevision: 2,
        evidenceDigests: [SHA_C],
      }),
    ],
  });

  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.revision, 2);
  assert.deepEqual(spec.acceptedInputs.map(({ taskId, deliverableId }) => [
    taskId,
    deliverableId,
  ]), [
    ["work-item-a", "implementation"],
    ["work-item-a", "requirement-spec"],
    ["work-item-z", "test-report"],
  ]);
  assert.deepEqual(spec.acceptedInputs[2].evidenceDigests, [SHA_A, SHA_B]);
  assert.match(spec.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(requirementSpecDigest(spec), spec.contentDigest);
  assert.deepEqual(normalizeRequirementSpec(spec), spec);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.acceptedInputs[0]), true);
  assert.equal(Object.isFrozen(REQUIREMENT_SPEC_JSON_SCHEMA), true);
  const acceptedInputSchema = REQUIREMENT_SPEC_JSON_SCHEMA
    .properties.acceptedInputs.items;
  assert.equal(acceptedInputSchema.required.includes("deliverableId"), true);
  assert.equal(
    new RegExp(acceptedInputSchema.properties.deliverableId.pattern)
      .test("requirement-spec"),
    true,
  );
  assert.equal(
    new RegExp(acceptedInputSchema.properties.deliverableId.pattern)
      .test("Requirement Spec"),
    false,
  );

  const reordered = createRequirementSpec({
    acceptedInputs: [...spec.acceptedInputs].reverse().map((input) => ({
      ...input,
      evidenceDigests: [...input.evidenceDigests].reverse(),
    })),
    sourceTask: { ...spec.sourceTask },
    revision: 2,
    draft: {
      ...draft(),
      requirements: [...draft().requirements].reverse(),
    },
  });
  assert.equal(reordered.contentDigest, spec.contentDigest);
});

test("a requirement specification serializes within one graph delivery summary", () => {
  const spec = createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [acceptedInput("work-item-input")],
  });
  const serialized = JSON.stringify(spec);

  assert.equal(Buffer.byteLength(serialized, "utf8") <= 16 * 1_024, true);
  assert.deepEqual(JSON.parse(serialized), spec);
});

test("rejects duplicate requirements, criteria, questions, inputs, and evidence digests", () => {
  const cases = [
    { ...draft(), requirements: ["重复", "重复"] },
    { ...draft(), acceptanceCriteria: ["重复", "重复"] },
    { ...draft(), openQuestions: ["重复", "重复"] },
  ];
  for (const candidate of cases) {
    assertInvalid(() => normalizeRequirementSpecDraft(candidate));
  }

  assertInvalid(() => createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [
      acceptedInput("work-item-input"),
      acceptedInput("work-item-input", { taskRevision: 8 }),
    ],
  }));
  assert.doesNotThrow(() => createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [
      acceptedInput("work-item-input", { deliverableId: "implementation" }),
      acceptedInput("work-item-input", { deliverableId: "test-report" }),
    ],
  }));
  assertInvalid(() => createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [acceptedInput("work-item-input", {
      evidenceDigests: [SHA_A, SHA_A],
    })],
  }));
});

test("rejects stale delivery bindings and forged content digests", () => {
  assertInvalid(() => createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [acceptedInput("work-item-input", {
      submittedDeliveryRevision: 3,
      decisionRevision: 5,
    })],
  }));

  const spec = createRequirementSpec({
    draft: draft(),
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [],
  });
  assertInvalid(() => normalizeRequirementSpec({
    ...spec,
    problem: "篡改后的问题定义",
  }));
  assertInvalid(() => normalizeRequirementSpec({
    ...spec,
    contentDigest: SHA_A,
  }));
});

test("rejects extra fields, accessors, sparse arrays, symbols, and cycles", () => {
  const accessor = draft();
  Object.defineProperty(accessor, "problem", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  const sparse = draft();
  sparse.requirements = new Array(1);
  const cyclic = draft();
  cyclic.openQuestions = [];
  cyclic.openQuestions.push(cyclic);

  for (const candidate of [
    { ...draft(), actorId: "owner" },
    { ...draft(), [Symbol("hidden")]: true },
    accessor,
    sparse,
    cyclic,
  ]) {
    assertInvalid(() => normalizeRequirementSpecDraft(candidate));
  }
});

test("enforces UTF-8 field limits and the 16 KiB serialized ceiling", () => {
  assert.doesNotThrow(() => normalizeRequirementSpecDraft({
    ...draft(),
    problem: "界".repeat(1_365),
  }));
  assertInvalid(() => normalizeRequirementSpecDraft({
    ...draft(),
    problem: "界".repeat(1_366),
  }));

  assertInvalid(() => createRequirementSpec({
    draft: {
      ...draft(),
      requirements: Array.from(
        { length: 10 },
        (_, index) => `${index}-${"界".repeat(650)}`,
      ),
    },
    revision: 1,
    sourceTask: sourceTask(),
    acceptedInputs: [],
  }));
});

test("rejects invalid trusted revisions and malformed accepted input objects", () => {
  const missingDeliverableId = acceptedInput("work-item-input");
  delete missingDeliverableId.deliverableId;
  for (const input of [
    { revision: 0, sourceTask: sourceTask(), acceptedInputs: [] },
    { revision: 1, sourceTask: { ...sourceTask(), graphRevision: -1 }, acceptedInputs: [] },
    {
      revision: 1,
      sourceTask: sourceTask(),
      acceptedInputs: [{ ...acceptedInput("work-item-input"), leaseId: "lease-1" }],
    },
    {
      revision: 1,
      sourceTask: sourceTask(),
      acceptedInputs: [acceptedInput("work-item-input", { evidenceDigests: [] })],
    },
    {
      revision: 1,
      sourceTask: sourceTask(),
      acceptedInputs: [missingDeliverableId],
    },
    {
      revision: 1,
      sourceTask: sourceTask(),
      acceptedInputs: [acceptedInput("work-item-input", {
        deliverableId: "Requirement Spec",
      })],
    },
    {
      revision: 1,
      sourceTask: sourceTask(),
      acceptedInputs: [acceptedInput("work-item-input", {
        deliverableId: "x".repeat(129),
      })],
    },
  ]) {
    assertInvalid(() => createRequirementSpec({ draft: draft(), ...input }));
  }
});
