import path from "node:path";
import { DockerTestSandbox } from "./adapters/docker-test-sandbox.js";
import { projectRoot } from "./lib/config.js";
import { StateStore } from "./lib/state-store.js";
import { digestValue } from "./domain/code-executor-contract.js";
import { CodeExecutionJournal } from "./services/code-execution-journal.js";
import { CodeWorkspaceBroker } from "./services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "./services/controlled-code-executor.js";

const WORKSPACE_KEYS = new Set([
  "id",
  "sourceRoot",
  "writablePaths",
  "excludePaths",
]);

export class CodeExecutorRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeExecutorRuntimeError";
    this.code = code;
  }
}

function invalidConfig(message = "代码执行器运行配置无效") {
  return new CodeExecutorRuntimeError("INVALID_CODE_EXECUTOR_CONFIG", message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value) {
  if (!isPlainRecord(value)) throw invalidConfig();
}

function resolveAbsolutePath(value, baseDirectory) {
  if (typeof value !== "string" || value.length === 0) throw invalidConfig();
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(baseDirectory, value);
}

function normalizeStringArray(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalidConfig();
  }
  return [...value];
}

function normalizeWorkspaces(workspaces, sourceBaseRoot) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw invalidConfig("至少需要配置一个可信代码工作区");
  }
  return workspaces.map((workspace) => {
    assertRecord(workspace);
    if (
      Reflect.ownKeys(workspace).some(
        (key) => typeof key !== "string" || !WORKSPACE_KEYS.has(key),
      )
    ) {
      throw invalidConfig();
    }
    return {
      id: workspace.id,
      sourceRoot: resolveAbsolutePath(workspace.sourceRoot, sourceBaseRoot),
      writablePaths: normalizeStringArray(workspace.writablePaths),
      excludePaths: normalizeStringArray(workspace.excludePaths),
    };
  });
}

function assertWorkspaceProfileCoverage(workspaces, requiredProfiles) {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  for (const workspaceId of workspaceIds) {
    if (!Object.hasOwn(requiredProfiles, workspaceId)) {
      throw invalidConfig("每个代码工作区都必须绑定固定测试配置");
    }
  }
  if (
    Object.keys(requiredProfiles).some(
      (workspaceId) => !workspaceIds.has(workspaceId),
    )
  ) {
    throw invalidConfig("测试配置引用了未知代码工作区");
  }
}

function normalizeEnabledConfig(config) {
  if (config === undefined) return null;
  assertRecord(config);
  if (config.enabled === false || config.enabled === undefined) return null;
  if (config.enabled !== true) throw invalidConfig();
  assertRecord(config.docker);
  assertRecord(config.profiles);
  assertRecord(config.requiredProfilesByWorkspace);
  if (Object.keys(config.profiles).length === 0) {
    throw invalidConfig("至少需要配置一个固定测试配置");
  }
  return config;
}

function resolveRuntimeRoot(value) {
  const runtimeRoot = value || path.join(projectRoot, "data", "code-executor");
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw invalidConfig("代码执行器数据目录无效");
  }
  return path.resolve(runtimeRoot);
}

function createWorkspaceAuthority(workspaces, requiredProfiles, sandbox) {
  return Object.freeze({
    workspaces: Object.freeze(
      workspaces.map((workspace) => {
        const profiles = requiredProfiles[workspace.id].map((id) =>
          Object.freeze({
            id,
            configDigest: sandbox.getProfileFingerprint(id),
          }),
        );
        return Object.freeze({
          id: workspace.id,
          capabilities: Object.freeze(["directory_snapshot"]),
          writablePaths: Object.freeze([...workspace.writablePaths]),
          requiredProfiles: Object.freeze(profiles),
          authorityDigest: digestValue({
            schemaVersion: 2,
            workspaceId: workspace.id,
            capabilities: ["directory_snapshot"],
            sourceRoot: workspace.sourceRoot,
            writablePaths: workspace.writablePaths,
            excludePaths: workspace.excludePaths,
            requiredProfiles: profiles,
          }),
        });
      }),
    ),
  });
}

