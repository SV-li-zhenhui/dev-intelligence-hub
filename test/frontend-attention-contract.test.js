import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function sources() {
  const [html, app] = await Promise.all([
    readFile(path.resolve(testDirectory, "../public/index.html"), "utf8"),
    readFile(path.resolve(testDirectory, "../public/app.js"), "utf8"),
  ]);
  return { html, app };
}

test("all attention sources share one dialog and one unified next endpoint", async () => {
  const { html, app } = await sources();

  assert.equal((html.match(/<dialog\b/g) || []).length, 2);
  assert.match(
    html,
    /<dialog id="detail-dialog" aria-label="详情">/,
  );
  assert.match(
    html,
    /<dialog id="confirmation-dialog" aria-label="待确认操作">/,
  );
  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /fetch\(attentionNextUrl\(\)/);
  assert.doesNotMatch(app, /fetch\("\/api\/confirmations\/next"/);
  assert.match(app, /source === "external_confirmation"/);
  assert.match(app, /source === "internal_request"/);
});

test("session deferrals are bounded and sent as exact source bindings", async () => {
  const { app } = await sources();

  assert.match(app, /const MAX_DEFERRED_CONFIRMATIONS = 32/);
  assert.match(app, /function rememberDeferredConfirmation/);
  assert.match(app, /while \(deferredConfirmations\.size > MAX_DEFERRED_CONFIRMATIONS\)/);
  assert.match(app, /params\.append\("deferred", `\$\{source\}:\$\{id\}:\$\{digest\}`\)/);
  assert.match(app, /async function refreshAfterDeferral/);
});

test("deferred confirmations have a visible retry control with failure-safe recovery", async () => {
  const { app } = await sources();

  assert.match(app, /id="confirmation-deferred-restore"/);
  assert.match(app, /重新查看稍后项/);
  assert.match(app, /deferredConfirmations\.size/);
  assert.match(app, /async function restoreDeferredConfirmations/);
  const start = app.indexOf("async function restoreDeferredConfirmations");
  const end = app.indexOf("\nasync function refreshAfterDeferral", start);
  const restore = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(
    restore.indexOf("deferredConfirmations.clear()") <
      restore.indexOf("await refreshConfirmationQueue"),
  );
  assert.match(restore, /catch \(error\)[\s\S]*rememberDeferredConfirmation/);
  assert.match(restore, /queueMicrotask\(showNextConfirmation\)/);
});

test("internal renderer cannot manufacture an external action control", async () => {
  const { app } = await sources();
  const start = app.indexOf("function showInternalAttention");
  const end = app.indexOf("function showReviewDraftConfirmation", start);
  assert.ok(start >= 0 && end > start);
  const internalRenderer = app.slice(start, end);

  assert.match(internalRenderer, /data-internal-choice/);
  assert.match(internalRenderer, /data-internal-operation="reject"/);
  assert.match(internalRenderer, /data-internal-operation="later"/);
  assert.match(internalRenderer, /escapeHtml\(item\.question/);
  assert.doesNotMatch(internalRenderer, /data-external-operation/);
  assert.doesNotMatch(internalRenderer, /\/api\/confirmations\//);
});

test("internal answers bind revision and digest and later is server-validated", async () => {
  const { app } = await sources();
  const start = app.indexOf("async function submitInternalAttention");
  const end = app.indexOf("function handleInternalAttentionClick", start);
  assert.ok(start >= 0 && end > start);
  const submitter = app.slice(start, end);

  assert.match(submitter, /encodeURIComponent\(item\.requestId\)/);
  assert.match(submitter, /expectedRevision:\s*item\.revision/);
  assert.match(submitter, /contentDigest:\s*item\.contentDigest/);
  assert.match(submitter, /operation === "later"/);
  assert.match(submitter, /response\.status === 409/);
  assert.match(submitter, /invalidateConfirmationQueueSnapshot/);
});

test("external actions retain their separate confirmation endpoint", async () => {
  const { app } = await sources();

  assert.match(
    app,
    /`\/api\/confirmations\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{operation\}`/,
  );
  assert.match(app, /approvalBindingDigest:\s*item\.approvalBindingDigest/);
  assert.match(app, /displayedPayloadDigest:\s*item\.displayedPayloadDigest/);
});
