import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultWorkGraphMetadata,
  projectWorkLedgerGraphSnapshot,
  validateWorkLedgerGraphTransition,
  workLedgerStatusToGraphStatus,
} from "../src/services/work-ledger-graph.js";
import {
  createAssignmentWorkItem,
  createGapAlertWorkItem,
} from "../src/services/work-ledger-records.js";
import {
  emptyWorkLedgerState,
  normalizeWorkLedgerPersistedState,
  WORK_LEDGER_STATE_SCHEMA_VERSION,
} from "../src/services/work-ledger-state.js";

const CREATED_AT = "2026-08-03T01:00:00.000Z";

function assignment(sequence, target = { type: "role", id: "pr-reviewer" }) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: `workflow-event-${sequence}`,
      target,
      reason: `route-${sequence}`,
      createdAt: CREATED_AT,
    },
    event: {
      schemaVersion: 1,
      eventId: `workflow-event-${sequence}`,
      eventType: "pull_request.created",
      occurredAt: CREATED_AT,
      subject: { id: `subject-${sequence}` },
      payload: { number: sequence },
    },
  };
}

function stateWithItems(items) {
  const state = emptyWorkLedgerState();
  state.revision = Math.max(1, ...items.map(({ revision }) => revision));
  state.items = items;
  state.intakeCursor = Math.max(
    0,
    ...items.map(({ sourceSequence }) => sourceSequence),
  );
  state.sourceHighWatermark = state.intakeCursor;
  return state;
}

function corrupted(error) {
  return error.code === "WORK_LEDGER_STATE_CORRUPTED";
}

test("new ledger items carry minimal graph metadata and project without a second state source", () => {
  const queued = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const blocked = createGapAlertWorkItem(
    { expectedSequence: 2, actualSequence: 4, reason: "source_retention" },
    CREATED_AT,
  );
  const snapshot = projectWorkLedgerGraphSnapshot(
    stateWithItems([queued, blocked]),
  );
  const byId = new Map(snapshot.tasks.map((task) => [task.taskId, task]));

  assert.equal(snapshot.graphId, "work-ledger");
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(queued.graph, createDefaultWorkGraphMetadata());
  assert.deepEqual(blocked.graph, createDefaultWorkGraphMetadata());
  assert.equal(byId.get(queued.itemId).status, "pending");
  assert.equal(byId.get(blocked.itemId).status, "in_progress");
  assert.deepEqual(byId.get(queued.itemId).responsibility, queued.currentTarget);
});

test("every ledger status has an explicit graph projection", () => {
  const expected = new Map([
    ["queued", "pending"],
    ["working", "in_progress"],
    ["dispatch_pending", "in_progress"],
    ["waiting_user", "in_progress"],
    ["waiting_condition", "in_progress"],
    ["waiting_external", "in_progress"],
    ["retry_wait", "in_progress"],
    ["completed", "completed"],
    ["blocked", "in_progress"],
    ["cancelled", "cancelled"],
  ]);

  for (const [status, graphStatus] of expected) {
    assert.equal(workLedgerStatusToGraphStatus(status), graphStatus);
  }
  assert.throws(
    () => workLedgerStatusToGraphStatus("invented"),
    (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
  );
  assert.throws(
    () => workLedgerStatusToGraphStatus({ toString: () => "queued" }),
    (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
  );
});

test("ledger graph revisions and recoverable statuses follow the ledger CAS", () => {
  const empty = emptyWorkLedgerState();
  const queued = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const first = stateWithItems([queued]);

  assert.equal(projectWorkLedgerGraphSnapshot(empty).revision, 0);
  assert.equal(projectWorkLedgerGraphSnapshot(first).revision, 1);
  assert.doesNotThrow(() => validateWorkLedgerGraphTransition(empty, first));

  const active = structuredClone(first);
  active.revision = 2;
  active.items[0].revision = 2;
  active.items[0].status = "working";
  assert.doesNotThrow(() => validateWorkLedgerGraphTransition(first, active));

  for (const status of ["waiting_user", "retry_wait", "blocked"]) {
    const waiting = structuredClone(active);
    waiting.revision = 3;
    waiting.items[0].revision = 3;
    waiting.items[0].status = status;
    assert.doesNotThrow(() =>
      validateWorkLedgerGraphTransition(active, waiting),
    );

    const requeued = structuredClone(waiting);
    requeued.revision = 4;
    requeued.items[0].revision = 4;
    requeued.items[0].status = "queued";
    assert.doesNotThrow(() =>
      validateWorkLedgerGraphTransition(waiting, requeued),
    );
  }
});

test("schema v2 composes graph and identity migrations without changing ledger facts", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 2;
  for (const item of legacy.items) delete item.graph;
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(migrated, current);
  assert.deepEqual(legacy, callerSnapshot);
});

test("schema v3 migrates identically to v4 before graph tasks are admitted", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 3;
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(migrated, current);
  assert.deepEqual(legacy, callerSnapshot);
});

