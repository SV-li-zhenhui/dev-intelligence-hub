import { escapeHtml as escapeGraphHtml, relativeTime } from "./view-format.js";

const MAX_TOTAL_GRAPH_TASKS = 5_000;
const MAX_GRAPH_TASKS = 300;
const MAX_GRAPH_DEPTH = 32;
const MAX_GRAPH_FAN_OUT = 64;
const MAX_DEPENDENCIES_PER_TASK = 64;
const MAX_CONTRACTS_PER_TASK = 32;
const MAX_CRITERIA_PER_CONTRACT = 64;
const MAX_DELIVERABLES_PER_CONTRACT = 64;
const MAX_DELIVERIES_PER_TASK = 256;
const MAX_EVIDENCE_PER_DELIVERY = 32;
const MAX_RENDERED_CRITERIA = 12;
const MAX_RENDERED_DELIVERABLES = 16;
const MAX_RENDERED_EVIDENCE = 4;

const LEDGER_STATUS_LABELS = Object.freeze({
  queued: "待领取",
  paused: "已暂停",
  working: "执行中",
  dispatch_pending: "等待派发",
  waiting_user: "等待你答复",
  waiting_condition: "等待条件",
  waiting_external: "等待外部授权",
  retry_wait: "等待重试",
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
});

const DELIVERY_STATUS_LABELS = Object.freeze({
  submitted: "待审核",
  accepted: "已接受",
  rejected: "已退回",
});

function graphReadError() {
  return new Error("工作图数据格式无效");
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableText(value) {
  return value === null || typeof value === "string";
}

function validRevision(value, { allowZero = false } = {}) {
  return (
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1)
  );
}

function exactObject(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw graphReadError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw graphReadError();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw graphReadError();
    }
  }
  return value;
}

function boundedList(value, maximum, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw graphReadError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw graphReadError();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw graphReadError();
    }
    result.push(descriptor.value);
  }
  return result;
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function normalizedCriterion(value) {
  exactObject(value, ["criterionId", "description"]);
  if (
    !nonEmptyText(value.criterionId) ||
    !nonEmptyText(value.description)
  ) {
    throw graphReadError();
  }
  return {
    criterionId: value.criterionId,
    description: value.description,
  };
}

function normalizedExpectedDeliverable(value) {
  exactObject(value, ["deliverableId", "kind", "description", "required"]);
  if (
    !nonEmptyText(value.deliverableId) ||
    !nonEmptyText(value.kind) ||
    !nonEmptyText(value.description) ||
    typeof value.required !== "boolean"
  ) {
    throw graphReadError();
  }
  return {
    deliverableId: value.deliverableId,
    kind: value.kind,
    description: value.description,
    required: value.required,
  };
}

function normalizedContract(value) {
  exactObject(value, [
    "revision",
    "acceptanceCriteria",
    "expectedDeliverables",
  ]);
  if (!validRevision(value.revision)) {
    throw graphReadError();
  }
  const acceptanceCriteria = boundedList(
    value.acceptanceCriteria,
    MAX_CRITERIA_PER_CONTRACT,
  ).map(normalizedCriterion);
  const expectedDeliverables = boundedList(
    value.expectedDeliverables,
    MAX_DELIVERABLES_PER_CONTRACT,
  ).map(normalizedExpectedDeliverable);
  if (
    !hasUniqueValues(acceptanceCriteria.map(({ criterionId }) => criterionId)) ||
    !hasUniqueValues(
      expectedDeliverables.map(({ deliverableId }) => deliverableId),
    )
  ) {
    throw graphReadError();
  }
  return {
    revision: value.revision,
    acceptanceCriteria,
    expectedDeliverables,
  };
}

function normalizedEvidence(value) {
  exactObject(value, ["kind", "referenceId", "contentDigest"]);
  if (
    !nonEmptyText(value.kind) ||
    !nonEmptyText(value.referenceId) ||
    typeof value.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest)
  ) {
    throw graphReadError();
  }
  return {
    kind: value.kind,
    referenceId: value.referenceId,
    contentDigest: value.contentDigest,
  };
}

