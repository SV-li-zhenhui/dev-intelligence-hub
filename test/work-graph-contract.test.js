import assert from "node:assert/strict";
import test from "node:test";

import {
  WORK_GRAPH_DEFAULT_LIMITS,
  WorkGraphError,
  createWorkGraphSnapshot,
  deriveParentTaskOutcome,
  getBlockedWorkGraphTasks,
  getParallelReadyWorkGraphTaskIds,
  getReadyWorkGraphTaskIds,
  normalizeWorkGraphSnapshot,
  validateWorkGraphTransition,
} from "../src/domain/work-graph-contract.js";

const SHA_A = "a".repeat(64);

function responsibility(id = "developer") {
  return { type: "role", id };
}

function contract(overrides = {}) {
  return {
    revision: 1,
    acceptanceCriteria: [
      { criterionId: "tests-pass", description: "Focused tests pass" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change_package",
        description: "Reviewed implementation package",
        required: true,
      },
    ],
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    deliverableId: "implementation",
    revision: 1,
    contractRevision: 1,
    status: "accepted",
    summary: "Implementation and tests are complete",
    evidence: [
      {
        kind: "change_package",
        referenceId: "change-package-1",
        contentDigest: SHA_A,
      },
    ],
    ...overrides,
  };
}

function task(taskId, overrides = {}) {
  return {
    taskId,
    revision: 1,
    parentTaskId: null,
    status: "pending",
    responsibility: responsibility(),
    acceptanceContracts: [contract()],
    deliveries: [],
    dependsOn: [],
    ...overrides,
  };
}

function draft(tasks, overrides = {}) {
  return {
    graphId: "work-item-42",
    revision: 7,
    tasks,
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => error instanceof WorkGraphError && error.code === code;
}

test("creates a deterministic schema v1 snapshot without retaining caller data", () => {
  const input = draft([
    task("child-b", { parentTaskId: "root" }),
    task("root", {
      acceptanceContracts: [
        contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
      ],
    }),
    task("child-a", { parentTaskId: "root" }),
  ]);

  const snapshot = createWorkGraphSnapshot(input);
  const reordered = createWorkGraphSnapshot(
    draft([...input.tasks].reverse()),
  );

  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.contentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot, reordered);
  assert.deepEqual(snapshot.tasks.map(({ taskId }) => taskId), [
    "child-a",
    "child-b",
    "root",
  ]);
  assert.deepEqual(normalizeWorkGraphSnapshot(snapshot), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.tasks[0].acceptanceContracts[0]));

  input.tasks[0].responsibility.id = "attacker";
  input.tasks[0].acceptanceContracts[0].acceptanceCriteria[0].description =
    "mutated";
  assert.equal(snapshot.tasks[1].responsibility.id, "developer");
  assert.equal(
    snapshot.tasks[1].acceptanceContracts[0].acceptanceCriteria[0].description,
    "Focused tests pass",
  );
});

test("rejects duplicate ids, dangling references, self dependencies, and cycles", () => {
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("same"), task("same")])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("child", { parentTaskId: "missing" })]),
      ),
    hasCode("WORK_GRAPH_DANGLING_REFERENCE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("self", { dependsOn: ["self"] })]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", { dependsOn: ["two"] }),
          task("two", { dependsOn: ["one"] }),
        ]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
});

test("rejects excessive task count, hierarchy depth, fan-out, and dependencies", () => {
  assert.equal(WORK_GRAPH_DEFAULT_LIMITS.maxTasks, 5_000);
  assert.throws(
    () =>
      createWorkGraphSnapshot(draft([task("one"), task("two")] ), {
        limits: { maxTasks: 1 },
      }),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(draft([task("one")]), {
        limits: { maxTasks: WORK_GRAPH_DEFAULT_LIMITS.maxTasks + 1 },
      }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root"),
          task("child", { parentTaskId: "root" }),
          task("grandchild", { parentTaskId: "child" }),
        ]),
        { limits: { maxDepth: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root"),
          task("one", { parentTaskId: "root" }),
          task("two", { parentTaskId: "root" }),
        ]),
        { limits: { maxFanOut: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one"),
          task("two"),
          task("consumer", { dependsOn: ["one", "two"] }),
        ]),
        { limits: { maxDependenciesPerTask: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
});

test("requires strict option objects and accepts node responsibility targets", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([task("one", { responsibility: responsibility("triage-node") })]),
  );
  const nodeTask = task("node-owned", {
    responsibility: { type: "node", id: "requirements-triage" },
  });
  assert.equal(
    createWorkGraphSnapshot(draft([nodeTask])).tasks[0].responsibility.type,
    "node",
  );

  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), null),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), { extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), { limits: undefined }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => normalizeWorkGraphSnapshot(snapshot, { extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "limits", {
    enumerable: true,
    get: () => ({}),
  });
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), accessorOptions),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.doesNotThrow(() =>
    createWorkGraphSnapshot(draft([task("one"), task("two")]), {
      limits: { maxFanOut: 1 },
    }),
  );
});

