import path from "node:path";
import { DingTalkAdapter } from "./adapters/dingtalk-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import { OllamaBrain } from "./adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "./adapters/ollama-pr-employee-reviewer.js";
import { loadConfig, projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { StateStore } from "./lib/state-store.js";
import { NotificationService } from "./services/notification-service.js";
import { EmployeeRegistry } from "./services/employee-registry.js";
import { ProactivePrEmployeeService } from "./services/proactive-pr-employee.js";
import { RefreshService } from "./services/refresh-service.js";

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

export async function createApplication() {
  const config = await loadConfig();
  const roleConfig = config.employees?.prReviewer || { enabled: false };
  const github = new GitHubAdapter({
    maxPatchCharacters: roleConfig.maxPatchCharacters,
  });
  const dingtalk = new DingTalkAdapter();
  const brain = createBrain(config.brain);
  const store = new StateStore(path.join(projectRoot, "data"));
  const operationQueue = new OperationQueue();
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
  });
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
  return {
    config,
    store,
    refreshService,
    employeeRegistry,
    prEmployee,
  };
}
