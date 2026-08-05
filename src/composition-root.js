import path from "node:path";
import { DingTalkAdapter } from "./adapters/dingtalk-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import { OllamaBrain } from "./adapters/ollama-brain.js";
import { OllamaPrEmployeeReviewer } from "./adapters/ollama-pr-employee-reviewer.js";
import { createAttentionInboxRuntime } from "./attention-inbox-runtime.js";
import { createChangePackageRuntime } from "./change-package-runtime.js";
import { createCodeExecutorRuntime } from "./code-executor-runtime.js";
import { createCodeJobRuntime } from "./code-job-runtime.js";
import { createConfirmationRuntime } from "./confirmation-runtime.js";
import { loadConfig, projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { StateStore } from "./lib/state-store.js";
import { createMemoryRuntime } from "./memory-runtime.js";
import { AttentionCoordinator } from "./services/attention-coordinator.js";
import { AttentionResultReconciler } from "./services/attention-result-reconciler.js";
import { NotificationService } from "./services/notification-service.js";
import { EmployeeRegistry } from "./services/employee-registry.js";
import {
  createConfiguredBrainRouter,
  createConfiguredWorkforce,
} from "./services/configured-workforce.js";
import { CodeJobMemoryProjector } from "./services/code-job-memory-projector.js";
import { CodeJobEvidenceReader } from "./services/code-job-evidence-reader.js";
import { ChangePackageApplicationResultReconciler } from "./services/change-package-application-result-reconciler.js";
import { MemoryProjector } from "./services/memory-projector.js";
import { MemoryAnswerService } from "./services/memory-answer-service.js";
import { MemoryContextRetriever } from "./services/memory-context-retriever.js";
import { LocalSessionImporter } from "./services/local-session-importer.js";
import { GitActivityImporter } from "./services/git-activity-importer.js";
import { ProactiveWorkLoop } from "./services/proactive-work-loop.js";
import { OrchestratorService } from "./services/orchestrator-service.js";
import { RoleContextAssembler } from "./services/role-context-assembler.js";
import { ProactivePrEmployeeService } from "./services/proactive-pr-employee.js";
import { RefreshService } from "./services/refresh-service.js";
import { RoleWorkerDirectory } from "./services/role-worker-directory.js";
import { WorkConditionWaker } from "./services/work-condition-waker.js";
import { WorkCoordinationService } from "./services/work-coordination-service.js";
import { createCodeActionProposalRunnerService } from "./services/code-action-proposal-handler.js";
import { CodeJobGrantFactory } from "./services/code-job-grant-factory.js";
import { createConfiguredCodeJobBrainDirectory } from "./services/code-job-brain-directory.js";
import { createGitHubReviewProposalRunnerService } from "./services/github-review-proposal-handler.js";
import { WorkIntentDispatcher } from "./services/work-intent-dispatcher.js";
import { WorkProposalResultReconciler } from "./services/work-proposal-result-reconciler.js";
import { createWorkIntentPolicy } from "./services/work-intent-policy.js";
import { createWorkProposalRunnerGroup } from "./services/work-proposal-runner-group.js";
import { WorkflowFactSource } from "./services/workflow-fact-source.js";
import { createWorkLedgerRuntime } from "./work-ledger-runtime.js";
import { createWorkProposalRuntime } from "./work-proposal-runtime.js";
import { createWorkflowRoutingRuntime } from "./workflow-routing-runtime.js";

const GITHUB_REVIEW_PROPOSAL_RUNNER_ID = "github-review-runner";
const CODE_ACTION_PROPOSAL_RUNNER_ID = "code-action-runner";

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

function codeActionRunnerRoles(policy = {}) {
  const declaredRoles = Array.isArray(policy.codeActionRoles)
    ? policy.codeActionRoles
    : [];
  const operationsByRole =
    policy.codeOperationsByRole &&
    typeof policy.codeOperationsByRole === "object" &&
    !Array.isArray(policy.codeOperationsByRole)
      ? policy.codeOperationsByRole
      : {};
  const eligibleRoles =
    declaredRoles.filter(
      (roleId) =>
        typeof roleId === "string" && Object.hasOwn(operationsByRole, roleId),
    );
  return [...new Set(eligibleRoles)];
}

function brainConfigurationsByRole(roles) {
  const configured =
    roles && typeof roles === "object" && !Array.isArray(roles) ? roles : {};
  return Object.fromEntries(
    Object.entries(configured).map(([roleId, role]) => [roleId, role?.brain]),
  );
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
  changePackageRuntimeFactory = createChangePackageRuntime,
  changePackageRuntimeDependencies = {},
  codeJobRuntimeFactory = createCodeJobRuntime,
  codeJobRuntimeDependencies = {},
  confirmationRuntimeFactory = createConfirmationRuntime,
  confirmationRuntimeDependencies = {},
  workflowRoutingRuntimeFactory = createWorkflowRoutingRuntime,
  workflowRoutingDependencies = {},
  workLedgerRuntimeFactory = createWorkLedgerRuntime,
  workLedgerDependencies = {},
  attentionInboxRuntimeFactory = createAttentionInboxRuntime,
  attentionInboxDependencies = {},
  workProposalRuntimeFactory = createWorkProposalRuntime,
  workProposalDependencies = {},
  memoryRuntimeFactory = createMemoryRuntime,
  memoryRuntimeDependencies = {},
  memoryProjectorFactory = (options) => new MemoryProjector(options),
  memoryContextRetrieverFactory = (options) =>
    new MemoryContextRetriever(options),
  memoryAnswerServiceFactory = (options) => new MemoryAnswerService(options),
  memoryBrainRouterFactory = createConfiguredBrainRouter,
  memoryAnswerDependencies = {},
  localSessionImporterFactory = (options) => new LocalSessionImporter(options),
  gitActivityImporterFactory = (options) => new GitActivityImporter(options),
  codeJobMemoryProjectorFactory = (options) =>
    new CodeJobMemoryProjector(options),
  codeJobEvidenceReaderFactory = (options) =>
    new CodeJobEvidenceReader(options),
  changePackageApplicationResultReconcilerFactory = (options) =>
    new ChangePackageApplicationResultReconciler(options),
  workIntentPolicyFactory = createWorkIntentPolicy,
  roleWorkerDirectoryFactory = (options) => new RoleWorkerDirectory(options),
  configuredWorkforceFactory = createConfiguredWorkforce,
  workflowFactSourceFactory = (options) => new WorkflowFactSource(options),
  attentionResultReconcilerFactory = (options) =>
    new AttentionResultReconciler(options),
  workProposalResultReconcilerFactory = (options) =>
    new WorkProposalResultReconciler(options),
  githubReviewProposalRunnerFactory =
    createGitHubReviewProposalRunnerService,
  codeJobGrantFactory = (options) => new CodeJobGrantFactory(options),
  codeJobBrainDirectoryFactory = createConfiguredCodeJobBrainDirectory,
  codeActionProposalRunnerFactory =
    createCodeActionProposalRunnerService,
  workProposalRunnerGroupFactory = createWorkProposalRunnerGroup,
  workConditionWakerFactory = (options) => new WorkConditionWaker(options),
  proactiveWorkLoopFactory = (options) => new ProactiveWorkLoop(options),
  roleContextAssemblerFactory = (options) =>
    new RoleContextAssembler(options),
  orchestratorServiceFactory = (options) => new OrchestratorService(options),
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
  let changePackageRuntime = null;
  let workflowRouting = null;
  let workLedgerRuntime = null;
  let attentionInboxRuntime = null;
  let workProposalRuntime = null;
  let memoryRuntime = null;
  let codeJobRuntime = null;
  let confirmationRuntime = null;
  let codeJobReader = null;
  let codeJobControl = null;
  let codeJobWorker = null;
  let codeJobMemoryProjector = null;
  let codeJobEvidenceReader = null;
  let codeJobChangePackageDispatcher = null;
  let changePackageReader = null;
  let changePackageApplicationReader = null;
  let changePackageApplicationStatusReader = null;
  let changePackageApplicationResultReconciler = null;
  let changePackageApplicationResultBarrier = null;
  let changePackageApplicationRequester = null;
  let grantFactory = null;
  try {
    codeExecutorRuntime = trackRuntime(
      await codeExecutorRuntimeFactory(config.codeExecutor, {
        ...codeExecutorDependencies,
        store,
      }),
    );
    const changePackageActionsEnabled =
      externalActions && config.changePackages?.enabled === true;
    if (changePackageActionsEnabled) {
      if (!codeExecutorRuntime) {
        throw new Error("change package 应用需要可用的代码执行器运行时");
      }
      if (
        !Array.isArray(codeExecutorRuntime.changePackageTargets) ||
        codeExecutorRuntime.changePackageTargets.length === 0
      ) {
        throw new Error("代码执行器没有可用于 change package 的可信工作区");
      }
      changePackageRuntime = trackRuntime(
        await changePackageRuntimeFactory(config.changePackages, {
          ...changePackageRuntimeDependencies,
          store,
          trustedTargets: codeExecutorRuntime.changePackageTargets,
        }),
      );
      if (!changePackageRuntime) {
        throw new Error("change package 配置已启用但运行时不可用");
      }
      changePackageReader = frozenPort(
        changePackageRuntime.packageReader,
        ["get"],
        "changePackageRuntime.packageReader",
      );
      changePackageApplicationReader = frozenPort(
        changePackageRuntime.applicationReader,
        ["getResult"],
        "changePackageRuntime.applicationReader",
      );
      changePackageApplicationStatusReader = frozenPort(
        changePackageRuntime.applicationProjectionReader,
        ["getForJob"],
        "changePackageRuntime.applicationProjectionReader",
      );
    }
    workflowRouting = trackRuntime(
      await workflowRoutingRuntimeFactory(config, {
        ...workflowRoutingDependencies,
        store,
      }),
    );
    const coordinationConfig = config.workCoordination || {};
    const coordinationEnabled = coordinationConfig.enabled === true;
    const githubProposalExecutionEnabled =
      coordinationEnabled &&
      externalActions &&
      config.githubActions?.enabled === true;
    const localCodeExecutionEnabled =
      coordinationEnabled && externalActions && Boolean(codeExecutorRuntime);
    const codeJobChangePackageDeliveryEnabled =
      localCodeExecutionEnabled && changePackageActionsEnabled;
    const codeRunnerRoleIds = localCodeExecutionEnabled
      ? codeActionRunnerRoles(coordinationConfig.policy)
      : [];
    if (localCodeExecutionEnabled && codeRunnerRoleIds.length === 0) {
      throw new Error("本地代码工作提案没有同时满足岗位和操作策略的执行角色");
    }
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
      workProposalRuntime = trackRuntime(
        await workProposalRuntimeFactory({
          ...workProposalDependencies,
          store,
          operationQueue: new OperationQueue(),
          runnerScopes: [
            ...(githubProposalExecutionEnabled
              ? [
                  {
                    runnerId: GITHUB_REVIEW_PROPOSAL_RUNNER_ID,
                    allowedKinds: ["github_review_proposal"],
                    allowedRoleIds:
                      coordinationConfig.policy?.githubReviewRoles || [],
                  },
                ]
              : []),
            ...(localCodeExecutionEnabled
              ? [
                  {
                    runnerId: CODE_ACTION_PROPOSAL_RUNNER_ID,
                    allowedKinds: ["code_action_proposal"],
                    allowedRoleIds: codeRunnerRoleIds,
                  },
                ]
              : []),
          ],
        }),
      );
    }
    const memoryEnabled = config.memory?.enabled === true;
    if (memoryEnabled) {
      memoryRuntime = trackRuntime(
        await memoryRuntimeFactory({
          ...memoryRuntimeDependencies,
          store,
          operationQueue: new OperationQueue(),
          maximumRecords: config.memory.maximumRecords,
          maximumStateBytes: config.memory.maximumStateBytes,
        }),
      );
    }
    if (localCodeExecutionEnabled && !memoryRuntime) {
      throw new Error("本地代码工作提案需要启用统一记忆运行时");
    }
    let activeCodeJobOptions = null;
    if (localCodeExecutionEnabled) {
      grantFactory = codeJobGrantFactory({
        executorAuthority: codeExecutorRuntime.authority,
        policyVersion: coordinationConfig.policy?.version ?? 1,
        workspaceByRepository:
          coordinationConfig.policy?.workspaceByRepository || {},
        codeActionRoles: coordinationConfig.policy?.codeActionRoles || [],
        codeOperationsByRole:
          coordinationConfig.policy?.codeOperationsByRole || {},
        brainByRole: brainConfigurationsByRole(config.employees?.roles),
        brainProviders: config.brainProviders || {},
      });
      const codeJobBrainDirectory = codeJobBrainDirectoryFactory({
        brainProviders: config.brainProviders || {},
        roles: config.employees?.roles || {},
        dependencies: workCoordinationDependencies.brainDependencies || {},
      });
      activeCodeJobOptions = {
        grantVerifier: frozenPort(
          grantFactory,
          ["verify"],
          "codeJobGrantFactory",
        ),
        executor: frozenPort(
          codeExecutorRuntime.executor,
          [
            "start",
            "view",
            "resume",
            "perform",
            "getActionResult",
            "reconcileAction",
            "reconcileCancellation",
          ],
          "codeExecutorRuntime.executor",
        ),
        brainDirectory: frozenPort(
          codeJobBrainDirectory,
          ["decide"],
          "codeJobBrainDirectory",
        ),
        workerLimits: {
          ...(coordinationConfig.codeJobMaximumTurns === undefined
            ? {}
            : { maxTurns: coordinationConfig.codeJobMaximumTurns }),
          ...(coordinationConfig.codeJobObservationLimit === undefined
            ? {}
            : {
                observationLimit:
                  coordinationConfig.codeJobObservationLimit,
              }),
        },
        ...(codeJobChangePackageDeliveryEnabled
          ? {
              completedChangeExporter: frozenPort(
                codeExecutorRuntime.completedChangeExporter,
                ["export"],
                "codeExecutorRuntime.completedChangeExporter",
              ),
              changePackageProducer: frozenPort(
                changePackageRuntime.packageProducer,
                ["create"],
                "changePackageRuntime.packageProducer",
              ),
              changePackageReader,
            }
          : {}),
      };
    }
    if (coordinationEnabled && memoryRuntime) {
      codeJobRuntime = trackRuntime(
        await codeJobRuntimeFactory({
          ...codeJobRuntimeDependencies,
          store,
          operationQueue: new OperationQueue(),
          memoryReceiptVerifier: frozenPort(
            memoryRuntime.receiptVerifier,
            ["verify"],
            "memoryRuntime.receiptVerifier",
          ),
          ...(activeCodeJobOptions ?? {}),
        }),
      );
      if (!codeJobRuntime) {
        throw new Error("代码任务记忆投影需要可用的代码任务运行时");
      }
      codeJobReader = frozenPort(
        codeJobRuntime.reader,
        ["get", "getDetail", "list", "listNewest"],
        "codeJobRuntime.reader",
      );
      codeJobControl = frozenPort(
        codeJobRuntime.control,
        ["pause", "resume", "cancel"],
        "codeJobRuntime.control",
      );
      if (codeJobChangePackageDeliveryEnabled) {
        codeJobEvidenceReader = frozenPort(
          codeJobEvidenceReaderFactory({
            codeJobReader,
            changePackageReader,
            auditArtifactReader: frozenPort(
              codeExecutorRuntime.auditArtifactReader,
              ["read"],
              "codeExecutorRuntime.auditArtifactReader",
            ),
          }),
          ["read"],
          "codeJobEvidenceReader",
        );
      }
      codeJobMemoryProjector = frozenPort(
        codeJobMemoryProjectorFactory({
          projectionSource: frozenPort(
            codeJobRuntime.projectionSource,
            ["readBatch", "ack"],
            "codeJobRuntime.projectionSource",
          ),
          memoryProducer: frozenPort(
            memoryRuntime.producer,
            ["appendBatch"],
            "memoryRuntime.producer",
          ),
        }),
        ["runCycle"],
        "codeJobMemoryProjector",
      );
      if (codeJobChangePackageDeliveryEnabled) {
        codeJobChangePackageDispatcher = frozenPort(
          codeJobRuntime.changePackageDelivery,
          ["runCycle"],
          "codeJobRuntime.changePackageDelivery",
        );
      }
    }
    const localExecutors = {};
    if (localCodeExecutionEnabled) {
      localExecutors["local.code-job-create"] = frozenPort(
        codeJobRuntime.confirmationExecutor,
        ["execute", "reconcile"],
        "codeJobRuntime.confirmationExecutor",
      );
      codeJobWorker = frozenPort(
        codeJobRuntime.worker,
        ["runCycle"],
        "codeJobRuntime.worker",
      );
    }
    if (changePackageActionsEnabled) {
      localExecutors["local.change-package-apply"] = frozenPort(
        changePackageRuntime.applicationExecutor,
        ["execute", "reconcile"],
        "changePackageRuntime.applicationExecutor",
      );
    }
    if (
      externalActions &&
      (Object.keys(localExecutors).length > 0 ||
        config.githubActions?.enabled === true)
    ) {
      confirmationRuntime = trackRuntime(
        await confirmationRuntimeFactory(config, {
          ...confirmationRuntimeDependencies,
          store,
          ...(Object.keys(localExecutors).length === 0
            ? {}
            : { localExecutors: Object.freeze(localExecutors) }),
        }),
      );
    }
    if (localCodeExecutionEnabled && !confirmationRuntime) {
      throw new Error("本地代码工作提案需要可用的确认运行时");
    }
    if (githubProposalExecutionEnabled && !confirmationRuntime) {
      throw new Error("GitHub 工作提案需要可用的确认运行时");
    }
    if (changePackageActionsEnabled && !confirmationRuntime) {
      throw new Error("change package 应用需要可用的确认运行时");
    }
    if (changePackageActionsEnabled) {
      const applicationProducer = frozenPort(
        changePackageRuntime.applicationProducer,
        ["prepareConfirmation"],
        "changePackageRuntime.applicationProducer",
      );
      const confirmationProducer = frozenPort(
        confirmationRuntime.producerQueue,
        ["enqueue"],
        "confirmationRuntime.producerQueue",
      );
      if (codeJobChangePackageDeliveryEnabled) {
        const resultReconciler =
          changePackageApplicationResultReconcilerFactory({
            applicationResultSource: frozenPort(
              confirmationRuntime.applicationResultSource,
              ["readSnapshot"],
              "confirmationRuntime.applicationResultSource",
            ),
            applicationReader: changePackageApplicationReader,
            projectionStore: frozenPort(
              changePackageRuntime.applicationProjectionWriter,
              ["getCheckpoint", "applySnapshot"],
              "changePackageRuntime.applicationProjectionWriter",
            ),
          });
        changePackageApplicationResultReconciler = frozenPort(
          resultReconciler,
          ["runCycle"],
          "changePackageApplicationResultReconciler",
        );
        changePackageApplicationResultBarrier = frozenPort(
          resultReconciler,
          ["runThrough"],
          "changePackageApplicationResultBarrier",
        );
      }
      changePackageApplicationRequester = Object.freeze({
        async request(value) {
          const plan = await applicationProducer.prepareConfirmation(value);
          const queued = await confirmationProducer.enqueue(plan);
          await changePackageApplicationResultBarrier?.runThrough(
            queued.queueRevision,
          );
          return queued;
        },
      });
    }
    const proposalRunners = [];
    if (githubProposalExecutionEnabled) {
      proposalRunners.push(
        githubReviewProposalRunnerFactory({
          enabled: true,
          runner:
            workProposalRuntime.runners[GITHUB_REVIEW_PROPOSAL_RUNNER_ID],
          confirmationProducer: confirmationRuntime.producerQueue,
          actorAccountId: config.githubActions.actorAccountId,
          leaseDurationMs: coordinationConfig.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        }),
      );
    }
    if (localCodeExecutionEnabled) {
      proposalRunners.push(
        codeActionProposalRunnerFactory({
          enabled: true,
          runner: workProposalRuntime.runners[CODE_ACTION_PROPOSAL_RUNNER_ID],
          confirmationProducer: confirmationRuntime.producerQueue,
          codeJobReader,
          grantFactory,
          leaseDurationMs: coordinationConfig.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        }),
      );
    }
    const proposalRunner = proposalRunners.length
      ? workProposalRunnerGroupFactory(proposalRunners)
      : null;
    if (proposalRunners.length && !proposalRunner) {
      throw new Error("工作提案 runner 组合失败");
    }
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
    let workCoordination = null;
    const configuredWorkforce = coordinationEnabled
      ? configuredWorkforceFactory({
          brainProviders: config.brainProviders || {},
          roles: config.employees?.roles || {},
          store,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
          dependencies: workCoordinationDependencies.brainDependencies || {},
          onRun: ({ roleId }) => {
            if (!workCoordination) {
              const error = new Error("员工主动循环尚未就绪");
              error.code = "WORK_COORDINATION_NOT_READY";
              throw error;
            }
            return workCoordination.runCycle({
              trigger: `employee:${roleId}`,
              includeWork: true,
              roleId,
            });
          },
        })
      : { employees: [], workers: [] };
    const employeeRegistry = createEmployeeRegistry([
      prEmployee,
      ...configuredWorkforce.employees,
    ]);
    let workLedgerView = null;
    let workGraphView = null;
    let attentionBrowser = null;
    let attentionCoordinator = null;
    let memoryProjector = null;
    if (coordinationEnabled) {
      const clockOptions = workCoordinationDependencies.clock
        ? { clock: workCoordinationDependencies.clock }
        : {};
      const policy = workIntentPolicyFactory(coordinationConfig.policy || {});
      const suppliedWorkers = workCoordinationDependencies.workers || [];
      const roleWorkers = configuredWorkforce.workers.length
        ? [...configuredWorkforce.workers, ...suppliedWorkers]
        : suppliedWorkers;
      const roleDirectory = roleWorkerDirectoryFactory({
        workers: roleWorkers,
        legacyEmployeeRegistry: employeeRegistry,
        legacyOwnedRoleIds: ["pr-reviewer"],
      });
      const factSource = workflowFactSourceFactory({
        store,
        ...clockOptions,
        maximumAgeMs: coordinationConfig.factMaximumAgeMs,
      });
      const roleContextAssembler = roleContextAssemblerFactory({
        graphReader: workLedgerRuntime.graphReader,
        factSource,
      });
      const orchestratorService = orchestratorServiceFactory({
        contextAssembler: roleContextAssembler,
        graphReader: workLedgerRuntime.graphReader,
        scopedGraphPlannerFactory:
          workLedgerRuntime.scopedGraphPlannerFactory,
        graphDelivererFactory: workLedgerRuntime.graphDelivererFactory,
        capabilityRoles: coordinationConfig.policy?.capabilityRoles || {},
        ...(workCoordinationDependencies.evidenceVerifier
          ? {
              evidenceVerifier:
                workCoordinationDependencies.evidenceVerifier,
            }
          : {}),
      });
      const attentionResultReconciler = attentionResultReconcilerFactory({
        attentionConsumer: attentionInboxRuntime.consumer,
        ledger: workLedgerRuntime,
      });
      const proposalResultReconciler = workProposalResultReconcilerFactory({
        proposalConsumer: workProposalRuntime.consumer,
        ledger: workLedgerRuntime,
        ...(codeJobReader === null ? {} : { codeJobReader }),
      });
      const conditionWaker = workConditionWakerFactory({
        ledger: workLedgerRuntime,
        factSource,
        ...clockOptions,
      });
      const workLoop = proactiveWorkLoopFactory({
        ledger: workLedgerRuntime,
        roleDirectory,
        roleContextAssembler,
        orchestratorService,
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
        proposalProducer: workProposalRuntime.producer,
        ...clockOptions,
      });
      const coordinationService = workCoordinationFactory({
        ledger: workLedgerRuntime,
        codeJobRunner: codeJobWorker,
        codeJobMemoryProjector,
        codeJobChangePackageDispatcher,
        changePackageApplicationResultReconciler,
        proposalRunner,
        proposalResultReconciler,
        attentionResultReconciler,
        conditionWaker,
        workLoop,
        dispatcher,
        intakeLimit: coordinationConfig.intakeLimit,
        workLimit: coordinationConfig.workLimit,
        dispatchLimit: coordinationConfig.dispatchLimit,
        attentionLimit: coordinationConfig.attentionLimit,
        proposalLimit: coordinationConfig.proposalLimit,
        conditionLimit: coordinationConfig.conditionLimit,
        codeJobLimit: coordinationConfig.codeJobLimit,
        codeJobMemoryLimit: coordinationConfig.codeJobMemoryLimit,
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
      workGraphView = frozenPort(
        workLedgerRuntime.graphReader,
        ["getSnapshot"],
        "workLedgerRuntime.graphReader",
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
      if (memoryRuntime) {
        memoryProjector = frozenPort(
          memoryProjectorFactory({
            memoryProducer: memoryRuntime.producer,
            ledgerView: workLedgerRuntime,
            graphProjectionSource: frozenPort(
              workLedgerRuntime.graphMemoryProjectionSource,
              ["readBatch", "ackBatch"],
              "workLedgerRuntime.graphMemoryProjectionSource",
            ),
            store,
          }),
          ["runCycle"],
          "memoryProjector",
        );
      }
    }
    const memorySearch = memoryRuntime
      ? frozenPort(
          memoryRuntime.search,
          ["search", "getHealth"],
          "memoryRuntime.search",
        )
      : null;
    let memoryAnswer = null;
    let memoryImports = null;
    const memoryAnswerConfig = config.memory?.answering;
    if (memoryEnabled && memoryAnswerConfig?.enabled === true) {
      if (!memoryRuntime) {
        throw new Error("记忆问答需要启用统一记忆运行时");
      }
      const memoryBrainRouter = memoryBrainRouterFactory({
        brainProviders: config.brainProviders || {},
        dependencies: memoryAnswerDependencies.brainDependencies || {},
      });
      const contextRetriever = memoryContextRetrieverFactory({
        memorySearch: frozenPort(
          memoryRuntime.search,
          ["search"],
          "memoryRuntime.search",
        ),
        contextReader: frozenPort(
          memoryRuntime.contextReader,
          ["readRecords"],
          "memoryRuntime.contextReader",
        ),
        maximumRecords: memoryAnswerConfig.maximumRecords,
        maximumContextBytes: memoryAnswerConfig.maximumContextBytes,
      });
      memoryAnswer = frozenPort(
        memoryAnswerServiceFactory({
          contextRetriever,
          brainRouter: memoryBrainRouter,
          configuredBrain: memoryAnswerConfig.brain,
          localBrain: memoryAnswerConfig.localBrain,
          maximumConcurrent: memoryAnswerConfig.maximumConcurrent,
          ...(memoryAnswerDependencies.beforeGenerate
            ? { beforeGenerate: memoryAnswerDependencies.beforeGenerate }
            : {}),
        }),
        ["answer"],
        "memoryAnswerService",
      );
    }
    const memoryImportConfig = config.memory?.imports || {};
    const localSessionImportEnabled =
      memoryEnabled && memoryImportConfig.localSessions === true;
    const gitImportEnabled = memoryEnabled && memoryImportConfig.git === true;
    if (localSessionImportEnabled || gitImportEnabled) {
      if (!memoryRuntime) {
        throw new Error("记忆导入需要启用统一记忆运行时");
      }
      const memoryProducer = frozenPort(
        memoryRuntime.producer,
        ["appendBatch"],
        "memoryRuntime.producer",
      );
      const imports = {};
      if (localSessionImportEnabled) {
        const importer = localSessionImporterFactory({
          memoryProducer,
        });
        imports.session = frozenPort(
          importer,
          ["importSession"],
          "localSessionImporter",
        );
      }
      if (gitImportEnabled) {
        const importer = gitActivityImporterFactory({
          memoryProducer,
        });
        imports.git = frozenPort(
          importer,
          ["importCommits"],
          "gitActivityImporter",
        );
      }
      memoryImports = Object.freeze(imports);
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
      changePackageReader,
      changePackageApplicationReader,
      changePackageApplicationStatusReader,
      changePackageApplicationRequester,
      workflowRouting,
      codeJobReader,
      codeJobControl,
      codeJobEvidenceReader,
      workLedgerView,
      workGraphView,
      attentionBrowser,
      attentionCoordinator,
      workCoordination,
      memorySearch,
      memoryAnswer,
      memoryImports,
      memoryProjector,
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
