import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
          brain: {
            ...baseBrain,
            ...localBrain,
            ...(baseBrain.remoteData !== undefined ||
            localBrain.remoteData !== undefined
              ? {
                  remoteData: {
                    ...(baseBrain.remoteData || {}),
                    ...(localBrain.remoteData || {}),
                  },
                }
              : {}),
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
          memory: {
            ...(base.memory || {}),
            ...(local.memory || {}),
          },
        }
      : {}),
  };
}

export async function loadConfig() {
  const base = JSON.parse(
    await readFile(path.join(projectRoot, "config.json"), "utf8"),
  );
  try {
    const local = JSON.parse(
      await readFile(path.join(projectRoot, "config.local.json"), "utf8"),
    );
    return mergeConfig(base, local);
  } catch (error) {
    if (error.code === "ENOENT") return base;
    throw error;
  }
}
