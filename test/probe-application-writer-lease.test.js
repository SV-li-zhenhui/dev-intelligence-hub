import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { createApplicationWriterLease } from "../src/lib/application-writer-lease.js";

const root = path.resolve(import.meta.dirname, "..");
const probeScript = path.join(root, "scripts", "probe-application-writer-lease.mjs");

function probeEnvironment(projectDigest) {
  return {
    MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST: projectDigest,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
}

function runProbe(projectDigest) {
  return spawnSync(process.execPath, [probeScript], {
    cwd: root,
    encoding: "utf8",
    env: probeEnvironment(projectDigest),
    timeout: 5_000,
    windowsHide: true,
  });
}

test("writer lease probe uses the production lease and emits sanitized bounded results", async (t) => {
  const projectDigest = randomBytes(32).toString("hex");
  const available = runProbe(projectDigest);
  assert.equal(available.status, 0, `${available.stderr}\n${available.stdout}`);
  assert.deepEqual(JSON.parse(available.stdout), { schemaVersion: 1, ok: true });
  assert.equal(available.stderr, "");

  const holder = createApplicationWriterLease({ projectRoot: root, projectDigest });
  t.after(() => holder.close());
  await holder.acquire();

  const held = runProbe(projectDigest);
  assert.equal(held.status, 1, `${held.stderr}\n${held.stdout}`);
  assert.deepEqual(JSON.parse(held.stdout), {
    schemaVersion: 1,
    ok: false,
    error: { code: "PROCESS_GUARD_HELD" },
  });
  assert.equal(held.stderr, "");
  assert.ok(held.stdout.length < 256, held.stdout);
});
