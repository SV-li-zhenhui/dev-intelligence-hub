import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.platform === "win32"
  ? path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : "pwsh";
const powershell7 = process.platform === "win32"
  ? path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")
  : "pwsh";
const powershell7Available = spawnSync(
  powershell7,
  ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
  { encoding: "utf8", timeout: 10_000 },
).status === 0;
const WINDOWS_MANAGER_SKIP = process.platform !== "win32"
  ? "requires Windows PowerShell manager"
  : false;
const POWERSHELL_7_MANAGER_SKIP = process.platform !== "win32"
  ? "requires Windows PowerShell manager"
  : powershell7Available
    ? false
    : "requires PowerShell 7";
const READINESS_PRIVATE_MARKERS = Object.freeze({
  blocker: "PRIVATE_READINESS_BLOCKER",
  path: "C:\\private\\readiness-state.json",
  credential: "sk-private-readiness-credential",
});
const READINESS_SAFE_MESSAGE =
  "MyDashboard is running but readiness could not be confirmed safely.";

async function copyWritableFixtureFile(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function invokeManager(
  root,
  action,
  timeoutSeconds = 5,
  executable = powershell,
  extraArguments = [],
  environment = process.env,
) {
  return spawnSync(
    executable,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "Manage-MyDashboard.ps1"),
      "-Action",
      action,
      "-TimeoutSeconds",
      String(timeoutSeconds),
      ...extraArguments,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      timeout: Math.max(30_000, (timeoutSeconds + 15) * 1_000),
    },
  );
}

function isolatedRealServerEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === "path") continue;
    if (/(?:token|api_key|secret|password|credential)/iu.test(name)) continue;
    environment[name] = value;
  }
  environment.PATH = [
    path.dirname(process.execPath),
    path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
  ].join(path.delimiter);
  return environment;
}

function removeFixtureTree(target) {
  return rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function stopOwnedFixtureProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "close" });
  const stoppedGracefully = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (stoppedGracefully || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`fixture process ${child.pid} did not exit`)),
      5_000,
    )),
  ]);
}

async function startForeignListener(t, { mode, port }) {
  const child = spawn(process.execPath, [
    path.join(projectRoot, "test", "fixtures", "operations-listener-fixture.cjs"),
    mode,
    String(port),
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopOwnedFixtureProcess(child));
  const [ready] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([status, signal]) => {
      throw new Error(
        `foreign listener exited before ready (${status}/${signal}): ${stderr}`,
      );
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`foreign listener did not bind port ${port}`)),
      5_000,
    )),
  ]);
  assert.deepEqual(ready, { type: "ready" });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  return { child, messages };
}

async function assertTcpListenerAlive(child, port) {
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => { throw error; }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`listener on port ${port} did not accept TCP`)),
        1_000,
      )),
    ]);
  } finally {
    socket.destroy();
  }
}

async function installRestoreRecorder(root, markerPath) {
  await writeFile(
    path.join(root, "scripts", "manage-offline-restore.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "restore helper invoked\\n", "utf8");
const backupId = process.argv.at(-1);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  action: "activate",
  result: { status: "activated", backupId },
}) + "\\n");
`,
    "utf8",
  );
}

function invokeManagerAsync(root, action) {
  const child = spawnManager(root, action);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function spawnManager(root, action) {
  return spawn(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "Manage-MyDashboard.ps1"),
      "-Action",
      action,
      "-TimeoutSeconds",
      "5",
    ],
    { cwd: root, windowsHide: true },
  );
}

function readRuntimeInfo(root) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "launch-mydashboard-process.mjs"), "--runtime-info"],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function waitForHealth(port, processId) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`);
      const body = await response.json();
      if (body.processId === processId && body.service === "mydashboard") return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw lastError || new Error("mock server did not become healthy");
}

async function waitForPath(filePath, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForProcessExit(processId, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${processId} did not exit`);
}

async function assertPortUnavailable(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/live`, {
    signal: AbortSignal.timeout(500),
  }));
}

