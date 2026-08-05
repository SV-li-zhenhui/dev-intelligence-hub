import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = app.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} must have a body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}") depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  assert.fail(`${name} must have a complete body`);
}

test("configuration center is a first-class view with an accessible editor", () => {
  assert.match(html, /data-view="configuration"/);
  assert.match(html, />配置中心</);
  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /configuration: "配置中心"/);
  assert.match(app, /id="configuration-editor-form"/);
  assert.match(app, /<label for="configuration-document">/);
  assert.match(app, /aria-invalid=/);
  assert.match(styles, /\.configuration-editor textarea:focus-visible/);
  assert.match(styles, /\.configuration-actions button:focus-visible/);
});

test("configuration and confirmation loading do not depend on a dashboard snapshot", () => {
  const load = functionSource("load");
  const applyConfiguration = functionSource("applyConfigurationState");
  const showNext = functionSource("showNextConfirmation");
  const pending = functionSource("pendingConfirmations");

  assert.match(app, /configurationFetch\("\/api\/configuration"/);
  assert.match(
    load,
    /if \(!hasConfigurationState\(\) \|\| currentView === "configuration"\)/,
  );
  assert.match(applyConfiguration, /sameConfigurationRevision/);
  assert.match(app, /isCurrentConfigurationRequest/);
  assert.match(app, /configurationFetch/);
  assert.ok(
    load.indexOf("applyConfirmationQueue") <
      load.indexOf("if (!nextDashboard)"),
  );
  assert.ok(
    load.indexOf("queueMicrotask(showNextConfirmation)") <
      load.indexOf("if (!nextDashboard)"),
  );
  assert.doesNotMatch(showNext, /!dashboard/);
  assert.match(pending, /const responsibilities = dashboard/);
  assert.match(pending, /: dashboard\s*\?/);
});

test("configuration navigation refreshes by identity instead of a positional shortcut", () => {
  const activate = functionSource("activateView");

  assert.match(activate, /currentView === "configuration"/);
  assert.match(activate, /void loadConfiguration\(\);/);
  assert.match(app, /if \(event\.key === "0"\) \{\s*activateView\("configuration"\);/);
  assert.doesNotMatch(app, /querySelectorAll\("\.nav-item"\)\[9\]/);
});

test("initialization editor uses only the bounded draft REST contract", () => {
  const save = functionSource("handleConfigurationSave");
  const preview = functionSource("handleConfigurationPreview");
  const request = functionSource("handleConfigurationRequest");
  const mutationSources = `${save}\n${preview}\n${request}`;

  assert.match(save, /"\/api\/configuration\/drafts"/);
  assert.match(save, /method: draftId \? "PUT" : "POST"/);
  assert.match(
    save,
    /\{ expectedDraftRevision, expectedStateRevision, configuration \}/,
  );
  assert.match(save, /\{ expectedStateRevision, configuration \}/);
  assert.match(preview, /\/preview`/);
  assert.match(
    preview,
    /JSON\.stringify\(\{\s*draftRevision: draft\.revision,\s*expectedStateRevision,\s*\}\)/,
  );
  assert.match(request, /\/request-confirmation`/);
  assert.match(
    request,
    /JSON\.stringify\(\{\s*draftRevision: draft\.revision,\s*expectedStateRevision,\s*\}\)/,
  );
  assert.doesNotMatch(mutationSources, /\/api\/configuration\/(?:activate|rollback|enqueue)/);
  assert.doesNotMatch(
    mutationSources,
    /\b(?:activatedBy|executor|plan|action)\s*:/,
  );
});

test("configuration initialization reuses the immutable one-at-a-time dialog", () => {
  const router = functionSource("showExternalActionConfirmation");
  const renderer = functionSource("showConfigurationActivationConfirmation");
  const impactMarkup = functionSource("configurationImpactMarkup");

  assert.match(router, /entry\.item\?\.kind === "local\.configuration-activate"/);
  assert.match(
    router,
    /entry\.item\?\.display\?\.payload\?\.action\?\.type ===\s*"initialize_from_draft"/,
  );
  for (const label of [
    "保存版本",
    "初始化草稿",
    "状态修订",
    "配置摘要",
    "验证摘要",
    "逐项影响",
    "不会自动重启服务",
  ]) {
    assert.equal(renderer.includes(label), true, label);
  }
  assert.match(renderer, /handleExternalConfirmation/);
  assert.match(impactMarkup, /category\.count/);
  assert.doesNotMatch(renderer, /data-external-operation="execute"/);
});

test("completed v1 reports a manual restart boundary without a restart endpoint", () => {
  const handler = functionSource("handleExternalConfirmation");

  assert.match(handler, /confirmationResult\?\.item\?\.status === "completed"/);
  assert.match(handler, /configurationNotice = "已保存，重启服务后生效"/);
  assert.match(app, /系统不会自动重启/);
  assert.doesNotMatch(app, /fetch\([^\n]*(?:restart|reboot)/i);
});