function normalizedDelivery(value, contract) {
  exactObject(value, [
    "deliverableId",
    "revision",
    "contractRevision",
    "status",
    "summary",
    "evidence",
  ]);
  if (
    !validRevision(value.revision) ||
    !validRevision(value.contractRevision) ||
    !nonEmptyText(value.deliverableId) ||
    !Object.hasOwn(DELIVERY_STATUS_LABELS, value.status) ||
    !nonEmptyText(value.summary)
  ) {
    throw graphReadError();
  }
  if (
    value.contractRevision !== contract.revision ||
    !contract.expectedDeliverables.some(
      ({ deliverableId }) => deliverableId === value.deliverableId,
    )
  ) {
    throw graphReadError();
  }
  return {
    deliverableId: value.deliverableId,
    revision: value.revision,
    contractRevision: value.contractRevision,
    status: value.status,
    summary: value.summary,
    evidence: boundedList(
      value.evidence,
      MAX_EVIDENCE_PER_DELIVERY,
      { minimum: 1 },
    ).map(normalizedEvidence),
  };
}

function normalizedTask(task) {
  exactObject(task, [
    "taskId",
    "revision",
    "parentTaskId",
    "responsibility",
    "acceptanceContract",
    "latestDeliveries",
    "history",
    "dependsOn",
  ]);
  exactObject(task.responsibility, ["type", "id"]);
  if (
    !nonEmptyText(task.taskId) ||
    !validRevision(task.revision) ||
    !(task.parentTaskId === null || nonEmptyText(task.parentTaskId)) ||
    !["role", "person", "node"].includes(task.responsibility.type) ||
    !nonEmptyText(task.responsibility.id) ||
    !Array.isArray(task.dependsOn)
  ) {
    throw graphReadError();
  }
  const acceptanceContract = normalizedContract(task.acceptanceContract);
  exactObject(task.history, ["acceptanceContractCount", "deliveryCount"]);
  if (
    !validRevision(task.history.acceptanceContractCount) ||
    task.history.acceptanceContractCount > MAX_CONTRACTS_PER_TASK ||
    task.history.acceptanceContractCount !== acceptanceContract.revision ||
    !validRevision(task.history.deliveryCount, { allowZero: true }) ||
    task.history.deliveryCount > MAX_DELIVERIES_PER_TASK
  ) {
    throw graphReadError();
  }
  const latestDeliveries = boundedList(
    task.latestDeliveries,
    MAX_DELIVERABLES_PER_CONTRACT,
  ).map((delivery) => normalizedDelivery(delivery, acceptanceContract));
  if (
    task.revision < acceptanceContract.revision ||
    task.revision < Math.max(0, ...latestDeliveries.map(({ revision }) => revision)) ||
    latestDeliveries.some(({ revision }) => revision > task.history.deliveryCount) ||
    !hasUniqueValues(
      latestDeliveries.map(({ deliverableId }) => deliverableId),
    )
  ) {
    throw graphReadError();
  }
  const dependsOn = boundedList(
    task.dependsOn,
    MAX_DEPENDENCIES_PER_TASK,
  );
  if (
    dependsOn.some((taskId) => !nonEmptyText(taskId)) ||
    !hasUniqueValues(dependsOn)
  ) {
    throw graphReadError();
  }
  return {
    taskId: task.taskId,
    revision: task.revision,
    parentTaskId: task.parentTaskId,
    responsibility: {
      type: task.responsibility.type,
      id: task.responsibility.id,
    },
    acceptanceContract,
    latestDeliveries,
    history: {
      acceptanceContractCount: task.history.acceptanceContractCount,
      deliveryCount: task.history.deliveryCount,
    },
    dependsOn,
  };
}

