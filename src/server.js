import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication } from "./composition-root.js";
import {
  normalizeUnifiedDeferredOptions,
} from "./domain/attention-deferred-contract.js";
import { projectRoot } from "./lib/config.js";
import { EmployeeRegistry } from "./services/employee-registry.js";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
const browserSecurityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const internalServerErrorMessage = "服务器内部错误";

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function assertTrustedHost(request, expectedOrigin) {
  const expectedHost = new URL(expectedOrigin).host.toLowerCase();
  const requestHost = request.headers.host?.toLowerCase();
  if (requestHost !== expectedHost) {
    throw httpError(421, "请求 Host 不属于本地指挥中枢");
  }
}

function assertTrustedMutation(request, expectedOrigin, { json = false } = {}) {
  if (
    request.headers.origin !== expectedOrigin ||
    request.headers["x-mydashboard-action"] !== "1"
  ) {
    throw httpError(403, "拒绝非同源操作请求");
  }
  if (
    json &&
    request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) {
    throw httpError(415, "请求体必须使用 application/json");
  }
}

async function readJsonBody(request, maxBytes = 8 * 1024) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw httpError(413, `请求体不能超过 ${maxBytes} 字节`);
  }

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) {
      request.resume();
      throw httpError(413, `请求体不能超过 ${maxBytes} 字节`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    throw httpError(400, "请求体不能为空");
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求体不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  return value;
}

function serveStatic(response, requestPath) {
  const publicDirectory = path.join(projectRoot, "public");
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const target = path.resolve(publicDirectory, relativePath);
  const relativeTarget = path.relative(publicDirectory, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    response.writeHead(403);
    response.end();
    return;
  }
  const stream = createReadStream(target);
  stream.once("open", () => {
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-cache",
      ...browserSecurityHeaders,
    });
    stream.pipe(response);
  });
  stream.once("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const notFound = ["ENOENT", "EISDIR"].includes(error.code);
    response.writeHead(notFound ? 404 : 500);
    response.end(notFound ? "Not found" : "Server error");
  });
}

async function readDashboard(application, employeeRegistry, fallback = null) {
  const dashboard = fallback || (await application.store.read("dashboard"));
  if (!dashboard) return null;
  const prEmployee = employeeRegistry.get("pr-reviewer")
    ? await employeeRegistry.view("pr-reviewer")
    : null;
  return {
    ...dashboard,
    ...(prEmployee ? { employee: prEmployee } : {}),
  };
}

function resolveEmployeeRegistry(application) {
  if (application.employeeRegistry) return application.employeeRegistry;
  return new EmployeeRegistry(
    application.prEmployee ? [application.prEmployee] : [],
  );
}

function requirePrEmployee(employeeRegistry) {
  const employee = employeeRegistry.get("pr-reviewer");
  if (
    !employee ||
    typeof employee.decide !== "function" ||
    typeof employee.searchMemory !== "function"
  ) {
    throw httpError(503, "PR 推进员工未配置");
  }
  return employee;
}

function requireConfirmationQueue(application) {
  const queue = application.confirmationQueue;
  if (
    !queue ||
    !["next", "approve", "retry", "reject"].every(
      (method) => typeof queue[method] === "function",
    )
  ) {
    throw httpError(503, "外部动作确认队列未启用");
  }
  return queue;
}

function requireWorkflowRouting(application) {
  const routing = application.workflowRouting;
  if (
    !routing ||
    ![
      "getConfig",
      "dryRun",
      "listAssignments",
      "listAudit",
    ].every((method) => typeof routing[method] === "function")
  ) {
    throw httpError(503, "工作流路由尚未配置");
  }
  return routing;
}

function requireWorkLedgerView(application) {
  const view = application.workLedgerView;
  if (
    !view ||
    !["getSummary", "listItems", "listTimeline"].every(
      (method) => typeof view[method] === "function",
    )
  ) {
    throw httpError(503, "员工工作台账尚未启用");
  }
  return view;
}

function requireWorkGraphView(application) {
  const view = application.workGraphView;
  if (!view || typeof view.getSnapshot !== "function") {
    throw httpError(503, "员工工作图尚未启用");
  }
  return view;
}

function projectGraphContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      description: criterion.description,
    })),
    expectedDeliverables: contract.expectedDeliverables.map((deliverable) => ({
      deliverableId: deliverable.deliverableId,
      kind: deliverable.kind,
      description: deliverable.description,
      required: deliverable.required,
    })),
  };
}

function projectGraphDelivery(delivery) {
  return {
    deliverableId: delivery.deliverableId,
    revision: delivery.revision,
    contractRevision: delivery.contractRevision,
    status: delivery.status,
    summary: delivery.summary,
    evidence: delivery.evidence.map((entry) => ({
      kind: entry.kind,
      referenceId: entry.referenceId,
      contentDigest: entry.contentDigest,
    })),
  };
}

const MAX_WORK_GRAPH_HTTP_TASKS = 300;

function compareGraphTaskRecency(left, right, stateById) {
  const leftTime = Date.parse(stateById.get(left.taskId)?.updatedAt || "");
  const rightTime = Date.parse(stateById.get(right.taskId)?.updatedAt || "");
  const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const safeRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  return safeRight - safeLeft || left.taskId.localeCompare(right.taskId, "en");
}

function graphTaskClosure(taskId, taskById, selected) {
  const pending = new Set();
  const stack = [taskId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (selected.has(currentId) || pending.has(currentId)) continue;
    const task = taskById.get(currentId);
    if (!task) continue;
    pending.add(currentId);
    if (task.parentTaskId !== null) stack.push(task.parentTaskId);
    stack.push(...task.dependsOn);
  }
  return pending;
}

function selectWorkGraphHttpWindow(snapshot) {
  const taskById = new Map(
    snapshot.graph.tasks.map((task) => [task.taskId, task]),
  );
  const stateById = new Map(
    snapshot.taskStates.map((state) => [state.taskId, state]),
  );
  const selected = new Set();
  const candidates = [...snapshot.graph.tasks].sort((left, right) =>
    compareGraphTaskRecency(left, right, stateById)
  );
  for (const candidate of candidates) {
    const closure = graphTaskClosure(candidate.taskId, taskById, selected);
    if (selected.size + closure.size > MAX_WORK_GRAPH_HTTP_TASKS) continue;
    for (const taskId of closure) selected.add(taskId);
    if (selected.size === MAX_WORK_GRAPH_HTTP_TASKS) break;
  }
  return {
    totalTaskCount: snapshot.graph.tasks.length,
    tasks: snapshot.graph.tasks.filter(({ taskId }) => selected.has(taskId)),
    taskStates: snapshot.taskStates.filter(({ taskId }) => selected.has(taskId)),
  };
}

