import { createHash } from "node:crypto";

import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import {
  createPullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { normalizeWorkGraphSnapshot } from "../domain/work-graph-contract.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import { createRoleContextEvidenceCatalogAdapter } from "./role-context-evidence-catalog.js";
import {
  RoleContextAssemblerError,
  roleContextError,
} from "./role-context-error.js";
import {
  normalizePullRequestInputBinding,
  normalizePullRequestWorkSource,
} from "./work-ledger-pr-source.js";

export { RoleContextAssemblerError };

const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PULL_REQUEST_CONTEXT_BYTES = 96 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_ENTRIES = 500;
const MAX_ROOT_DELIVERABLE_SLOTS = 4;
const MAX_ROOT_DELIVERY_PAYLOADS = 1;
const MAX_SPECIALIST_REJECTION_REASON_BYTES = 4 * 1024;
const MAX_SPECIALIST_REJECTION_EVIDENCE = 8;
const MAX_ROOT_CHILD_DESCRIPTION_BYTES = 512;
const ORCHESTRATOR_ROLE_ID = "orchestrator";
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,254}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESPONSIBILITY_TYPES = new Set(["role", "person", "node"]);
const FACT_NAMES = Object.freeze([
  "action-state",
  "ci-status",
  "merge-state",
  "next-action",
  "review-decision",
  "state",
]);
const ISSUE_FACT_NAMES = Object.freeze([
  "issue-description",
  "issue-comments-count",
  "issue-latest-comment",
]);
const DATA_CLASS_BY_DELIVERABLE_KIND = new Map([
  ["requirement-spec", "requirements"],
  ["text-report", "requirements"],
  ["change-package", "code"],
  ["test-report", "code"],
  ["review-report", "code"],
  ["github-review", "code"],
]);

function contextError(code, message, statusCode, options) {
  return roleContextError(code, message, statusCode, options);
}

function invalid(message = "Role context input is invalid", options) {
  return contextError("ROLE_CONTEXT_INVALID", message, 400, options);
}

function ownData(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} is invalid`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} is invalid`);
    }
    entries.push([key, descriptor.value]);
  }
  return new Map(entries);
}