test("schema v2 preserves responsibility IDs accepted by the existing ledger", () => {
  for (const target of [
    { type: "role", id: "审查员" },
    { type: "person", id: "alice@example.com" },
    { type: "node", id: "PR review node" },
  ]) {
    const current = stateWithItems([
      createAssignmentWorkItem(assignment(1, target), CREATED_AT),
    ]);
    current.schemaVersion = 2;
    for (const item of current.items) delete item.graph;

    assert.deepEqual(
      normalizeWorkLedgerPersistedState(current).items[0].currentTarget,
      target,
    );
  }
});

test("schema v1 composes both migrations and initializes both later checkpoints", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
  for (const item of legacy.items) delete item.graph;

  assert.deepEqual(normalizeWorkLedgerPersistedState(legacy), current);
});

test("dangling and cyclic embedded graph relationships make recovery fail closed", async (t) => {
  const first = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const second = createAssignmentWorkItem(assignment(2), CREATED_AT);

  await t.test("dangling parent", () => {
    const state = stateWithItems([first]);
    state.items[0].graph.parentItemId = "missing-item";
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("parent cycle", () => {
    const state = stateWithItems([
      structuredClone(first),
      structuredClone(second),
    ]);
    state.items[0].graph.parentItemId = state.items[1].itemId;
    state.items[1].graph.parentItemId = state.items[0].itemId;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });
});

test("graph metadata is an exact versioned object", async (t) => {
  const item = createAssignmentWorkItem(assignment(1), CREATED_AT);

  await t.test("extra field", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.items[0].graph.typo = true;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("missing field", () => {
    const state = stateWithItems([structuredClone(item)]);
    delete state.items[0].graph.deliveries;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("accessor field", () => {
    let invoked = false;
    const state = stateWithItems([structuredClone(item)]);
    Object.defineProperty(state.items[0].graph, "deliveries", {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    assert.equal(invoked, false);
  });

  await t.test("mixed schema v2 item", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.schemaVersion = 2;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("graph collection cap", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.items[0].graph.deliveries = Array.from({ length: 257 }, () => null);
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });
});

test("ledger recovery rejects sparse arrays and accessors without invoking them", async (t) => {
  for (const collection of ["items", "timeline", "outbox"]) {
    await t.test(`sparse ${collection} array`, () => {
      const state = emptyWorkLedgerState();
      state[collection] = new Array(1);
      assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    });

    await t.test(`${collection} array accessor`, () => {
      let invoked = false;
      const entries = [];
      Object.defineProperty(entries, "0", {
        enumerable: true,
        get() {
          invoked = true;
          return null;
        },
      });
      const state = emptyWorkLedgerState();
      state[collection] = entries;

      assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
      assert.equal(invoked, false);
    });
  }

  await t.test("schema v2 item array accessor", () => {
    let invoked = false;
    const items = [];
    Object.defineProperty(items, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return createAssignmentWorkItem(assignment(1), CREATED_AT);
      },
    });
    const state = emptyWorkLedgerState();
    state.schemaVersion = 2;
    state.items = items;

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    assert.equal(invoked, false);
  });

  await t.test("item object accessor in graph projection", () => {
    let invoked = false;
    const item = createAssignmentWorkItem(assignment(1), CREATED_AT);
    Object.defineProperty(item, "status", {
      enumerable: true,
      get() {
        invoked = true;
        return "queued";
      },
    });

    assert.throws(
      () => projectWorkLedgerGraphSnapshot({ revision: 1, items: [item] }),
      (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    );
    assert.equal(invoked, false);
  });

  await t.test("revision coercion in graph projection", () => {
    let invoked = false;
    const revision = {
      valueOf() {
        invoked = true;
        return 1;
      },
    };

    assert.throws(
      () => projectWorkLedgerGraphSnapshot({ revision, items: [] }),
      (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    );
    assert.equal(invoked, false);
  });
});