function projectCurrentGraphTask(task) {
  const acceptanceContract = task.acceptanceContracts.at(-1);
  const latestByDeliverable = new Map();
  for (const delivery of task.deliveries) {
    if (delivery.contractRevision === acceptanceContract.revision) {
      latestByDeliverable.set(delivery.deliverableId, delivery);
    }
  }
  return {
    taskId: task.taskId,
    revision: task.revision,
    parentTaskId: task.parentTaskId,
    responsibility: {
      type: task.responsibility.type,
      id: task.responsibility.id,
    },
    acceptanceContract: projectGraphContract(acceptanceContract),
    latestDeliveries: acceptanceContract.expectedDeliverables
      .map(({ deliverableId }) => latestByDeliverable.get(deliverableId))
      .filter(Boolean)
      .map(projectGraphDelivery),
    history: {
      acceptanceContractCount: task.acceptanceContracts.length,
      deliveryCount: task.deliveries.length,
    },
    dependsOn: [...task.dependsOn],
  };
}

function projectWorkGraphHttpSnapshot(snapshot) {
  const window = selectWorkGraphHttpWindow(snapshot);
  return {
    schemaVersion: 2,
    totalTaskCount: window.totalTaskCount,
    graph: {
      schemaVersion: snapshot.graph.schemaVersion,
      graphId: snapshot.graph.graphId,
      revision: snapshot.graph.revision,
      tasks: window.tasks.map(projectCurrentGraphTask),
    },
    taskStates: window.taskStates.map((state) => ({
      taskId: state.taskId,
      taskRevision: state.taskRevision,
      ledgerStatus: state.ledgerStatus,
      ownerId: state.ownerId,
      statusReason: state.statusReason,
      updatedAt: state.updatedAt,
      work: {
        title: state.work.title,
        description: state.work.description,
      },
    })),
  };
}

function requireAttentionBrowser(application) {
  const browser = application.attentionBrowser;
  if (
    !browser ||
    !["answer", "reject", "later"].every(
      (method) => typeof browser[method] === "function",
    )
  ) {
    throw httpError(503, "内部请示队列尚未启用");
  }
  return browser;
}

function requireMemorySearch(application) {
  const search = application.memorySearch;
  if (
    !search ||
    !["search", "getHealth"].every(
      (method) => typeof search[method] === "function",
    )
  ) {
    throw httpError(503, "统一记忆尚未启用");
  }
  return search;
}

function memoryQueryOptions(url) {
  const allowed = new Set([
    "q",
    "roleId",
    "repository",
    "eventType",
    "from",
    "to",
    "limit",
    "cursor",
  ]);
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw httpError(400, "记忆查询参数无效");
  }
  return Object.fromEntries(
    [...allowed]
      .filter((key) => url.searchParams.has(key))
      .map((key) => [key, url.searchParams.get(key)]),
  );
}

function unifiedAttentionOptions(url) {
  if ([...url.searchParams.keys()].some((key) => key !== "deferred")) {
    throw httpError(400, "统一确认队列查询参数无效");
  }
  const values = url.searchParams.getAll("deferred");
  if (!values.length) return undefined;
  const deferred = { external: [], internal: [] };
  for (const value of values) {
    const parts = value.split(":");
    if (parts.length !== 3) {
      throw httpError(400, "稍后处理绑定格式无效");
    }
    const [source, id, digest] = parts;
    if (source === "external") {
      deferred.external.push({ id, approvalBindingDigest: digest });
    } else if (source === "internal") {
      deferred.internal.push({ requestId: id, contentDigest: digest });
    } else {
      throw httpError(400, "稍后处理来源无效");
    }
  }
  return normalizeUnifiedDeferredOptions(deferred);
}

async function readUnifiedAttention(application, options) {
  if (typeof application.attentionCoordinator?.next === "function") {
    return options === undefined
      ? application.attentionCoordinator.next()
      : application.attentionCoordinator.next(options);
  }
  if (application.confirmationQueue) {
    const queue = requireConfirmationQueue(application);
    const external = options === undefined
      ? await queue.next()
      : await queue.next({ deferred: options.external });
    return {
      available: Boolean(external.item),
      source: external.item ? "external_confirmation" : null,
      pendingCount: Number.isSafeInteger(external.pendingCount)
        ? external.pendingCount
        : 0,
      externalEnabled: true,
      externalQueueRevision: Number.isSafeInteger(external.queueRevision)
        ? external.queueRevision
        : 0,
      item: external.item || null,
    };
  }
  return {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled: false,
    externalQueueRevision: 0,
    item: null,
  };
}

function queryOptions(url, { status = false, order = false } = {}) {
  return {
    ...(url.searchParams.has("limit")
      ? { limit: url.searchParams.get("limit") }
      : {}),
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor") }
      : {}),
    ...(status && url.searchParams.has("status")
      ? { status: url.searchParams.get("status") }
      : {}),
    ...(order && url.searchParams.has("order")
      ? { order: url.searchParams.get("order") }
      : {}),
  };
}

const codeJobPauseReason = "用户从本地指挥中枢暂停代码任务";
const codeJobCancelReason = "用户从本地指挥中枢取消代码任务";
const sha256Pattern = /^[a-f0-9]{64}$/;
const changePackageApplicationConflictCodes = new Set([
  "CHANGE_PACKAGE_APPLICATION_STALE",
  "CHANGE_PACKAGE_TARGET_DIRTY",
  "CHANGE_PACKAGE_TARGET_STALE",
  "CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT",
  "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
]);
const changePackageApplicationProjectionStatuses = new Set([
  "not_requested",
  "pending",
  "applying",
  "rejected",
  "stale",
  "failed",
  "applied",
  "already",
]);
const safeChangePackageApplicationId =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const safeChangePackageApplicationCode = /^[A-Z][A-Z0-9_]{2,63}$/;

