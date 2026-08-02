import path from "node:path";
import { DingTalkAdapter } from "./adapters/dingtalk-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import { OllamaBrain } from "./adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "./adapters/ollama-pr-employee-reviewer.js";
import { createAttentionInboxRuntime } from "./attention-inbox-runtime.js";
import { createCodeExecutorRuntime } from "./code-executor-runtime.js";
import { createConfirmationRuntime } from "./confirmation-runtime.js";
import { loadConfig, projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { StateStore } from "./lib/state-store.js";
import { AttentionCoordinator } from "./services/attention-coordinator.js";
import { AttentionResultReconciler } from "./services/attention-result-reconciler.js";
import { NotificationService } from "./services/notification-service.js";
import { EmployeeRegistry } from "./services/employee-registry.js";
import { ProactiveWorkLoop } from "./services/proactive-work-loop.js";
import { ProactivePrEmployeeService } from "./services/proactive-pr-employee.js";
import { RefreshService } from "./services/refresh-service.js";
import { RoleWorkerDirectory } from "./services/role-worker-directory.js";
import { WorkConditionWaker } from "./services/work-condition-waker.js";
import { WorkCoordinationService } from "./services/work-coordination-service.js";
import { WorkIntentDispatcher } from "./services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "./services/work-intent-policy.js";
import { WorkflowFactSource } from "./services/workflow-fact-source.js";
import { createWorkLedgerRuntime } from "./work-ledger-runtime.js";
import { createWorkflowRoutingRuntime } from "./workflow-routing-runtime.js";

function frozenPort(source, methods, name) {
  if (!source || methods.some((method) => typeof source[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, source[method].bind(source)]),
    ),
  );
}

