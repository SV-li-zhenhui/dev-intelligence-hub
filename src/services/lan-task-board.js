import { createServer } from "node:http";
import { isIPv4 } from "node:net";

const PORT = 4174;
const phases = {
  preparing: "准备执行", starting_model: "启动模型", waiting_model: "等待模型",
  running: "执行中", waiting_checkpoint: "等待检查点", waiting_step: "等待下一步骤",
  paused: "已暂停", failed: "失败", completed: "已完成", cancelled: "已取消",
  fenced: "等待维护", unknown: "状态待确认", idle: "等待调度",
  control_failed: "停止待确认",
};

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务进度看板</title><link rel="stylesheet" href="/board.css">
<main><h1>任务进度看板</h1><p id="status" role="status">正在读取任务…</p>
<table><thead><tr><th>任务</th><th>岗位</th><th>状态</th><th>最近更新</th></tr></thead>
<tbody id="tasks"></tbody></table></main><script src="/board.js" defer></script></html>`;
const style = `body{font:16px system-ui;margin:0;color:#17201d;background:#f4f2ec}
main{max-width:960px;margin:auto;padding:24px}table{width:100%;border-collapse:collapse;background:#fffdf8}
th,td{text-align:left;padding:12px;border-bottom:1px solid #d9d7cf;overflow-wrap:anywhere}`;
const script = `const status = document.getElementById("status");
const tasks = document.getElementById("tasks");
async function refresh() {
  try {
    const response = await fetch("/api/tasks", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error();
    const rows = await response.json();
    tasks.replaceChildren(...rows.map(row => {
      const tr = document.createElement("tr");
      for (const value of [row.title, row.role, row.phase, row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }));
    status.textContent = rows.length ? "每 5 秒刷新" : "当前没有可查看的任务";
  } catch {
    tasks.replaceChildren();
    status.textContent = "看板已关闭、访问权限已变化或连接不可用";
  } finally {
    setTimeout(refresh, 5000);
  }
}
void refresh();`;

function privateIPv4(value) {
  if (typeof value !== "string" || !isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function settings(value) {
  if (value?.enabled === false) return { enabled: false, host: "", allow: [] };
  if (value?.enabled !== true || !privateIPv4(value.host) ||
      !Array.isArray(value.allow) || value.allow.length < 1 || value.allow.length > 64 ||
      !value.allow.every(privateIPv4)) {
    throw Object.assign(new Error("请输入局域网 IPv4 地址及 1 到 64 个白名单地址"), { statusCode: 400 });
  }
  return { enabled: true, host: value.host, allow: [...new Set(value.allow)] };
}

function send(response, status, type, body) {
  response.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}

function project(list) {
  return [...list.items ?? [], ...list.held ?? [], ...list.background ?? [], ...list.recent ?? []]
    .slice(0, 100).map(task => ({
      title: typeof task.title === "string" ? task.title.slice(0, 240) : "任务",
      role: typeof task.roleId === "string" ? task.roleId.slice(0, 64) : "",
      phase: Object.hasOwn(phases, task.phase) ? phases[task.phase] : "状态待确认",
      updatedAt: Number.isFinite(Date.parse(task.lastActivityAt)) ? task.lastActivityAt : null,
    }));
}

export function createLanTaskBoard(readTasks) {
  let listener;
  let current = settings({ enabled: false });
  let queue = Promise.resolve();
  let disposed = false;
  const view = () => ({ ...current, allow: [...current.allow],
    url: current.enabled ? `http://${current.host}:${PORT}/` : null });

  async function stop() {
    current = settings({ enabled: false });
    if (!listener) return;
    const old = listener;
    listener = undefined;
    await new Promise(resolve => {
      old.close(resolve);
      old.closeAllConnections();
    });
  }

  function configure(value) {
    const next = settings(value);
    const operation = queue.then(async () => {
      if (disposed) throw Object.assign(new Error("服务正在关闭"), { statusCode: 503 });
      if (listener && next.enabled && current.host === next.host) {
        current = next;
        return view();
      }
      await stop();
      if (!next.enabled) return view();
      const candidate = createServer(async (request, response) => {
        const allowed = () => current.enabled && listener === candidate &&
          request.headers.host === `${current.host}:${PORT}` &&
          current.allow.includes(request.socket.remoteAddress);
        if (!allowed()) return send(response, 403, "text/plain", "此设备无访问权限");
        if (request.method !== "GET") return send(response, 405, "text/plain", "只读看板");
        if (request.url === "/") return send(response, 200, "text/html", page);
        if (request.url === "/board.js") return send(response, 200, "text/javascript", script);
        if (request.url === "/board.css") return send(response, 200, "text/css", style);
        if (request.url !== "/api/tasks") return send(response, 404, "text/plain", "页面不存在");
        try {
          const rows = project(await readTasks());
          if (response.destroyed) return;
          if (!allowed()) return send(response, 403, "text/plain", "此设备无访问权限");
          send(response, 200, "application/json", JSON.stringify(rows));
        } catch {
          if (!response.destroyed) send(response, 503, "text/plain", "任务状态暂不可用");
        }
      });
      try {
        await new Promise((resolve, reject) => {
          candidate.once("error", reject);
          candidate.listen({ host: next.host, port: PORT, exclusive: true }, resolve);
        });
      } catch {
        throw Object.assign(new Error("无法监听该地址，请检查本机 IP 和 4174 端口"), { statusCode: 409 });
      }
      listener = candidate;
      current = next;
      return view();
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { view, configure, close() { disposed = true; return queue.then(stop); } };
}