async function createFixture(
  t,
  {
    shutdownExitCode = 0,
    claimMode = "normal",
    listenDelayMilliseconds = 0,
    readinessMode = "ready",
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-manager-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  const port = await availablePort();
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "Manage-MyDashboard.ps1"),
    path.join(root, "scripts", "Manage-MyDashboard.ps1"),
  );
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "launch-mydashboard-process.mjs"),
    path.join(root, "scripts", "launch-mydashboard-process.mjs"),
  );
  await writeFile(
    path.join(root, "scripts", "run-managed-dashboard.mjs"),
    'await import("../src/server.js");\n',
    "utf8",
  );
  await writeFile(path.join(root, "config.json"), `${JSON.stringify({ port })}\n`);
  await writeFile(
    path.join(root, "src", "server.js"),
    `import { createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
const origin = \`http://127.0.0.1:\${config.port}\`;
const names = [
  "MYDASHBOARD_MANAGED_TOKEN",
  "MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY",
  "MYDASHBOARD_MANAGED_PROJECT_DIGEST",
  "MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS",
  "MYDASHBOARD_MANAGED_LOG_DIRECTORY",
  "MYDASHBOARD_MANAGED_INSTANCE_ID",
  "MYDASHBOARD_MANAGED_START_IDENTITY",
];
const environment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
for (const name of names) delete process.env[name];
const managed = Boolean(environment.MYDASHBOARD_MANAGED_TOKEN);
const tokenBytes = managed ? Buffer.from(environment.MYDASHBOARD_MANAGED_TOKEN, "base64") : null;
let lifecycleState = managed ? "pending_claim" : "running";
let livenessStartIdentity = environment.MYDASHBOARD_MANAGED_START_IDENTITY;
let watchdog = null;
const readinessMode = ${JSON.stringify(readinessMode)};
const readinessPrivateMarkers = ${JSON.stringify(READINESS_PRIVATE_MARKERS)};
if (managed) {
  writeFileSync(
    path.join(environment.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY, "fixture-child-started.marker"),
    JSON.stringify({ processId: process.pid }),
    { encoding: "utf8", flag: "w", mode: 0o600 },
  );
}
function authorized(request) {
  if (!managed) return false;
  const supplied = Buffer.from(request.headers["x-mydashboard-control-token"] || "", "base64");
  return supplied.length === 32 && timingSafeEqual(tokenBytes, supplied) &&
    request.headers["x-mydashboard-process-id"] === String(process.pid) &&
    request.headers["x-mydashboard-instance-id"] === environment.MYDASHBOARD_MANAGED_INSTANCE_ID &&
    request.headers["x-mydashboard-start-identity"] === environment.MYDASHBOARD_MANAGED_START_IDENTITY;
}
function receiptPayload(receipt) {
  return [
    "receipt-v1",
    receipt.phase,
    receipt.status,
    String(receipt.processId),
    receipt.instanceId,
    receipt.startIdentity,
    receipt.atUnixMilliseconds,
    receipt.errorCode || "",
  ].join("\\n");
}
function writeReceipt(phase, status, errorCode = null) {
  const receipt = {
    schemaVersion: 1,
    phase,
    status,
    processId: process.pid,
    instanceId: environment.MYDASHBOARD_MANAGED_INSTANCE_ID,
    startIdentity: environment.MYDASHBOARD_MANAGED_START_IDENTITY,
    atUnixMilliseconds: String(Date.now()),
    errorCode,
    hmac: "",
  };
  receipt.hmac = createHmac("sha256", tokenBytes)
    .update(receiptPayload(receipt), "utf8")
    .digest("base64");
  writeFileSync(
    path.join(environment.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY, \`mydashboard-shutdown-\${receipt.instanceId}-\${phase}.json\`),
    \`\${JSON.stringify(receipt)}\\n\`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      live: true,
      service: "mydashboard",
      processId: process.pid,
      managed,
      lifecycleState,
      ...(managed ? {
        instanceId: environment.MYDASHBOARD_MANAGED_INSTANCE_ID,
        startIdentity: livenessStartIdentity,
      } : {}),
    }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/system/status") {
    if (readinessMode === "hang") return;
    if (readinessMode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '{"readiness":{"ready":false},"credential":"' +
          readinessPrivateMarkers.credential + '"',
      );
      return;
    }
    if (readinessMode === "oversized") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        readiness: { ready: true },
        private: readinessPrivateMarkers,
        padding: "x".repeat(128 * 1024),
      }));
      return;
    }
    if (readinessMode !== "missing") {
      const ready = readinessMode !== "not-ready";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        liveness: { schemaVersion: 1, live: true },
        readiness: {
          schemaVersion: 1,
          ready,
          recoveryBlockers: ready ? [] : [{
            probeId: "recovery_state",
            code: readinessPrivateMarkers.blocker,
            path: readinessPrivateMarkers.path,
            credential: readinessPrivateMarkers.credential,
          }],
          unknownExternalActions: [],
          storageWarnings: [],
          probeFailures: [],
        },
        maintenance: { mode: "open", activeOperations: 0 },
        backups: {
          available: true,
          items: [],
          incompleteCount: 0,
          unrecognizedCount: 0,
        },
      }));
      if (readinessMode === "identity-race") {
        livenessStartIdentity = "0".repeat(64);
      }
      return;
    }
  }
  if (
    request.method === "POST" &&
    request.url === "/api/system/claim" &&
    request.headers.origin === origin &&
    request.headers["x-mydashboard-action"] === "1" &&
    authorized(request)
  ) {
    if (${JSON.stringify(claimMode)} === "hang") return;
    lifecycleState = "running";
    clearTimeout(watchdog);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ claimed: true, state: "running" }));
    return;
  }
  if (
    request.method === "POST" &&
    request.url === "/api/system/shutdown" &&
    request.headers.origin === origin &&
    request.headers["x-mydashboard-action"] === "1" &&
    (!managed || authorized(request))
  ) {
    if (managed) {
      lifecycleState = "stopping";
      clearTimeout(watchdog);
      writeReceipt("requested", "unknown");
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, state: "stopping" }), () => {
      if (managed) {
        writeReceipt(
          "terminal",
          ${shutdownExitCode} === 0 ? "success" : "failure",
          ${shutdownExitCode} === 0 ? null : "LIFECYCLE_FAILURE",
        );
      }
      process.exitCode = ${shutdownExitCode};
      server.close();
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
setTimeout(() => {
  server.listen(config.port, "127.0.0.1", () => {
    if (managed) {
      watchdog = setTimeout(
        () => {
          if (lifecycleState === "pending_claim") {
            server.close();
            server.closeAllConnections?.();
          }
        },
        Number(environment.MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS),
      );
      watchdog.unref();
    }
  });
}, ${listenDelayMilliseconds});
`,
    "utf8",
  );
  t.after(async () => {
    const runtime = readRuntimeInfo(root);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(500),
      });
      const health = await response.json();
      if (health.service === "mydashboard") {
        let controlHeaders = {};
        try {
          const state = JSON.parse(await readFile(
            path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
            "utf8",
          ));
          controlHeaders = {
            "x-mydashboard-control-token": state.controlToken,
            "x-mydashboard-process-id": String(state.processId),
            "x-mydashboard-instance-id": state.instanceId,
            "x-mydashboard-start-identity": state.startIdentity,
          };
        } catch {
          // Unmanaged fixtures have no authenticated control state.
        }
        await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
          method: "POST",
          headers: {
            origin: `http://127.0.0.1:${port}`,
            "x-mydashboard-action": "1",
            ...controlHeaders,
          },
          signal: AbortSignal.timeout(500),
        });
      }
    } catch {
      // The fixture is already stopped or never reached liveness.
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/live`, {
          signal: AbortSignal.timeout(100),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        break;
      }
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(300),
      });
      const health = await response.json();
      if (health.service === "mydashboard" && Number.isInteger(health.processId)) {
        process.kill(health.processId);
        await waitForProcessExit(health.processId, 5_000);
      }
    } catch {
      // No fixture-owned listener remains.
    }
    await removeFixtureTree(runtime.runtimeDirectory);
    await removeFixtureTree(root);
  });
  return { root, port };
}

async function createRealServerFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-real-manager-"));
  const port = await availablePort();
  assert.notEqual(port, 4173);
  await cp(path.join(projectRoot, "src"), path.join(root, "src"), {
    recursive: true,
  });
  const guardPath = path.join(root, "src", "lib", "process-exclusive-guard.js");
  await chmod(guardPath, 0o644);
  const guardSource = await readFile(guardPath, "utf8");
  const fixtureGuardPrefix = `fixture-${randomBytes(8).toString("hex")}`;
  await writeFile(
    guardPath,
    guardSource.replace(
      "function guardEndpoint(name) {",
      `function guardEndpoint(name) {\n  name = \`${fixtureGuardPrefix}-\${name}\`;`,
    ),
    "utf8",
  );
  await cp(path.join(projectRoot, "public"), path.join(root, "public"), {
    recursive: true,
  });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  for (const name of [
    "Manage-MyDashboard.ps1",
    "launch-mydashboard-process.mjs",
    "run-managed-dashboard.mjs",
  ]) {
    await copyWritableFixtureFile(
      path.join(projectRoot, "scripts", name),
      path.join(root, "scripts", name),
    );
  }
  const configuration = JSON.parse(await readFile(
    path.join(projectRoot, "config.example.json"),
    "utf8",
  ));
  configuration.port = port;
  await writeFile(
    path.join(root, "config.example.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "mydashboard-real-manager-fixture",
      private: true,
      type: "module",
      files: ["config.example.json", "public/", "scripts/", "src/"],
    }, null, 2)}\n`,
    "utf8",
  );
  const environment = isolatedRealServerEnvironment();
  const externalGitHub = spawnSync("gh", ["--version"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(externalGitHub.error?.code, "ENOENT");
  t.after(async () => {
    const runtime = readRuntimeInfo(root);
    invokeManager(root, "Stop", 10, powershell, [], environment);
    try {
      const live = await (await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(500),
      })).json();
      if (live.service === "mydashboard" && Number.isInteger(live.processId)) {
        process.kill(live.processId);
        await waitForProcessExit(live.processId, 5_000);
      }
    } catch {
      // The real fixture is already stopped.
    }
    await removeFixtureTree(runtime.runtimeDirectory);
    await removeFixtureTree(root);
  });
  return { root, port, runtime: readRuntimeInfo(root), environment };
}

test(
  "the real application server completes authenticated manager start and stop on an isolated port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port, runtime, environment } = await createRealServerFixture(t);
    const started = invokeManager(root, "Start", 30, powershell, [], environment);
    const managedLog = await readFile(
      path.join(runtime.runtimeDirectory, "logs", "server.log"),
      "utf8",
    ).catch(() => "<no managed server log>");
    assert.equal(
      started.status,
      0,
      `${started.stderr}\n${started.stdout}\n${managedLog}`,
    );
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const state = JSON.parse(await readFile(controlPath, "utf8"));
    assert.equal(managedLog.includes(state.controlToken), false);
    const live = await (await fetch(`http://127.0.0.1:${port}/api/live`)).json();
    assert.equal(live.processId, state.processId);
    assert.equal(live.instanceId, state.instanceId);
    assert.equal(live.lifecycleState, "running");
    assert.equal(live.runtimeSource.clean, true);
    assert.match(live.runtimeSource.headOid, /^[a-f0-9]{64}$/u);
    assert.match(live.runtimeSource.treeOid, /^[a-f0-9]{64}$/u);
    assert.match(live.runtimeSource.runtimeDigest, /^[a-f0-9]{64}$/u);
    assert.equal(live.runtimeSource.runtimeFileCount > 0, true);
    assert.equal(live.runtimeSource.runtimeByteCount > 0, true);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);

    const stopStartedAt = performance.now();
    const stopped = invokeManager(root, "Stop", 30, powershell, [], environment);
    const stopDurationMs = performance.now() - stopStartedAt;
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.match(stopped.stdout, /stopped gracefully/u);
    assert.equal(
      stopDurationMs < 10_000,
      true,
      `isolated manager stop took ${stopDurationMs} ms`,
    );
    await assertPortUnavailable(port);
    await assert.rejects(readFile(controlPath, "utf8"), { code: "ENOENT" });
  },
);

