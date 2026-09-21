import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { createDashboardServer } from "../src/server.js";
import { StateStore } from "../src/lib/state-store.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { ConfiguredRoleEmployee } from "../src/services/configured-role-employee.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";
import {
  createPullRequestExternalActionExecutor,
} from "../src/services/pull-request-external-action-executor.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import {
  pullRequestExternalActionBinding,
  pullRequestExternalActionQueuePlan,
} from "./support/pull-request-external-action-fixture.js";

const NOW = "2026-08-08T08:09:10.111Z";

class MemoryStore {
  values = new Map();

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

class ExclusiveLease {
  #queue = new OperationQueue();

  run(operation) {
    return this.#queue.enqueue(operation);
  }
}

class TestGuard {
  async acquire() {}

  run(operation) {
    return operation();
  }

  async close() {}
}

function guardFactory() {
  return new TestGuard();
}

function workDecision(intent) {
  return JSON.stringify({
    schemaVersion: 1,
    confidence: 96,
    summary: intent.summary,
    intent,
  });
}

function askUserIntent() {
  return {
    schemaVersion: 1,
    type: "ask_user",
    summary: "The employee needs one bounded owner choice.",
    reason: "The configured role cannot safely infer the missing choice.",
    question: "Should this bounded local task continue?",
    choices: [{
      id: "continue",
      label: "Continue",
      description: "Continue under the existing role permissions.",
    }],
  };
}

function completeIntent() {
  return {
    schemaVersion: 1,
    type: "complete",
    summary: "Attempt an unconfigured completion action.",
    reason: "This response deliberately exceeds the role permission fixture.",
    outcome: "done",
    evidence: [],
  };
}

function pullRequestCommentIntent() {
  return {
    schemaVersion: 1,
    type: "propose_github_pull_request_action",
    summary: "Propose one owner-visible PR comment.",
    reason: "The employee may prepare the action but cannot publish it.",
    action: {
      type: "comment",
      body: "Please add the missing regression test.",
    },
    evidence: ["The bounded local review found one missing regression test."],
  };
}

function request(server, {
  method = "GET",
  path = "/",
  headers = {},
  body = "",
} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        method,
        path,
        headers: {
          host: "127.0.0.1:4173",
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function localMutationHeaders({ json = false } = {}) {
  return {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function roleDefinition(id = "requirements-analyst") {
  return {
    id,
    name: "Requirements analyst",
    mission: "Resolve bounded requirements without exceeding configured authority.",
    enabled: true,
    scheduleMinutes: 0,
  };
}

function roleBrain(provider, model, remoteData = {}) {
  return {
    provider,
    model,
    remoteData: {
      requirements: false,
      code: false,
      memory: false,
      ...remoteData,
    },
  };
}

function composedParityConfig({
  model = "small-local-model",
  remote = false,
} = {}) {
  return {
    port: 4173,
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    githubActions: { enabled: false, enabledActions: [] },
    codeExecutor: { enabled: false },
    changePackages: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 10,
      workLimit: 10,
      dispatchLimit: 10,
      attentionLimit: 10,
      proposalLimit: 10,
      conditionLimit: 10,
      codeJobLimit: 10,
      codeJobMemoryLimit: 10,
      leaseDurationMs: 30_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 2_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: {},
        githubReviewRoles: [],
        codeActionRoles: [],
        codeOperationsByRole: {},
        workspaceByRepository: {},
      },
    },
    memory: { enabled: false },
    brainProviders: {
      local: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        remote,
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        "requirements-analyst": {
          name: "Requirements analyst",
          mission:
            "Resolve bounded requirements without exceeding configured authority.",
          enabled: true,
          scheduleMinutes: 0,
          initialPaused: false,
          permissions: { allowedIntents: ["ask_user"] },
          brain: roleBrain("local", model),
        },
      },
    },
  };
}

async function createComposedParityApplication({
  root,
  fetch,
  model,
  remote = false,
}) {
  const clock = () => new Date(NOW);
  return createApplication({
    config: composedParityConfig({ model, remote }),
    versionedConfiguration: false,
    externalActions: false,
    store: new StateStore(path.join(root, "state")),
    operationsRuntimeFactory: () => Object.freeze({
      admission: Object.freeze({ run: (operation) => operation() }),
    }),
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    prEngineerExclusiveGuardFactory: guardFactory,
    workCoordinationDependencies: {
      clock,
      brainDependencies: { fetch },
    },
  });
}

test("UI, HTTP, and the configured employee enforce the same pause and permission state", async (t) => {
  const store = new MemoryStore();
  await store.write("dashboard", { items: [], sourceStatus: {} });
  const providerCalls = [];
  const runCalls = [];
  const router = new BrainRouter({
    providers: [{
      id: "local",
      remote: false,
      async generate(input) {
        providerCalls.push(structuredClone(input));
        return workDecision(askUserIntent());
      },
    }],
  });
  const employee = new ConfiguredRoleEmployee({
    definition: roleDefinition(),
    permissions: { allowedIntents: ["ask_user"] },
    brain: roleBrain("local", "small-local-model"),
    brainRouter: router,
    store,
    stateKey: "u12-parity-role",
    clock: () => new Date(NOW),
    onRun: async (input) => runCalls.push(structuredClone(input)),
  });
  const registry = new EmployeeRegistry([employee]);
  const application = {
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: false },
    },
    store,
    refreshService: { running: null },
    employeeRegistry: registry,
    async close() {},
  };
  const server = createDashboardServer(application, {
    reportError(error) {
      assert.fail(error);
    },
  });
  await listen(server);
  t.after(() => closeServer(server));

  const listed = await request(server, { path: "/api/employees" });
  assert.equal(listed.status, 200);
  const initialRole = JSON.parse(listed.body).items[0];
  assert.deepEqual(initialRole.permissions.allowedIntents, ["ask_user"]);
  assert.equal(initialRole.brain.model, "small-local-model");
  assert.equal(initialRole.paused, false);

  const ui = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(ui, /role\.permissions\?\.allowedIntents \|\| \[\]/u);
  assert.match(ui, /permissions\.length \? permissions\.join\(" · "\)/u);
  assert.match(ui, /data-role-control="\$\{role\.paused \? "resume" : "pause"\}"/u);
  assert.match(ui, /expectedRevision: Number\(button\.dataset\.roleRevision\)/u);
  assert.match(
    ui,
    /\/api\/employees\/\$\{encodeURIComponent\(roleId\)\}\/control/u,
  );

  const pause = await request(server, {
    method: "POST",
    path: "/api/employees/requirements-analyst/control",
    headers: localMutationHeaders({ json: true }),
    body: JSON.stringify({
      command: "pause",
      expectedRevision: initialRole.revision,
    }),
  });
  assert.equal(pause.status, 200);
  let pausedRole = JSON.parse((await request(server, {
    path: "/api/employees",
  })).body).items[0];
  assert.equal(pausedRole.paused, true);
  assert.equal(pausedRole.state, "paused");

  const runWhilePaused = await request(server, {
    method: "POST",
    path: "/api/employees/requirements-analyst/run",
    headers: localMutationHeaders(),
  });
  assert.equal(runWhilePaused.status, 200);
  assert.equal(runCalls.length, 0);
  await assert.rejects(
    employee.decide({
      item: { kind: "manual" },
      context: { requirements: { task: "bounded local task" } },
    }),
    (error) => error.code === "ROLE_PAUSED" && error.statusCode === 409,
  );
  assert.equal(providerCalls.length, 0);

  const resume = await request(server, {
    method: "POST",
    path: "/api/employees/requirements-analyst/control",
    headers: localMutationHeaders({ json: true }),
    body: JSON.stringify({
      command: "resume",
      expectedRevision: pausedRole.revision,
    }),
  });
  assert.equal(resume.status, 200);
  pausedRole = JSON.parse((await request(server, {
    path: "/api/employees",
  })).body).items[0];
  assert.equal(pausedRole.paused, false);

  const manualRun = await request(server, {
    method: "POST",
    path: "/api/employees/requirements-analyst/run",
    headers: localMutationHeaders(),
  });
  assert.equal(manualRun.status, 200);
  assert.equal(runCalls.length, 1);
  const allowed = await employee.decide({
    item: { kind: "manual" },
    context: { requirements: { task: "bounded local task" } },
  });
  assert.equal(allowed.intent.type, "ask_user");
  assert.equal(providerCalls.length, 1);
});

