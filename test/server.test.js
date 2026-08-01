import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createDashboardServer,
  startApplicationBackgroundWork,
} from "../src/server.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";

function request(server, {
  method = "GET",
  path = "/",
  headers = {},
  body = "",
} = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
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
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

async function withServer(run, { legacyOnly = false } = {}) {
  const calls = [];
  const dashboard = {
    meta: { refreshedAt: "2026-07-31T09:00:00.000Z" },
    secretMarker: "private-dashboard-data",
  };
  const prEmployee = {
    id: "pr-reviewer",
    running: null,
    async view() {
      return {
        role: {
          id: "pr-reviewer",
          name: "PR 推进员工",
          state: "observing",
          revision: 4,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "employee_tick", ...options });
      return this.view();
    },
    async tick(options) {
      return this.run(options);
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "employee_control", command, expectedRevision });
      return this.view();
    },
    async decide(id, decision, options) {
      calls.push({ operation: "employee_decide", id, decision, ...options });
      return this.view();
    },
    async searchMemory(query, limit) {
      calls.push({ operation: "memory_search", query, limit });
      return [{ id: "memory-1", title: "Checkout review" }];
    },
  };
  const requirementsAnalyst = {
    id: "requirements-analyst",
    async view() {
      return {
        role: {
          id: this.id,
          name: "需求分析员工",
          state: "observing",
          revision: 2,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "analyst_tick", ...options });
      return this.view();
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "analyst_control", command, expectedRevision });
      return this.view();
    },
  };
  const application = {
    config: { port: 4173, refreshMinutes: 10 },
    store: {
      async read() {
        return dashboard;
      },
    },
    refreshService: {
      running: null,
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
        return { dashboard };
      },
      async confirmPullRequestResponsibility(id, actionState, headRefOid) {
        calls.push({ operation: "confirm", id, actionState, headRefOid });
        return dashboard;
      },
    },
    prEmployee,
  };
  if (!legacyOnly) {
    application.employeeRegistry = new EmployeeRegistry([
      prEmployee,
      requirementsAnalyst,
    ]);
  }
  const server = createDashboardServer(application);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ server, calls });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("background work runs every registered employee after the initial refresh and on schedule", async () => {
  const calls = [];
  const timers = [];
  const employeeRegistry = {
    async runAll(options) {
      calls.push({ operation: "run_all", ...options });
    },
    schedules() {
      return [
        { id: "pr-reviewer", intervalMinutes: 3 },
        { id: "requirements-analyst", intervalMinutes: 11 },
      ];
    },
    async run(id, options) {
      calls.push({ operation: "run", id, ...options });
    },
  };
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry,
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
      },
    },
  };
  const setIntervalFn = (callback, milliseconds) => {
    const timer = {
      callback,
      milliseconds,
      unreferenced: false,
      unref() {
        this.unreferenced = true;
      },
    };
    timers.push(timer);
    return timer;
  };

  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn,
  });
  await backgroundWork.initialRefresh;

  assert.deepEqual(calls, [
    { operation: "refresh", notify: false },
    { operation: "run_all", trigger: "refresh_completed" },
  ]);
  assert.deepEqual(
    timers.map((timer) => timer.milliseconds),
    [7 * 60_000, 3 * 60_000, 11 * 60_000],
  );
  assert.equal(timers.every((timer) => timer.unreferenced), true);

  for (const timer of timers) await timer.callback();

  assert.deepEqual(calls.slice(2), [
    { operation: "refresh", notify: false },
    { operation: "run", id: "pr-reviewer", trigger: "scheduled" },
    {
      operation: "run",
      id: "requirements-analyst",
      trigger: "scheduled",
    },
  ]);
});

test("server rejects an untrusted Host before exposing local data", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, {
      path: "/api/dashboard",
      headers: { host: "evil.example:4173" },
    });

    assert.equal(response.status, 421);
    assert.equal(response.body.includes("private-dashboard-data"), false);
  });
});

test("the local UI cannot be framed by another site", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server);

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(
      response.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
  });
});