test(
  "PowerShell manager starts, identifies, reports, and gracefully stops only its process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    assert.equal(path.isAbsolute(runtime.runtimeDirectory), true);
    assert.notEqual(
      path.dirname(runtime.runtimeDirectory).toLowerCase(),
      path.join(root, "data").toLowerCase(),
    );
    const started = invokeManager(root, "Start");
    assert.equal(started.error, undefined);
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    assert.match(started.stdout, new RegExp(`started at http://127\\.0\\.0\\.1:${port}`));

    const stateText = await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    );
    assert.equal(stateText.charCodeAt(0), "{".charCodeAt(0));
    const state = JSON.parse(stateText);
    await waitForHealth(port, state.processId);
    assert.doesNotThrow(() => process.kill(state.processId, 0));

    const status = invokeManager(root, "Status");
    assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, new RegExp(`PID ${state.processId}`));

    const restarted = invokeManager(root, "Restart");
    assert.equal(restarted.status, 0, `${restarted.stderr}\n${restarted.stdout}`);
    assert.match(restarted.stdout, /stopped gracefully/u);
    assert.match(restarted.stdout, /started at/u);
    const restartedState = JSON.parse(await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    ));
    assert.notEqual(restartedState.instanceId, state.instanceId);
    await waitForHealth(port, restartedState.processId);
    assert.throws(() => process.kill(state.processId, 0));

    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.match(stopped.stdout, /stopped gracefully/);
    assert.throws(() => process.kill(restartedState.processId, 0));

    const finalStatus = invokeManager(root, "Status");
    assert.equal(finalStatus.status, 3);
    assert.match(finalStatus.stdout, /is stopped/);
  },
);