function codeJobDetailQueryOptions(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => !["limit", "cursor"].includes(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw httpError(400, "代码任务详情查询参数无效");
  }
  return queryOptions(url);
}

function codeJobEvidenceQueryOptions(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    !keys.includes("packageDigest") ||
    !keys.includes("sha256") ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    throw httpError(400, "测试证据查询绑定无效");
  }
  const packageDigest = url.searchParams.get("packageDigest");
  const expectedSha256 = url.searchParams.get("sha256");
  if (
    !sha256Pattern.test(packageDigest || "") ||
    !sha256Pattern.test(expectedSha256 || "")
  ) {
    throw httpError(400, "测试证据查询绑定无效");
  }
  return { packageDigest, expectedSha256 };
}

function requireApplicationPort(application, property, methods, message) {
  const port = application[property];
  if (
    !port ||
    !methods.every((method) => typeof port[method] === "function")
  ) {
    throw httpError(503, message);
  }
  return port;
}

function requireExactJsonFields(value, fields, message) {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    !expected.every((field, index) => keys[index] === field)
  ) {
    throw httpError(400, message);
  }
  return value;
}

function requireExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw httpError(400, "expectedRevision 无效");
  }
  return value;
}

function dataFieldMap(value, required, message, maximumFields = 32) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw httpError(500, message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > maximumFields ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    ) ||
    required.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    throw httpError(500, message);
  }
  return new Map(keys.map((key) => [key, descriptors[key].value]));
}

function canonicalApplicationTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function normalizedApplicationReceipt(value, message) {
  if (value === null) return null;
  const fields = dataFieldMap(value, ["id", "createdAt"], message, 2);
  if (
    fields.size !== 2 ||
    !/^change-package-application-[a-f0-9]{64}$/.test(fields.get("id") || "") ||
    !canonicalApplicationTimestamp(fields.get("createdAt"))
  ) {
    throw httpError(500, message);
  }
  return { id: fields.get("id"), createdAt: fields.get("createdAt") };
}

function normalizedApplicationFailure(value, message) {
  if (value === null) return null;
  const fields = dataFieldMap(
    value,
    ["code", "outcome", "retryable", "at"],
    message,
    4,
  );
  if (
    fields.size !== 4 ||
    !safeChangePackageApplicationCode.test(fields.get("code") || "") ||
    !["absent", "unknown"].includes(fields.get("outcome")) ||
    typeof fields.get("retryable") !== "boolean" ||
    !canonicalApplicationTimestamp(fields.get("at"))
  ) {
    throw httpError(500, message);
  }
  return {
    code: fields.get("code"),
    outcome: fields.get("outcome"),
    retryable: fields.get("retryable"),
    at: fields.get("at"),
  };
}

function normalizedChangePackageApplicationProjection(
  value,
  { jobId, receipt, packageReady },
) {
  const message = "change package 应用状态绑定无效";
  const fields = dataFieldMap(value, ["status"], message);
  const status = fields.get("status");
  if (!changePackageApplicationProjectionStatuses.has(status)) {
    throw httpError(500, message);
  }
  if (status === "not_requested") {
    if (fields.size !== 1) throw httpError(500, message);
    return Object.freeze({ status, canRequest: packageReady });
  }

  for (const field of [
    "confirmationId",
    "job",
    "packageId",
    "packageDigest",
    "itemRevision",
    "createdAt",
    "updatedAt",
  ]) {
    if (!fields.has(field)) throw httpError(500, message);
  }
  const job = dataFieldMap(
    fields.get("job"),
    ["id", "revision", "recordDigest"],
    message,
    3,
  );
  if (
    job.size !== 3 ||
    job.get("id") !== jobId ||
    !Number.isSafeInteger(job.get("revision")) ||
    job.get("revision") < 1 ||
    !sha256Pattern.test(job.get("recordDigest") || "") ||
    !sha256Pattern.test(fields.get("packageDigest") || "") ||
    fields.get("packageId") !==
      `change-package-${fields.get("packageDigest")}` ||
    fields.get("packageId") !== receipt?.packageId ||
    fields.get("packageDigest") !== receipt?.packageDigest ||
    !safeChangePackageApplicationId.test(fields.get("confirmationId") || "") ||
    !Number.isSafeInteger(fields.get("itemRevision")) ||
    fields.get("itemRevision") < 1 ||
    !canonicalApplicationTimestamp(fields.get("createdAt")) ||
    !canonicalApplicationTimestamp(fields.get("updatedAt")) ||
    Date.parse(fields.get("updatedAt")) < Date.parse(fields.get("createdAt"))
  ) {
    throw httpError(500, message);
  }
  const projectedReceipt = normalizedApplicationReceipt(
    fields.has("receipt") ? fields.get("receipt") : null,
    message,
  );
  const failure = normalizedApplicationFailure(
    fields.has("failure") ? fields.get("failure") : null,
    message,
  );
  const rejectedAt = fields.has("rejectedAt")
    ? fields.get("rejectedAt")
    : null;
  if (rejectedAt !== null && !canonicalApplicationTimestamp(rejectedAt)) {
    throw httpError(500, message);
  }
  if (
    (["applied", "already"].includes(status) !== (projectedReceipt !== null)) ||
    ((status === "failed") !== (failure !== null)) ||
    ((status === "rejected") !== (rejectedAt !== null))
  ) {
    throw httpError(500, message);
  }
  return Object.freeze({
    status,
    canRequest: false,
    confirmationId: fields.get("confirmationId"),
    updatedAt: fields.get("updatedAt"),
    retryable: failure?.retryable ?? false,
    receipt: projectedReceipt,
    failure,
    rejectedAt,
  });
}

async function attachChangePackageApplicationProjection(
  application,
  detail,
  jobId,
) {
  if (!application.changePackageApplicationStatusReader) return detail;
  const reader = requireApplicationPort(
    application,
    "changePackageApplicationStatusReader",
    ["getForJob"],
    "change package 应用状态读取端口无效",
  );
  let projection;
  try {
    projection = await reader.getForJob(jobId);
  } catch (error) {
    if (error?.code === "CHANGE_PACKAGE_APPLICATION_PROJECTION_NOT_READY") {
      throw httpError(503, "change package 应用状态尚未就绪");
    }
    throw error;
  }
  const changePackage = detail.changePackage;
  const receipt = changePackage?.receipt ?? null;
  const packageReady = changePackage?.status === "ready" && receipt !== null;
  const normalized = normalizedChangePackageApplicationProjection(projection, {
    jobId,
    receipt,
    packageReady,
  });
  return {
    ...detail,
    changePackage: {
      ...changePackage,
      application: normalized,
    },
  };
}

