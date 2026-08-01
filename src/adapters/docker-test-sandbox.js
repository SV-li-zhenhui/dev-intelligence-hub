import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ManagedProcessError,
  ManagedProcessRunner,
} from "../lib/managed-process.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const IMAGE_WITH_DIGEST =
  /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const RUN_KEYS = new Set([
  "profileId",
  "workspacePath",
  "executionId",
  "actionId",
  "signal",
]);
const CLEANUP_KEYS = new Set(["executionId", "actionId"]);
const NODE_TEST_ARGS = Object.freeze([
  "--permission",
  "--allow-child-process",
  "--allow-fs-read=/workspace",
  "--allow-fs-read=/artifacts",
  "--allow-fs-read=/tmp",
  "--allow-fs-write=/artifacts",
  "--allow-fs-write=/tmp",
  "--test",
]);
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export class DockerSandboxError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DockerSandboxError";
    this.code = code;
    if (details) this.details = details;
  }
}

function sandboxError(code, message, cause, details) {
  return new DockerSandboxError(code, message, { cause, details });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", `${label} is invalid`);
  }
  return value;
}

function normalizeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw sandboxError("INVALID_SANDBOX_CONFIG", "Sandbox profiles are invalid");
  }
  const normalized = new Map();
  for (const [id, profile] of Object.entries(profiles)) {
    assertSafeId(id, "profileId");
    const keys = Object.keys(profile || {}).sort();
    if (
      !keys.every((key) => ["image", "kind", "timeoutMs"].includes(key)) ||
      profile.kind !== "node-test" ||
      !IMAGE_WITH_DIGEST.test(profile.image) ||
      !Number.isSafeInteger(profile.timeoutMs) ||
      profile.timeoutMs < 1_000 ||
      profile.timeoutMs > 600_000
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Sandbox profile is invalid");
    }
    normalized.set(id, Object.freeze({ ...profile }));
  }
  return normalized;
}

function fixedDockerEnvironment(sourceEnvironment) {
  const sourceEntries = Object.entries(sourceEnvironment || {});
  const environment = { DOCKER_CLI_HINTS: "false" };
  for (const requested of ["SystemRoot", "WINDIR"]) {
    const entry = sourceEntries.find(
      ([name]) => name.toLowerCase() === requested.toLowerCase(),
    );
    if (entry && typeof entry[1] === "string") environment[entry[0]] = entry[1];
  }
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      left === "DOCKER_CLI_HINTS" ? 1 : right === "DOCKER_CLI_HINTS" ? -1 : 0,
    ),
  );
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(ANSI_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

function isMountableAbsolutePath(value) {
  return (
    typeof value === "string" &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value)) &&
    !value.includes(",")
  );
}

async function resolveDirectory(value) {
  if (!isMountableAbsolutePath(value)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  let stats;
  try {
    stats = await lstat(value);
  } catch (error) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is unavailable", error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  const resolved = await realpath(value);
  if (resolved.includes(",")) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  return resolved;
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function assertExactRequest(request, allowedKeys, requiredKeys) {
  if (!isPlainRecord(request)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request is invalid");
  }
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request has unknown fields");
  }
  if (requiredKeys.some((key) => !Object.hasOwn(request, key))) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request is incomplete");
  }
}

function isAbortSignal(value) {
  return (
    value === null ||
    (value &&
      typeof value === "object" &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function" &&
      typeof value.removeEventListener === "function")
  );
}

function sanitizedProcessDetails(details) {
  if (!isPlainRecord(details)) return undefined;
  return {
    exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null,
    signal: typeof details.signal === "string" ? details.signal : null,
    stdout: sanitizeOutput(details.stdout),
    stderr: sanitizeOutput(details.stderr),
    durationMs: Number.isFinite(details.durationMs)
      ? Math.max(0, Math.round(details.durationMs))
      : 0,
    truncated: Boolean(details.truncated),
  };
}

