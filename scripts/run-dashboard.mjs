import path from "node:path";
import {
  captureRuntimeStartupIdentity,
  verifyRuntimeStartupIdentity,
} from "../src/lib/runtime-startup-identity.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeSourceIdentity = await captureRuntimeStartupIdentity(projectRoot);
const { startDashboardFromVerifiedRuntime } = await import("../src/server.js");
await verifyRuntimeStartupIdentity(projectRoot, runtimeSourceIdentity);
await startDashboardFromVerifiedRuntime(
  runtimeSourceIdentity,
  () => verifyRuntimeStartupIdentity(projectRoot, runtimeSourceIdentity),
);
