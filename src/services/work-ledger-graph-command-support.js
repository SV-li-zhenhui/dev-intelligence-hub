import { validateWorkLedgerGraphTransition } from "./work-ledger-graph.js";
import { normalizeWorkActor } from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

function invalidGraphCommand(message) {
  return workLedgerError("WORK_LEDGER_GRAPH_COMMAND_INVALID", message);
}

const preWriteGraphRevisionConflicts = new WeakSet();

export function isPreWriteGraphRevisionConflict(error) {
  return preWriteGraphRevisionConflicts.has(error);
}

export function normalizeWorkGraphCommandAuthority(value) {
  if (!hasExactLedgerKeys(value, ["actorId", "scopeRootTaskId"])) {
    throw invalidGraphCommand("工作图权限上下文无效");
  }
  let scopeRootTaskId;
  try {
    scopeRootTaskId = value.scopeRootTaskId === null
      ? null
      : boundedLedgerString(value.scopeRootTaskId, "scopeRootTaskId", 192);
  } catch {
    throw invalidGraphCommand("工作图权限上下文无效");
  }
  return {
    actorId: normalizeWorkActor(value.actorId),
    scopeRootTaskId,
  };
}

export function assertWorkGraphTasksInScope(
  state,
  taskIds,
  scopeRootTaskId,
) {
  if (scopeRootTaskId === null) return;
  const byId = new Map(state.items.map((item) => [item.itemId, item]));
  if (!byId.has(scopeRootTaskId)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_SCOPE_INVALID",
      "工作图权限范围不存在",
      403,
    );
  }
  for (const taskId of taskIds) {
    let currentTaskId = taskId;
    while (currentTaskId !== null && currentTaskId !== scopeRootTaskId) {
      currentTaskId = byId.get(currentTaskId)?.graph.parentItemId ?? null;
    }
    if (currentTaskId !== scopeRootTaskId) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_SCOPE_DENIED",
        "工作图命令越过了绑定任务范围",
        403,
      );
    }
  }
}

export function assertExpectedWorkGraphRevision(expectedRevision, state) {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw invalidGraphCommand("工作图 revision 无效");
  }
  if (expectedRevision !== state.revision) {
    const error = workLedgerError(
      "WORK_LEDGER_STATE_REVISION_CONFLICT",
      "工作图已被其他员工更新",
      409,
    );
    preWriteGraphRevisionConflicts.add(error);
    throw error;
  }
}

export function assertWorkGraphCommandTransition(state, items) {
  try {
    validateWorkLedgerGraphTransition(state, {
      ...state,
      revision: state.revision + 1,
      items,
    });
  } catch (cause) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TRANSITION_INVALID",
      "工作图命令会破坏任务关系或修订约束",
      409,
      { cause },
    );
  }
}
