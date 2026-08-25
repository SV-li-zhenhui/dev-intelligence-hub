import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerTestSandbox } from "../src/adapters/docker-test-sandbox.js";

const enabled = process.env.MYDASHBOARD_DOCKER_INTEGRATION === "1";
const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

test(
  "real Docker sandbox denies host network, secrets, and source writes",
  {
    skip: !enabled
      ? "requires MYDASHBOARD_DOCKER_INTEGRATION=1"
      : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "docker-sandbox-live-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(path.join(workspacePath, "test"), { recursive: true });
    await writeFile(
      path.join(workspacePath, "test", "boundary.test.js"),
      `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

test("container boundary", async () => {
  assert.equal(process.env.MYDASHBOARD_TEST_SECRET, undefined);
  await assert.rejects(
    fetch("http://host.docker.internal:4173", {
      signal: AbortSignal.timeout(1_000),
    }),
  );
  await assert.rejects(writeFile("/workspace/escape.txt", "blocked"));
  await writeFile("/tmp/allowed.txt", "ok");
  await writeFile("/artifacts/result.txt", "contained");
  assert.equal(await readFile("/tmp/allowed.txt", "utf8"), "ok");
  assert.equal(await readFile("/artifacts/result.txt", "utf8"), "contained");
});
`,
      "utf8",
    );
    t.after(() => rm(root, { recursive: true, force: true }));

    const sandbox = new DockerTestSandbox({
      dockerExecutable:
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      dockerHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
      allowedWorkspaceRoot: root,
      profiles: {
        "node-tests": { kind: "node-test", image, timeoutMs: 30_000 },
        "library-boundary": {
          kind: "node-script",
          image,
          timeoutMs: 30_000,
          asset: {
            schemaVersion: 1,
            title: "Live reusable test",
            description: "Proves a centrally managed script runs inside the real boundary.",
            version: 1,
            source: `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

assert.equal(process.env.MYDASHBOARD_TEST_SECRET, undefined);
assert.match(await readFile("/workspace/test/boundary.test.js", "utf8"), /container boundary/);
await assert.rejects(writeFile("/workspace/library-escape.txt", "blocked"));
await writeFile("/artifacts/library-result.txt", "reusable-test-passed");
console.log("reusable-test-passed");`,
          },
        },
      },
      sourceEnvironment: {
        ...process.env,
        MYDASHBOARD_TEST_SECRET: "must-not-leak",
      },
    });

    const result = await sandbox.run({
      profileId: "node-tests",
      workspacePath,
      executionId: "live-run",
      actionId: "live-check",
    });

    assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /pass 1/);

    const libraryResult = await sandbox.run({
      profileId: "library-boundary",
      workspacePath,
      executionId: "live-library",
      actionId: "live-script",
    });

    assert.equal(
      libraryResult.exitCode,
      0,
      `${libraryResult.stderr}\n${libraryResult.stdout}`,
    );
    assert.match(libraryResult.stdout, /reusable-test-passed/);
    assert.match(libraryResult.profileFingerprint, /^[a-f0-9]{64}$/);
  },
);