test("production composition preserves UI, API, employee, model, and remote-data authority parity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-action-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerModels = [];
  const localFetch = async (_url, options) => {
    providerModels.push(JSON.parse(options.body).model);
    return new Response(JSON.stringify({
      message: { content: workDecision(completeIntent()) },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  for (const [index, model] of ["small-model", "strong-model"].entries()) {
    const application = await createComposedParityApplication({
      root: path.join(root, `local-${index}`),
      fetch: localFetch,
      model,
    });
    const server = createDashboardServer(application, {
      reportError(error) {
        assert.fail(error);
      },
    });
    await listen(server);
    try {
      const listed = JSON.parse((await request(server, {
        path: "/api/employees",
      })).body);
      const role = listed.items.find(
        ({ id }) => id === "requirements-analyst",
      );
      assert.deepEqual(role.permissions.allowedIntents, ["ask_user"]);
      assert.equal(role.brain.model, model);

      const paused = await request(server, {
        method: "POST",
        path: "/api/employees/requirements-analyst/control",
        headers: localMutationHeaders({ json: true }),
        body: JSON.stringify({
          command: "pause",
          expectedRevision: role.revision,
        }),
      });
      assert.equal(paused.status, 200);
      const employee = application.employeeRegistry.get(
        "requirements-analyst",
      );
      await assert.rejects(
        employee.decide({
          item: { kind: "manual" },
          context: { requirements: { task: "bounded local task" } },
        }),
        (error) => error.code === "ROLE_PAUSED" && error.statusCode === 409,
      );
      assert.equal(providerModels.length, index);

      const pausedRole = JSON.parse((await request(server, {
        path: "/api/employees",
      })).body).items.find(({ id }) => id === "requirements-analyst");
      const resumed = await request(server, {
        method: "POST",
        path: "/api/employees/requirements-analyst/control",
        headers: localMutationHeaders({ json: true }),
        body: JSON.stringify({
          command: "resume",
          expectedRevision: pausedRole.revision,
        }),
      });
      assert.equal(resumed.status, 200);
      await assert.rejects(
        employee.decide({
          item: { kind: "manual" },
          context: { requirements: { task: "bounded local task" } },
        }),
        (error) =>
          error.code === "ROLE_INTENT_NOT_PERMITTED" &&
          error.statusCode === 403,
      );
      assert.equal(providerModels.at(-1), model);
    } finally {
      await server.shutdown();
    }
  }
  assert.deepEqual(providerModels, ["small-model", "strong-model"]);

  let remoteCalls = 0;
  const remoteApplication = await createComposedParityApplication({
    root: path.join(root, "remote"),
    remote: true,
    model: "remote-model",
    async fetch() {
      remoteCalls += 1;
      throw new Error("remote provider must not receive denied context");
    },
  });
  try {
    await assert.rejects(
      remoteApplication.employeeRegistry.get("requirements-analyst").decide({
        item: { kind: "manual" },
        context: {
          requirements: { secretRequirement: "must remain local" },
        },
      }),
      (error) =>
        error.code === "REMOTE_DATA_NOT_AUTHORIZED" &&
        error.statusCode === 403,
    );
    assert.equal(remoteCalls, 0);
  } finally {
    await remoteApplication.close();
  }
});

test("changing only the model cannot expand a role's configured actions", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [{
      id: "local",
      remote: false,
      async generate(input) {
        calls.push(input.model);
        return workDecision(completeIntent());
      },
    }],
  });
  const makeEngine = (model) => new RoleDecisionEngine({
    definition: roleDefinition(`analyst-${model}`),
    permissions: { allowedIntents: ["ask_user"] },
    brain: roleBrain("local", model),
    brainRouter: router,
  });
  const errors = [];
  for (const model of ["small-model", "strong-model"]) {
    try {
      await makeEngine(model).decide({
        item: null,
        context: { requirements: { task: "same bounded task" } },
      });
      assert.fail("a model must not add an unconfigured complete permission");
    } catch (error) {
      errors.push({ code: error.code, statusCode: error.statusCode });
    }
  }

  assert.deepEqual(calls, ["small-model", "strong-model"]);
  assert.deepEqual(errors, [
    { code: "ROLE_INTENT_NOT_PERMITTED", statusCode: 403 },
    { code: "ROLE_INTENT_NOT_PERMITTED", statusCode: 403 },
  ]);
});

