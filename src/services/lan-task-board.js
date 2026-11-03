import { createServer } from "node:http";
import { isIPv4 } from "node:net";

const PORT = 4174;
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

export function createLanTaskBoard(readPage) {
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
        try {
          const result = await readPage(request.url, AbortSignal.timeout(10_000));
          if (response.destroyed) return;
          if (!allowed()) return send(response, 403, "text/plain", "此设备无访问权限");
          if (!result) return send(response, 404, "text/plain", "此内容仅本机可见");
          send(response, result.status, result.type, result.body);
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
