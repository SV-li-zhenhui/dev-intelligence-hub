import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSafeDisabledConfiguration,
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";

export { createSafeDisabledConfiguration };

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

function mergeCaseInsensitiveNames(base = {}, local = {}) {
  const merged = new Map();
  const appendLayer = (value) => {
    const layerNames = new Set();
    for (const [name, entry] of Object.entries(value)) {
      const portableName = name.toLowerCase();
      if (layerNames.has(portableName)) {
        throw new TypeError(
          "repository mirror map contains case-insensitive duplicate names",
        );
      }
      layerNames.add(portableName);
      merged.set(portableName, [name, entry]);
    }
  };
  appendLayer(base);
  appendLayer(local);
  return Object.fromEntries(merged.values());
}

function mergeConflictPreparationConfig(base = {}, local = {}) {
  if (local.enabled === false) return { ...local };
  const merged = { ...base, ...local };
  for (const name of [
    "baseMirrorsByRepository",
    "headMirrorsByRepository",
  ]) {
    if (base[name] === undefined && local[name] === undefined) continue;
    merged[name] = mergeCaseInsensitiveNames(base[name], local[name]);
  }
  return merged;
}

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
  if (
    base.conflictPreparation !== undefined ||
    local.conflictPreparation !== undefined
  ) {
    merged.conflictPreparation = mergeConflictPreparationConfig(
      base.conflictPreparation,
      local.conflictPreparation,
    );
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
  const baseTaskBrain = base.taskBrain || {};
  const localTaskBrain = local.taskBrain || {};
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
    ...(base.taskBrain !== undefined || local.taskBrain !== undefined
      ? {
          taskBrain: mergeBrainConfig(baseTaskBrain, localTaskBrain),
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
    ...(base.githubRead !== undefined || local.githubRead !== undefined
      ? {
          githubRead: {
            ...(base.githubRead || {}),
            ...(local.githubRead || {}),
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

async function readBaseConfig() {
  try {
    return JSON.parse(
      await readFile(path.join(projectRoot, "config.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return JSON.parse(
      await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
    );
  }
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
