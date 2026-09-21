import assert from "node:assert/strict";
import test from "node:test";

import { ReadinessService } from "../src/services/readiness-service.js";

function probe(id, kind, check) {
  return { id, kind, check };
}

function healthyProbes(overrides = {}) {
  return [
    probe(
      "recovery_state",
      "recovery",
      overrides.recovery ?? (async () => ({ blockerCodes: [] })),
    ),
    probe(
      "external_actions",
      "external_action",
      overrides.externalAction ?? (async () => ({ unknownActionTypes: [] })),
    ),
    probe(
      "storage_capacity",
      "capacity",
      overrides.capacity ?? (async () => ({ warnings: [] })),
    ),
  ];
}

test("liveness is dependency-free while healthy readiness runs every required probe", async () => {
  let calls = 0;
  const service = new ReadinessService({
    probes: healthyProbes({
      recovery: async () => {
        calls += 1;
        return { blockerCodes: [] };
      },
      externalAction: async () => {
        calls += 1;
        return { unknownActionTypes: [] };
      },
      capacity: async () => {
        calls += 1;
        return { warnings: [] };
      },
    }),
  });

  const liveness = service.liveness();
  assert.deepEqual(liveness, { schemaVersion: 1, live: true });
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(liveness));

  const readiness = await service.readiness();
  assert.equal(readiness.ready, true);
  assert.match(readiness.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readiness.recoveryBlockers, []);
  assert.deepEqual(readiness.unknownExternalActions, []);
  assert.deepEqual(readiness.capacityWarnings, []);
  assert.deepEqual(readiness.probeFailures, []);
  assert.deepEqual(readiness.probeSummary, {
    total: 3,
    succeeded: 3,
    failed: 0,
    timedOut: 0,
  });
  assert.equal(calls, 3);
  assert.ok(Object.isFrozen(readiness));
  assert.ok(Object.isFrozen(readiness.probeSummary));
});

test("readiness deterministically aggregates all operational issues", async () => {
  const service = new ReadinessService({
    probes: [
      probe("recovery_z", "recovery", async () => ({
        blockerCodes: ["STORE_NOT_RECOVERED", "CHECKPOINT_RELEASE_UNKNOWN"],
      })),
      probe("recovery_a", "recovery", async () => ({
        blockerCodes: ["APPLICATION_FENCED"],
      })),
      probe("external_actions", "external_action", async () => ({
        unknownActionTypes: ["github_review", "controlled_commit"],
      })),
      probe("storage_capacity", "capacity", async () => ({
        warnings: [
          { resource: "backup_store", severity: "warning", usedPercent: 82.5 },
          { resource: "workspace_store", severity: "critical", usedPercent: 97 },
        ],
      })),
    ],
  });

  const result = await service.readiness();

  assert.equal(result.ready, false);
  assert.deepEqual(result.recoveryBlockers, [
    { probeId: "recovery_a", code: "APPLICATION_FENCED" },
    { probeId: "recovery_z", code: "CHECKPOINT_RELEASE_UNKNOWN" },
    { probeId: "recovery_z", code: "STORE_NOT_RECOVERED" },
  ]);
  assert.deepEqual(result.unknownExternalActions, [
    { probeId: "external_actions", actionType: "controlled_commit" },
    { probeId: "external_actions", actionType: "github_review" },
  ]);
  assert.deepEqual(result.capacityWarnings, [
    {
      probeId: "storage_capacity",
      resource: "backup_store",
      severity: "warning",
      usedPercent: 82.5,
    },
    {
      probeId: "storage_capacity",
      resource: "workspace_store",
      severity: "critical",
      usedPercent: 97,
    },
  ]);
  assert.deepEqual(result.probeFailures, []);
});

test("a non-critical capacity warning stays observable without closing readiness", async () => {
  const service = new ReadinessService({
    probes: healthyProbes({
      capacity: async () => ({
        warnings: [
          { resource: "backup_store", severity: "warning", usedPercent: 81 },
        ],
      }),
    }),
  });

  const result = await service.readiness();

  assert.equal(result.ready, true);
  assert.deepEqual(result.capacityWarnings, [{
    probeId: "storage_capacity",
    resource: "backup_store",
    severity: "warning",
    usedPercent: 81,
  }]);
});