test("remote data denial happens before the remote provider receives any context", async () => {
  let remoteCalls = 0;
  const router = new BrainRouter({
    providers: [{
      id: "remote",
      remote: true,
      async generate() {
        remoteCalls += 1;
        return workDecision(askUserIntent());
      },
    }],
  });
  const engine = new RoleDecisionEngine({
    definition: roleDefinition("remote-analyst"),
    permissions: { allowedIntents: ["ask_user"] },
    brain: roleBrain("remote", "remote-model", {
      requirements: false,
    }),
    brainRouter: router,
  });

  await assert.rejects(
    engine.decide({
      item: null,
      context: {
        requirements: { secretRequirement: "must remain local" },
      },
    }),
    (error) =>
      error.code === "REMOTE_DATA_NOT_AUTHORIZED" && error.statusCode === 403,
  );
  assert.equal(remoteCalls, 0);
});

function initialCommentObservation(input) {
  return {
    schemaVersion: 1,
    actorAccountId: input.actorAccountId,
    gitTarget: structuredClone(input.action.inputBinding.gitTarget),
    state: "open",
    actionEvidence: { kind: "marker_records", records: [] },
  };
}

function completedCommentObservation(input) {
  const observation = initialCommentObservation(input);
  observation.actionEvidence.records = [{
    marker: input.marker,
    actorAccountId: input.actorAccountId,
    body: input.action.body,
    reviewEvent: input.action.type === "pull_request_comment"
      ? "COMMENT"
      : input.action.reviewEvent,
    headOid: input.action.inputBinding.gitTarget.headRefOid,
    receipt: { id: "comment-u12-parity" },
  }];
  return observation;
}

