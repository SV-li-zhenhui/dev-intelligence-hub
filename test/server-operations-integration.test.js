import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOperationsRuntime } from "../src/operations-runtime.js";
import { createDashboardServer } from "../src/server.js";

function request(server, { method = "GET", pathname, body = "", headers = {} }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: pathname,
      headers: {
        host: "127.0.0.1:4173",
        ...headers,
        ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("real operations runtime is reachable through the safe system HTTP contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-http-ops-"));
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    path.join(dataDirectory, "work-ledger.json"),
    JSON.stringify({ revision: 1, items: [] }),
    "utf8",
  );
  const operations = createOperationsRuntime({ dataDirectory, backupDirectory });
  const application = {
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: false },
    },
    operations,
    store: { async read() { return null; } },
    refreshService: {
      running: null,
      async refresh() {
        return { dashboard: {} };
      },
    },
  };
  const server = createDashboardServer(application, { reportError() {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const initial = await request(server, {
    pathname: "/api/system/status",
  });
  assert.equal(initial.status, 200);
  assert.deepEqual(JSON.parse(initial.body).backups.items, []);

  const created = await request(server, {
    method: "POST",
    pathname: "/api/system/backups",
    headers: {
      origin: "http://127.0.0.1:4173",
      "content-type": "application/json",
      "x-mydashboard-action": "1",
    },
    body: "{}",
  });
  assert.equal(created.status, 201);
  const receipt = JSON.parse(created.body);
  assert.match(receipt.backupId, /^backup-[a-f0-9]{64}$/u);
  assert.equal(created.body.includes(root), false);

  const after = await request(server, { pathname: "/api/system/status" });
  assert.equal(after.status, 200);
  const status = JSON.parse(after.body);
  assert.equal(status.backups.items[0].backupId, receipt.backupId);
  assert.deepEqual(status.maintenance, {
    mode: "open",
    activeOperations: 0,
  });
  for (const privateField of [root, "sourceDirectory", "producer", "credential"]) {
    assert.equal(after.body.includes(privateField), false);
  }
});