test("probe errors fail closed without traps or secret leakage", async () => {
  let proxyTraps = 0;
  let timedOutSignal;
  // PRIVACY_FAKE_CREDENTIAL_SHA256:64e87c98cb5ccd709f4167e9e599a0b5391be55c96cfc1afda0bed2e89991a26
  const secret = "sk-live-never-render-this";
  const service = new ReadinessService({
    probeTimeoutMs: 20,
    probes: [
      probe("recovery_state", "recovery", async () => {
        throw new Error(`database failed with ${secret}`);
      }),
      probe("external_actions", "external_action", async () => new Proxy({}, {
        getPrototypeOf() {
          proxyTraps += 1;
          throw new Error(`proxy contains ${secret}`);
        },
      })),
      probe("storage_capacity", "capacity", ({ signal }) => {
        timedOutSignal = signal;
        return new Promise(() => {});
      }),
    ],
  });

  const result = await service.readiness();
  const serialized = JSON.stringify(result);

  assert.equal(result.ready, false);
  assert.deepEqual(result.probeFailures, [
    { probeId: "external_actions", code: "PROBE_RESULT_INVALID" },
    { probeId: "recovery_state", code: "PROBE_FAILED" },
    { probeId: "storage_capacity", code: "PROBE_TIMEOUT" },
  ]);
  assert.deepEqual(result.probeSummary, {
    total: 3,
    succeeded: 0,
    failed: 2,
    timedOut: 1,
  });
  assert.equal(proxyTraps, 0);
  assert.equal(timedOutSignal.aborted, true);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("database failed"), false);
});

test("missing categories and oversized probe output remain explicitly not ready", async () => {
  const missing = new ReadinessService({ probes: [] });
  const missingResult = await missing.readiness();
  assert.equal(missingResult.ready, false);
  assert.deepEqual(missingResult.probeFailures, [
    { probeId: "capacity", code: "PROBE_MISSING" },
    { probeId: "external_action", code: "PROBE_MISSING" },
    { probeId: "recovery", code: "PROBE_MISSING" },
  ]);

  const oversized = new ReadinessService({
    probes: healthyProbes({
      recovery: async () => ({
        blockerCodes: Array.from({ length: 17 }, (_, index) => `BLOCKER_${index}`),
      }),
    }),
  });
  const oversizedResult = await oversized.readiness();
  assert.equal(oversizedResult.ready, false);
  assert.deepEqual(oversizedResult.recoveryBlockers, []);
  assert.deepEqual(oversizedResult.probeFailures, [
    { probeId: "recovery_state", code: "PROBE_RESULT_INVALID" },
  ]);
});

test("probe configuration is passive, unique, and strictly bounded", () => {
  let accessorCalls = 0;
  const accessor = { id: "unsafe", kind: "recovery" };
  Object.defineProperty(accessor, "check", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => new ReadinessService({ probes: [accessor] }), TypeError);
  assert.equal(accessorCalls, 0);

  let optionTraps = 0;
  assert.throws(
    () => new ReadinessService(new Proxy({}, {
      get() {
        optionTraps += 1;
        throw new Error("constructor option trap must not run");
      },
    })),
    TypeError,
  );
  assert.equal(optionTraps, 0);

  assert.throws(
    () => new ReadinessService({
      probes: [
        probe("same", "recovery", async () => ({ blockerCodes: [] })),
        probe("same", "capacity", async () => ({ warnings: [] })),
      ],
    }),
    TypeError,
  );
  assert.throws(
    () => new ReadinessService({
      probes: Array.from({ length: 25 }, (_, index) =>
        probe(`probe_${index}`, "recovery", async () => ({ blockerCodes: [] }))),
    }),
    TypeError,
  );
});

test("concurrent readiness callers share one bounded probe cycle", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = new ReadinessService({
    probes: healthyProbes({
      recovery: async () => {
        calls += 1;
        await gate;
        return { blockerCodes: [] };
      },
    }),
  });

  const first = service.readiness();
  const second = service.readiness();
  assert.equal(first, second);
  release();
  assert.equal((await first).ready, true);
  assert.equal(calls, 1);
});

test("a probe that ignores abort stays fenced instead of accumulating hung work", async () => {
  let capacityCalls = 0;
  const service = new ReadinessService({
    probeTimeoutMs: 10,
    probes: healthyProbes({
      capacity: () => {
        capacityCalls += 1;
        return new Promise(() => {});
      },
    }),
  });

  const first = await service.readiness();
  const second = await service.readiness();

  assert.equal(first.ready, false);
  assert.equal(second.ready, false);
  assert.deepEqual(second.probeFailures, [
    { probeId: "storage_capacity", code: "PROBE_TIMEOUT" },
  ]);
  assert.equal(capacityCalls, 1);
});