function approval(next) {
  return {
    requestId: "request-u12-owner-confirmation",
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
}

test("an employee PR action remains inert until the owner confirmation API boundary", async (t) => {
  const providerCalls = [];
  const brainRouter = new BrainRouter({
    providers: [{
      id: "local",
      remote: false,
      async generate(input) {
        providerCalls.push(structuredClone(input));
        return workDecision(pullRequestCommentIntent());
      },
    }],
  });
  const engine = new RoleDecisionEngine({
    definition: {
      ...roleDefinition("pr-engineer"),
      name: "PR engineer",
    },
    permissions: {
      allowedIntents: ["propose_github_pull_request_action"],
    },
    brain: roleBrain("local", "pr-model"),
    brainRouter,
  });
  const proposed = await engine.decide({
    item: null,
    context: {
      requirements: { task: "review pull request 42" },
      code: { repository: "acme/repo", pullRequestNumber: 42 },
    },
  });
  assert.equal(proposed.intent.type, "propose_github_pull_request_action");
  assert.equal(proposed.intent.action.type, "comment");
  assert.equal(providerCalls.length, 1);

  const binding = pullRequestExternalActionBinding();
  const observations = new Map();
  const transportCalls = [];
  let credentialCalls = 0;
  const transport = {
    async observe(input) {
      transportCalls.push({ method: "observe", input: structuredClone(input) });
      return structuredClone(
        observations.get(input.marker) ?? initialCommentObservation(input),
      );
    },
    async perform(input) {
      transportCalls.push({ method: "perform", input: structuredClone(input) });
      observations.set(input.marker, completedCommentObservation(input));
      return { accepted: true };
    },
  };
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: Object.freeze({
      async acquire() {
        credentialCalls += 1;
        return Object.freeze({
          async use(callback) {
            return callback("fake-token-never-leaves-the-test");
          },
          release() {},
        });
      },
    }),
    transport,
    inputAuthorityVerifier: {
      async verify() {
        return structuredClone(binding);
      },
    },
  });
  const queue = new ConfirmationQueue({
    store: new MemoryStore(),
    executor,
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
    clock: () => new Date(NOW),
  });
  await queue.recover();
  await queue.enqueue(pullRequestExternalActionQueuePlan(
    proposed.intent.action,
    { binding },
  ));

  const store = new MemoryStore();
  await store.write("dashboard", { items: [], sourceStatus: {} });
  const server = createDashboardServer({
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: true },
    },
    store,
    refreshService: { running: null },
    employeeRegistry: new EmployeeRegistry([]),
    confirmationQueue: queue,
    async close() {},
  });
  await listen(server);
  t.after(() => closeServer(server));
  const nextResponse = await request(server, {
    path: "/api/confirmations/next",
  });
  assert.equal(nextResponse.status, 200);
  const next = JSON.parse(nextResponse.body);
  assert.equal(next.pendingCount, 1);
  assert.equal(next.item.kind, "github.pull-request-comment");
  assert.equal(credentialCalls, 0);
  assert.equal(transportCalls.length, 0);

  const ui = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(ui, /showNextConfirmation/u);
  assert.match(
    ui,
    /\/api\/confirmations\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{operation\}/u,
  );
  const approvalResponse = await request(server, {
    method: "POST",
    path: `/api/confirmations/${encodeURIComponent(next.item.id)}/approve`,
    headers: localMutationHeaders({ json: true }),
    body: JSON.stringify(approval(next)),
  });
  assert.equal(approvalResponse.status, 200);
  const completed = JSON.parse(approvalResponse.body).item;
  assert.equal(completed.status, "completed");
  assert.equal(completed.receipt.id, "comment-u12-parity");
  assert.equal(credentialCalls, 1);
  assert.equal(
    transportCalls.filter(({ method }) => method === "perform").length,
    1,
  );
});
