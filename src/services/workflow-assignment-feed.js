import {
  boundedWorkflowString,
  cloneWorkflowValue,
  hasExactWorkflowKeys,
  workflowDataEntries,
  workflowServiceError,
} from "./workflow-routing-values.js";

export const MAX_WORKFLOW_ASSIGNMENT_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;

export function normalizeWorkflowAssignmentFeedEntry(value) {
  if (
    !hasExactWorkflowKeys(value, ["sequence", "assignmentId", "eventId"]) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > MAX_WORKFLOW_ASSIGNMENT_SEQUENCE
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流分派消费流记录损坏",
      503,
    );
  }
  return {
    sequence: value.sequence,
    assignmentId: boundedWorkflowString(
      value.assignmentId,
      "assignmentFeed.assignmentId",
      128,
    ),
    eventId: boundedWorkflowString(
      value.eventId,
      "assignmentFeed.eventId",
      128,
    ),
  };
}

export function migrateWorkflowAssignmentFeed(assignments) {
  const assignmentFeed = assignments.map((assignment, index) => ({
    sequence: index + 1,
    assignmentId: assignment.assignmentId,
    eventId: assignment.eventId,
  }));
  return {
    assignmentFeed,
    assignmentHighWatermark: assignmentFeed.length,
    assignmentOldestAvailableSequence: assignmentFeed[0]?.sequence || 1,
  };
}

export function assertWorkflowAssignmentFeedConsistency(
  state,
  { events, assignments },
) {
  if (state.assignmentFeed.length !== state.assignments.length) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流分派消费流与分派记录数量不一致",
      503,
    );
  }
  if (state.assignmentFeed.length === 0) {
    if (
      state.assignmentOldestAvailableSequence !==
      state.assignmentHighWatermark + 1
    ) {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流分派消费流水位不一致",
        503,
      );
    }
  } else if (
    state.assignmentFeed[0].sequence !==
      state.assignmentOldestAvailableSequence ||
    state.assignmentFeed.at(-1).sequence !== state.assignmentHighWatermark
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流分派消费流水位不一致",
      503,
    );
  }
  for (let index = 0; index < state.assignmentFeed.length; index += 1) {
    const feedEntry = state.assignmentFeed[index];
    const assignment = state.assignments[index];
    if (
      feedEntry.sequence !==
        state.assignmentOldestAvailableSequence + index ||
      feedEntry.assignmentId !== assignment.assignmentId ||
      feedEntry.eventId !== assignment.eventId ||
      !events.has(feedEntry.eventId) ||
      !assignments.has(feedEntry.assignmentId)
    ) {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流分派消费流引用不一致",
        503,
      );
    }
  }
}

export function appendWorkflowAssignmentFeed(state, newAssignments) {
  if (
    newAssignments.length >
    MAX_WORKFLOW_ASSIGNMENT_SEQUENCE - state.assignmentHighWatermark
  ) {
    throw workflowServiceError(
      "WORKFLOW_ASSIGNMENT_SEQUENCE_EXHAUSTED",
      "工作流分派消费序号已耗尽",
      409,
    );
  }
  const appended = newAssignments.map((assignment, index) => ({
    sequence: state.assignmentHighWatermark + index + 1,
    assignmentId: assignment.assignmentId,
    eventId: assignment.eventId,
  }));
  const assignmentFeed = [...state.assignmentFeed, ...appended];
  const assignmentHighWatermark =
    state.assignmentHighWatermark + appended.length;
  return {
    assignmentFeed,
    assignmentHighWatermark,
    assignmentOldestAvailableSequence:
      assignmentFeed[0]?.sequence || assignmentHighWatermark + 1,
  };
}

function assignmentBatchOptions(value) {
  const entries = workflowDataEntries(value);
  const input = entries ? Object.fromEntries(entries) : null;
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["afterSequence", "limit"].includes(key),
    ) ||
    !Number.isSafeInteger(input.afterSequence) ||
    input.afterSequence < 0
  ) {
    throw workflowServiceError(
      "WORKFLOW_ASSIGNMENT_CURSOR_INVALID",
      "工作流分派消费游标无效",
    );
  }
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw workflowServiceError(
      "WORKFLOW_ASSIGNMENT_QUERY_INVALID",
      "工作流分派消费条数无效",
    );
  }
  return { afterSequence: input.afterSequence, limit };
}

export function readWorkflowAssignmentBatch(state, options = {}) {
  const { afterSequence, limit } = assignmentBatchOptions(options);
  const highWatermark = state.assignmentHighWatermark;
  const oldestAvailableSequence = state.assignmentOldestAvailableSequence;
  if (afterSequence > highWatermark) {
    throw workflowServiceError(
      "WORKFLOW_ASSIGNMENT_CURSOR_INVALID",
      "工作流分派消费游标超过当前高水位",
    );
  }
  if (afterSequence < oldestAvailableSequence - 1) {
    const error = workflowServiceError(
      "WORKFLOW_ASSIGNMENT_GAP",
      "工作流分派消费进度已落后于本地保留窗口",
      409,
    );
    error.details = Object.freeze({
      afterSequence,
      expectedSequence: afterSequence + 1,
      oldestAvailableSequence,
      highWatermark,
    });
    throw error;
  }
  const assignments = new Map(
    state.assignments.map((assignment) => [
      assignment.assignmentId,
      assignment,
    ]),
  );
  const events = new Map(state.events.map((event) => [event.eventId, event]));
  const start = Math.max(
    0,
    afterSequence - oldestAvailableSequence + 1,
  );
  const entries = state.assignmentFeed.slice(start, start + limit);
  const items = entries.map((entry) => ({
    sequence: entry.sequence,
    assignment: assignments.get(entry.assignmentId),
    event: events.get(entry.eventId),
  }));
  return cloneWorkflowValue({
    items,
    nextSequence: items.at(-1)?.sequence || afterSequence,
    highWatermark,
    oldestAvailableSequence,
  });
}