function normalizedTaskState(taskState) {
  exactObject(taskState, [
    "taskId",
    "taskRevision",
    "ledgerStatus",
    "ownerId",
    "statusReason",
    "updatedAt",
    "work",
  ]);
  const work = taskState?.work;
  exactObject(work, ["title", "description"]);
  if (
    !nonEmptyText(taskState.taskId) ||
    !validRevision(taskState.taskRevision) ||
    !nonEmptyText(taskState.ledgerStatus) ||
    !nullableText(taskState.ownerId) ||
    !nullableText(taskState.statusReason) ||
    !nullableText(taskState.updatedAt) ||
    !nullableText(work.title) ||
    !nullableText(work.description)
  ) {
    throw graphReadError();
  }
  return {
    taskId: taskState.taskId,
    taskRevision: taskState.taskRevision,
    ledgerStatus: taskState.ledgerStatus,
    ownerId: taskState.ownerId,
    statusReason: taskState.statusReason,
    updatedAt: taskState.updatedAt,
    work: {
      title: work.title,
      description: work.description,
    },
  };
}

function assertTree(taskById) {
  const childrenByParent = new Map();
  for (const task of taskById.values()) {
    if (task.parentTaskId !== null && !taskById.has(task.parentTaskId)) {
      throw graphReadError();
    }
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.taskId || !taskById.has(dependencyId)) {
        throw graphReadError();
      }
    }
    const siblings = childrenByParent.get(task.parentTaskId) || [];
    siblings.push(task.taskId);
    childrenByParent.set(task.parentTaskId, siblings);
    if (
      task.parentTaskId !== null &&
      siblings.length > MAX_GRAPH_FAN_OUT
    ) {
      throw graphReadError();
    }
  }

  const hierarchyVisiting = new Set();
  const hierarchyDepth = new Map();
  function depthOf(taskId) {
    if (hierarchyDepth.has(taskId)) return hierarchyDepth.get(taskId);
    if (hierarchyVisiting.has(taskId)) throw graphReadError();
    hierarchyVisiting.add(taskId);
    const parentTaskId = taskById.get(taskId).parentTaskId;
    const depth = parentTaskId === null ? 0 : depthOf(parentTaskId) + 1;
    hierarchyVisiting.delete(taskId);
    if (depth > MAX_GRAPH_DEPTH) throw graphReadError();
    hierarchyDepth.set(taskId, depth);
    return depth;
  }
  for (const taskId of taskById.keys()) depthOf(taskId);

  const prerequisiteVisiting = new Set();
  const prerequisiteVisited = new Set();
  function visitPrerequisites(taskId) {
    if (prerequisiteVisiting.has(taskId)) throw graphReadError();
    if (prerequisiteVisited.has(taskId)) return;
    prerequisiteVisiting.add(taskId);
    const task = taskById.get(taskId);
    const prerequisites = [
      ...task.dependsOn,
      ...(childrenByParent.get(taskId) || []),
    ];
    for (const prerequisiteId of prerequisites) {
      visitPrerequisites(prerequisiteId);
    }
    prerequisiteVisiting.delete(taskId);
    prerequisiteVisited.add(taskId);
  }
  for (const taskId of taskById.keys()) visitPrerequisites(taskId);
}