async function readCodeJobDetail(application, jobId, options = {}) {
  const reader = requireApplicationPort(
    application,
    "codeJobReader",
    ["getDetail"],
    "本地代码任务详情读取端口无效",
  );
  const detail = await reader.getDetail({ jobId, ...options });
  if (detail === null) throw httpError(404, "代码任务不存在");
  if (
    !detail ||
    typeof detail !== "object" ||
    Array.isArray(detail) ||
    !detail.job ||
    typeof detail.job !== "object" ||
    detail.job.jobId !== jobId
  ) {
    throw httpError(409, "代码任务详情绑定无效");
  }
  return attachChangePackageApplicationProjection(application, detail, jobId);
}

function readyChangePackageReceipt(detail) {
  const receipt = detail.changePackage?.receipt;
  if (
    detail.changePackage?.status !== "ready" ||
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    typeof receipt.packageDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.packageDigest) ||
    receipt.packageId !== `change-package-${receipt.packageDigest}`
  ) {
    throw httpError(409, "代码任务 change package 尚未就绪");
  }
  return receipt;
}

function requireBoundChangePackageManifest(manifest, receipt, jobId) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.packageId !== receipt.packageId ||
    manifest.packageDigest !== receipt.packageDigest ||
    manifest.job?.id !== jobId
  ) {
    throw httpError(409, "change package 与代码任务绑定不一致");
  }
  return manifest;
}

async function readChangePackageManifest(reader, packageId) {
  try {
    return await reader.get(packageId);
  } catch (error) {
    if (error?.code === "CHANGE_PACKAGE_NOT_FOUND") {
      throw httpError(404, "change package 不存在");
    }
    if (error?.code === "CHANGE_PACKAGE_STORE_NOT_READY") {
      throw httpError(503, "change package 存储尚未就绪");
    }
    throw error;
  }
}

async function requestChangePackageApplication(requester, input) {
  try {
    return await requester.request(input);
  } catch (error) {
    if (changePackageApplicationConflictCodes.has(error?.code)) {
      throw httpError(409, error.message);
    }
    if (error?.code === "INVALID_CHANGE_PACKAGE_APPLICATION") {
      throw httpError(400, error.message);
    }
    if (error?.code === "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE") {
      throw httpError(503, "change package 暂时无法验证");
    }
    throw error;
  }
}

async function readCodeJobEvidence(reader, input) {
  try {
    return await reader.read(input);
  } catch (error) {
    const statusByCode = {
      INVALID_CODE_JOB_EVIDENCE_REQUEST: 400,
      CODE_JOB_EVIDENCE_NOT_FOUND: 404,
      CODE_JOB_EVIDENCE_STALE: 409,
      CODE_JOB_EVIDENCE_CORRUPTED: 500,
      CODE_JOB_EVIDENCE_UNAVAILABLE: 503,
    };
    const status = statusByCode[error?.code];
    if (status) {
      throw httpError(
        status,
        status >= 500 ? "测试证据暂时无法读取" : error.message,
      );
    }
    throw error;
  }
}

function verifiedCodeJobEvidence(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const fields = [
    "jobId",
    "packageId",
    "packageDigest",
    "profileId",
    "kind",
    "sha256",
    "bytes",
    "content",
  ];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    fields.some(
      (field) =>
        !descriptors[field]?.enumerable ||
        !("value" in descriptors[field]),
    )
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const result = Object.fromEntries(
    fields.map((field) => [field, descriptors[field].value]),
  );
  for (const field of [
    "jobId",
    "packageId",
    "packageDigest",
    "profileId",
    "kind",
  ]) {
    if (result[field] !== expected[field]) {
      throw httpError(500, "测试证据读取结果绑定无效");
    }
  }
  if (
    result.sha256 !== expected.expectedSha256 ||
    !sha256Pattern.test(result.sha256 || "") ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 1 ||
    !(Buffer.isBuffer(result.content) || result.content instanceof Uint8Array)
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const content = Buffer.from(result.content);
  if (
    content.length !== result.bytes ||
    createHash("sha256").update(content).digest("hex") !== result.sha256
  ) {
    throw httpError(500, "测试证据完整性校验失败");
  }
  return { ...result, content };
}

function sendCodeJobEvidence(response, evidence) {
  const digestBase64 = Buffer.from(evidence.sha256, "hex").toString("base64");
  const filename = [
    evidence.profileId,
    evidence.kind,
    evidence.sha256.slice(0, 12),
  ].join("-");
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}.json"`,
    "content-length": evidence.bytes,
    "content-digest": `sha-256=:${digestBase64}:`,
    "x-content-sha256": evidence.sha256,
    etag: `"${evidence.sha256}"`,
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  });
  response.end(evidence.content);
}

async function syncConfirmationOutcome(employeeRegistry, item) {
  const employee = employeeRegistry.get(item?.requestedBy?.roleId);
  if (!employee || typeof employee.recordConfirmationOutcome !== "function") {
    return false;
  }
  await employee.recordConfirmationOutcome(item);
  return true;
}

function confirmationUnavailable() {
  return Object.assign(new Error("外部动作正在核对最新事实，请稍后重试"), {
    statusCode: 503,
    code: "CONFIRMATION_FACTS_NOT_READY",
  });
}

function employeeFactsUnavailable() {
  return Object.assign(new Error("岗位正在等待最新事实，请稍后重试"), {
    statusCode: 503,
    code: "EMPLOYEE_FACTS_NOT_READY",
  });
}

