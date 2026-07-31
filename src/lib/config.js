import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function mergeConfig(base, local = {}) {
  const basePrReviewer = base.employees?.prReviewer || {};
  const localPrReviewer = local.employees?.prReviewer || {};
  return {
    ...base,
    ...local,
    dingtalk: { ...base.dingtalk, ...local.dingtalk },
    brain: { ...base.brain, ...local.brain },
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