export function normalizeWorkGraphSnapshot(value) {
  exactObject(value, [
    "schemaVersion",
    "totalTaskCount",
    "graph",
    "taskStates",
  ]);
  const graph = value.graph;
  exactObject(graph, ["schemaVersion", "graphId", "revision", "tasks"]);
  if (
    value.schemaVersion !== 2 ||
    !validRevision(value.totalTaskCount, { allowZero: true }) ||
    value.totalTaskCount > MAX_TOTAL_GRAPH_TASKS ||
    graph.schemaVersion !== 1 ||
    !nonEmptyText(graph.graphId) ||
    !validRevision(graph.revision, { allowZero: true }) ||
    !Array.isArray(graph.tasks) ||
    !Array.isArray(value.taskStates)
  ) {
    throw graphReadError();
  }

  const tasks = boundedList(graph.tasks, MAX_GRAPH_TASKS).map(normalizedTask);
  const taskStates = boundedList(value.taskStates, MAX_GRAPH_TASKS)
    .map(normalizedTaskState);
  if (
    taskStates.length !== tasks.length ||
    value.totalTaskCount < tasks.length
  ) {
    throw graphReadError();
  }
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const stateById = new Map(taskStates.map((state) => [state.taskId, state]));
  if (
    taskById.size !== tasks.length ||
    stateById.size !== taskStates.length ||
    tasks.some(
      (task) => stateById.get(task.taskId)?.taskRevision !== task.revision,
    )
  ) {
    throw graphReadError();
  }
  assertTree(taskById);
  return {
    schemaVersion: 2,
    totalTaskCount: value.totalTaskCount,
    graph: {
      schemaVersion: 1,
      graphId: graph.graphId,
      revision: graph.revision,
      tasks,
    },
    taskStates,
  };
}

function responsibilityLabel(responsibility) {
  const type = {
    role: "岗位",
    person: "人员",
    node: "节点",
  }[responsibility.type];
  return `${type} · ${responsibility.id}`;
}

function statusPresentation(ledgerStatus, statusReason = null) {
  if (
    ledgerStatus === "waiting_external" &&
    statusReason === "delivery_submitted"
  ) {
    return {
      className: ledgerStatus,
      label: "等待交付审核",
    };
  }
  if (Object.hasOwn(LEDGER_STATUS_LABELS, ledgerStatus)) {
    return {
      className: ledgerStatus,
      label: LEDGER_STATUS_LABELS[ledgerStatus],
    };
  }
  return {
    className: "unknown",
    label: `未知状态 · ${ledgerStatus}`,
  };
}

function taskTitle(task, state) {
  return state.work.title || task.taskId;
}

function taskReference(taskId, taskById, stateById) {
  const task = taskById.get(taskId);
  const state = stateById.get(taskId);
  return {
    id: taskId,
    title: taskTitle(task, state),
    status: statusPresentation(state.ledgerStatus, state.statusReason),
  };
}

function dependencyMarkup(task, taskById, stateById) {
  if (task.dependsOn.length === 0) {
    return '<div class="work-graph-dependencies"><span>前置依赖</span><em>无</em></div>';
  }
  return `<div class="work-graph-dependencies">
    <span>前置依赖</span>
    <div>${task.dependsOn.map((taskId) => {
      const dependency = taskReference(taskId, taskById, stateById);
      return `<span class="work-graph-dependency">
        <strong>${escapeGraphHtml(dependency.title)}</strong>
        <code>${escapeGraphHtml(dependency.id)}</code>
        <small>${escapeGraphHtml(dependency.status.label)}</small>
      </span>`;
    }).join("")}</div>
  </div>`;
}

function evidenceMarkup(evidence) {
  const visibleEvidence = evidence.slice(0, MAX_RENDERED_EVIDENCE);
  const hiddenCount = evidence.length - visibleEvidence.length;
  return `<ul class="work-graph-evidence">${visibleEvidence.map((entry) => `
    <li>
      <code>${escapeGraphHtml(entry.kind)} · ${escapeGraphHtml(entry.referenceId)}</code>
      <small>SHA256 ${escapeGraphHtml(entry.contentDigest.slice(0, 12))}…</small>
    </li>`).join("")}${hiddenCount > 0
      ? `<li class="work-graph-overflow-note">另有 ${hiddenCount} 条证据未展开</li>`
      : ""}
  </ul>`;
}