test("write endpoints require same-origin action headers and JSON", async () => {
  await withServer(async ({ server, calls }) => {
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });
    const missingActionHeader = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: { origin: "http://127.0.0.1:4173" },
    });
    const plainText = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "text/plain",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "historical",
        headRefOid: "head-1",
      }),
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(missingActionHeader.status, 403);
    assert.equal(plainText.status, 415);
    assert.deepEqual(calls, []);
  });
});

test("same-origin UI requests can refresh and confirm the displayed head", async () => {
  await withServer(async ({ server, calls }) => {
    const trustedHeaders = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    };
    const refresh = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: trustedHeaders,
    });
    const confirm = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        ...trustedHeaders,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      }),
    });

    assert.equal(refresh.status, 200);
    assert.equal(confirm.status, 200);
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      {
        operation: "confirm",
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      },
    ]);
  });
});

test("the scheduled service path can request notification delivery", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      method: "POST",
      path: "/api/refresh?notify=1",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ operation: "refresh", notify: true }]);
  });
});

test("dashboard and health expose the proactive employee without changing stored data", async () => {
  await withServer(async ({ server }) => {
    const dashboard = await request(server, { path: "/api/dashboard" });
    const health = await request(server, { path: "/api/health" });

    assert.equal(dashboard.status, 200);
    const dashboardBody = JSON.parse(dashboard.body);
    const healthBody = JSON.parse(health.body);
    assert.equal(dashboardBody.employee.role.id, "pr-reviewer");
    assert.equal("employees" in dashboardBody, false);
    assert.equal(healthBody.employee.state, "observing");
    assert.deepEqual(
      healthBody.employees.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
  });
});

test("server keeps legacy prEmployee-only applications operational", async () => {
  await withServer(async ({ server, calls }) => {
    const health = await request(server, { path: "/api/health" });
    const list = await request(server, { path: "/api/employees" });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(health.status, 200);
    assert.deepEqual(
      JSON.parse(health.body).employees.map((employee) => employee.id),
      ["pr-reviewer"],
    );
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).items.length, 1);
    assert.equal(run.status, 200);
    assert.deepEqual(calls, [
      { operation: "employee_tick", trigger: "manual" },
    ]);
  }, { legacyOnly: true });
});

test("employee discovery and dynamic routes work for every registered role", async () => {
  await withServer(async ({ server, calls }) => {
    const list = await request(server, { path: "/api/employees" });
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 2 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const missing = await request(server, {
      method: "POST",
      path: "/api/employees/missing-role/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(list.status, 200);
    assert.deepEqual(
      JSON.parse(list.body).items.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
    assert.equal("jobs" in JSON.parse(list.body).items[0], false);
    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(missing.status, 404);
    assert.equal(untrusted.status, 403);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("analyst_")),
      [
        { operation: "analyst_control", command: "pause", expectedRevision: 2 },
        { operation: "analyst_tick", trigger: "manual" },
      ],
    );
  });
});

test("employee control, manual run, and draft decisions use trusted local mutations", async () => {
  await withServer(async ({ server, calls }) => {
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 4 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const decide = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/decide",
      headers,
      body: JSON.stringify({
        id: "pr-work-1",
        decision: "accept",
        headRefOid: "head-1",
        expectedRevision: 4,
      }),
    });

    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(decide.status, 200);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("employee_")),
      [
        { operation: "employee_control", command: "pause", expectedRevision: 4 },
        { operation: "employee_tick", trigger: "manual" },
        {
          operation: "employee_decide",
          id: "pr-work-1",
          decision: "accept",
          headRefOid: "head-1",
          expectedRevision: 4,
        },
      ],
    );
  });
});

test("memory search is local, bounded, and read-only", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/memory/search?q=checkout&limit=999",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).items, [
      { id: "memory-1", title: "Checkout review" },
    ]);
    assert.deepEqual(calls.at(-1), {
      operation: "memory_search",
      query: "checkout",
      limit: 100,
    });
  });
});
