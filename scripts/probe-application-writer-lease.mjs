import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationWriterLease } from "../src/lib/application-writer-lease.js";

const PROJECT_DIGEST = /^[a-f0-9]{64}$/u;
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptsDirectory, "..");
const projectDigest = process.env.MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST;
const holdUntilInputCloses = process.env.MYDASHBOARD_WRITER_LEASE_HOLD === "1";
delete process.env.MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST;
delete process.env.MYDASHBOARD_WRITER_LEASE_HOLD;

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
  if (holdUntilInputCloses) {
    process.stdout.write('{"schemaVersion":1,"ok":true,"holding":true}\n');
    await new Promise((resolve, reject) => {
      process.stdin.once("end", resolve);
      process.stdin.once("error", reject);
      process.stdin.resume();
    });
    await lease.close();
  } else {
    await lease.close();
    process.stdout.write('{"schemaVersion":1,"ok":true}\n');
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
  process.exitCode = 1;
}