function createChangePackageTargets(workspaces, authority) {
  const authorityByWorkspace = new Map(
    authority.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  return Object.freeze(
    workspaces.map((workspace) =>
      Object.freeze({
        workspaceId: workspace.id,
        sourceRoot: workspace.sourceRoot,
        targetAuthorityDigest:
          authorityByWorkspace.get(workspace.id).authorityDigest,
        writablePaths: Object.freeze([...workspace.writablePaths]),
        excludePaths: Object.freeze([...workspace.excludePaths]),
      }),
    ),
  );
}

function createCompletedChangeExporter(executor) {
  return Object.freeze({
    export: executor.exportCompletedChangeSet.bind(executor),
  });
}

function createAuditArtifactReader(journal) {
  return Object.freeze({
    read: journal.readBytes.bind(journal),
  });
}

export async function createCodeExecutorRuntime(config, dependencies = {}) {
  const enabledConfig = normalizeEnabledConfig(config);
  if (!enabledConfig) return null;

  const runtimeRoot = resolveRuntimeRoot(dependencies.runtimeRoot);
  const sourceBaseRoot = dependencies.sourceBaseRoot || projectRoot;
  if (
    typeof sourceBaseRoot !== "string" ||
    !path.isAbsolute(sourceBaseRoot)
  ) {
    throw invalidConfig("代码工作区基准目录无效");
  }
  const workspaces = normalizeWorkspaces(
    enabledConfig.workspaces,
    sourceBaseRoot,
  );
  assertWorkspaceProfileCoverage(
    workspaces,
    enabledConfig.requiredProfilesByWorkspace,
  );
  const store =
    dependencies.store || new StateStore(path.join(projectRoot, "data"));
  const broker =
    dependencies.broker ||
    new CodeWorkspaceBroker({
      workspaces,
      scratchRoot: path.join(runtimeRoot, "workspaces"),
      limits: enabledConfig.brokerLimits || {},
    });
  const journal =
    dependencies.journal ||
    new CodeExecutionJournal({
      root: path.join(runtimeRoot, "artifacts"),
      ...(enabledConfig.maxArtifactBytes === undefined
        ? {}
        : { maxArtifactBytes: enabledConfig.maxArtifactBytes }),
    });
  const sandbox =
    dependencies.sandbox ||
    new DockerTestSandbox({
      dockerExecutable: enabledConfig.docker.executable,
      dockerHost: enabledConfig.docker.host,
      allowedWorkspaceRoot: path.join(runtimeRoot, "workspaces"),
      profiles: enabledConfig.profiles,
      ...(dependencies.processRunner
        ? { processRunner: dependencies.processRunner }
        : {}),
      ...(dependencies.sourceEnvironment
        ? { sourceEnvironment: dependencies.sourceEnvironment }
        : {}),
    });
  const executor = new ControlledCodeExecutor({
    broker,
    sandbox,
    store,
    journal,
    profileDefinitions: enabledConfig.profiles,
    requiredProfilesByWorkspace:
      enabledConfig.requiredProfilesByWorkspace,
    limits: enabledConfig.executorLimits || {},
  });
  const recovery = await executor.recover();
  const authority = createWorkspaceAuthority(
    workspaces,
    enabledConfig.requiredProfilesByWorkspace,
    sandbox,
  );
  const changePackageTargets = createChangePackageTargets(
    workspaces,
    authority,
  );
  const completedChangeExporter = createCompletedChangeExporter(executor);
  const auditArtifactReader = createAuditArtifactReader(journal);
  return Object.freeze({
    broker,
    sandbox,
    journal,
    executor,
    authority,
    changePackageTargets,
    completedChangeExporter,
    auditArtifactReader,
    recovery,
  });
}
