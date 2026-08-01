import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication } from "./composition-root.js";
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
        sendJson(response, 200, {
          ok: true,
          refreshing: Boolean(application.refreshService.running),
          employee,
          employees,
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
        await employeeRegistry.run(employeeAction[1], {
          trigger: "manual",
        });
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
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 100))
          : 30;
        const query = url.searchParams.get("q") || "";
        const items = await requirePrEmployee(employeeRegistry).searchMemory(
          query,
          limit,
        );
        sendJson(response, 200, { query, items });
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
  let refreshTail = Promise.resolve();

  function runTracked(operation, { rethrow = false } = {}) {
    if (stopped) return Promise.resolve();
    let task;
    task = (async () => {
      if (stopped) return;
      try {
        return await operation();
      } catch (error) {
        try {
          reportError(error);
        } catch {
          // A diagnostics failure must not alter lifecycle safety.
        }
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

  function enqueueFactCycle(factOperation) {
    const operation = async () => {
      await confirmationAccess.closeAndDrain();
      if (stopped) return undefined;
      const result = await factOperation();
      if (stopped) return result;
      if (!(await hasFreshPullRequestFacts())) return result;
      await reconcileExternalConfirmations();
      if (stopped) return result;
      await employeeRegistry.runAll({ trigger: "refresh_completed" });
      if (!stopped) confirmationAccess.open();
      return result;
    };
    const result = refreshTail.then(operation, operation);
    refreshTail = result.catch(() => {});
    return result;
  }

  function enqueueRefresh({ notify = false } = {}) {
    return enqueueFactCycle(() =>
      application.refreshService.refresh({ notify }),
    );
  }

  const initialRefresh = runTracked(
    () => enqueueRefresh({ notify: false }),
    { rethrow: Boolean(application.confirmationQueue) },
  );

  timers.push(
    setIntervalFn(
      () =>
        runTracked(() => enqueueRefresh({ notify: false })),
      application.config.refreshMinutes * 60_000,
    ),
  );
  for (const schedule of employeeRegistry.schedules()) {
    timers.push(
      setIntervalFn(
        () =>
          runTracked(() =>
            employeeRegistry.run(schedule.id, { trigger: "scheduled" }),
          ),
        schedule.intervalMinutes * 60_000,
      ),
    );
  }
  for (const timer of timers) timer.unref?.();

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
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
    if (application.confirmationQueue) {
      await backgroundWork.initialRefresh;
    }
    await listenForLocalConnections(server, application.config.port);
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