function createConfirmationAccessGate(enabled) {
  let ready = !enabled;
  let activeOperations = 0;
  const drainWaiters = new Set();

  function releaseDrainers() {
    if (activeOperations !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  return Object.freeze({
    isReady() {
      return ready;
    },
    async closeAndDrain() {
      if (!enabled) return;
      ready = false;
      if (activeOperations === 0) return;
      await new Promise((resolve) => drainWaiters.add(resolve));
    },
    open() {
      if (enabled) ready = true;
    },
    async run(operation) {
      if (!enabled) return operation();
      if (!ready) throw confirmationUnavailable();
      activeOperations += 1;
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
        releaseDrainers();
      }
    },
  });
}

function runConfirmationOperation(backgroundWork, operation) {
  if (typeof backgroundWork?.runConfirmationOperation !== "function") {
    return operation();
  }
  return backgroundWork.runConfirmationOperation(operation);
}

function signalBackgroundAgency(backgroundWork, options, reportError) {
  if (typeof backgroundWork?.signalAgency !== "function") return;
  Promise.resolve()
    .then(() => backgroundWork.signalAgency(options))
    .catch((error) => {
      try {
        reportError(error);
      } catch {
        // Background diagnostics must never change the saved user answer.
      }
    });
}

function closeHttpServer(closeServer) {
  return new Promise((resolve, reject) => {
    closeServer((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function runLifecycleStep(step) {
  try {
    return Promise.resolve(step());
  } catch (error) {
    return Promise.reject(error);
  }
}

function lifecycleFailure(results) {
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return null;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "服务器关闭时发生多个错误");
}

function attachServerLifecycle(server, application, backgroundWork) {
  const closeServer = server.close.bind(server);
  let shutdownPromise = null;

  async function performShutdown() {
    const stoppingBackground = backgroundWork?.stop
      ? runLifecycleStep(() => backgroundWork.stop())
      : Promise.resolve();
    const closingHttp = closeHttpServer(closeServer);
    const serviceResults = await Promise.allSettled([
      stoppingBackground,
      closingHttp,
    ]);
    const applicationResults = await Promise.allSettled([
      typeof application.close === "function"
        ? runLifecycleStep(() => application.close())
        : Promise.resolve(),
    ]);
    const failure = lifecycleFailure([...serviceResults, ...applicationResults]);
    if (failure) throw failure;
  }

  function shutdown() {
    if (!shutdownPromise) shutdownPromise = performShutdown();
    return shutdownPromise;
  }

  Object.defineProperty(server, "shutdown", {
    configurable: false,
    enumerable: false,
    value: shutdown,
    writable: false,
  });
  server.close = (callback) => {
    shutdown().then(
      () => callback?.(),
      (error) => {
        if (callback) callback(error);
        else console.error(error);
      },
    );
    return server;
  };
  return server;
}

export function createDashboardServer(
  application,
  { backgroundWork, reportError = console.error } = {},
) {
  if (typeof reportError !== "function") {
    throw new TypeError("reportError must be a function");
  }
  const expectedOrigin = `http://127.0.0.1:${application.config.port}`;
  const employeeRegistry = resolveEmployeeRegistry(application);
  const server = http.createServer(async (request, response) => {
    try {
      assertTrustedHost(request, expectedOrigin);
      const url = new URL(request.url, expectedOrigin);
      if (request.method === "GET" && url.pathname === "/api/health") {
        const employees = await employeeRegistry.listRoles();
        const employee =
          employees.find((role) => role.id === "pr-reviewer") || null;
        const memory = application.memorySearch
          ? await requireMemorySearch(application).getHealth()
          : null;
        sendJson(response, 200, {
          ok: true,
          refreshing: Boolean(application.refreshService.running),
          employee,
          employees,
          ...(memory ? { memory } : {}),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const dashboard = await readDashboard(application, employeeRegistry);
        sendJson(
          response,
          dashboard ? 200 : 404,
          dashboard || { error: "no_snapshot" },
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        assertTrustedMutation(request, expectedOrigin);
        const refresh = backgroundWork?.refresh ||
          ((options) => application.refreshService.refresh(options));
        const result = await refresh({
          notify: url.searchParams.get("notify") === "1",
        });
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry, result.dashboard),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/employees") {
        sendJson(response, 200, { items: await employeeRegistry.listRoles() });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/work/summary"
      ) {
        const summary = await requireWorkLedgerView(application).getSummary();
        const prRole = employeeRegistry.get("pr-reviewer")
          ? await employeeRegistry.get("pr-reviewer").roleView()
          : null;
        sendJson(response, 200, {
          ...summary,
          safeguards: {
            prEmployeePaused: prRole ? Boolean(prRole.paused) : true,
            externalActionsEnabled:
              application.config.githubActions?.enabled === true,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/work/graph") {
        const snapshot = await requireWorkGraphView(application).getSnapshot();
        sendJson(
          response,
          200,
          projectWorkGraphHttpSnapshot(snapshot),
        );
        return;
      }
      if (
        request.method === "GET" &&
        ["/api/work/items", "/api/work/timeline"].includes(url.pathname)
      ) {
        const view = requireWorkLedgerView(application);
        const result = url.pathname.endsWith("/items")
          ? await view.listItems(queryOptions(url, { status: true, order: true }))
          : await view.listTimeline(queryOptions(url, { order: true }));
        sendJson(response, 200, result);
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/code/jobs"
      ) {
        if (!application.codeJobReader) {
          sendJson(response, 200, {
            enabled: false,
            items: [],
            nextCursor: null,
          });
          return;
        }
        if (typeof application.codeJobReader.list !== "function") {
          throw httpError(503, "本地代码任务读取端口无效");
        }
        sendJson(response, 200, {
          enabled: true,
          ...(await application.codeJobReader.list(
            queryOptions(url, { status: true, order: true }),
          )),
        });
        return;
      }
      const codeJobControlAction = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/control$/,
      );
      if (request.method === "POST" && codeJobControlAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = requireExactJsonFields(
          await readJsonBody(request),
          ["command", "expectedRevision"],
          "代码任务控制请求字段无效",
        );
        if (!["pause", "resume", "cancel"].includes(input.command)) {
          throw httpError(400, "command 只能是 pause、resume 或 cancel");
        }
        const expectedRevision = requireExpectedRevision(input.expectedRevision);
        const control = requireApplicationPort(
          application,
          "codeJobControl",
          ["pause", "resume", "cancel"],
          "本地代码任务控制端口无效",
        );
        const jobId = codeJobControlAction[1];
        let result;
        if (input.command === "pause") {
          result = await control.pause({
            jobId,
            expectedRevision,
            reason: codeJobPauseReason,
          });
        } else if (input.command === "resume") {
          result = await control.resume({ jobId, expectedRevision });
        } else {
          result = await control.cancel({
            jobId,
            expectedRevision,
            reason: codeJobCancelReason,
          });
          signalBackgroundAgency(
            backgroundWork,
            { trigger: "code_job_cancel_requested" },
            reportError,
          );
        }
        sendJson(response, 200, result);
        return;
      }
      const codeJobChangePackageApplication = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/change-package\/apply$/,
      );
      if (request.method === "POST" && codeJobChangePackageApplication) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = requireExactJsonFields(
          await readJsonBody(request),
          ["expectedRevision"],
          "change package 应用请求字段无效",
        );
        const expectedRevision = requireExpectedRevision(input.expectedRevision);
        const jobId = codeJobChangePackageApplication[1];
        requireApplicationPort(
          application,
          "changePackageApplicationStatusReader",
          ["getForJob"],
          "change package 应用状态读取端口无效",
        );
        const detail = await readCodeJobDetail(application, jobId);
        if (detail.job.revision !== expectedRevision) {
          throw httpError(409, "代码任务版本已变化，请基于最新状态重试");
        }
        const receipt = readyChangePackageReceipt(detail);
        if (detail.changePackage.application?.canRequest !== true) {
          throw httpError(409, "该 change package 已经进入应用流程");
        }
        const requester = requireApplicationPort(
          application,
          "changePackageApplicationRequester",
          ["request"],
          "change package 应用请求端口无效",
        );
        const queued = await requestChangePackageApplication(requester, {
          packageId: receipt.packageId,
          requestedBy: detail.job.requestedBy,
        });
        sendJson(response, 200, { request: queued });
        signalBackgroundAgency(
          backgroundWork,
          { trigger: "change_package_application_requested" },
          reportError,
        );
        return;
      }
      const codeJobEvidence = url.pathname.match(
        /^\/api\/code\/jobs\/(code-job-[a-f0-9]{55})\/change-package\/(change-package-[a-f0-9]{64})\/evidence\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/(output|stdout|stderr)$/,
      );
      if (request.method === "GET" && codeJobEvidence) {
        const [, jobId, packageId, profileId, kind] = codeJobEvidence;
        const binding = Object.freeze({
          jobId,
          packageId,
          profileId,
          kind,
          ...codeJobEvidenceQueryOptions(url),
        });
        const readerRequest = Object.freeze({ ...binding });
        const reader = requireApplicationPort(
          application,
          "codeJobEvidenceReader",
          ["read"],
          "代码任务测试证据读取端口无效",
        );
        const evidence = verifiedCodeJobEvidence(
          await readCodeJobEvidence(reader, readerRequest),
          binding,
        );
        sendCodeJobEvidence(response, evidence);
        return;
      }
      const codeJobChangePackage = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/change-package$/,
      );
      if (request.method === "GET" && codeJobChangePackage) {
        const jobId = codeJobChangePackage[1];
        const detail = await readCodeJobDetail(application, jobId);
        const receipt = readyChangePackageReceipt(detail);
        const reader = requireApplicationPort(
          application,
          "changePackageReader",
          ["get"],
          "change package 读取端口无效",
        );
        const manifest = requireBoundChangePackageManifest(
          await readChangePackageManifest(reader, receipt.packageId),
          receipt,
          jobId,
        );
        sendJson(response, 200, { manifest });
        return;
      }
      const codeJobDetail = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)$/,
      );
      if (request.method === "GET" && codeJobDetail) {
        const detail = await readCodeJobDetail(
          application,
          codeJobDetail[1],
          codeJobDetailQueryOptions(url),
        );
        sendJson(response, 200, { enabled: true, detail });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workflow/routing"
      ) {
        sendJson(
          response,
          200,
          await requireWorkflowRouting(application).getConfig(),
        );
        return;
      }
      if (
        request.method === "GET" &&
        ["/api/workflow/assignments", "/api/workflow/audit"].includes(
          url.pathname,
        )
      ) {
        const routing = requireWorkflowRouting(application);
        const options = {
          ...(url.searchParams.has("limit")
            ? { limit: url.searchParams.get("limit") }
            : {}),
          ...(url.searchParams.has("cursor")
            ? { cursor: url.searchParams.get("cursor") }
            : {}),
        };
        const result = url.pathname.endsWith("/assignments")
          ? await routing.listAssignments(options)
          : await routing.listAudit(options);
        sendJson(response, 200, result);
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/workflow/dry-run"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { event, definition } = await readJsonBody(
          request,
          128 * 1024,
        );
        const input = {
          event,
          ...(definition === undefined ? {} : { definition }),
        };
        sendJson(
          response,
          200,
          await requireWorkflowRouting(application).dryRun(input),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/attention/next"
      ) {
        const options = unifiedAttentionOptions(url);
        const next = await runConfirmationOperation(backgroundWork, () =>
          readUnifiedAttention(application, options),
        );
        sendJson(response, 200, next);
        return;
      }
      const internalAttentionAction = url.pathname.match(
        /^\/api\/attention\/internal\/(attention-[a-f0-9]{64})\/(answer|reject|later)$/,
      );
      if (request.method === "POST" && internalAttentionAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = await readJsonBody(request, 16 * 1024);
        if (Object.hasOwn(input, "requestId")) {
          throw httpError(400, "requestId 只能来自请求路径");
        }
        const operation = internalAttentionAction[2];
        const item = await requireAttentionBrowser(application)[operation]({
          ...input,
          requestId: internalAttentionAction[1],
        });
        if (operation !== "later") {
          signalBackgroundAgency(
            backgroundWork,
            { trigger: "user_answered" },
            reportError,
          );
        }
        sendJson(response, 200, { item });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/confirmations/next"
      ) {
        if (!application.confirmationQueue) {
          sendJson(response, 200, {
            available: false,
            queueRevision: 0,
            pendingCount: 0,
            item: null,
          });
          return;
        }
        const next = await runConfirmationOperation(backgroundWork, () =>
          requireConfirmationQueue(application).next(),
        );
        sendJson(response, 200, { available: true, ...next });
        return;
      }
      const confirmationAction = url.pathname.match(
        /^\/api\/confirmations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(approve|retry|reject)$/,
      );
      if (request.method === "POST" && confirmationAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        await runConfirmationOperation(backgroundWork, async () => {
          const input = await readJsonBody(request);
          const queue = requireConfirmationQueue(application);
          const item = await queue[confirmationAction[2]](
            confirmationAction[1],
            input,
          );
          let employeeSyncPending = false;
          try {
            await syncConfirmationOutcome(employeeRegistry, item);
          } catch {
            employeeSyncPending = true;
          }
          sendJson(response, 200, {
            item,
            next: await queue.next(),
            employeeSyncPending,
          });
        });
        signalBackgroundAgency(
          backgroundWork,
          { trigger: "confirmation_answered" },
          reportError,
        );
        return;
      }
      const employeeAction = url.pathname.match(
        /^\/api\/employees\/([a-z0-9-]+)\/(control|run)$/,
      );
      if (
        request.method === "POST" &&
        employeeAction?.[2] === "control"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { command, expectedRevision } = await readJsonBody(request);
        await employeeRegistry.control(
          employeeAction[1],
          command,
          expectedRevision,
        );
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "POST" &&
        employeeAction?.[2] === "run"
      ) {
        assertTrustedMutation(request, expectedOrigin);
        if (typeof backgroundWork?.runEmployee === "function") {
          const result = await backgroundWork.runEmployee(employeeAction[1], {
            trigger: "manual",
          });
          if (result?.skipped) throw employeeFactsUnavailable();
        } else {
          await employeeRegistry.run(employeeAction[1], {
            trigger: "manual",
          });
        }
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-review-jobs/decide"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, decision, headRefOid, expectedRevision } =
          await readJsonBody(request);
        await requirePrEmployee(employeeRegistry).decide(id, decision, {
          headRefOid,
          expectedRevision,
        });
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/memory/search"
      ) {
        const rawLimit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : Number.NaN;
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 100))
          : 30;
        const query = url.searchParams.get("q") || "";
        const items = application.memorySearch
          ? (
              await requireMemorySearch(application).search({
                q: query,
                limit,
              })
            ).items
          : await requirePrEmployee(employeeRegistry).searchMemory(query, limit);
        sendJson(response, 200, { query, items });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/memory/query"
      ) {
        sendJson(
          response,
          200,
          await requireMemorySearch(application).search(
            memoryQueryOptions(url),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-responsibility/confirm"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, actionState, headRefOid } = await readJsonBody(request);
        const mutation = () =>
          application.refreshService.confirmPullRequestResponsibility(
            id,
            actionState,
            headRefOid,
          );
        const dashboard = backgroundWork?.mutateFacts
          ? await backgroundWork.mutateFacts(mutation)
          : await mutation();
        sendJson(response, 200, dashboard);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      const status = Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
      if (status >= 500) {
        try {
          reportError(error);
        } catch {
          // Diagnostics must never replace the safe HTTP response.
        }
      }
      sendJson(response, status, {
        error: status >= 500 ? internalServerErrorMessage : error.message,
      });
    }
  });
  return attachServerLifecycle(server, application, backgroundWork);
}

export function startApplicationBackgroundWork(
  application,
  {
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    reportError = console.error,
  } = {},
) {
  const employeeRegistry = resolveEmployeeRegistry(application);
  const timers = [];
  const activeTasks = new Set();
  const confirmationAccess = createConfirmationAccessGate(
    Boolean(application.confirmationQueue),
  );
  let stopped = false;
  let stopPromise = null;
  let backgroundTail = Promise.resolve();
  let factsReady = false;
  let pendingFactCycles = 0;
  const coalescedAgencyCycles = new Map();
  const coalescedRefreshCycles = new Map();

  function reportBackgroundError(error) {
    try {
      reportError(error);
    } catch {
      // A diagnostics failure must not alter lifecycle safety.
    }
  }

  function runTracked(operation, { rethrow = false } = {}) {
    if (stopped) return Promise.resolve();
    let task;
    task = (async () => {
      if (stopped) return;
      try {
        return await operation();
      } catch (error) {
        reportBackgroundError(error);
        if (rethrow) throw error;
      }
    })().finally(() => activeTasks.delete(task));
    activeTasks.add(task);
    return task;
  }

  async function hasFreshPullRequestFacts() {
    if (!application.confirmationQueue) return true;
    const snapshot = await application.store?.read?.("snapshot", null);
    return snapshot?.sourceStatus?.githubPullRequests?.ok === true;
  }

  async function reconcileExternalConfirmations() {
    if (!application.confirmationQueue) return;
    const employee = employeeRegistry.get("pr-reviewer");
    if (typeof employee?.recoverConfirmations === "function") {
      await employee.recoverConfirmations();
    }
  }

  async function routeWorkflowSnapshot() {
    if (typeof application.workflowRouting?.ingestSnapshot !== "function") {
      return;
    }
    const snapshot = await application.store?.read?.("snapshot", null);
    if (snapshot) {
      await application.workflowRouting.ingestSnapshot({ snapshot });
    }
  }

  async function intakeWorkflowAssignments() {
    if (typeof application.workCoordination?.intake === "function") {
      await application.workCoordination.intake();
    }
  }

  async function performAgencyCycle({
    trigger,
    includeLegacyEmployees = false,
    employeeIds = [],
    discardWhenFactsPending = false,
  }) {
    if (stopped) return { skipped: "stopped" };
    if (!factsReady) return { skipped: "facts_not_ready" };
    if (discardWhenFactsPending && pendingFactCycles > 0) {
      return { skipped: "newer_facts_pending" };
    }
    const failures = [];
    if (typeof application.workCoordination?.runCycle === "function") {
      try {
        await application.workCoordination.runCycle({
          trigger,
          includeWork: false,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    const selectedEmployeeIds = [
      ...(includeLegacyEmployees ? ["pr-reviewer"] : []),
      ...employeeIds,
    ].filter((id, index, ids) => ids.indexOf(id) === index);
    if (selectedEmployeeIds.length > 0 && !stopped) {
      try {
        if (typeof employeeRegistry.runSelected === "function") {
          await employeeRegistry.runSelected(selectedEmployeeIds, { trigger });
        } else if (
          includeLegacyEmployees &&
          typeof employeeRegistry.runAll === "function"
        ) {
          await employeeRegistry.runAll({ trigger });
        } else if (
          selectedEmployeeIds.length === 1 &&
          typeof employeeRegistry.run === "function"
        ) {
          await employeeRegistry.run(selectedEmployeeIds[0], { trigger });
        } else {
          await employeeRegistry.runAll({ trigger });
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (typeof application.memoryProjector?.runCycle === "function" && !stopped) {
      try {
        await application.memoryProjector.runCycle();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "员工主动循环、旧岗位巡查或记忆投影失败",
      );
    }
    return { skipped: null };
  }

  function enqueueAgencyCycle(options) {
    const operation = () => performAgencyCycle(options);
    const result = backgroundTail.then(operation, operation);
    backgroundTail = result.catch(() => {});
    return result;
  }

  function coalesceCycle(cycles, key, createCycle) {
    const existing = cycles.get(key);
    if (existing) return existing;
    let tracked;
    tracked = createCycle().finally(() => {
      if (cycles.get(key) === tracked) cycles.delete(key);
    });
    cycles.set(key, tracked);
    return tracked;
  }

  function enqueueCoalescedAgencyCycle(key, options) {
    return coalesceCycle(coalescedAgencyCycles, key, () =>
      enqueueAgencyCycle(options),
    );
  }

  function enqueueFactCycle(factOperation) {
    pendingFactCycles += 1;
    const operation = async () => {
      try {
        if (stopped) return undefined;
        factsReady = false;
        await confirmationAccess.closeAndDrain();
        if (stopped) return undefined;
        const result = await factOperation();
        if (stopped) return result;
        await routeWorkflowSnapshot();
        if (stopped) return result;
        await intakeWorkflowAssignments();
        if (stopped) return result;
        if (!(await hasFreshPullRequestFacts())) return result;
        await reconcileExternalConfirmations();
        if (stopped) return result;
        factsReady = true;
        if (pendingFactCycles === 1) {
          confirmationAccess.open();
          try {
            await performAgencyCycle({
              trigger: "refresh_completed",
              includeLegacyEmployees: true,
            });
          } catch (error) {
            reportBackgroundError(error);
          }
        }
        return result;
      } finally {
        pendingFactCycles -= 1;
        if (stopped) factsReady = false;
      }
    };
    const result = backgroundTail.then(operation, operation);
    backgroundTail = result.catch(() => {});
    return result;
  }

  function enqueueRefresh({ notify = false } = {}) {
    const key = notify ? "notify" : "silent";
    return coalesceCycle(coalescedRefreshCycles, key, () =>
      enqueueFactCycle(() => application.refreshService.refresh({ notify })),
    );
  }

  const initialRefresh = runTracked(
    () => enqueueRefresh({ notify: false }),
    { rethrow: true },
  );

  timers.push(
    setIntervalFn(
      () =>
        runTracked(() => enqueueRefresh({ notify: false })),
      application.config.refreshMinutes * 60_000,
    ),
  );
  const agencyTickSeconds = Number(
    application.config.workCoordination?.tickSeconds,
  );
  if (
    typeof application.workCoordination?.runCycle === "function" &&
    Number.isFinite(agencyTickSeconds) &&
    agencyTickSeconds > 0
  ) {
    timers.push(
      setIntervalFn(
        () =>
          runTracked(() =>
            enqueueCoalescedAgencyCycle("coordination", {
              trigger: "scheduled",
              includeLegacyEmployees: false,
              discardWhenFactsPending: true,
            }),
          ),
        agencyTickSeconds * 1_000,
      ),
    );
  }
  for (const schedule of employeeRegistry.schedules()) {
    timers.push(
      setIntervalFn(
        () =>
          runTracked(() =>
            enqueueCoalescedAgencyCycle(`employee:${schedule.id}`, {
              trigger: "scheduled",
              employeeIds: [schedule.id],
              discardWhenFactsPending: true,
            }),
          ),
        schedule.intervalMinutes * 60_000,
      ),
    );
  }
  for (const timer of timers) timer.unref?.();

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    factsReady = false;
    for (const timer of timers) clearIntervalFn(timer);
    stopPromise = (async () => {
      await confirmationAccess.closeAndDrain();
      while (activeTasks.size > 0) {
        await Promise.allSettled([...activeTasks]);
      }
    })();
    return stopPromise;
  }

  return {
    initialRefresh,
    timers,
    stop,
    refresh: (options) =>
      runTracked(() => enqueueRefresh(options), { rethrow: true }),
    mutateFacts: (operation) =>
      runTracked(() => enqueueFactCycle(operation), { rethrow: true }),
    signalAgency: ({ trigger = "signal" } = {}) =>
      runTracked(() =>
        enqueueCoalescedAgencyCycle("signal", {
          trigger,
          includeLegacyEmployees: false,
        }),
      ),
    runEmployee: (id, { trigger = "manual" } = {}) =>
      runTracked(
        () =>
          enqueueCoalescedAgencyCycle(`manual-employee:${id}`, {
            trigger,
            employeeIds: [id],
          }),
        { rethrow: true },
      ),
    runConfirmationOperation: (operation) => confirmationAccess.run(operation),
    confirmationReady: () => confirmationAccess.isReady(),
  };
}

function listenForLocalConnections(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startDashboardServer(
  {
    createApplicationFn = createApplication,
    startBackgroundWorkFn = startApplicationBackgroundWork,
    log = console.log,
  } = {},
) {
  const application = await createApplicationFn();
  let backgroundWork = null;
  let server = null;
  try {
    backgroundWork = startBackgroundWorkFn(application);
    server = createDashboardServer(application, { backgroundWork });
    await listenForLocalConnections(server, application.config.port);
    await backgroundWork.initialRefresh;
  } catch (error) {
    try {
      if (server) {
        await server.shutdown();
      } else {
        await backgroundWork?.stop?.();
        await application.close?.();
      }
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "服务器启动失败且资源释放不完整",
      );
    }
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address
    ? address.port
    : application.config.port;
  log(`MyDashboard: http://127.0.0.1:${port}`);
  return server;
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedModule) {
  await startDashboardServer();
}
