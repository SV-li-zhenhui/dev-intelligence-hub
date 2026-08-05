import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfigurationDocument } from "../domain/configuration-contract.js";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const codeExecutorNestedConfigs = [
  "docker",
  "profiles",
  "requiredProfilesByWorkspace",
  "brokerLimits",
  "executorLimits",
];

function mergeCodeExecutorConfig(base = {}, local = {}) {
  const merged = { ...base, ...local };
  for (const name of codeExecutorNestedConfigs) {
    if (base[name] === undefined && local[name] === undefined) continue;
    merged[name] = { ...base[name], ...local[name] };
  }
  if (local.workspaces !== undefined) {
    merged.requiredProfilesByWorkspace = {
      ...(local.requiredProfilesByWorkspace || {}),
    };
  }
  return merged;
}

function mergeWorkCoordinationConfig(base = {}, local = {}) {
  const basePolicy = base.policy || {};
  const localPolicy = local.policy || {};
  return {
    ...base,
    ...local,
    policy: {
      ...basePolicy,
      ...localPolicy,
      capabilityRoles: {
        ...(basePolicy.capabilityRoles || {}),
        ...(localPolicy.capabilityRoles || {}),
      },
      workspaceByRepository: {
        ...(basePolicy.workspaceByRepository || {}),
        ...(localPolicy.workspaceByRepository || {}),
      },
      ...(basePolicy.codeOperationsByRole !== undefined ||
      localPolicy.codeOperationsByRole !== undefined
        ? {
            codeOperationsByRole: {
              ...(basePolicy.codeOperationsByRole || {}),
              ...(localPolicy.codeOperationsByRole || {}),
            },
          }
        : {}),
    },
  };
}

function mergeNamedConfigs(base = {}, local = {}, mergeValue) {
  const merged = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    merged[key] = mergeValue(base[key] || {}, local[key] || {});
  }
  return merged;
}

function mergeBrainConfig(base = {}, local = {}) {
  return {
    ...base,
    ...local,
    ...(base.remoteData !== undefined || local.remoteData !== undefined
      ? {
          remoteData: {
            ...(base.remoteData || {}),
            ...(local.remoteData || {}),
          },
        }
      : {}),
  };
}

function mergeRoleConfig(base = {}, local = {}) {
  const baseBrain = base.brain || {};
  const localBrain = local.brain || {};
  return {
    ...base,
    ...local,
    ...(base.permissions !== undefined || local.permissions !== undefined
      ? { permissions: { ...(base.permissions || {}), ...(local.permissions || {}) } }
      : {}),
    ...(base.brain !== undefined || local.brain !== undefined
      ? {
          brain: mergeBrainConfig(baseBrain, localBrain),
        }
      : {}),
  };
}