test("rejects sparse arrays, accessors, extra fields, and dangerous keys", () => {
  const sparse = [task("one")];
  sparse.length = 2;
  assert.throws(
    () => createWorkGraphSnapshot(draft(sparse)),
    hasCode("WORK_GRAPH_INVALID"),
  );

  const accessor = task("one");
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get: () => "pending",
  });
  assert.throws(
    () => createWorkGraphSnapshot(draft([accessor])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot({ ...draft([task("one")]), extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );

  const polluted = JSON.parse(
    '{"taskId":"one","revision":1,"parentTaskId":null,"status":"pending","responsibility":{"type":"role","id":"developer"},"acceptanceContracts":[],"deliveries":[],"dependsOn":[],"__proto__":{"admin":true}}',
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([polluted])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.equal({}.admin, undefined);
});

test("keeps contract and delivery history revisioned and rejects stale bindings", () => {
  const revised = task("implementation", {
    revision: 3,
    status: "completed",
    acceptanceContracts: [
      contract(),
      contract({
        revision: 2,
        acceptanceCriteria: [
          { criterionId: "tests-pass", description: "All tests pass" },
        ],
      }),
    ],
    deliveries: [
      delivery({ status: "rejected", summary: "Needs rework" }),
      delivery({
        revision: 2,
        contractRevision: 2,
        summary: "Rework accepted",
      }),
    ],
  });
  assert.doesNotThrow(() => createWorkGraphSnapshot(draft([revised])));

  const stale = {
    ...revised,
    status: "in_progress",
    deliveries: [delivery({ contractRevision: 3 })],
  };
  assert.throws(
    () => createWorkGraphSnapshot(draft([stale])),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );

  const snapshot = createWorkGraphSnapshot(draft([task("one")]));
  assert.throws(
    () => normalizeWorkGraphSnapshot(snapshot, { expectedRevision: 6 }),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );
});

test("rejects blank prose and graph revisions older than contained tasks", () => {
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            acceptanceContracts: [
              contract({
                acceptanceCriteria: [
                  { criterionId: "tests-pass", description: "   " },
                ],
              }),
            ],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery({ summary: "\t " })],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("one", { revision: 8 })], { revision: 7 }),
      ),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );
});

test("rejects combined parent-dependency cycles and premature parent completion", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root", { acceptanceContracts: [groupingContract] }),
          task("child", {
            parentTaskId: "root",
            dependsOn: ["root"],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root", {
            status: "completed",
            acceptanceContracts: [groupingContract],
          }),
          task("child", { parentTaskId: "root" }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("foundation"),
          task("consumer", {
            revision: 2,
            status: "completed",
            dependsOn: ["foundation"],
            deliveries: [delivery()],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("validates one-step CAS transitions and append-only task histories", () => {
  const previous = createWorkGraphSnapshot(
    draft([task("implementation")], { revision: 7 }),
  );
  const next = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "completed",
          deliveries: [delivery()],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(validateWorkGraphTransition(previous, next), next);

  const invalidNextSnapshots = [
    createWorkGraphSnapshot(
      draft(
        [task("implementation", { revision: 2, status: "in_progress" })],
        { revision: 9 },
      ),
    ),
    createWorkGraphSnapshot(draft([], { revision: 8 })),
    createWorkGraphSnapshot(
      draft([task("implementation", { status: "in_progress" })], {
        revision: 8,
      }),
    ),
    createWorkGraphSnapshot(
      draft([task("implementation", { revision: 3, status: "in_progress" })], {
        revision: 8,
      }),
    ),
  ];
  for (const invalidNext of invalidNextSnapshots) {
    assert.throws(
      () => validateWorkGraphTransition(previous, invalidNext),
      (error) =>
        error instanceof WorkGraphError &&
        [
          "WORK_GRAPH_STALE_REVISION",
          "WORK_GRAPH_INVALID_TRANSITION",
        ].includes(error.code),
    );
  }

  const validNewTask = createWorkGraphSnapshot(
    draft([task("implementation"), task("new-task")], { revision: 8 }),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, validNewTask),
    validNewTask,
  );

  const invalidNewTasks = [
    task("new-task", { revision: 2 }),
    task("new-task", { status: "in_progress" }),
    task("new-task", {
      revision: 2,
      acceptanceContracts: [contract(), contract({ revision: 2 })],
    }),
    task("new-task", { deliveries: [delivery()] }),
  ];
  for (const invalidNewTask of invalidNewTasks) {
    const invalidNewTaskSnapshot = createWorkGraphSnapshot(
      draft([task("implementation"), invalidNewTask], { revision: 8 }),
    );
    assert.throws(
      () => validateWorkGraphTransition(previous, invalidNewTaskSnapshot),
      hasCode("WORK_GRAPH_INVALID_TRANSITION"),
    );
  }
});

test("rejects rewritten history and newly appended deliveries for stale contracts", () => {
  const contracts = [
    contract(),
    contract({
      revision: 2,
      acceptanceCriteria: [
        { criterionId: "tests-pass", description: "All tests pass" },
      ],
    }),
  ];
  const previous = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [delivery({ status: "rejected" })],
        }),
      ],
      { revision: 7 },
    ),
  );
  const rewrittenHistory = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected", summary: "rewritten history" }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, rewrittenHistory),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );

  const staleAppend = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected" }),
            delivery({
              revision: 2,
              contractRevision: 1,
              status: "submitted",
            }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, staleAppend),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );

  const currentAppend = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "completed",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected" }),
            delivery({ revision: 2, contractRevision: 2 }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(validateWorkGraphTransition(previous, currentAppend), currentAppend);
});