for (const scenario of [
  { mode: "ready", label: "explicit readiness" },
  { mode: "not-ready", label: "explicit non-readiness" },
  { mode: "malformed", label: "malformed readiness JSON" },
  { mode: "hang", label: "hanging readiness" },
  { mode: "missing", label: "a missing readiness route" },
  { mode: "oversized", label: "an oversized readiness body" },
  { mode: "identity-race", label: "a post-readiness identity race" },
]) {
  test(
    `managed Status reports ${scenario.label} safely`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const { root, port } = await createFixture(t, {
        readinessMode: scenario.mode,
      });
      const runtime = readRuntimeInfo(root);
      const started = invokeManager(root, "Start");
      assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
      const state = JSON.parse(await readFile(path.join(
        runtime.runtimeDirectory,
        "mydashboard-server-process.json",
      ), "utf8"));

      const statusStartedAt = performance.now();
      const status = invokeManager(root, "Status");
      const statusDurationMilliseconds = performance.now() - statusStartedAt;
      assert.equal(status.error, undefined);
      const output = `${status.stdout}\n${status.stderr}`;
      const leakedValues = [
        ...Object.values(READINESS_PRIVATE_MARKERS),
        state.controlToken,
        root,
      ].filter((value) => output.includes(value));

      if (scenario.mode === "ready") {
        assert.deepEqual(
          {
            exitCode: status.status,
            reportsManagedProcess: new RegExp(
              `running at http://127\\.0\\.0\\.1:${port} \\(PID ${state.processId}\\)`,
              "u",
            ).test(status.stdout),
            bounded: statusDurationMilliseconds < 7_000,
            leakedValues,
          },
          {
            exitCode: 0,
            reportsManagedProcess: true,
            bounded: true,
            leakedValues: [],
          },
          output,
        );
        return;
      }

      assert.deepEqual(
        {
          exitCode: status.status,
          stdout: status.stdout.trim(),
          stderr: status.stderr.trim(),
          bounded: statusDurationMilliseconds < 7_000,
          leakedValues,
        },
        {
          exitCode: 5,
          stdout: READINESS_SAFE_MESSAGE,
          stderr: "",
          bounded: true,
          leakedValues: [],
        },
        output,
      );
    },
  );
}