function deliverableMarkup(expected, latestDelivery) {
  const status = latestDelivery
    ? DELIVERY_STATUS_LABELS[latestDelivery.status]
    : "未提交";
  const className = latestDelivery?.status || "missing";
  return `<li class="work-graph-deliverable">
    <div>
      <strong>${escapeGraphHtml(expected.description)}</strong>
      <span>${escapeGraphHtml(expected.kind)} · ${expected.required ? "必需" : "可选"}</span>
    </div>
    <span class="work-graph-delivery-status delivery-${className}">${status}</span>
    ${latestDelivery ? `
      <p>最新交付 R${latestDelivery.revision} · ${escapeGraphHtml(latestDelivery.summary)}</p>
      ${evidenceMarkup(latestDelivery.evidence)}` : ""}
  </li>`;
}

function acceptanceMarkup(task) {
  const contract = task.acceptanceContract;
  const latestByDeliverable = new Map();
  for (const delivery of task.latestDeliveries) {
    latestByDeliverable.set(delivery.deliverableId, delivery);
  }
  const visibleCriteria = contract.acceptanceCriteria.slice(
    0,
    MAX_RENDERED_CRITERIA,
  );
  const hiddenCriteriaCount = contract.acceptanceCriteria.length -
    visibleCriteria.length;
  const criteria = contract.acceptanceCriteria.length > 0
    ? `<ul class="work-graph-criteria">${visibleCriteria.map(
      (criterion) => `<li><code>${escapeGraphHtml(criterion.criterionId)}</code><span>${escapeGraphHtml(criterion.description)}</span></li>`,
    ).join("")}${hiddenCriteriaCount > 0
      ? `<li class="work-graph-overflow-note">另有 ${hiddenCriteriaCount} 条验收标准未展开</li>`
      : ""}</ul>`
    : '<p class="work-graph-contract-empty">未定义单独验收标准</p>';
  const visibleDeliverables = contract.expectedDeliverables.slice(
    0,
    MAX_RENDERED_DELIVERABLES,
  );
  const hiddenDeliverableCount = contract.expectedDeliverables.length -
    visibleDeliverables.length;
  const deliverables = contract.expectedDeliverables.length > 0
    ? `<ul class="work-graph-deliverables">${visibleDeliverables.map(
      (expected) => deliverableMarkup(
        expected,
        latestByDeliverable.get(expected.deliverableId),
      ),
    ).join("")}${hiddenDeliverableCount > 0
      ? `<li class="work-graph-overflow-note">另有 ${hiddenDeliverableCount} 项交付物未展开</li>`
      : ""}</ul>`
    : '<p class="work-graph-contract-empty">无指定交付物</p>';
  return `<section class="work-graph-acceptance" aria-label="当前验收契约">
    <div class="work-graph-contract-heading">
      <strong>验收契约 R${contract.revision}</strong>
      <span>${contract.acceptanceCriteria.length} 条标准 · ${contract.expectedDeliverables.length} 项交付 · 历史 ${task.history.acceptanceContractCount} 版 / ${task.history.deliveryCount} 次交付记录</span>
    </div>
    ${criteria}
    ${deliverables}
  </section>`;
}