test("enforces delivery revision, evidence, count, and serialized byte limits", () => {
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 3,
            deliveries: [delivery(), delivery({ revision: 3 })],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery(), delivery({ revision: 2 })],
          }),
        ]),
        { limits: { maxDeliveriesPerTask: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery({ summary: "x".repeat(256) })],
          }),
        ]),
        { limits: { maxDeliveryBytesPerTask: 128 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [
              delivery({ evidence: [] }),
            ],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("computes blocked, ready, and sibling-parallel leaf tasks", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([
      task("root", {
        status: "in_progress",
        acceptanceContracts: [
          contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
        ],
      }),
      task("foundation", {
        revision: 2,
        parentTaskId: "root",
        status: "completed",
        deliveries: [delivery()],
      }),
      task("api", { parentTaskId: "root", dependsOn: ["foundation"] }),
      task("ui", { parentTaskId: "root", dependsOn: ["foundation"] }),
      task("release", { parentTaskId: "root", dependsOn: ["api", "ui"] }),
    ]),
  );

  assert.deepEqual(getReadyWorkGraphTaskIds(snapshot), ["api", "ui"]);
  assert.deepEqual(getParallelReadyWorkGraphTaskIds(snapshot), ["api", "ui"]);
  assert.deepEqual(getBlockedWorkGraphTasks(snapshot), [
    { taskId: "release", blockingTaskIds: ["api", "ui"] },
  ]);
});

test("derives parent pending, partial, completed, failed, and cancelled outcomes", () => {
  const parent = task("root", {
    status: "in_progress",
    acceptanceContracts: [
      contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
    ],
  });
  const graph = (children) =>
    createWorkGraphSnapshot(
      draft([parent, ...children.map((entry) => ({ ...entry, parentTaskId: "root" }))]),
    );

  const pendingParent = { ...parent, status: "pending" };
  assert.equal(
    deriveParentTaskOutcome(
      createWorkGraphSnapshot(
        draft([pendingParent, { ...task("one"), parentTaskId: "root" }]),
      ),
      "root",
    ).outcome,
    "pending",
  );
  assert.equal(
    deriveParentTaskOutcome(graph([task("one")]), "root").outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { revision: 2, status: "completed", deliveries: [delivery()] }),
        task("two"),
      ]),
      "root",
    ).outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { revision: 2, status: "completed", deliveries: [delivery()] }),
        task("two", { revision: 2, status: "completed", deliveries: [delivery()] }),
      ]),
      "root",
    ).outcome,
    "completed",
  );
  const dependencyBlockedParent = createWorkGraphSnapshot(
    draft([
      task("gate"),
      { ...parent, dependsOn: ["gate"] },
      {
        ...task("one", {
          revision: 2,
          status: "completed",
          deliveries: [delivery()],
        }),
        parentTaskId: "root",
      },
    ]),
  );
  assert.equal(
    deriveParentTaskOutcome(dependencyBlockedParent, "root").outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(graph([task("one", { status: "failed" })]), "root")
      .outcome,
    "failed",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { status: "cancelled" }),
        task("two", { status: "cancelled" }),
      ]),
      "root",
    ).outcome,
    "cancelled",
  );
});

test("parent outcome lookup rejects hostile task ids without coercion", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([
      task("root", {
        acceptanceContracts: [
          contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
        ],
      }),
      task("child", { parentTaskId: "root" }),
    ]),
  );
  let coercions = 0;
  const hostileTaskId = {
    toString() {
      coercions += 1;
      return "root";
    },
  };

  assert.throws(
    () => deriveParentTaskOutcome(snapshot, hostileTaskId),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.equal(coercions, 0);
});
