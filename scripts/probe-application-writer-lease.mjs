import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationWriterLease } from "../src/lib/application-writer-lease.js";

const PROJECT_DIGEST = /^[a-f0-9]{64}$/u;
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptsDirectory, "..");
const projectDigest = process.env.MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST;
delete process.env.MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST;

function safeFailure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.code)
    ? error.code
    : "WRITER_LEASE_PROBE_FAILED";
  return { schemaVersion: 1, ok: false, error: { code } };
}

try {
  if (!PROJECT_DIGEST.test(projectDigest || "")) {
    throw new TypeError("writer lease probe requires one project digest");
  }
  const lease = createApplicationWriterLease({ projectRoot: projectDirectory, projectDigest });
  await lease.acquire();
  await lease.close();
  process.stdout.write('{"schemaVersion":1,"ok":true}\n');
} catch (error) {
  process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
  process.exitCode = 1;
}
