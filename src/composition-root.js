import path from "node:path";
import { DingTalkAdapter } from "./adapters/dingtalk-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import { OllamaBrain } from "./adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "./adapters/ollama-pr-employee-reviewer.js";
import { createCodeExecutorRuntime } from "./code-executor-runtime.js";
import { createConfirmationRuntime } from "./confirmation-runtime.js";
import { loadConfig, projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { StateStore } from "./lib/state-store.js";
import { NotificationService } from "./services/notification-service.js";
import { EmployeeRegistry } from "./services/employee-registry.js";
import { ProactivePrEmployeeService } from "./services/proactive-pr-employee.js";
import { RefreshService } from "./services/refresh-service.js";
import { createWorkflowRoutingRuntime } from "./workflow-routing-runtime.js";

export function createBrain(config = {}, dependencies = {}) {
  if (!config.enabled) return null;
  if (config.provider === "ollama") {
    return new OllamaBrain({
      ...config,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  }
  throw new Error(`Unsupported brain provider: ${config.provider || "(empty)"}`);
}

export function createPrEmployeeReviewer(
  baseConfig = {},
  roleOverrides = {},
  dependencies = {},
) {
  const config = { ...baseConfig, ...roleOverrides };
  if (!config.enabled) return null;
  if (config.provider === "ollama") {
    return new OllamaPrEmployeeReviewer({
      ...config,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  }
  throw new Error(
    `Unsupported PR employee brain provider: ${config.provider || "(empty)"}`,
  );
}

export function createEmployeeRegistry(employees = []) {
  return new EmployeeRegistry(employees.filter(Boolean));
}

export async function createApplication({
  config: suppliedConfig,
  store: suppliedStore,
  codeExecutorRuntimeFactory = createCodeExecutorRuntime,
  codeExecutorDependencies = {},
  confirmationRuntimeFactory = createConfirmationRuntime,
  confirmationRuntimeDependencies = {},
  workflowRoutingRuntimeFactory = createWorkflowRoutingRuntime,
  workflowRoutingDependencies = {},
  externalActions = true,
} = {}) {
  const config = suppliedConfig ?? (await loadConfig());
  const roleConfig = config.employees?.prReviewer || { enabled: false };
  const github = new GitHubAdapter({
    maxPatchCharacters: roleConfig.maxPatchCharacters,
  });
  const dingtalk = new DingTalkAdapter();
  const brain = createBrain(config.brain);
  const store = suppliedStore || new StateStore(path.join(projectRoot, "data"));
  const codeExecutorRuntime = await codeExecutorRuntimeFactory(
    config.codeExecutor,
    { ...codeExecutorDependencies, store },
  );
  const operationQueue = new OperationQueue();
  let workflowRouting = null;
  let confirmationRuntime = null;
  try {
    workflowRouting = await workflowRoutingRuntimeFactory(config, {
      ...workflowRoutingDependencies,
      store,
    });
    confirmationRuntime = externalActions
      ? await confirmationRuntimeFactory(config, {
          ...confirmationRuntimeDependencies,
          store,
        })
      : null;
    const prEmployee = new ProactivePrEmployeeService({
      github,
      reviewer: roleConfig.enabled
        ? createPrEmployeeReviewer(config.brain, {
            ...roleConfig.brain,
            allowRemoteCodeContext: roleConfig.allowRemoteCodeContext,
          })
        : null,
      store,
      config: roleConfig,
      operationQueue,
      producerQueue: confirmationRuntime?.producerQueue || null,
      githubActions: externalActions
        ? config.githubActions || { enabled: false }
        : { enabled: false },
    });
    if (confirmationRuntime) await prEmployee.recoverConfirmations();
    const employeeRegistry = createEmployeeRegistry([prEmployee]);
    const notifier = new NotificationService(dingtalk, config.dingtalk);
    const refreshService = new RefreshService({
      github,
      brain,
      dingtalk,
      store,
      notifier,
      config,
      operationQueue,
    });
    let closePromise = null;
    const close = () => {
      closePromise ||= Promise.allSettled([
        Promise.resolve().then(() => confirmationRuntime?.close?.()),
        Promise.resolve().then(() => workflowRouting?.close?.()),
      ]).then((results) => {
        const failure = results.find(({ status }) => status === "rejected");
        if (failure) throw failure.reason;
      });
      return closePromise;
    };
    return {
      config,
      store,
      refreshService,
      employeeRegistry,
      prEmployee,
      confirmationQueue: confirmationRuntime?.queue || null,
      workflowRouting,
      codeExecutorRuntime,
      codeExecutor: codeExecutorRuntime?.executor || null,
      close,
    };
  } catch (error) {
    const shutdowns = [
      Promise.resolve().then(() => confirmationRuntime?.close?.()),
      Promise.resolve().then(() => workflowRouting?.close?.()),
    ];
    await Promise.allSettled(shutdowns);
    throw error;
  }
}
