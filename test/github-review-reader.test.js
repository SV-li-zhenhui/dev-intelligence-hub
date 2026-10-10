import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReviewReader } from "../src/adapters/github-review-reader.js";

const TARGET = { pullRequestNumber: 42, gitTarget: {
  schemaVersion: 1, provider: "github", sourceAccountId: "reviewer",
  baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40),
  headRepository: "contributor/repo", headRefName: "feature", headRefOid: "b".repeat(40),
} };

function fixture({ changed = 117, moved = false, missingFile = false, missingDiff = false } = {}) {
  const calls = [];
  const files = Array.from({ length: changed }, (_, i) => ({ filename: `src/${i}.js`, status: "modified", additions: 2, deletions: 1 }));
  const diff = files.slice(0, missingDiff ? -1 : undefined).map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n-old\n+${"new ".repeat(180)}\n`).join("");
  let metadataCalls = 0;
  const run = async (command, args) => {
    assert.equal(command, "gh");
    calls.push(args);
    const endpoint = args[3];
    if (endpoint === "user") return { login: "reviewer" };
    if (endpoint === "repos/acme/repo/pulls/42") {
      metadataCalls += 1;
      return { changed_files: changed, head: { sha: moved && metadataCalls > 1 ? "c".repeat(40) : TARGET.gitTarget.headRefOid, repo: { full_name: "contributor/repo" } }, base: { sha: TARGET.gitTarget.baseRefOid, repo: { full_name: "acme/repo" } } };
    }
    if (endpoint === "repos/acme/repo/pulls/42/files?per_page=100") {
      assert.ok(args.includes("--paginate"));
      return [files.slice(0, 100), files.slice(100, missingFile ? -1 : undefined)];
    }
    if (endpoint.includes("/contents/")) {
      if (endpoint.includes("/contents/?")) return [{ type: "file", path: "src/related.js" }];
      return { type: "file", encoding: "base64", content: Buffer.from("related implementation\n").toString("base64") };
    }
    throw new Error("unexpected fixture request");
  };
  const runText = async (command, args) => {
    calls.push(args);
    assert.ok(args.includes("Accept: application/vnd.github.diff"));
    assert.match(args[3], new RegExp(`${TARGET.gitTarget.baseRefOid}\\.\\.\\.${TARGET.gitTarget.headRefOid}$`));
    return diff;
  };
  return { reader: new GitHubReviewReader({ run, runText }), files, diff, calls };
}

async function rpc(session, method, params = {}) {
  const response = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

async function tool(session, name, args) {
  const result = await rpc(session, "tools/call", { name, arguments: args });
  if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
  return JSON.parse(result.content[0].text);
}

test("CLI can page through all 117 files and a diff beyond the old prompt budget", async (t) => {
  const f = fixture();
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  assert.ok(session.diffText.length > 60_000);
  assert.equal(JSON.parse(session.manifestText).files.length, 117);
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const init = await rpc(session, "initialize", { protocolVersion: "2024-11-05" });
  assert.ok(init.capabilities.tools);
  assert.deepEqual((await rpc(session, "tools/list")).tools.map((x) => x.name), ["read_document", "read_source", "list_directory"]);
  for (const [document, expected] of [["review-manifest.json", session.manifestText], ["review.diff", f.diff]]) {
    let offset = 0;
    let text = "";
    do {
      const page = await tool(session, "read_document", { document, offset, length: 8_000 });
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(text, expected);
  }
  await session.assertComplete();
  const related = await tool(session, "read_source", { path: "src/related.js", revision: "head", offset: 0 });
  assert.equal(related.text, "related implementation\n");
  assert.ok(f.calls.some((args) => args[3] === `repos/contributor/repo/contents/src/related.js?ref=${TARGET.gitTarget.headRefOid}`));
  assert.equal((await tool(session, "list_directory", { path: "", revision: "base" })).entries[0].path, "src/related.js");
});

test("partial documents, including a skipped middle range, cannot complete a review", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  await tool(session, "read_document", { document: "review-manifest.json", offset: 0, length: 48_000 });
  await tool(session, "read_document", { document: "review.diff", offset: 0, length: 1_000 });
  for (let offset = 2_000; offset < session.diffText.length; offset += 48_000) {
    await tool(session, "read_document", { document: "review.diff", offset, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
});

test("the read endpoint rejects host paths, unpinned revisions, and write tools", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  for (const path of ["../auth.json", "C:\\private\\token", "/etc/passwd", "src//secret"]) {
    await assert.rejects(tool(session, "read_source", { path, revision: "head", offset: 0 }), { code: "PR_REVIEW_READ_PATH_INVALID" });
  }
  await assert.rejects(tool(session, "read_source", { path: "a.js", revision: "main", offset: 0 }), { code: "PR_REVIEW_READ_REVISION_INVALID" });
  await assert.rejects(tool(session, "write_file", { path: "a.js", text: "change" }), { code: "PR_REVIEW_READ_TOOL_NOT_ALLOWED" });
  assert.equal((await fetch(session.url.replace(/review\/.+$/, "review/wrong"), { method: "POST" })).status, 404);
});

test("a changed Head or incomplete GitHub response is rejected before a CLI can review it", async () => {
  for (const options of [{ moved: true }, { missingFile: true }, { missingDiff: true }]) {
    await assert.rejects(fixture(options).reader.open(TARGET), { code: options.moved ? "PR_REVIEW_READ_HEAD_CHANGED" : options.missingFile ? "PR_REVIEW_READ_FILES_INCOMPLETE" : "PR_REVIEW_READ_DIFF_INCOMPLETE" });
  }
});

test("cancellation closes the read endpoint and releases its listener", async () => {
  const controller = new AbortController();
  const session = await fixture().reader.open(TARGET, { signal: controller.signal });
  controller.abort();
  await session.close();
  await assert.rejects(fetch(session.url));
});

test("source paging reuses the decoded immutable blob and retries a failed fetch", async (t) => {
  const f = fixture({ changed: 1 });
  const original = f.reader.run;
  const source = "related implementation\n".repeat(5_000);
  let blobs = 0;
  f.reader.run = async (command, args, options) => {
    if (args[3].includes("/contents/src/large.js")) return { type: "file", encoding: "none", sha: "c".repeat(40) };
    if (args[3].includes("/git/blobs/")) {
      blobs += 1;
      if (blobs === 1) throw new Error("temporary upstream error");
      return { encoding: "base64", content: Buffer.from(source).toString("base64") };
    }
    return original(command, args, options);
  };
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  const args = { path: "src/large.js", revision: "head", offset: 0 };
  await assert.rejects(tool(session, "read_source", args), { code: "PR_REVIEW_READ_FAILED" });
  let text = "", offset = 0;
  do {
    const result = await tool(session, "read_source", { ...args, offset });
    text += result.text;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(text, source);
  assert.equal(blobs, 2);
});
