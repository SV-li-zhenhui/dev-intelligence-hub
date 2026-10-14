import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { runCommand, runJson } from "../lib/command-runner.js";
import { normalizeReviewReadTarget } from "../domain/review-read-target.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function repositoryPath(value, { directory = false } = {}) {
  if (directory && value === "") return "";
  if (typeof value !== "string" || !value || /[\\\u0000-\u001f\u007f]/u.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw failure("PR_REVIEW_READ_PATH_INVALID");
  }
  return value.split("/").map(encodeURIComponent).join("/");
}

function page(value, offset, length = 24_000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length ||
      !Number.isSafeInteger(length) || length < 1 || length > 48_000) {
    throw failure("PR_REVIEW_READ_RANGE_INVALID");
  }
  const end = Math.min(value.length, offset + length);
  return { offset, nextOffset: end < value.length ? end : null, totalLength: value.length, text: value.slice(offset, end) };
}

function coversAll(ranges, length) {
  let through = 0;
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    if (start > through) return false;
    through = Math.max(through, end);
  }
  return through >= length;
}

const integer = { type: "integer", minimum: 0 };
const TOOLS = [
  { name: "read_document", description: "Read review-manifest.json or review.diff in successive pages. Use nextOffset until null. review.diff is the complete final three-dot diff, not a series of historical commit patches.", inputSchema: { type: "object", required: ["document", "offset"], additionalProperties: false, properties: { document: { type: "string", enum: ["review-manifest.json", "review.diff"] }, offset: integer, length: { type: "integer", minimum: 1, maximum: 48_000 } } } },
  { name: "read_source", description: "Read any related source file at the pinned head or base commit. Continue with nextOffset for large files. Paths are repository-relative, never host filesystem paths.", inputSchema: { type: "object", required: ["path", "revision", "offset"], additionalProperties: false, properties: { path: { type: "string" }, revision: { type: "string", enum: ["head", "base"] }, offset: integer, length: { type: "integer", minimum: 1, maximum: 48_000 } } } },
  { name: "list_directory", description: "List a repository directory at the pinned head or base to find related source and tests. Use an empty path for the repository root.", inputSchema: { type: "object", required: ["path", "revision"], additionalProperties: false, properties: { path: { type: "string" }, revision: { type: "string", enum: ["head", "base"] } } } },
];
for (const tool of TOOLS) tool.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

// GitHub credentials stay in the parent. The CLI receives only this invocation's
// read endpoint, bound to one PR and immutable commit IDs, with no write tools.
export class GitHubReviewReader {
  constructor({ run = runJson, runText = runCommand } = {}) {
    this.run = run;
    this.runText = runText;
  }

