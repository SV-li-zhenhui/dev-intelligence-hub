import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("the dashboard keeps one confirmation dialog for local and external decisions", async () => {
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /kind: "external_action"/);
  assert.match(app, /kind: "responsibility"/);
  assert.match(app, /kind: "review_draft"/);
  assert.equal(app.includes("showReviewDraftConfirmation"), true);
  assert.equal(app.includes("/api/pr-review-jobs/decide"), true);
  assert.match(
    app,
    /const legacyReviewDrafts = confirmationQueueState\.available\s*\? \[\]/,
  );
});

test("external confirmation renders the exact authorization context", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  for (const visibleLabel of [
    "执行账号",
    "目标",
    "绑定 Head",
    "Review 类型",
    "将发布的完整正文",
    "依据",
    "确认并发布到 GitHub",
  ]) {
    assert.equal(app.includes(visibleLabel), true, visibleLabel);
  }
  assert.match(
    app,
    /external\\u0000\$\{confirmationQueueState\.item\.id\}\\u0000\$\{confirmationQueueState\.item\.approvalBindingDigest\}/,
  );
});

test("browser mutations send binding metadata and never submit an action payload", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const end = app.indexOf("\nfunction updateChrome", start);
  const handler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /requestId: crypto\.randomUUID\(\)/);
  assert.match(handler, /expectedQueueRevision: item\.queueRevision/);
  assert.match(handler, /expectedItemRevision: item\.itemRevision/);
  assert.match(handler, /displayedPayloadDigest: item\.displayedPayloadDigest/);
  assert.match(handler, /approvalBindingDigest: item\.approvalBindingDigest/);
  assert.equal(handler.includes("action: item"), false);
  assert.equal(handler.includes("body: action"), false);
});

test("later closes the popup without entering the mutation branch", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const fetchStart = app.indexOf("const response = await fetch", start);
  const laterBranch = app.slice(start, fetchStart);

  assert.match(laterBranch, /if \(operation === "later"\)/);
  assert.match(laterBranch, /confirmationDialog\.close\(\)/);
  assert.match(laterBranch, /return;/);
  assert.equal(laterBranch.includes("fetch("), false);
});

test("a conflict hides the stale snapshot until a fresh queue read succeeds", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const end = app.indexOf("\nasync function handleReviewDraftDecision", start);
  const handler = app.slice(start, end);
  const conflict = handler.slice(
    handler.indexOf("if (response.status === 409)"),
    handler.indexOf("if (!response.ok)"),
  );

  assert.match(conflict, /invalidateConfirmationQueueSnapshot\(\)/);
  assert.match(conflict, /await refreshConfirmationQueue/);
  assert.ok(
    conflict.indexOf("invalidateConfirmationQueueSnapshot()") <
      conflict.indexOf("await refreshConfirmationQueue"),
  );
  assert.match(conflict, /成功读取最新确认内容前不会再次弹出/);
});