function taskMarkup(task, childrenByParent, taskById, stateById, now) {
  const state = stateById.get(task.taskId);
  const status = statusPresentation(state.ledgerStatus, state.statusReason);
  const parent = task.parentTaskId === null
    ? null
    : taskReference(task.parentTaskId, taskById, stateById);
  const children = childrenByParent.get(task.taskId) || [];
  return `<li class="work-graph-node">
    <article class="work-graph-card">
      <div class="work-graph-card-heading">
        <div>
          <span>${parent ? `子任务 · 父任务 ${escapeGraphHtml(parent.title)}` : "根任务"}</span>
          <strong>${escapeGraphHtml(taskTitle(task, state))}</strong>
        </div>
        <span class="status-pill status-${status.className}">${escapeGraphHtml(status.label)}</span>
      </div>
      ${state.work.description ? `<p>${escapeGraphHtml(state.work.description)}</p>` : ""}
      <div class="work-graph-meta">
        <span><b>责任</b>${escapeGraphHtml(responsibilityLabel(task.responsibility))}</span>
        ${state.ownerId ? `<span><b>当前执行</b>${escapeGraphHtml(state.ownerId)}</span>` : ""}
        <span><b>任务 ID</b><code>${escapeGraphHtml(task.taskId)}</code></span>
        <span><b>更新</b>${relativeTime(state.updatedAt, now)}</span>
      </div>
      ${state.statusReason ? `<small class="work-graph-reason">${escapeGraphHtml(state.statusReason)}</small>` : ""}
      ${dependencyMarkup(task, taskById, stateById)}
      ${acceptanceMarkup(task)}
    </article>
    ${children.length > 0 ? `<ol class="work-graph-children">${children.map((child) => taskMarkup(child, childrenByParent, taskById, stateById, now)).join("")}</ol>` : ""}
  </li>`;
}

function graphTreeMarkup(snapshot, now) {
  const taskById = new Map(
    snapshot.graph.tasks.map((task) => [task.taskId, task]),
  );
  const stateById = new Map(
    snapshot.taskStates.map((state) => [state.taskId, state]),
  );
  const visibleTasks = snapshot.graph.tasks;
  const childrenByParent = new Map();
  for (const task of visibleTasks) {
    if (task.parentTaskId === null) continue;
    const children = childrenByParent.get(task.parentTaskId) || [];
    children.push(task);
    childrenByParent.set(task.parentTaskId, children);
  }
  const roots = visibleTasks.filter(
    ({ parentTaskId }) => parentTaskId === null,
  );
  const windowNotice = visibleTasks.length < snapshot.totalTaskCount
    ? `<p class="work-graph-window-note">显示按最新更新选出的任务及其必需上下文 ${visibleTasks.length} / ${snapshot.totalTaskCount} 项</p>`
    : "";
  return `${windowNotice}<ol class="work-graph-tree">${roots.map((task) => taskMarkup(task, childrenByParent, taskById, stateById, now)).join("")}</ol>`;
}

export function renderWorkGraph(state = {}, { now = Date.now() } = {}) {
  const snapshot = state.snapshot || null;
  const taskCount = snapshot?.totalTaskCount || 0;
  const revision = snapshot?.graph.revision;
  const headingStatus = snapshot
    ? `${taskCount} TASKS · REVISION ${revision} · READ ONLY`
    : "READ ONLY";
  let body = "";
  if (!snapshot && state.loading) {
    body = '<div class="empty">正在读取共享任务图…</div>';
  } else if (!snapshot && state.error) {
    body = `<div class="empty">共享任务图暂不可读取：${escapeGraphHtml(state.error)}。工作台账的其他内容不受影响。</div>`;
  } else if (!snapshot || taskCount === 0) {
    body = '<div class="empty">尚无共享任务；员工拆分工作后会在这里形成任务树。</div>';
  } else {
    let warning = "";
    if (state.error) {
      warning = `<p class="work-graph-warning" role="status">刷新共享任务图失败：${escapeGraphHtml(state.error)}。以下为上次成功读取的 revision ${escapeGraphHtml(revision)}。</p>`;
    } else if (state.loading) {
      warning = '<p class="work-graph-refreshing" role="status">正在刷新任务图，当前继续显示上次完整快照。</p>';
    }
    body = `${warning}${graphTreeMarkup(snapshot, now)}`;
  }
  return `<section class="section work-panel work-graph-panel" aria-labelledby="work-graph-title">
    <div class="section-heading">
      <h2 id="work-graph-title">共享任务图</h2>
      <span>${headingStatus}</span>
    </div>
    <p class="work-graph-read-note">只读呈现父子任务、前置依赖、责任归属、验收标准与交付证据；执行状态以工作台账为准。</p>
    ${body}
  </section>`;
}
