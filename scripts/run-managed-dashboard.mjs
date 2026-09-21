import path from "node:path";

const managedEnvironmentKeys = [
  "MYDASHBOARD_MANAGED_TOKEN",
  "MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY",
  "MYDASHBOARD_MANAGED_PROJECT_DIGEST",
  "MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS",
  "MYDASHBOARD_MANAGED_LOG_DIRECTORY",
  "MYDASHBOARD_MANAGED_INSTANCE_ID",
  "MYDASHBOARD_MANAGED_START_IDENTITY",
];

const capturedEnvironment = Object.fromEntries(
  managedEnvironmentKeys.map((name) => [name, process.env[name]]),
);
for (const name of managedEnvironmentKeys) delete process.env[name];

const projectRoot = path.resolve(import.meta.dirname, "..");
const {
  captureRuntimeStartupIdentity,
  verifyRuntimeStartupIdentity,
} = await import("../src/lib/runtime-startup-identity.js");
const runtimeSourceIdentity = await captureRuntimeStartupIdentity(projectRoot);
const { startManagedDashboardFromCapturedEnvironment } = await import(
  "../src/server.js"
);
await verifyRuntimeStartupIdentity(projectRoot, runtimeSourceIdentity);
await startManagedDashboardFromCapturedEnvironment(
  capturedEnvironment,
  runtimeSourceIdentity,
  () => verifyRuntimeStartupIdentity(projectRoot, runtimeSourceIdentity),
);
