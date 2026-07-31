import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication } from "./composition-root.js";
import { projectRoot } from "./lib/config.js";

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

async function readDashboard(application, fallback = null) {
  const dashboard = fallback || (await application.store.read("dashboard"));
  if (!dashboard) return null;
  if (!application.prEmployee) return dashboard;
  return {
    ...dashboard,
    employee: await application.prEmployee.view(),
  };
}

function requirePrEmployee(application) {
  if (!application.prEmployee) {
    throw httpError(503, "PR 推进员工未配置");
  }
  return application.prEmployee;
}

export function createDashboardServer(application) {
  const expectedOrigin = `http://127.0.0.1:${application.config.port}`;
  return http.createServer(async (request, response) => {
    try {
      assertTrustedHost(request, expectedOrigin);
      const url = new URL(request.url, expectedOrigin);
      if (request.method === "GET" && url.pathname === "/api/health") {
        const employee = application.prEmployee
          ? (await application.prEmployee.view()).role
          : null;
        sendJson(response, 200, {
          ok: true,
          refreshing: Boolean(application.refreshService.running),
          employee,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const dashboard = await readDashboard(application);
        sendJson(
          response,
          dashboard ? 200 : 404,
          dashboard || { error: "no_snapshot" },
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        assertTrustedMutation(request, expectedOrigin);
        const result = await application.refreshService.refresh({
          notify: url.searchParams.get("notify") === "1",
        });
        sendJson(response, 200, await readDashboard(application, result.dashboard));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/employees/pr-reviewer/control"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { command, expectedRevision } = await readJsonBody(request);
        await requirePrEmployee(application).control(command, expectedRevision);
        sendJson(response, 200, await readDashboard(application));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/employees/pr-reviewer/run"
      ) {
        assertTrustedMutation(request, expectedOrigin);
        await requirePrEmployee(application).tick({ trigger: "manual" });
        sendJson(response, 200, await readDashboard(application));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-review-jobs/decide"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, decision, headRefOid, expectedRevision } =
          await readJsonBody(request);
        await requirePrEmployee(application).decide(id, decision, {
          headRefOid,
          expectedRevision,
        });
        sendJson(response, 200, await readDashboard(application));
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
        const items = await requirePrEmployee(application).searchMemory(
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
        const dashboard =
          await application.refreshService.confirmPullRequestResponsibility(
            id,
            actionState,
            headRefOid,
          );
        sendJson(response, 200, dashboard);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      const status = Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
      sendJson(response, status, { error: error.message });
    }
  });
}

export async function startDashboardServer() {
  const application = await createApplication();
  const server = createDashboardServer(application);
  server.listen(application.config.port, "127.0.0.1", () => {
    console.log(`MyDashboard: http://127.0.0.1:${application.config.port}`);
  });

  application.refreshService
    .refresh({ notify: false })
    .then(() => application.prEmployee?.tick({ trigger: "refresh_completed" }))
    .catch(console.error);
  setInterval(
    () =>
      application.refreshService.refresh({ notify: false }).catch(console.error),
    application.config.refreshMinutes * 60_000,
  ).unref();
  if (application.prEmployee) {
    setInterval(
      () => application.prEmployee.tick({ trigger: "scheduled" }).catch(console.error),
      (application.config.employees?.prReviewer?.tickMinutes || 2) * 60_000,
    ).unref();
  }
  return server;
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedModule) {
  await startDashboardServer();
}