  async open(rawTarget, { signal = null, skillDocuments = {} } = {}) {
    const skills = Object.entries(skillDocuments);
    if (skills.some(([name, value]) => !/^review-skill\/(?:SKILL\.md|manifest\.json|references\/[a-z-]+\.md)$/.test(name) ||
      typeof value !== "string" || Buffer.byteLength(value) > 128 * 1024)) throw failure("PR_REVIEW_READ_DOCUMENT_INVALID");
    const target = normalizeReviewReadTarget(rawTarget);
    const git = target.gitTarget;
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const options = { signal: requestSignal, env: { ...process.env, GH_HOST: "github.com" } };
    const api = (endpoint, extra = []) => ["api", "--hostname", "github.com", endpoint, ...extra];
    const prEndpoint = `repos/${git.baseRepository}/pulls/${target.pullRequestNumber}`;
    const checkTarget = async () => {
      const pr = await this.run("gh", api(prEndpoint), options);
      if (pr.head?.sha !== git.headRefOid || pr.base?.sha !== git.baseRefOid ||
          pr.head?.repo?.full_name?.toLowerCase() !== git.headRepository.toLowerCase() ||
          pr.base?.repo?.full_name?.toLowerCase() !== git.baseRepository.toLowerCase()) {
        throw failure("PR_REVIEW_READ_HEAD_CHANGED");
      }
      return pr;
    };
    const account = await this.run("gh", api("user"), options);
    if (account.login?.toLowerCase() !== git.sourceAccountId) throw failure("PR_REVIEW_READ_ACCOUNT_CHANGED");
    const pr = await checkTarget();
    const downloaded = await Promise.allSettled([
      this.run("gh", api(`${prEndpoint}/files?per_page=100`, ["--paginate", "--slurp"]), options),
      this.runText("gh", api(`repos/${git.baseRepository}/compare/${git.baseRefOid}...${git.headRefOid}`, ["--header", "Accept: application/vnd.github.diff"]), options),
    ]);
    for (const result of downloaded) if (result.status === "rejected") throw result.reason;
    const [pages, diffText] = downloaded.map((result) => result.value);
    if (!Array.isArray(pages) || pages.some((entry) => !Array.isArray(entry))) throw failure("PR_REVIEW_READ_FILES_INVALID");
    const files = pages.flat().map((file) => {
      repositoryPath(file.filename);
      return { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, ...(file.previous_filename ? { previousPath: file.previous_filename } : {}) };
    });
    if (files.length !== pr.changed_files || new Set(files.map((file) => file.path)).size !== files.length) {
      throw failure("PR_REVIEW_READ_FILES_INCOMPLETE");
    }
    if (typeof diffText !== "string" || (files.length > 0 && !diffText.startsWith("diff --git "))) {
      throw failure("PR_REVIEW_READ_DIFF_INVALID");
    }
    if ((diffText.match(/^diff --git /gm) || []).length !== files.length) {
      throw failure("PR_REVIEW_READ_DIFF_INCOMPLETE");
    }
    await checkTarget();
    const manifestText = JSON.stringify({ repository: git.baseRepository, pullRequestNumber: target.pullRequestNumber, base: git.baseRefOid, head: git.headRefOid, changedFiles: files.length, files }, null, 2);
    const documents = { "review-manifest.json": manifestText, "review.diff": diffText, ...Object.fromEntries(skills) };
    const requiredDocuments = ["review-manifest.json", "review.diff", ...skills.filter(([name]) => ["review-skill/SKILL.md", "review-skill/manifest.json"].includes(name)).map(([name]) => name)];
    const reads = Object.fromEntries(Object.keys(documents).map((name) => [name, []]));
    const tools = TOOLS.map((tool) => tool.name === "read_document" ? {
      ...tool, description: "Read a PR or trusted skill document in successive pages, following nextOffset until null.",
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, document: { type: "string", enum: Object.keys(documents) } } },
    } : tool);
    const contentsCache = new Map();
    const sourceCache = new Map();
    const contents = async (filePath, revision, directory = false) => {
      if (!["head", "base"].includes(revision)) throw failure("PR_REVIEW_READ_REVISION_INVALID");
      const encoded = repositoryPath(filePath, { directory });
      const repository = revision === "head" ? git.headRepository : git.baseRepository;
      const oid = revision === "head" ? git.headRefOid : git.baseRefOid;
      const key = `${revision}:${filePath}`;
      if (!contentsCache.has(key)) {
        const pending = this.run("gh", api(`repos/${repository}/contents/${encoded}?ref=${oid}`), options);
        contentsCache.set(key, pending);
        pending.catch(() => contentsCache.delete(key));
      }
      return { value: await contentsCache.get(key), repository };
    };
    const source = (filePath, revision) => {
      const key = `${revision}:${filePath}`;
      if (!sourceCache.has(key)) {
        const pending = (async () => {
          const { value, repository } = await contents(filePath, revision);
          if (value.type !== "file") throw failure("PR_REVIEW_READ_NOT_FILE");
          const file = value.encoding === "base64" ? value : await this.run("gh", api(`repos/${repository}/git/blobs/${value.sha}`), options);
          if (file.encoding !== "base64" || typeof file.content !== "string") throw failure("PR_REVIEW_READ_CONTENT_INVALID");
          const bytes = Buffer.from(file.content, "base64");
          return bytes.includes(0)
            ? { binary: true, bytes: bytes.length }
            : { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
        })();
        sourceCache.set(key, pending);
        pending.catch(() => sourceCache.delete(key));
      }
      return sourceCache.get(key);
    };
    const callTool = async (name, args) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw failure("PR_REVIEW_READ_ARGUMENT_INVALID");
      if (name === "read_document") {
        if (!Object.hasOwn(documents, args.document)) throw failure("PR_REVIEW_READ_DOCUMENT_INVALID");
        const result = page(documents[args.document], args.offset, args.length);
        reads[args.document].push([result.offset, result.offset + result.text.length]);
        return result;
      }
      if (name === "read_source") {
        const value = await source(args.path, args.revision);
        if (value.binary) return { ...value, path: args.path, revision: args.revision };
        return { path: args.path, revision: args.revision, ...page(value.text, args.offset, args.length) };
      }
      if (name === "list_directory") {
        const { value } = await contents(args.path, args.revision, true);
        if (!Array.isArray(value)) throw failure("PR_REVIEW_READ_NOT_DIRECTORY");
        return { entries: value.map((entry) => ({ path: entry.path, type: entry.type })) };
      }
      throw failure("PR_REVIEW_READ_TOOL_NOT_ALLOWED");
    };

    const endpointPath = `/review/${randomBytes(32).toString("hex")}`;
    const server = createServer(async (request, response) => {
      if (request.url !== endpointPath || request.headers.origin || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      let message;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw failure("PR_REVIEW_READ_ARGUMENT_INVALID");
          chunks.push(chunk);
        }
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (message.jsonrpc !== "2.0") throw failure("PR_REVIEW_READ_ARGUMENT_INVALID");
        if (!Object.hasOwn(message, "id")) { response.writeHead(202).end(); return; }
        let result;
        if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mydashboard-pr-review", version: "1.0.0" } };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools };
        else if (message.method === "tools/call") {
          try {
            const value = await callTool(message.params?.name, message.params?.arguments);
            result = { content: [{ type: "text", text: JSON.stringify(value) }] };
          } catch (error) {
            result = { isError: true, content: [{ type: "text", text: /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : "PR_REVIEW_READ_FAILED" }] };
          }
        } else throw failure("PR_REVIEW_READ_METHOD_NOT_ALLOWED");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid request" } }));
      }
    });
    server.requestTimeout = 60_000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    let closing;
    const onAbort = () => { void close(); };
    const close = () => closing ??= (async () => {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    })();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) { await close(); requestSignal.throwIfAborted(); }
    return {
      url: `http://127.0.0.1:${server.address().port}${endpointPath}`,
      diffText, manifestText,
      async assertComplete() {
        if (requiredDocuments.some((name) => !coversAll(reads[name], documents[name].length))) {
          throw failure("PR_REVIEW_READ_INCOMPLETE");
        }
        await checkTarget();
      },
      close,
    };
  }
}