function containerName(executionId, actionId) {
  const digest = createHash("sha256")
    .update(`${executionId}:${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `mydashboard-${digest}`;
}

function translateProcessError(error) {
  const code = {
    PROCESS_TIMEOUT: "SANDBOX_TIMEOUT",
    PROCESS_OUTPUT_LIMIT: "SANDBOX_OUTPUT_LIMIT",
    PROCESS_ABORTED: "SANDBOX_ABORTED",
  }[error.code];
  const details = sanitizedProcessDetails(error.details);
  return code
    ? sandboxError(code, "Sandbox execution was interrupted", error, details)
    : sandboxError(
        "SANDBOX_START_FAILED",
        "Sandbox execution failed",
        error,
        details,
      );
}

function retainCleanupState(error, cleanup) {
  if (!cleanup.cleanupPending) return error;
  error.details = {
    ...(error.details || {}),
    cleanupPending: true,
    containerName: cleanup.containerName,
  };
  return error;
}

export class DockerTestSandbox {
  constructor({
    dockerExecutable,
    dockerHost,
    allowedWorkspaceRoot,
    profiles,
    processRunner = new ManagedProcessRunner(),
    sourceEnvironment = process.env,
  }) {
    if (
      typeof dockerExecutable !== "string" ||
      !(path.isAbsolute(dockerExecutable) || path.win32.isAbsolute(dockerExecutable))
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Docker executable is invalid");
    }
    if (
      typeof dockerHost !== "string" ||
      !(dockerHost.startsWith("npipe://") || dockerHost.startsWith("unix://"))
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Docker host must be local");
    }
    if (
      !isMountableAbsolutePath(allowedWorkspaceRoot)
    ) {
      throw sandboxError(
        "INVALID_SANDBOX_CONFIG",
        "Allowed workspace root is invalid",
      );
    }
    this.dockerExecutable = dockerExecutable;
    this.dockerHost = dockerHost;
    this.allowedWorkspaceRoot = allowedWorkspaceRoot;
    this.profiles = normalizeProfiles(profiles);
    this.processRunner = processRunner;
    this.environment = fixedDockerEnvironment(sourceEnvironment);
  }

  async run(request) {
    this.assertRunRequest(request);
    const profile = this.profiles.get(request.profileId);
    if (!profile) {
      throw sandboxError("SANDBOX_PROFILE_NOT_FOUND", "Sandbox profile was not found");
    }
    const workspacePath = await this.resolveWorkspace(request.workspacePath);
    const name = containerName(request.executionId, request.actionId);
    const imageId = await this.probe(profile, request.signal);
    let result;
    try {
      result = await this.runDocker(
        this.runArguments({
          name,
          profile,
          workspacePath,
        }),
        profile.timeoutMs,
        request.signal,
      );
    } catch (error) {
      const cleanup = await this.removeContainer(name, { bestEffort: true });
      const failure = error instanceof ManagedProcessError
        ? translateProcessError(error)
        : sandboxError("SANDBOX_START_FAILED", "Sandbox execution failed", error);
      throw retainCleanupState(failure, cleanup);
    }
    if (result.exitCode === 125) {
      const cleanup = await this.removeContainer(name, { bestEffort: true });
      throw retainCleanupState(
        sandboxError("SANDBOX_START_FAILED", "Sandbox could not be started"),
        cleanup,
      );
    }
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: sanitizeOutput(result.stdout),
      stderr: sanitizeOutput(result.stderr),
      durationMs: result.durationMs,
      imageId,
      timedOut: false,
    };
  }

  async cleanup(request) {
    assertExactRequest(request, CLEANUP_KEYS, ["executionId", "actionId"]);
    assertSafeId(request.executionId, "executionId");
    assertSafeId(request.actionId, "actionId");
    await this.removeContainer(
      containerName(request.executionId, request.actionId),
    );
  }

  assertRunRequest(request) {
    assertExactRequest(request, RUN_KEYS, [
      "profileId",
      "workspacePath",
      "executionId",
      "actionId",
    ]);
    assertSafeId(request.profileId, "profileId");
    assertSafeId(request.executionId, "executionId");
    assertSafeId(request.actionId, "actionId");
    if (Object.hasOwn(request, "signal") && !isAbortSignal(request.signal)) {
      throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox signal is invalid");
    }
  }

  async resolveWorkspace(requestedPath) {
    if (!isMountableAbsolutePath(requestedPath)) {
      throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
    }
    const lexicalRoot = path.resolve(this.allowedWorkspaceRoot);
    const lexicalWorkspace = path.resolve(requestedPath);
    if (!isStrictDescendant(lexicalRoot, lexicalWorkspace)) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Workspace is outside its allowed root",
      );
    }
    const allowedRoot = await resolveDirectory(this.allowedWorkspaceRoot);
    const workspace = await resolveDirectory(requestedPath);
    if (!isStrictDescendant(allowedRoot, workspace)) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Workspace is outside its allowed root",
      );
    }
    return workspace;
  }

  async probe(profile, signal = null) {
    let version;
    try {
      version = await this.runDocker(
        ["version", "--format", "{{.Server.Version}}"],
        10_000,
        signal,
      );
    } catch (error) {
      if (error instanceof ManagedProcessError && error.code === "PROCESS_ABORTED") {
        throw translateProcessError(error);
      }
      throw sandboxError("SANDBOX_UNAVAILABLE", "Docker sandbox is unavailable", error);
    }
    if (version.exitCode !== 0 || !sanitizeOutput(version.stdout).trim()) {
      throw sandboxError("SANDBOX_UNAVAILABLE", "Docker sandbox is unavailable");
    }
    let image;
    try {
      image = await this.runDocker(
        ["image", "inspect", "--format", "{{.Id}}", profile.image],
        10_000,
        signal,
      );
    } catch (error) {
      if (error instanceof ManagedProcessError && error.code === "PROCESS_ABORTED") {
        throw translateProcessError(error);
      }
      throw sandboxError(
        "SANDBOX_IMAGE_UNAVAILABLE",
        "Pinned sandbox image is unavailable",
        error,
      );
    }
    const imageId = sanitizeOutput(image.stdout).trim();
    if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw sandboxError(
        "SANDBOX_IMAGE_UNAVAILABLE",
        "Pinned sandbox image is unavailable",
      );
    }
    return imageId;
  }

  runArguments({ name, profile, workspacePath }) {
    return [
      "run",
      "--rm",
      "--name",
      name,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--user",
      "65532:65532",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs",
      "/artifacts:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=65532,gid=65532",
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace,readonly,bind-recursive=disabled`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "NO_COLOR=1",
      "--entrypoint",
      "node",
      profile.image,
      ...NODE_TEST_ARGS,
    ];
  }

  runDocker(args, timeoutMs, signal = null) {
    return this.processRunner.run({
      command: this.dockerExecutable,
      args: ["--host", this.dockerHost, ...args],
      env: this.environment,
      timeoutMs,
      signal,
    });
  }

  async removeContainer(name, { bestEffort = false } = {}) {
    let removalError;
    let removal;
    try {
      removal = await this.runDocker(
        ["container", "rm", "-f", name],
        10_000,
      );
    } catch (error) {
      removalError = error;
    }
    if (removal?.exitCode === 0) return { cleanupPending: false };

    let presence;
    try {
      presence = await this.runDocker(
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ],
        10_000,
      );
    } catch (error) {
      removalError ||= error;
    }
    const names = sanitizeOutput(presence?.stdout)
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (presence?.exitCode === 0 && !names.includes(name)) {
      return { cleanupPending: false };
    }

    const details = { cleanupPending: true, containerName: name };
    const error = sandboxError(
      "SANDBOX_CLEANUP_FAILED",
      "Sandbox container cleanup could not be confirmed",
      removalError,
      details,
    );
    if (bestEffort) return { ...details, error };
    throw error;
  }
}