test(
  "PowerShell manager permits an exact offline restore only while the service is stopped",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const callsPath = path.join(root, "restore-invocations.jsonl");
    await writeFile(
      path.join(root, "scripts", "manage-offline-restore.mjs"),
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const authorized = process.env.MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY === "manager-v1" &&
  /^[a-f0-9]{64}$/.test(process.env.MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST || "");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, authorized }) + "\\n");
if (!authorized || args.length !== 2 || args[0] !== "--activate") process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  action: "activate",
  result: { status: "activated", backupId: args[1] },
}) + "\\n");
`,
      "utf8",
    );
    const backupId = `backup-${"a".repeat(64)}`;
    const restored = invokeManager(
      root,
      "Restore",
      5,
      powershell,
      ["-BackupId", backupId],
    );
    assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);
    assert.match(restored.stdout, new RegExp(backupId));
    assert.match(restored.stdout, /service remains stopped/u);
    assert.deepEqual(
      (await readFile(callsPath, "utf8")).trim().split(/\r?\n/u).map(JSON.parse),
      [{ args: ["--activate", backupId], authorized: true }],
    );
    await assertPortUnavailable(port);

    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const refused = invokeManager(
      root,
      "Restore",
      5,
      powershell,
      ["-BackupId", backupId],
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /must be stopped before offline restore/u);
    assert.equal(
      (await readFile(callsPath, "utf8")).trim().split(/\r?\n/u).length,
      1,
    );
  },
);

for (const scenario of [
  { mode: "raw", label: "a raw TCP listener" },
  { mode: "not-found", label: "an HTTP 404 listener" },
  { mode: "malformed", label: "malformed liveness JSON" },
  { mode: "hang", label: "an accept-but-hang listener" },
]) {
  test(
    `offline Restore rejects ${scenario.label} before invoking its helper`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const { root, port } = await createFixture(t);
      const markerPath = path.join(root, "restore-helper-invoked.marker");
      await installRestoreRecorder(root, markerPath);
      const foreign = await startForeignListener(t, {
        mode: scenario.mode,
        port,
      });
      const backupId = `backup-${"b".repeat(64)}`;

      const restored = invokeManager(
        root,
        "Restore",
        5,
        powershell,
        ["-BackupId", backupId],
      );
      assert.equal(restored.error, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const helperTouched = await fileExists(markerPath);
      await assertTcpListenerAlive(foreign.child, port);
      const shutdownRequests = foreign.messages.filter((message) =>
        message.type === "request" &&
        message.method === "POST" &&
        message.url === "/api/system/shutdown"
      ).length;
      const output = `${restored.stderr}\n${restored.stdout}`;

      assert.deepEqual(
        {
          refused: restored.status !== 0,
          helperTouched,
          foreignListenerAlive: true,
          shutdownRequests,
          genericListenerRefusal: /configured port.*listener|port.*occupied/iu.test(
            output,
          ),
        },
        {
          refused: true,
          helperTouched: false,
          foreignListenerAlive: true,
          shutdownRequests: 0,
          genericListenerRefusal: true,
        },
        output,
      );
    },
  );
}

test(
  "Start and state-free Status fence an HTTP 404 listener without controlling it",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const foreign = await startForeignListener(t, { mode: "not-found", port });

    const status = invokeManager(root, "Status");
    const started = invokeManager(root, "Start");
    assert.equal(status.error, undefined);
    assert.equal(started.error, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const childLaunchMarker = await fileExists(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    ));
    await assertTcpListenerAlive(foreign.child, port);
    const shutdownRequests = foreign.messages.filter((message) =>
      message.type === "request" &&
      message.method === "POST" &&
      message.url === "/api/system/shutdown"
    ).length;
    const startOutput = `${started.stderr}\n${started.stdout}`;

    assert.deepEqual(
      {
        statusCode: status.status,
        startRefused: started.status !== 0,
        childLaunchMarker,
        shutdownRequests,
        foreignListenerAlive: true,
        genericListenerRefusal: /unmanaged listener|port.*occupied/iu.test(
          startOutput,
        ),
      },
      {
        statusCode: 4,
        startRefused: true,
        childLaunchMarker: false,
        shutdownRequests: 0,
        foreignListenerAlive: true,
        genericListenerRefusal: true,
      },
      `${status.stderr}\n${status.stdout}\n${startOutput}`,
    );
  },
);

test(
  "PowerShell 7 uses the same private ACL and authenticated lifecycle",
  { skip: POWERSHELL_7_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start", 10, powershell7);
    const failedStartLiveness = started.status === 0
      ? null
      : await fetch(`http://127.0.0.1:${port}/api/live`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => {
          const value = await response.json();
          return {
            status: response.status,
            service: value.service,
            processId: value.processId,
            lifecycleState: value.lifecycleState,
          };
        }).catch((error) => ({ error: error.name }));
    assert.equal(
      started.status,
      0,
      `${started.stderr}\n${started.stdout}\n${JSON.stringify(failedStartLiveness)}`,
    );
    const state = JSON.parse(await readFile(path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    await waitForHealth(port, state.processId);
    const crossVersionStatus = invokeManager(root, "Status");
    assert.equal(
      crossVersionStatus.status,
      0,
      `${crossVersionStatus.stderr}\n${crossVersionStatus.stdout}`,
    );
    const stopped = invokeManager(root, "Stop", 10, powershell7);
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    await assertPortUnavailable(port);
  },
);

