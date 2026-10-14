import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  CODE_ACTION_DECISION_JSON_SCHEMA, normalizeStructuredCodeActionDecision,
} from "../domain/structured-code-action-contract.js";
import { beginCodeExecutionSession } from "../lib/code-execution-context.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";

const MAXIMUM_REQUEST_BYTES = 1024 * 1024;
const MAXIMUM_ACTION_REQUESTS = 128;
const TOOLS = [
  { name: "perform_action", description: "Perform one authorized semantic action using the host executor. Trusted execution fields remain host selected. Do not call complete here; return the final structured complete decision after all tools settle.",
    inputSchema: { type: "object", required: ["decision"], additionalProperties: false,
      properties: { decision: CODE_ACTION_DECISION_JSON_SCHEMA } },
    annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "read_source", description: "Read a page from this job's current audited source. Offsets are UTF-16 code units. Follow nextOffset until null; echo page.sourceVersion on subsequent pages. A changed workspace invalidates old versions.",
    inputSchema: { type: "object", required: ["path", "offset"], additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 1024 },
        offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 48_000 },
        sourceVersion: { type: "string", minLength: 1, maxLength: 256 } } },
    annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "get_state", description: "Read current job state, permitted actions, workspace revision and verification evidence.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false } },
];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function exactArguments(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw failure("CODE_EXECUTION_ARGUMENT_INVALID");
  }
  return value;
}

function normalizeArguments(name, value) {
  if (name === "perform_action") {
    exactArguments(value, ["decision"]);
    const decision = normalizeStructuredCodeActionDecision(value.decision);
    if (decision.action.type === "complete") throw failure("CODE_EXECUTION_COMPLETE_NOT_ALLOWED");
    return { decision };
  }
  if (name === "read_source") {
    const args = exactArguments(value, ["path", "offset"], ["length", "sourceVersion"]);
    if (typeof args.path !== "string" || !args.path || Buffer.byteLength(args.path, "utf8") > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(args.path) ||
        !Number.isSafeInteger(args.offset) || args.offset < 0 || Object.is(args.offset, -0) ||
        (Object.hasOwn(args, "length") && (!Number.isSafeInteger(args.length) || args.length < 1 || args.length > 48_000)) ||
        (Object.hasOwn(args, "sourceVersion") && (typeof args.sourceVersion !== "string" ||
          !args.sourceVersion || Buffer.byteLength(args.sourceVersion, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(args.sourceVersion)))) {
      throw failure("CODE_EXECUTION_ARGUMENT_INVALID");
    }
    return args;
  }
  if (name === "get_state") return exactArguments(value, []);
  throw failure("CODE_EXECUTION_TOOL_NOT_ALLOWED");
}

function toolError(error) {
  const code = typeof error?.code === "string" && error.code.length <= 128 &&
    /^(?:(?:CODE_EXECUTION|CODE_READ|CODE_JOB|CODE_BRAIN|CODE_ARTIFACT|EXECUTION|STRUCTURED_CODE_ACTION|WORK_LEDGER)_[A-Z0-9_]+|INVALID_CODE_JOB_AUTHORITY)$/u.test(error.code)
    ? error.code : "CODE_EXECUTION_FAILED";
  return { isError: true, content: [{ type: "text", text: code }] };
}

function validRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" || Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) return false;
  if (!Object.hasOwn(message, "id")) return message.method === "notifications/initialized";
  return (typeof message.id === "string" && message.id.length > 0 && Buffer.byteLength(message.id, "utf8") <= 256) ||
    (Number.isSafeInteger(message.id) && !Object.is(message.id, -0));
}

// The endpoint owns no filesystem/GitHub authority. Its opaque callbacks bind
// every tool invocation to current durable job state and controlled execution.
export async function createCodeJobExecutionMcp(context, { signal = null } = {}) {
  const session = beginCodeExecutionSession(context, { signal });
  const endpointPath = `/code-execution/${randomBytes(32).toString("hex")}`;
  const mutations = new Map();
  const admittedResponses = new Set();
  let closing;
  let revoked = false;
  const revoke = (options) => { revoked = true; session.revoke(options); };
  const trackResponse = (response) => {
    let settled;
    const finished = new Promise((resolve) => { settled = resolve; });
    admittedResponses.add(finished);
    const done = () => {
      response.removeListener("finish", done);
      response.removeListener("close", done);
      admittedResponses.delete(finished);
      settled();
    };
    response.once("finish", done);
    response.once("close", done);
  };
  const callTool = async (message, response) => {
    try {
      session.assertActive();
      const params = exactArguments(message.params, ["name", "arguments"]);
      const args = normalizeArguments(params.name, params.arguments);
      trackResponse(response);
      const invoke = async () => {
        try {
          const value = await session.invoke(params.name, args);
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) { return toolError(error); }
      };
      if (params.name !== "perform_action") return await invoke();
      const key = JSON.stringify(message.id);
      const payload = JSON.stringify(args);
      const previous = mutations.get(key);
      if (previous) {
        if (previous.payload !== payload) throw failure("CODE_EXECUTION_REQUEST_ID_CONFLICT");
        return await previous.result;
      }
      if (mutations.size >= MAXIMUM_ACTION_REQUESTS) throw failure("CODE_EXECUTION_ACTION_LIMIT");
      const result = invoke();
      mutations.set(key, { payload, result });
      return await result;
    } catch (error) { return toolError(error); }
  };
  const server = createServer(async (request, response) => {
    if (request.url !== endpointPath || request.headers.origin !== undefined || request.method !== "POST") {
      response.writeHead(404).end(); return;
    }
    let message;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAXIMUM_REQUEST_BYTES) throw failure("CODE_EXECUTION_ARGUMENT_INVALID");
        chunks.push(chunk);
      }
      message = parseJsonWithUniqueKeys(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
      if (!validRequest(message)) throw failure("CODE_EXECUTION_ARGUMENT_INVALID");
      if (!Object.hasOwn(message, "id")) { response.writeHead(202).end(); return; }
      let result;
      if (revoked && message.method !== "tools/call") throw failure("CODE_EXECUTION_SESSION_REVOKED");
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mydashboard-code-execution", version: "1.0.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: TOOLS };
      else if (message.method === "tools/call") result = await callTool(message, response);
      else throw failure("CODE_EXECUTION_METHOD_NOT_ALLOWED");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch {
      if (!response.destroyed) response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: validRequest(message) ? message.id ?? null : null, error: { code: -32600, message: "Invalid request" },
      }));
    }
  });
  server.requestTimeout = 60_000;
  const close = () => closing ??= (async () => {
    revoke();
    signal?.removeEventListener("abort", onAbort);
    try {
      const receipt = await session.close();
      // Let admitted responses flush their result receipts before sockets close.
      await Promise.all([...admittedResponses]);
      return receipt;
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  })();
  const onAbort = () => { revoke({ abortActive: true }); void close().catch(() => {}); };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.on("error", () => { revoke({ abortActive: true }); void close().catch(() => {}); });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { await close(); signal.throwIfAborted(); }
    return Object.freeze({ url: `http://127.0.0.1:${server.address().port}${endpointPath}`,
      tools: Object.freeze(TOOLS.map(({ name }) => name)), revoke, close });
  } catch (error) {
    revoke({ abortActive: true }); await close(); throw error;
  }
}