function exactData(value, keys, name) {
  const entries = ownData(value, name);
  if (
    entries.size !== keys.length ||
    keys.some((key) => !entries.has(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return entries;
}

function denseArray(value, name, maximum = MAX_CANONICAL_ENTRIES) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} is invalid`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} is invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value, name, maximumBytes = 16 * 1024) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function nullableText(value, name, maximumBytes) {
  return value === null ? null : text(value, name, maximumBytes);
}

function identifier(value, name, maximumBytes = 256) {
  const normalized = text(value, name, maximumBytes);
  if (!SAFE_ID.test(normalized)) throw invalid(`${name} is invalid`);
  return normalized;
}

function positiveRevision(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function truncateUtf8(value, maximumBytes) {
  if (value === null || Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalValue(value, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw invalid("Role context data is too deep");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (
      INVALID_CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > 512 * 1024
    ) {
      throw invalid("Role context text is invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return denseArray(value, "Role context array").map((entry) =>
      canonicalValue(entry, depth + 1)
    );
  }
  const entries = [...ownData(value, "Role context object").entries()];
  if (entries.length > MAX_CANONICAL_ENTRIES) {
    throw invalid("Role context object is too large");
  }
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [
        text(key, "Role context key", 128),
        canonicalValue(entry, depth + 1),
      ]),
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function bindPortMethod(value, method, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  throw new TypeError(`${name} is invalid`);
}

function requireGraphReader(value) {
  return Object.freeze({
    getSnapshot: bindPortMethod(value, "getSnapshot", "graphReader"),
  });
}

function optionalFactSource(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    read: bindPortMethod(value, "read", "factSource"),
  });
}

function optionalPullRequestContextReader(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    read: bindPortMethod(value, "read", "pullRequestContextReader"),
  });
}

function optionalMemoryQueryReader(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    readContext: bindPortMethod(value, "readContext", "memoryQueryReader"),
  });
}

function normalizeTarget(value, name) {
  const fields = exactData(value, ["type", "id"], name);
  const type = fields.get("type");
  if (!RESPONSIBILITY_TYPES.has(type)) throw invalid(`${name} is invalid`);
  return {
    type,
    id: text(fields.get("id"), `${name}.id`, 128),
  };
}

function inheritedPullRequestInputBinding(fields) {
  if (!fields.has("kind") || fields.get("kind") !== "graph_task") {
    return null;
  }
  if (!fields.has("assignment")) throw invalid("item is invalid");
  const assignment = ownData(fields.get("assignment"), "item.assignment");
  if (!assignment.has("graphTask")) throw invalid("item assignment is invalid");
  const graphTask = ownData(
    assignment.get("graphTask"),
    "item.assignment.graphTask",
  );
  if (!graphTask.has("sourceBinding")) {
    throw invalid("item source binding is invalid");
  }
  const sourceBinding = graphTask.get("sourceBinding");
  if (sourceBinding === null) return null;
  try {
    return normalizePullRequestInputBinding(sourceBinding);
  } catch (cause) {
    throw invalid("item source binding is invalid", { cause });
  }
}

function normalizeItem(value) {
  const fields = ownData(value, "item");
  for (const key of [
    "itemId",
    "revision",
    "inputDigest",
    "assignmentId",
    "currentTarget",
    "decisionContext",
    "event",
  ]) {
    if (!fields.has(key)) throw invalid("item is invalid");
  }
  let source = null;
  if (fields.has("source") && fields.get("source") !== null) {
    try {
      source = normalizePullRequestWorkSource(fields.get("source"));
    } catch (cause) {
      throw invalid("item source is invalid", { cause });
    }
  }
  const taskId = identifier(fields.get("itemId"), "item.itemId", 192);
  let sourceBinding = inheritedPullRequestInputBinding(fields);
  if (source !== null) {
    const revision = source.revisions[source.activeRevision - 1];
    sourceBinding = normalizePullRequestInputBinding({
      kind: "pull_request",
      rootItemId: taskId,
      workKey: source.workKey,
      inputRevision: source.activeRevision,
      headRevision: revision.headRevision,
      headRefOid: source.current.headRefOid,
      eventId: source.current.eventId,
      eventDigest: source.current.eventDigest,
      inputDigest: source.current.inputDigest,
    });
  }
  const rawEvent = canonicalValue(
    source === null ? fields.get("event") : source.current.event,
  );
  let event = rawEvent;
  if (sourceBinding !== null) {
    try {
      event = normalizeStoredWorkflowEvent(rawEvent);
    } catch (cause) {
      throw invalid("item source event is invalid", { cause });
    }
  }
  const eventFields = ownData(event, "item.event");
  const eventId = identifier(eventFields.get("eventId"), "eventId", 512);
  const eventType = text(eventFields.get("eventType"), "eventType", 128);
  const inputDigest = digest(fields.get("inputDigest"), "item.inputDigest");
  if (source !== null && inputDigest !== source.current.inputDigest) {
    throw invalid("item source input is stale");
  }
  if (
    sourceBinding !== null &&
    (
      eventId !== sourceBinding.eventId ||
      event.contentDigest !== sourceBinding.eventDigest ||
      event.payload?.headRefOid !== sourceBinding.headRefOid ||
      !eventType.startsWith("pull_request.")
    )
  ) {
    throw invalid("item source event is stale");
  }
  return {
    taskId,
    taskRevision: positiveRevision(fields.get("revision"), "item.revision"),
    inputDigest,
    assignmentId: identifier(
      fields.get("assignmentId"),
      "item.assignmentId",
      512,
    ),
    currentTarget: normalizeTarget(fields.get("currentTarget"), "currentTarget"),
    decisionContext: canonicalValue(fields.get("decisionContext")),
    event,
    eventId,
    eventType,
    sourceBinding,
  };
}

function classifyDeliverable(kind) {
  const normalized = identifier(kind, "deliverable.kind", 128);
  const dataClass = DATA_CLASS_BY_DELIVERABLE_KIND.get(normalized);
  if (!dataClass) {
    throw contextError(
      "ROLE_CONTEXT_CLASSIFICATION_REQUIRED",
      `No data class is registered for deliverable kind ${normalized}`,
      403,
    );
  }
  return { kind: normalized, dataClass };
}

function classifyContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria,
    expectedDeliverables: contract.expectedDeliverables.map((deliverable) => ({
      ...deliverable,
      ...classifyDeliverable(deliverable.kind),
    })),
  };
}

function publicContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
    })),
    expectedDeliverables: contract.expectedDeliverables.map(
      ({ dataClass: _dataClass, ...deliverable }) => ({ ...deliverable }),
    ),
  };
}

function normalizeSnapshot(value) {
  const snapshot = exactData(
    value,
    ["schemaVersion", "graph", "taskStates"],
    "graph snapshot",
  );
  if (snapshot.get("schemaVersion") !== 1) {
    throw invalid("graph snapshot schemaVersion is invalid");
  }
  let graph;
  try {
    graph = normalizeWorkGraphSnapshot(snapshot.get("graph"));
  } catch (cause) {
    throw invalid("graph snapshot is invalid", { cause });
  }
  const tasksById = new Map(
    graph.tasks.map((task) => [task.taskId, task]),
  );

  const states = denseArray(snapshot.get("taskStates"), "taskStates", 5_000);
  const statesById = new Map();
  for (const entry of states) {
    const fields = ownData(entry, "task state");
    for (const key of ["taskId", "taskRevision", "work"]) {
      if (!fields.has(key)) throw invalid("task state is invalid");
    }
    const taskId = identifier(fields.get("taskId"), "taskState.taskId");
    const work = exactData(fields.get("work"), ["title", "description"], "task work");
    if (statesById.has(taskId)) throw invalid("task state IDs are duplicated");
    statesById.set(taskId, {
      taskId,
      taskRevision: positiveRevision(
        fields.get("taskRevision"),
        "taskState.taskRevision",
      ),
      work: {
        title: nullableText(work.get("title"), "work.title", 256),
        description: nullableText(
          work.get("description"),
          "work.description",
          16 * 1_024,
        ),
      },
    });
  }
  return {
    graphId: graph.graphId,
    graphRevision: graph.revision,
    graphContentDigest: graph.contentDigest,
    tasksById,
    statesById,
  };
}

function sameTarget(left, right) {
  return left.type === right.type && left.id === right.id;
}

function rootTaskId(taskId, tasksById) {
  const visited = new Set();
  let current = tasksById.get(taskId);
  while (current) {
    if (visited.has(current.taskId)) throw invalid("graph hierarchy contains a cycle");
    visited.add(current.taskId);
    if (current.parentTaskId === null) return current.taskId;
    current = tasksById.get(current.parentTaskId);
  }
  throw invalid("graph hierarchy contains a missing parent");
}

function assertCurrentBinding({ roleId, item, task, taskState }) {
  if (task.revision !== item.taskRevision || taskState.taskRevision !== task.revision) {
    throw contextError(
      "ROLE_CONTEXT_STALE",
      "The claimed task revision no longer matches the graph",
      409,
    );
  }
  if (!sameTarget(task.responsibility, item.currentTarget)) {
    throw contextError(
      "ROLE_CONTEXT_STALE",
      "The claimed task responsibility no longer matches the work item",
      409,
    );
  }
  if (
    roleId !== "orchestrator" &&
    (task.responsibility.type !== "role" || task.responsibility.id !== roleId)
  ) {
    throw contextError(
      "ROLE_CONTEXT_AUTHORITY_DENIED",
      "The role is not responsible for the claimed task",
      403,
    );
  }
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchingSubmission(deliveries, decision, code, message) {
  const submitted = deliveries[decision.revision - 2];
  if (
    !submitted ||
    submitted.status !== "submitted" ||
    submitted.revision + 1 !== decision.revision ||
    submitted.contractRevision !== decision.contractRevision ||
    submitted.deliverableId !== decision.deliverableId ||
    !sameEvidence(submitted.evidence, decision.evidence)
  ) {
    throw contextError(code, message, 409);
  }
  return submitted;
}

function currentDeliveryState(task) {
  const currentContract = classifyContract(task.acceptanceContracts.at(-1));
  const latestByDeliverable = new Map();
  for (const record of task.deliveries) {
    if (record.contractRevision === currentContract.revision) {
      latestByDeliverable.set(record.deliverableId, record);
    }
  }
  return {
    currentContract,
    deliveries: task.deliveries,
    latestByDeliverable,
  };
}

function acceptedDependency(task) {
  if (task.status !== "completed") {
    throw contextError(
      "ROLE_CONTEXT_DEPENDENCY_NOT_ACCEPTED",
      `Dependency ${task.taskId} is not completed`,
      409,
    );
  }
  const { currentContract, deliveries, latestByDeliverable } =
    currentDeliveryState(task);
  const projected = [];
  const acceptedInputs = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const accepted = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (accepted?.status !== "accepted") {
      if (expectedDelivery.required) {
        throw contextError(
          "ROLE_CONTEXT_DEPENDENCY_NOT_ACCEPTED",
          `Required dependency delivery ${expectedDelivery.deliverableId} is not accepted`,
          409,
        );
      }
      continue;
    }
    const submitted = matchingSubmission(
      deliveries,
      accepted,
      "ROLE_CONTEXT_DEPENDENCY_INVALID",
      `Accepted dependency delivery ${expectedDelivery.deliverableId} has no matching submission`,
    );
    const evidenceDigests = [
      ...new Set(accepted.evidence.map(({ contentDigest }) => contentDigest)),
    ].sort(compareText);
    projected.push({
      dataClass: expectedDelivery.dataClass,
      delivery: {
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        required: expectedDelivery.required,
        submittedDeliveryRevision: submitted.revision,
        decisionRevision: accepted.revision,
        summary: submitted.summary,
        acceptanceReason: accepted.summary,
        evidence: accepted.evidence.map((entry) => ({ ...entry })),
      },
    });
    acceptedInputs.push({
      taskId: task.taskId,
      taskRevision: task.revision,
      contractRevision: currentContract.revision,
      deliverableId: expectedDelivery.deliverableId,
      submittedDeliveryRevision: submitted.revision,
      decisionRevision: accepted.revision,
      evidenceDigests,
    });
  }
  return { contractRevision: currentContract.revision, projected, acceptedInputs };
}

function appendDependency(target, task, contractRevision, deliveries) {
  if (deliveries.length === 0) return;
  target.push({
    taskId: task.taskId,
    taskRevision: task.revision,
    contractRevision,
    deliverables: deliveries.sort((left, right) =>
      compareText(left.deliverableId, right.deliverableId)
    ),
  });
}

function projectDependencies(currentTask, snapshot) {
  const currentRoot = rootTaskId(currentTask.taskId, snapshot.tasksById);
  const requirements = [];
  const code = [];
  const acceptedInputs = [];
  for (const dependencyId of currentTask.dependsOn) {
    const dependency = snapshot.tasksById.get(dependencyId);
    if (!dependency) throw invalid(`Dependency ${dependencyId} does not exist`);
    if (rootTaskId(dependency.taskId, snapshot.tasksById) !== currentRoot) {
      throw contextError(
        "ROLE_CONTEXT_SCOPE_DENIED",
        `Dependency ${dependency.taskId} is outside the current root`,
        403,
      );
    }
    const projection = acceptedDependency(dependency);
    appendDependency(
      requirements,
      dependency,
      projection.contractRevision,
      projection.projected
        .filter(({ dataClass }) => dataClass === "requirements")
        .map(({ delivery: value }) => value),
    );
    appendDependency(
      code,
      dependency,
      projection.contractRevision,
      projection.projected
        .filter(({ dataClass }) => dataClass === "code")
        .map(({ delivery: value }) => value),
    );
    acceptedInputs.push(...projection.acceptedInputs);
  }
  const dependencyOrder = (left, right) => compareText(left.taskId, right.taskId);
  acceptedInputs.sort((left, right) =>
    compareText(
      `${left.taskId}\u0000${left.deliverableId}`,
      `${right.taskId}\u0000${right.deliverableId}`,
    )
  );
  return {
    requirements: requirements.sort(dependencyOrder),
    code: code.sort(dependencyOrder),
    acceptedInputs,
  };
}

function isConfiguredRootOrchestrator(roleId, task) {
  return (
    roleId === ORCHESTRATOR_ROLE_ID &&
    task.parentTaskId === null &&
    task.responsibility.type === "role" &&
    task.responsibility.id === ORCHESTRATOR_ROLE_ID
  );
}

function projectChildDeliveries(task) {
  const { currentContract, deliveries, latestByDeliverable } =
    currentDeliveryState(task);

  const slots = [];
  const payloads = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const latest = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (!latest) {
      slots.push({
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        required: expectedDelivery.required,
        state: "none",
        submittedDeliveryRevision: null,
        decisionRevision: null,
      });
      continue;
    }

    const decision = latest.status === "submitted" ? null : latest;
    const submitted = decision
      ? matchingSubmission(
          deliveries,
          decision,
          "ROLE_CONTEXT_CHILD_DELIVERY_INVALID",
          `Child delivery ${expectedDelivery.deliverableId} has no matching submission`,
        )
      : latest;
    slots.push({
      deliverableId: expectedDelivery.deliverableId,
      kind: expectedDelivery.kind,
      required: expectedDelivery.required,
      state: latest.status,
      submittedDeliveryRevision: submitted.revision,
      decisionRevision: decision?.revision ?? null,
    });
    payloads.push({
      dataClass: expectedDelivery.dataClass,
      payload: {
        taskId: task.taskId,
        taskRevision: task.revision,
        contractRevision: currentContract.revision,
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        state: latest.status,
        submittedDeliveryRevision: submitted.revision,
        decisionRevision: decision?.revision ?? null,
        summary: submitted.summary,
        decisionReason: decision?.summary ?? null,
        evidence: submitted.evidence.map((entry) => ({ ...entry })),
      },
    });
  }
  return { contractRevision: currentContract.revision, slots, payloads };
}

function projectCurrentTaskRejection(roleId, currentTask, deliveryState) {
  if (
    roleId === ORCHESTRATOR_ROLE_ID ||
    currentTask.parentTaskId === null ||
    currentTask.responsibility.type !== "role" ||
    currentTask.responsibility.id !== roleId
  ) {
    return null;
  }

  const { currentContract, deliveries, latestByDeliverable } = deliveryState;
  const rejected = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const decision = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (decision?.status !== "rejected") continue;
    const submitted = matchingSubmission(
      deliveries,
      decision,
      "ROLE_CONTEXT_CURRENT_REJECTION_INVALID",
      `Rejected current delivery ${expectedDelivery.deliverableId} has no matching submission`,
    );
    rejected.push({ decision, expectedDelivery, submitted });
  }
  rejected.sort(
    (left, right) =>
      right.decision.revision - left.decision.revision ||
      compareText(
        left.expectedDelivery.deliverableId,
        right.expectedDelivery.deliverableId,
      ),
  );
  const selected = rejected.at(0);
  if (!selected) return null;

  const reason = truncateUtf8(
    selected.decision.summary,
    MAX_SPECIALIST_REJECTION_REASON_BYTES,
  );
  const evidence = selected.decision.evidence.slice(
    0,
    MAX_SPECIALIST_REJECTION_EVIDENCE,
  );
  return {
    dataClass: selected.expectedDelivery.dataClass,
    value: {
      contractRevision: currentContract.revision,
      deliverableId: selected.expectedDelivery.deliverableId,
      kind: selected.expectedDelivery.kind,
      submittedDeliveryRevision: selected.submitted.revision,
      decisionRevision: selected.decision.revision,
      reason,
      reasonTruncated: reason !== selected.decision.summary,
      evidence: evidence.map((entry) => ({ ...entry })),
      hasMoreEvidence: selected.decision.evidence.length > evidence.length,
    },
  };
}

function projectRootCoordination(roleId, currentTask, snapshot) {
  if (!isConfiguredRootOrchestrator(roleId, currentTask)) return null;

  const allChildren = [...snapshot.tasksById.values()]
    .filter(({ parentTaskId }) => parentTaskId === currentTask.taskId)
    .sort((left, right) => compareText(left.taskId, right.taskId));
  const supersededChildCount = allChildren.filter(
    ({ status }) => status === "superseded",
  ).length;
  const children = allChildren.filter(
    ({ status }) => status !== "superseded",
  );
  const childIds = new Set(children.map(({ taskId }) => taskId));
  const deliveryPayloads = [];
  const directChildren = children.map((child) => {
    const taskState = snapshot.statesById.get(child.taskId);
    if (!taskState || taskState.taskRevision !== child.revision) {
      throw contextError(
        "ROLE_CONTEXT_STALE",
        `Child task ${child.taskId} no longer matches its graph state`,
        409,
      );
    }
    const deliveries = projectChildDeliveries(child);
    deliveryPayloads.push(
      ...deliveries.payloads.filter(({ payload }) => payload.state === "submitted"),
    );
    const visibleDeliverables = deliveries.slots.slice(
      0,
      MAX_ROOT_DELIVERABLE_SLOTS,
    );
    return {
      taskId: child.taskId,
      taskRevision: child.revision,
      status: child.status,
      responsibility: { ...child.responsibility },
      work: {
        title: taskState.work.title,
        description: truncateUtf8(
          taskState.work.description,
          MAX_ROOT_CHILD_DESCRIPTION_BYTES,
        ),
      },
      directDependencyTaskIds: child.dependsOn.filter((taskId) =>
        childIds.has(taskId)
      ),
      hasOtherDependencies: child.dependsOn.some((taskId) =>
        !childIds.has(taskId)
      ),
      contractRevision: deliveries.contractRevision,
      deliverableCount: deliveries.slots.length,
      hasMoreDeliverables:
        deliveries.slots.length > visibleDeliverables.length,
      deliverables: visibleDeliverables,
    };
  });
  const payloadOrder = (left, right) =>
    compareText(
      `${left.taskId}\u0000${left.deliverableId}`,
      `${right.taskId}\u0000${right.deliverableId}`,
    );
  const sortedPayloads = deliveryPayloads.sort(({ payload: left }, { payload: right }) =>
    payloadOrder(left, right)
  );
  const selectedPayloads = sortedPayloads.slice(0, MAX_ROOT_DELIVERY_PAYLOADS);
  const requirements = selectedPayloads
    .filter(({ dataClass }) => dataClass === "requirements")
    .map(({ payload }) => payload);
  const code = selectedPayloads
    .filter(({ dataClass }) => dataClass === "code")
    .map(({ payload }) => payload);
  return {
    coordination: {
      schemaVersion: 2,
      rootTaskId: currentTask.taskId,
      directChildren,
      history: {
        supersededChildCount,
      },
      deliveryWindow: {
        pendingCount: sortedPayloads.length,
        shownCount: selectedPayloads.length,
        hasMore: sortedPayloads.length > selectedPayloads.length,
      },
    },
    requirements,
    code,
  };
}

function normalizeFactObservation(value, name) {
  const fields = exactData(
    value,
    ["healthy", "fresh", "value", "observedAt"],
    `fact ${name}`,
  );
  if (
    typeof fields.get("healthy") !== "boolean" ||
    typeof fields.get("fresh") !== "boolean"
  ) {
    throw invalid(`fact ${name} is invalid`);
  }
  if (
    fields.get("healthy") !== true ||
    fields.get("fresh") !== true ||
    fields.get("value") === null ||
    fields.get("value") === ""
  ) {
    return null;
  }
  const maximumBytes = name === "issue-description"
    ? 16 * 1024
    : name === "issue-latest-comment"
      ? 8 * 1024
      : 4 * 1024;
  const valueText = text(fields.get("value"), `fact ${name}.value`, maximumBytes);
  const observedAt = fields.get("observedAt");
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(Date.parse(observedAt)).toISOString() !== observedAt
  ) {
    throw invalid(`fact ${name}.observedAt is invalid`);
  }
  return { name, value: valueText, observedAt };
}

async function readFacts(factSource, event, signal) {
  signal?.throwIfAborted();
  if (!factSource) return [];
  const facts = [];
  const names = event.eventType.startsWith("issue.")
    ? [...FACT_NAMES, ...ISSUE_FACT_NAMES]
    : FACT_NAMES;
  for (const name of names) {
    signal?.throwIfAborted();
    let observation;
    try {
      observation = await factSource.read(
        {
          item: { event: structuredClone(event) },
          fact: name,
        },
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw contextError(
        "ROLE_CONTEXT_FACT_UNAVAILABLE",
        `Unable to read current fact ${name}`,
        503,
        { cause },
      );
    }
    signal?.throwIfAborted();
    const normalized = normalizeFactObservation(observation, name);
    if (normalized) facts.push(normalized);
  }
  return facts;
}

function normalizePullRequestContext(value) {
  const normalized = canonicalValue(value);
  const hasReviewMaterial = Object.hasOwn(normalized, "reviewMaterial");
  const fields = exactData(
    normalized,
    [
      "schemaVersion",
      "identityDigest",
      "contentDigest",
      "observedAt",
      "summary",
      "comments",
      "reviews",
      "reviewThreads",
      "checks",
      "contextTruncated",
      ...(hasReviewMaterial ? ["reviewMaterial"] : []),
    ],
    "pullRequest context",
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    typeof fields.get("contextTruncated") !== "boolean"
  ) {
    throw invalid("pullRequest context is invalid");
  }
  if (hasReviewMaterial) {
    const material = exactData(
      fields.get("reviewMaterial"),
      [
        "schemaVersion",
        "gitTarget",
        "additions",
        "deletions",
        "changedFiles",
        "files",
        "filesTruncated",
        "patch",
        "patchTruncated",
      ],
      "pullRequest review material",
    );
    const files = material.get("files");
    if (
      material.get("schemaVersion") !== 1 ||
      typeof material.get("patch") !== "string" ||
      /\u0000/u.test(material.get("patch")) ||
      typeof material.get("patchTruncated") !== "boolean" ||
      typeof material.get("filesTruncated") !== "boolean" ||
      !Array.isArray(files) ||
      files.length > 100 ||
      !["additions", "deletions", "changedFiles"].every((name) =>
        Number.isSafeInteger(material.get(name)) && material.get(name) >= 0)
    ) {
      throw invalid("pullRequest review material is invalid");
    }
    try {
      normalizePullRequestGitTarget(material.get("gitTarget"));
    } catch (cause) {
      throw invalid("pullRequest review material is invalid", { cause });
    }
    for (const [index, file] of files.entries()) {
      const entry = exactData(
        file,
        ["path", "additions", "deletions"],
        `pullRequest review material file ${index}`,
      );
      if (
        typeof entry.get("path") !== "string" ||
        entry.get("path").length === 0 ||
        INVALID_CONTROL.test(entry.get("path")) ||
        Buffer.byteLength(entry.get("path"), "utf8") > 2_048 ||
        !["additions", "deletions"].every((name) =>
          Number.isSafeInteger(entry.get(name)) && entry.get(name) >= 0)
      ) {
        throw invalid("pullRequest review material file is invalid");
      }
    }
  }
  digest(fields.get("identityDigest"), "pullRequest.identityDigest");
  digest(fields.get("contentDigest"), "pullRequest.contentDigest");
  const observedAt = fields.get("observedAt");
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(Date.parse(observedAt)).toISOString() !== observedAt ||
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
      MAX_PULL_REQUEST_CONTEXT_BYTES
  ) {
    throw invalid("pullRequest context is invalid");
  }
  return normalized;
}

async function readPullRequestContext(reader, item, signal) {
  signal?.throwIfAborted();
  if (!item.eventType.startsWith("pull_request.") || reader === null) {
    return null;
  }
  if (item.sourceBinding === null) {
    throw contextError(
      "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
      "Current PR task has no exact source binding",
      503,
    );
  }
  try {
    const value = await reader.read(
      {
        sourceBinding: item.sourceBinding,
        event: item.event,
      },
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    const normalized = normalizePullRequestContext(value);
    if (normalized.reviewMaterial) {
      let executionBinding;
      try {
        executionBinding = createPullRequestExecutionBinding({
          sourceBinding: item.sourceBinding,
          event: item.event,
        });
      } catch (cause) {
        throw contextError(
          "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
          "PR review material requires an atomic execution binding",
          503,
          { cause },
        );
      }
      if (
        executionBinding.schemaVersion !== 2 ||
        !samePullRequestGitTarget(
          normalizePullRequestGitTarget(normalized.reviewMaterial.gitTarget),
          executionBinding.gitTarget,
        )
      ) {
        throw contextError(
          "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
          "PR review material does not match the exact source binding",
          503,
        );
      }
    }
    return normalized;
  } catch (cause) {
    signal?.throwIfAborted();
    if (
      cause instanceof RoleContextAssemblerError &&
      cause.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE"
    ) {
      throw cause;
    }
    throw contextError(
      "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
      "Unable to read bounded PR task facts",
      503,
      { cause },
    );
  }
}

async function readMemoryQueryContext(reader, roleId, item, signal) {
  signal?.throwIfAborted();
  if (reader === null) return null;
  try {
    const result = await reader.readContext({
      roleId,
      item: {
        itemId: item.taskId,
        itemRevision: item.taskRevision,
        inputDigest: item.inputDigest,
        currentTarget: { ...item.currentTarget },
      },
    });
    signal?.throwIfAborted();
    return result === null ? null : canonicalValue(result);
  } catch (cause) {
    signal?.throwIfAborted();
    let code = null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      code = descriptor && "value" in descriptor ? descriptor.value : null;
    } catch {
      // Untrusted errors collapse to the unavailable classification below.
    }
    if (code === "AGENT_MEMORY_QUERY_CITATION_STALE") {
      throw contextError(
        "ROLE_CONTEXT_MEMORY_STALE",
        "The persisted agent memory answer no longer has current citations",
        409,
        { cause },
      );
    }
    throw contextError(
      "ROLE_CONTEXT_MEMORY_UNAVAILABLE",
      "Unable to read the persisted agent memory answer",
      503,
      { cause },
    );
  }
}

function assertPacketSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTEXT_BYTES) {
    throw contextError(
      "ROLE_CONTEXT_TOO_LARGE",
      "Role context exceeds 128 KiB",
      413,
    );
  }
}

export class RoleContextAssembler {
  #graphReader;
  #factSource;
  #pullRequestContextReader;
  #memoryQueryReader;
  #evidenceCatalogAdapter;

  constructor({
    graphReader,
    factSource,
    pullRequestContextReader,
    memoryQueryReader,
    evidenceCatalog,
  } = {}) {
    this.#graphReader = requireGraphReader(graphReader);
    this.#factSource = optionalFactSource(factSource);
    this.#pullRequestContextReader = optionalPullRequestContextReader(
      pullRequestContextReader,
    );
    this.#memoryQueryReader = optionalMemoryQueryReader(memoryQueryReader);
    this.#evidenceCatalogAdapter =
      createRoleContextEvidenceCatalogAdapter(evidenceCatalog);
    Object.freeze(this);
  }

  async assemble(value) {
    const input = ownData(value, "assemble input");
    const assembleKeys = input.has("signal")
      ? ["roleId", "item", "trigger", "signal"]
      : ["roleId", "item", "trigger"];
    if (
      input.size !== assembleKeys.length ||
      assembleKeys.some((key) => !input.has(key))
    ) {
      throw invalid("assemble input is invalid");
    }
    const roleId = text(input.get("roleId"), "roleId", 128);
    if (!SAFE_ROLE_ID.test(roleId)) throw invalid("roleId is invalid");
    const trigger = text(input.get("trigger"), "trigger", 128);
    const item = normalizeItem(input.get("item"));
    const signal = input.get("signal");
    if (
      signal !== undefined &&
      (
        signal === null ||
        typeof signal !== "object" ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function" ||
        typeof signal.throwIfAborted !== "function"
      )
    ) {
      throw invalid("signal is invalid");
    }
    signal?.throwIfAborted();

    let snapshotValue;
    try {
      snapshotValue = await this.#graphReader.getSnapshot(
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw contextError(
        "ROLE_CONTEXT_GRAPH_UNAVAILABLE",
        "Unable to read the work graph",
        503,
        { cause },
      );
    }
    signal?.throwIfAborted();
    const snapshot = normalizeSnapshot(snapshotValue);
    signal?.throwIfAborted();
    const currentTask = snapshot.tasksById.get(item.taskId);
    const taskState = snapshot.statesById.get(item.taskId);
    if (!currentTask || !taskState) {
      throw contextError(
        "ROLE_CONTEXT_STALE",
        "The claimed task no longer exists in the graph",
        409,
      );
    }
    assertCurrentBinding({ roleId, item, task: currentTask, taskState });

    const deliveryState = currentDeliveryState(currentTask);
    const { currentContract } = deliveryState;
    const currentAcceptanceContract = publicContract(currentContract);
    const dependencies = projectDependencies(currentTask, snapshot);
    const coordination = projectRootCoordination(roleId, currentTask, snapshot);
    const currentTaskRejection = projectCurrentTaskRejection(
      roleId,
      currentTask,
      deliveryState,
    );
    const [facts, authoritativeEvidence, pullRequest, memoryQuery] = await Promise.all([
      readFacts(this.#factSource, item.event, signal),
      this.#evidenceCatalogAdapter.read({
        roleId,
        taskId: currentTask.taskId,
        acceptanceContract: currentAcceptanceContract,
        signal,
      }),
      readPullRequestContext(this.#pullRequestContextReader, item, signal),
      readMemoryQueryContext(this.#memoryQueryReader, roleId, item, signal),
    ]);
    signal?.throwIfAborted();
    const isPullRequest = item.eventType.startsWith("pull_request.");

    const binding = {
      roleId,
      taskId: currentTask.taskId,
      taskRevision: currentTask.revision,
      inputDigest: item.inputDigest,
      graphId: snapshot.graphId,
      graphRevision: snapshot.graphRevision,
      graphContentDigest: snapshot.graphContentDigest,
      contractRevision: currentContract.revision,
      ...(item.sourceBinding === null
        ? {}
        : { source: item.sourceBinding }),
    };
    const proposalDecisionContext =
      item.decisionContext?.source === "proposal"
        ? item.decisionContext
        : null;
    const requirementsDecisionContext = proposalDecisionContext
      ? null
      : item.decisionContext;
    const requirements = {
      schemaVersion: 1,
      trigger,
      roleId,
      graph: {
        graphId: snapshot.graphId,
        revision: snapshot.graphRevision,
        contentDigest: snapshot.graphContentDigest,
      },
      currentTask: {
        taskId: currentTask.taskId,
        revision: currentTask.revision,
        parentTaskId: currentTask.parentTaskId,
        responsibility: { ...currentTask.responsibility },
        work: { ...taskState.work },
        acceptanceContract: currentAcceptanceContract,
      },
      source: {
        assignmentId: item.assignmentId,
        eventId: item.eventId,
        eventType: item.eventType,
        ...(item.sourceBinding === null ? {} : item.sourceBinding),
      },
      ...(requirementsDecisionContext === null
        ? {}
        : { decisionContext: requirementsDecisionContext }),
      acceptedDependencies: dependencies.requirements,
      facts: isPullRequest ? [] : facts,
      ...(currentTaskRejection?.dataClass === "requirements"
        ? { currentTaskRejection: currentTaskRejection.value }
        : {}),
      ...(coordination
        ? {
            coordination: coordination.coordination,
            childDeliveries: coordination.requirements,
          }
        : {}),
    };
    const context = { requirements };
    if (
      isPullRequest ||
      dependencies.code.length > 0 ||
      coordination?.code.length > 0 ||
      currentTaskRejection?.dataClass === "code" ||
      proposalDecisionContext !== null ||
      authoritativeEvidence.length > 0
    ) {
      context.code = {
        ...(isPullRequest ? { sourceEvent: item.event } : {}),
        ...(pullRequest === null ? {} : { pullRequest }),
        acceptedDependencies: dependencies.code,
        facts: isPullRequest ? facts : [],
        ...(proposalDecisionContext === null
          ? {}
          : { decisionContext: proposalDecisionContext }),
        ...(currentTaskRejection?.dataClass === "code"
          ? { currentTaskRejection: currentTaskRejection.value }
          : {}),
        ...(coordination?.code.length > 0
          ? { childDeliveries: coordination.code }
          : {}),
        ...(authoritativeEvidence.length > 0
          ? { authoritativeEvidence }
          : {}),
      };
    }
    if (memoryQuery !== null) {
      context.memory = { agentQuery: memoryQuery };
    }
    assertPacketSize(context);

    const contextDigest = sha256({
      domain: "mydashboard-role-context/v1",
      binding,
      dataClasses: Object.keys(context).sort(compareText),
      context,
    });
    const packet = {
      schemaVersion: 1,
      binding,
      context,
      acceptedInputs: dependencies.acceptedInputs,
      contextDigest,
    };
    assertPacketSize(packet);
    signal?.throwIfAborted();
    return deepFreeze(packet);
  }
}