test(
  "PowerShell manager refuses an unrecorded loopback listener without killing it",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const unmanaged = spawn(process.execPath, [path.join(root, "src", "server.js")], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(() => {
      if (unmanaged.exitCode === null) unmanaged.kill();
    });
    await waitForHealth(port, unmanaged.pid);

    const result = invokeManager(root, "Start");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /unmanaged listener/);
    assert.doesNotThrow(() => process.kill(unmanaged.pid, 0));

    const response = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${port}`,
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(response.status, 202);
    await Promise.race([
      once(unmanaged, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("unmanaged mock did not stop")), 5_000),
      ),
    ]);
  },
);

test(
  "concurrent starts serialize and retain one health-bound process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const [first, second] = await Promise.all([
      invokeManagerAsync(root, "Start"),
      invokeManagerAsync(root, "Start"),
    ]);
    for (const result of [first, second]) {
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    }

    const runtime = readRuntimeInfo(root);
    const state = JSON.parse(await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    ));
    await waitForHealth(port, state.processId);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    assert.equal(
      [first.stdout, second.stdout].filter((output) => /started at/u.test(output)).length,
      1,
    );
    assert.equal(
      [first.stdout, second.stdout].filter((output) => /already running/u.test(output)).length,
      1,
    );

    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.throws(() => process.kill(state.processId, 0));
  },
);

test(
  "a manager killed after durable control publication leaves a child that self-exits unclaimed",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, { claimMode: "hang" });
    const runtime = readRuntimeInfo(root);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const manager = spawnManager(root, "Start");
    manager.stdout.resume();
    manager.stderr.resume();
    const state = JSON.parse(await waitForPath(controlPath));
    await waitForHealth(port, state.processId);
    const managerExited = once(manager, "exit");
    assert.equal(manager.kill(), true);
    await managerExited;

    await waitForProcessExit(state.processId, 8_000);
    await assertPortUnavailable(port);
    const status = invokeManager(root, "Status");
    assert.equal(status.status, 6, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, /retained unknown control state/u);
    const refusedRestart = invokeManager(root, "Start");
    assert.notEqual(refusedRestart.status, 0);
    assert.match(
      `${refusedRestart.stderr}\n${refusedRestart.stdout}`,
      /dead without a durable success receipt/u,
    );
  },
);

test(
  "exclusive launch-result failure stops only the unpublished child and preserves the colliding file",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const initialized = invokeManager(root, "Status");
    assert.equal(initialized.status, 3, `${initialized.stderr}\n${initialized.stdout}`);
    const resultPath = path.join(
      runtime.runtimeDirectory,
      `mydashboard-launch-result-${process.pid}-${randomBytes(16).toString("hex")}.json`,
    );
    await writeFile(resultPath, "preexisting-owner-data", "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    const token = randomBytes(32).toString("base64");
    const launched = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "launch-mydashboard-process.mjs"), resultPath],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          MYDASHBOARD_MANAGED_TOKEN: token,
          MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY: runtime.runtimeDirectory,
          MYDASHBOARD_MANAGED_PROJECT_DIGEST: runtime.projectDigest,
          MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS: "4000",
          MYDASHBOARD_MANAGED_LOG_DIRECTORY: path.join(
            runtime.runtimeDirectory,
            "logs",
          ),
        },
      },
    );
    assert.notEqual(launched.status, 0);
    assert.equal(await readFile(resultPath, "utf8"), "preexisting-owner-data");
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "exclusive control publication failure gracefully stops the authenticated child and preserves the owner file",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, {
      listenDelayMilliseconds: 1_000,
    });
    const runtime = readRuntimeInfo(root);
    const managerResult = invokeManagerAsync(root, "Start");
    const marker = JSON.parse(await waitForPath(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    )));
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    await writeFile(controlPath, "preexisting-control-owner", "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });

    const failed = await managerResult;
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stderr}\n${failed.stdout}`, /already exists/u);
    assert.equal(await readFile(controlPath, "utf8"), "preexisting-control-owner");
    await waitForProcessExit(marker.processId, 8_000);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "tampered launch-result HMAC is rejected while the unclaimed child self-exits",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const launcherPath = path.join(
      root,
      "scripts",
      "launch-mydashboard-process.mjs",
    );
    const launcher = await readFile(launcherPath, "utf8");
    const tamperedLauncher = launcher.replace(
      "hmac: hmac(launchPayload(child.pid)),",
      'hmac: Buffer.alloc(32).toString("base64"),',
    );
    assert.notEqual(tamperedLauncher, launcher);
    await writeFile(launcherPath, tamperedLauncher, "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });

    const failed = invokeManager(root, "Start");
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stderr}\n${failed.stdout}`, /was not authenticated/u);
    const marker = JSON.parse(await waitForPath(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    )));
    await waitForProcessExit(marker.processId, 8_000);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "tampered authenticated control fails closed without touching an unrelated Node process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const original = await readFile(controlPath, "utf8");
    const state = JSON.parse(original);
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    await writeFile(
      controlPath,
      JSON.stringify({ ...state, processId: state.processId + 1 }),
      "utf8",
    );
    const tampered = invokeManager(root, "Status");
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stderr}\n${tampered.stdout}`, /authentication failed/u);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));

    await writeFile(controlPath, original, "utf8");
    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    await assertPortUnavailable(port);
  },
);

