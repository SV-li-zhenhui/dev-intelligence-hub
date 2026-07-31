import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDashboardServer } from "../src/server.js";

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

async function withServer(run) {
  const calls = [];
  const dashboard = {
    meta: { refreshedAt: "2026-07-31T09:00:00.000Z" },
    secretMarker: "private-dashboard-data",
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
    prEmployee: {
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
      async tick(options) {
        calls.push({ operation: "employee_tick", ...options });
        return this.view();
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
    },
  };
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
    assert.equal(JSON.parse(dashboard.body).employee.role.id, "pr-reviewer");
    assert.equal(JSON.parse(health.body).employee.state, "observing");
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
