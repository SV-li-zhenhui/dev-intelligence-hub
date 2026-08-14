const http = require("node:http");
const net = require("node:net");

const mode = process.argv[2];
const port = Number(process.argv[3]);
if (
  !new Set([
    "raw",
    "raw-ipv6",
    "not-found",
    "malformed",
    "hang",
    "saturated",
  ]).has(mode) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65_535
) {
  throw new TypeError("expected one fixture mode and loopback port");
}

const sockets = new Set();
let closing = false;

function track(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

const server = mode === "raw" || mode === "raw-ipv6" || mode === "saturated"
  ? net.createServer((socket) => {
      process.send?.({ type: "connection" });
    })
  : http.createServer((request, response) => {
      process.send?.({ type: "request", method: request.method, url: request.url });
      if (mode === "hang") return;
      if (mode === "not-found") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1024",
      });
      response.write('{"live":');
      response.socket.destroy();
    });

server.on("connection", track);
server.on("error", (error) => {
  process.send?.({ type: "fixture-error", code: error.code || "UNKNOWN" });
  process.exitCode = 1;
});

function close() {
  if (closing) return;
  closing = true;
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.on("message", (message) => {
  if (message?.type === "close") close();
});
process.on("disconnect", close);
const listenOptions = {
  host: mode === "raw-ipv6" ? "::1" : "127.0.0.1",
  port,
  ...(mode === "saturated" ? { backlog: 1 } : {}),
};
server.listen(listenOptions, () => {
  if (mode !== "saturated") {
    process.send?.({ type: "ready" });
    return;
  }
  process.send?.({ type: "ready" }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  });
});