test(
  "junction aliases share the real-project mutex and one control plane",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const alias = `${root}-junction`;
    await symlink(root, alias, "junction");
    t.after(() => unlink(alias).catch(() => {}));
    const directRuntime = readRuntimeInfo(root);
    const aliasRuntime = readRuntimeInfo(alias);
    assert.equal(aliasRuntime.projectDigest, directRuntime.projectDigest);
    assert.equal(aliasRuntime.runtimeDirectory, directRuntime.runtimeDirectory);

    const [direct, throughAlias] = await Promise.all([
      invokeManagerAsync(root, "Start"),
      invokeManagerAsync(alias, "Start"),
    ]);
    for (const result of [direct, throughAlias]) {
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    }
    const state = JSON.parse(await readFile(path.join(
      directRuntime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    await waitForHealth(port, state.processId);
    assert.equal(
      [direct.stdout, throughAlias.stdout]
        .filter((output) => /started at/u.test(output)).length,
      1,
    );
    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  },
);

test(
  "a dead recorded instance cannot authorize shutdown of a new listener on its old port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const state = JSON.parse(await readFile(path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    process.kill(state.processId);
    await waitForProcessExit(state.processId);

    const replacement = spawn(
      process.execPath,
      [path.join(root, "src", "server.js")],
      { cwd: root, stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (replacement.exitCode === null) replacement.kill();
    });
    await waitForHealth(port, replacement.pid);
    const stopped = invokeManager(root, "Stop");
    assert.notEqual(stopped.status, 0);
    assert.match(
      `${stopped.stderr}\n${stopped.stdout}`,
      /dead without a durable success receipt|different process/u,
    );
    assert.doesNotThrow(() => process.kill(replacement.pid, 0));
    const response = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${port}`,
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(response.status, 202);
    await once(replacement, "exit");
  },
);

test(
  "failure receipt retains control and prevents Restart from creating a new writer",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, { shutdownExitCode: 1 });
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const stopped = invokeManager(root, "Stop");
    assert.notEqual(stopped.status, 0);
    assert.match(`${stopped.stderr}\n${stopped.stdout}`, /shutdown failure/u);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const retained = JSON.parse(await readFile(controlPath, "utf8"));
    await waitForProcessExit(retained.processId);

    const restarted = invokeManager(root, "Restart");
    assert.notEqual(restarted.status, 0);
    assert.match(`${restarted.stderr}\n${restarted.stdout}`, /shutdown failure/u);
    assert.equal(await readFile(controlPath, "utf8").then(Boolean), true);
    await assertPortUnavailable(port);
  },
);

test(
  "broad-write ACL and runtime junctions are rejected before process control",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const first = await createFixture(t);
    const firstRuntime = readRuntimeInfo(first.root);
    const initialized = invokeManager(first.root, "Status");
    assert.equal(initialized.status, 3, `${initialized.stderr}\n${initialized.stdout}`);
    const aclScript = [
      `$target = '${firstRuntime.runtimeDirectory.replaceAll("'", "''")}'`,
      "$acl = [System.IO.Directory]::GetAccessControl($target)",
      "$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
      "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
      "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
      "[void]$acl.AddAccessRule($rule)",
      "[System.IO.Directory]::SetAccessControl($target, $acl)",
    ].join("; ");
    const weakened = spawnSync(
      powershell,
      ["-NoProfile", "-Command", aclScript],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(weakened.status, 0, `${weakened.stderr}\n${weakened.stdout}`);
    const refusedAcl = invokeManager(first.root, "Status");
    assert.notEqual(refusedAcl.status, 0);
    assert.match(`${refusedAcl.stderr}\n${refusedAcl.stdout}`, /broad write access/u);

    const second = await createFixture(t);
    const secondRuntime = readRuntimeInfo(second.root);
    await mkdir(path.dirname(secondRuntime.runtimeDirectory), { recursive: true });
    const junctionTarget = path.join(second.root, "runtime-junction-target");
    await mkdir(junctionTarget);
    await symlink(junctionTarget, secondRuntime.runtimeDirectory, "junction");
    const refusedJunction = invokeManager(second.root, "Status");
    assert.notEqual(refusedJunction.status, 0);
    assert.match(`${refusedJunction.stderr}\n${refusedJunction.stdout}`, /not a regular directory/u);
    await unlink(secondRuntime.runtimeDirectory);
  },
);
