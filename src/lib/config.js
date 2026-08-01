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
    },
    ...(hasCodeExecutor
      ? {
          codeExecutor: mergeCodeExecutorConfig(
            base.codeExecutor,
            local.codeExecutor,
          ),
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
