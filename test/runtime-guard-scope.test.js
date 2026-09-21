import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../src/composition-root.js";
import { ProcessExclusiveGuard } from "../src/lib/process-exclusive-guard.js";
import {
  createProjectScopedGuardFactory,
  projectScopedRuntimeGuardName,
} from "../src/lib/project-identity.js";

function uncoordinatedApplicationConfig() {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    employees: { prReviewer: { enabled: false } },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor: { enabled: false },
  };
}

test("project-scoped runtime guard names are stable, safe, and checkout-specific", async (context) => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-guard-one-"));
  const secondRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-guard-two-"));
  context.after(async () => {
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  });

  const first = projectScopedRuntimeGuardName({
    projectRoot: firstRoot,
    guardName: "mydashboard-configuration-v1",
  });
  assert.equal(
    projectScopedRuntimeGuardName({
      projectRoot: firstRoot,
      guardName: "mydashboard-configuration-v1",
    }),
    first,
  );
  assert.match(first, /^mydashboard-runtime-[a-f0-9]{64}$/u);
  assert.notEqual(
    projectScopedRuntimeGuardName({
      projectRoot: secondRoot,
      guardName: "mydashboard-configuration-v1",
    }),
    first,
  );
  assert.notEqual(
    projectScopedRuntimeGuardName({
      projectRoot: firstRoot,
      guardName: "mydashboard-work-ledger-v1",
    }),
    first,
  );
});

test("project-scoped runtime guards exclude the same project but not another checkout", async (context) => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-guard-one-"));
  const secondRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-guard-two-"));
  const guards = [];
  context.after(async () => {
    await Promise.allSettled(guards.map((guard) => guard.close()));
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  });

  const first = new ProcessExclusiveGuard({
    name: projectScopedRuntimeGuardName({
      projectRoot: firstRoot,
      guardName: "mydashboard-work-ledger-v1",
    }),
  });
  const sameProject = new ProcessExclusiveGuard({
    name: projectScopedRuntimeGuardName({
      projectRoot: firstRoot,
      guardName: "mydashboard-work-ledger-v1",
    }),
  });
  const otherProject = new ProcessExclusiveGuard({
    name: projectScopedRuntimeGuardName({
      projectRoot: secondRoot,
      guardName: "mydashboard-work-ledger-v1",
    }),
  });
  guards.push(first, sameProject, otherProject);

  await first.acquire();
  await assert.rejects(sameProject.acquire(), {
    code: "PROCESS_GUARD_HELD",
  });
  await otherProject.acquire();
});

test("project-scoped guard factory preserves an explicitly supplied factory", async (context) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-guard-factory-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const received = [];
  const explicitFactory = (options) => {
    received.push(options);
    return { marker: "explicit" };
  };
  const projectFactory = createProjectScopedGuardFactory({ projectRoot });

  const explicitlyCreated = explicitFactory({ name: "mydashboard-memory-v1" });
  const defaultCreated = projectFactory({ name: "mydashboard-memory-v1" });

  assert.equal(explicitlyCreated.marker, "explicit");
  assert.deepEqual(received, [{ name: "mydashboard-memory-v1" }]);
  assert.equal(defaultCreated.name.startsWith("mydashboard-runtime-"), true);
  await defaultCreated.close();
});

test("application composition injects a scoped default guard and preserves an explicit guard factory", async () => {
  const defaultCalls = [];
  const defaultApplication = await createApplication({
    config: uncoordinatedApplicationConfig(),
    versionedConfiguration: false,
    externalActions: false,
    workflowRoutingRuntimeFactory: async (_config, options) => {
      defaultCalls.push(options);
      return { async readAssignmentBatch() {}, async close() {} };
    },
  });
  try {
    assert.equal(typeof defaultCalls[0]?.createGuard, "function");
    const guard = defaultCalls[0].createGuard({
      name: "mydashboard-workflow-routing-v1",
    });
    assert.match(guard.name, /^mydashboard-runtime-[a-f0-9]{64}$/u);
    await guard.close();
  } finally {
    await defaultApplication.close();
  }

  const explicitGuardFactory = () => ({ marker: "explicit" });
  const explicitCalls = [];
  const explicitApplication = await createApplication({
    config: uncoordinatedApplicationConfig(),
    versionedConfiguration: false,
    externalActions: false,
    workflowRoutingDependencies: { createGuard: explicitGuardFactory },
    workflowRoutingRuntimeFactory: async (_config, options) => {
      explicitCalls.push(options);
      return { async readAssignmentBatch() {}, async close() {} };
    },
  });
  try {
    assert.strictEqual(explicitCalls[0].createGuard, explicitGuardFactory);
  } finally {
    await explicitApplication.close();
  }
});