function mergeMemoryConfig(base = {}, local = {}) {
  const baseAnswering = base.answering || {};
  const localAnswering = local.answering || {};
  return {
    ...base,
    ...local,
    ...(base.answering !== undefined || local.answering !== undefined
      ? {
          answering: {
            ...baseAnswering,
            ...localAnswering,
            ...(baseAnswering.brain !== undefined ||
            localAnswering.brain !== undefined
              ? {
                  brain: mergeBrainConfig(
                    baseAnswering.brain,
                    localAnswering.brain,
                  ),
                }
              : {}),
            ...(baseAnswering.localBrain !== undefined ||
            localAnswering.localBrain !== undefined
              ? {
                  localBrain: mergeBrainConfig(
                    baseAnswering.localBrain,
                    localAnswering.localBrain,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(base.imports !== undefined || local.imports !== undefined
      ? {
          imports: {
            ...(base.imports || {}),
            ...(local.imports || {}),
          },
        }
      : {}),
  };
}

export function mergeConfig(base, local = {}) {
  const basePrReviewer = base.employees?.prReviewer || {};
  const localPrReviewer = local.employees?.prReviewer || {};
  const hasCodeExecutor =
    base.codeExecutor !== undefined || local.codeExecutor !== undefined;
  return {
    ...base,
    ...local,
    dingtalk: { ...base.dingtalk, ...local.dingtalk },
    brain: { ...base.brain, ...local.brain },
    ...(base.brainProviders !== undefined || local.brainProviders !== undefined
      ? {
          brainProviders: mergeNamedConfigs(
            base.brainProviders,
            local.brainProviders,
            (baseProvider, localProvider) => ({
              ...baseProvider,
              ...localProvider,
            }),
          ),
        }
      : {}),
    ...(base.githubActions !== undefined || local.githubActions !== undefined
      ? {
          githubActions: {
            ...(base.githubActions || {}),
            ...(local.githubActions || {}),
            ...((base.githubActions?.networkEnv !== undefined ||
              local.githubActions?.networkEnv !== undefined)
              ? {
                  networkEnv: {
                    ...(base.githubActions?.networkEnv || {}),
                    ...(local.githubActions?.networkEnv || {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    prResponsibility: {
      ...base.prResponsibility,
      ...local.prResponsibility,
    },
    employees: {
      ...(base.employees || {}),
      ...(local.employees || {}),
      prReviewer: {
        ...basePrReviewer,
        ...localPrReviewer,
        brain: {
          ...(basePrReviewer.brain || {}),
          ...(localPrReviewer.brain || {}),
        },
      },
      ...(base.employees?.roles !== undefined ||
      local.employees?.roles !== undefined
        ? {
            roles: mergeNamedConfigs(
              base.employees?.roles,
              local.employees?.roles,
              mergeRoleConfig,
            ),
          }
        : {}),
    },
    ...(hasCodeExecutor
      ? {
          codeExecutor: mergeCodeExecutorConfig(
            base.codeExecutor,
            local.codeExecutor,
          ),
        }
      : {}),
    ...(base.changePackages !== undefined || local.changePackages !== undefined
      ? {
          changePackages: {
            ...(base.changePackages || {}),
            ...(local.changePackages || {}),
          },
        }
      : {}),
    ...(base.workCoordination !== undefined ||
      local.workCoordination !== undefined
      ? {
          workCoordination: mergeWorkCoordinationConfig(
            base.workCoordination,
            local.workCoordination,
          ),
        }
      : {}),
    ...(base.memory !== undefined || local.memory !== undefined
      ? {
          memory: mergeMemoryConfig(base.memory, local.memory),
        }
      : {}),
  };
}

export function createSafeDisabledConfiguration(value) {
  const safe = structuredClone(normalizeConfigurationDocument(value));
  safe.trackedRepositories = [];
  safe.brain.enabled = false;
  safe.codeExecutor.enabled = false;
  safe.changePackages.enabled = false;
  safe.githubActions.enabled = false;
  safe.workflowRouting.enabled = false;
  safe.workCoordination.enabled = false;
  safe.memory.imports = { localSessions: false, git: false };
  if (safe.memory.answering) safe.memory.answering.enabled = false;
  safe.employees.prReviewer.enabled = false;
  safe.employees.prReviewer.initialPaused = true;
  for (const role of Object.values(safe.employees.roles)) {
    role.enabled = false;
    role.initialPaused = true;
  }
  safe.dingtalk.enabled = false;
  return normalizeConfigurationDocument(safe);
}

async function readBaseConfig() {
  return JSON.parse(
    await readFile(path.join(projectRoot, "config.json"), "utf8"),
  );
}

async function readLocalConfig() {
  return JSON.parse(
    await readFile(path.join(projectRoot, "config.local.json"), "utf8"),
  );
}

export async function loadConfigBootstrap() {
  const base = await readBaseConfig();
  const fallbackConfiguration = createSafeDisabledConfiguration(base);
  try {
    return {
      candidate: mergeConfig(base, await readLocalConfig()),
      fallbackConfiguration,
      bootstrapError: null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { candidate: base, fallbackConfiguration, bootstrapError: null };
    }
    if (error instanceof SyntaxError) {
      return {
        candidate: null,
        fallbackConfiguration,
        bootstrapError: {
          code: "CONFIG_LOCAL_INVALID",
          message: "本地覆盖配置无法解析",
        },
      };
    }
    throw error;
  }
}

export async function loadConfig() {
  const base = await readBaseConfig();
  try {
    return mergeConfig(base, await readLocalConfig());
  } catch (error) {
    if (error.code === "ENOENT") return base;
    throw error;
  }
}