async function closeRuntimes(runtimes) {
  let firstFailure = null;
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    try {
      await runtimes[index]();
    } catch (error) {
      firstFailure ||= error;
    }
  }
  if (firstFailure) throw firstFailure;
}

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
  workLedgerRuntimeFactory = createWorkLedgerRuntime,
  workLedgerDependencies = {},
  attentionInboxRuntimeFactory = createAttentionInboxRuntime,
  attentionInboxDependencies = {},
  workIntentPolicyFactory = createWorkIntentPolicy,
  roleWorkerDirectoryFactory = (options) => new RoleWorkerDirectory(options),
  workflowFactSourceFactory = (options) => new WorkflowFactSource(options),
  attentionResultReconcilerFactory = (options) =>
    new AttentionResultReconciler(options),
  workConditionWakerFactory = (options) => new WorkConditionWaker(options),
  proactiveWorkLoopFactory = (options) => new ProactiveWorkLoop(options),
  workIntentDispatcherFactory = (options) =>
    new WorkIntentDispatcher(options),
  workCoordinationFactory = (options) =>
    new WorkCoordinationService(options),
  attentionCoordinatorFactory = (options) => new AttentionCoordinator(options),
  workCoordinationDependencies = {},
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
  const operationQueue = new OperationQueue();
  const acquiredRuntimes = [];
  const trackRuntime = (runtime) => {
    if (runtime && typeof runtime.close === "function") {
      acquiredRuntimes.push(runtime.close.bind(runtime));
    }
    return runtime;
  };
  let codeExecutorRuntime = null;
  let workflowRouting = null;
  let workLedgerRuntime = null;
  let attentionInboxRuntime = null;
  let confirmationRuntime = null;
  try {
    codeExecutorRuntime = trackRuntime(
      await codeExecutorRuntimeFactory(config.codeExecutor, {
        ...codeExecutorDependencies,
        store,
      }),
    );
    workflowRouting = trackRuntime(
      await workflowRoutingRuntimeFactory(config, {
        ...workflowRoutingDependencies,
        store,
      }),
    );
    const coordinationConfig = config.workCoordination || {};
    const coordinationEnabled = coordinationConfig.enabled === true;
    if (coordinationEnabled) {
      workLedgerRuntime = trackRuntime(
        await workLedgerRuntimeFactory({
          ...workLedgerDependencies,
          store,
          assignmentSource: workflowRouting,
          operationQueue: new OperationQueue(),
        }),
      );
      attentionInboxRuntime = trackRuntime(
        await attentionInboxRuntimeFactory({
          ...attentionInboxDependencies,
          store,
          operationQueue: new OperationQueue(),
        }),
      );
    }
    confirmationRuntime =
      externalActions && config.githubActions?.enabled === true
        ? trackRuntime(await confirmationRuntimeFactory(config, {
          ...confirmationRuntimeDependencies,
          store,
        }))
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
    let workLedgerView = null;
    let attentionBrowser = null;
    let attentionCoordinator = null;
    let workCoordination = null;
    if (coordinationEnabled) {
      const clockOptions = workCoordinationDependencies.clock
        ? { clock: workCoordinationDependencies.clock }
        : {};
      const policy = workIntentPolicyFactory(coordinationConfig.policy || {});
      const roleDirectory = roleWorkerDirectoryFactory({
        workers: workCoordinationDependencies.workers || [],
        legacyEmployeeRegistry: employeeRegistry,
        legacyOwnedRoleIds: ["pr-reviewer"],
      });
      const factSource = workflowFactSourceFactory({
        store,
        ...clockOptions,
        maximumAgeMs: coordinationConfig.factMaximumAgeMs,
      });
      const attentionResultReconciler = attentionResultReconcilerFactory({
        attentionConsumer: attentionInboxRuntime.consumer,
        ledger: workLedgerRuntime,
      });
      const conditionWaker = workConditionWakerFactory({
        ledger: workLedgerRuntime,
        factSource,
        ...clockOptions,
      });
      const workLoop = proactiveWorkLoopFactory({
        ledger: workLedgerRuntime,
        roleDirectory,
        ...clockOptions,
        leaseDurationMs: coordinationConfig.leaseDurationMs,
        maxAttempts: coordinationConfig.maxAttempts,
        retryBaseMs: coordinationConfig.retryBaseMs,
        retryMaxMs: coordinationConfig.retryMaxMs,
        resolveTimeoutMs: coordinationConfig.resolveTimeoutMs,
        decideTimeoutMs: coordinationConfig.decisionTimeoutMs,
      });
      const dispatcher = workIntentDispatcherFactory({
        ledger: workLedgerRuntime,
        policy,
        attentionProducer: attentionInboxRuntime.producer,
        ...clockOptions,
      });
      const coordinationService = workCoordinationFactory({
        ledger: workLedgerRuntime,
        attentionResultReconciler,
        conditionWaker,
        workLoop,
        dispatcher,
        intakeLimit: coordinationConfig.intakeLimit,
        workLimit: coordinationConfig.workLimit,
        dispatchLimit: coordinationConfig.dispatchLimit,
        attentionLimit: coordinationConfig.attentionLimit,
        conditionLimit: coordinationConfig.conditionLimit,
      });
      const coordinator = attentionCoordinatorFactory({
        externalQueue: confirmationRuntime?.queue || null,
        internalInbox: attentionInboxRuntime.browser,
      });
      workLedgerView = frozenPort(
        workLedgerRuntime,
        ["getSummary", "listItems", "listTimeline"],
        "workLedgerRuntime",
      );
      attentionBrowser = frozenPort(
        attentionInboxRuntime.browser,
        ["next", "answer", "reject", "later"],
        "attentionInboxRuntime.browser",
      );
      attentionCoordinator = frozenPort(
        coordinator,
        ["next"],
        "attentionCoordinator",
      );
      workCoordination = frozenPort(
        coordinationService,
        ["intake", "runCycle"],
        "workCoordination",
      );
    }
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
      closePromise ||= closeRuntimes(acquiredRuntimes);
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
      workLedgerView,
      attentionBrowser,
      attentionCoordinator,
      workCoordination,
      close,
    };
  } catch (error) {
    try {
      await closeRuntimes(acquiredRuntimes);
    } catch {
      // Preserve the startup failure after attempting every acquired runtime.
    }
    throw error;
  }
}
