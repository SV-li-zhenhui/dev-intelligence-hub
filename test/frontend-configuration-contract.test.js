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

test("configuration center is a first-class view with an accessible structured form", () => {
  assert.match(html, /data-view="configuration"/);
  assert.match(html, />配置中心</);
  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /configuration: "配置中心"/);
  assert.match(app, /renderConfigurationSettingsSkeleton/);
  assert.match(app, /createConfigurationFormState/);
  assert.match(app, /configurationDocumentFromForm/);
  assert.match(app, /bindConfigurationFormController/);
  assert.doesNotMatch(app, /<textarea[^>]+configuration-document/);
  assert.doesNotMatch(app, /configurationEditorValue|parsedConfigurationDocument/);
  assert.match(styles, /\.configuration-structured-field/);
  assert.match(styles, /\[data-configuration-field\]:focus-visible/);
  assert.match(styles, /\.configuration-actions button:focus-visible/);
});

test("configuration save is registered after the structured controller submit guard", () => {
  const source = functionSource("bindConfigurationView");
  const controller = source.indexOf("bindConfigurationFormController({");
  const save = source.indexOf(
    'form?.addEventListener("submit", handleConfigurationSave)',
  );
  assert.ok(controller >= 0);
  assert.ok(save > controller);
});

test("configuration and confirmation loading do not depend on a dashboard snapshot", () => {
  const load = functionSource("load");
  const loadConfigurationBackedView = functionSource(
    "loadConfigurationBackedView",
  );
  const applyDashboard = functionSource("applyDashboard");
  const applyConfiguration = functionSource("applyConfigurationState");
  const showNext = functionSource("showNextConfirmation");
  const pending = functionSource("pendingConfirmations");

  assert.match(app, /configurationFetch\("\/api\/configuration"/);
  assert.match(
    load,
    /if \(isConfigurationBackedView\(\)\)/,
  );
  assert.match(load, /await loadConfigurationBackedView\(\{ showConfirmation \}\)/);
  assert.match(loadConfigurationBackedView, /loadConfiguration\(\)/);
  assert.match(loadConfigurationBackedView, /loadBrainProviderStatus\(\)/);
  assert.match(loadConfigurationBackedView, /refreshConfirmationQueue\(\{/);
  assert.match(applyConfiguration, /sameConfigurationRevision/);
  assert.match(applyDashboard, /\{ renderView = true \}/);
  assert.match(applyDashboard, /if \(renderView\) render\(\)/);
  assert.match(
    load,
    /if \(isConfigurationBackedView\(\)\) \{[\s\S]*?return;[\s\S]*?fetchDashboard\(\)/,
  );
  assert.match(app, /isCurrentConfigurationRequest/);
  assert.match(app, /configurationFetch/);
  assert.ok(
    load.indexOf("applyConfirmationQueue") <
      load.indexOf("if (!dashboardResult.value)"),
  );
  assert.ok(
    load.indexOf("queueMicrotask(showNextConfirmation)") <
      load.indexOf("if (!dashboardResult.value)"),
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

test("configuration editor uses only the bounded staged lifecycle contract", () => {
  const save = functionSource("handleConfigurationSave");
  const preview = functionSource("handleConfigurationPreview");
  const request = functionSource("handleConfigurationRequest");
  const binding = functionSource("requiredConfigurationBinding");
  const rollbackPreview = functionSource("handleConfigurationRollbackPreview");
  const rollbackRequest = functionSource("handleConfigurationRollbackRequest");
  const mutationSources = `${save}\n${preview}\n${request}\n${rollbackPreview}\n${rollbackRequest}`;

  assert.match(save, /"\/api\/configuration\/drafts"/);
  assert.match(save, /method: draftId \? "PUT" : "POST"/);
  assert.match(save, /configurationAuthorityBinding/);
  assert.match(preview, /\/preview`/);
  assert.match(preview, /requiredConfigurationBinding/);
  assert.match(request, /\/request-confirmation`/);
  assert.match(request, /requiredConfigurationBinding/);
  assert.match(binding, /configurationAuthorityBinding/);
  assert.match(
    rollbackPreview,
    /\/api\/configuration\/versions\/\$\{targetVersion\}\/rollback\/preview/,
  );
  assert.match(
    rollbackRequest,
    /\/api\/configuration\/versions\/\$\{targetVersion\}\/rollback\/request-confirmation/,
  );
  assert.doesNotMatch(
    mutationSources,
    /\/api\/configuration\/(?:activate|rollback|enqueue)(?:["'`/]|$)/,
  );
  assert.doesNotMatch(
    mutationSources,
    /\b(?:activatedBy|executor|plan|action)\s*:/,
  );
});

test("all configuration activations reuse the immutable one-at-a-time dialog", () => {
  const router = functionSource("showExternalActionConfirmation");
  const renderer = functionSource("showConfigurationActivationConfirmation");
  const impactMarkup = functionSource("configurationImpactMarkup");

  assert.match(router, /entry\.item\?\.kind === "local\.configuration-activate"/);
  assert.match(router, /configurationActivationActions/);
  for (const actionType of [
    "initialize_from_draft",
    "activate_draft",
    "activate_rollback",
  ]) {
    assert.match(app, new RegExp(`${actionType}: Object\\.freeze`));
  }
  for (const label of [
    "保存版本",
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

test("active configuration view exposes version history and staged rollback controls", () => {
  const view = functionSource("configurationView");
  const versions = functionSource("configurationVersionsMarkup");
  const binding = functionSource("configurationAuthorityBinding");

  assert.match(view, /!safeMode && activeVersion !== null/);
  assert.doesNotMatch(view, /在线草稿激活和回滚尚未开放/);
  assert.match(view, /configurationVersionsMarkup/);
  assert.match(versions, /data-configuration-rollback-preview/);
  assert.match(versions, /data-configuration-rollback-request/);
  assert.match(binding, /expectedActiveVersion/);
  assert.match(styles, /\.configuration-version-actions button:focus-visible/);
});

test("configuration interactions invalidate stale previews and preserve active editing", () => {
  const view = functionSource("configurationView");
  const input = functionSource("handleConfigurationFormInvalidate");
  const invalidate = functionSource("invalidateConfigurationPreviewUi");
  const applyConfiguration = functionSource("applyConfigurationState");
  const preserveFocus = functionSource(
    "renderConfigurationPreservingEditorFocus",
  );
  const operation = functionSource("runConfigurationOperation");
  const versions = functionSource("configurationVersionsMarkup");

  assert.match(view, /const activationPreviewReady/);
  assert.match(view, /!activationPreviewReady \? "disabled" : ""/);
  assert.match(input, /invalidateConfigurationPreviewUi\(\)/);
  assert.match(invalidate, /configurationPreview = null/);
  assert.match(invalidate, /querySelector\("\.configuration-preview"\)\?\.remove\(\)/);
  assert.match(invalidate, /data-configuration-operation-notice/);
  assert.match(invalidate, /data-configuration-rollback-request/);
  assert.match(invalidate, /button\.disabled = true/);
  assert.match(applyConfiguration, /const runtimeUnchanged/);
  assert.match(
    applyConfiguration,
    /\(!runtimeUnchanged \|\| hadLoadError\)/,
  );
  assert.match(
    applyConfiguration,
    /renderConfigurationPreservingEditorFocus\(\)/,
  );
  assert.match(preserveFocus, /data-configuration-field/);
  assert.match(preserveFocus, /\.focus\(/);
  assert.match(operation, /\{ editorError = true, focusSelector = null \}/);
  assert.match(operation, /configurationOperationError = error\.message/);
  assert.match(versions, /aria-label="预览回滚到 v\$\{versionNumber\}"/);
  assert.match(
    versions,
    /aria-label="请求回滚到 v\$\{versionNumber\} 的确认"/,
  );
});

test("a stale draft save keeps local typed form state behind an explicit reset", () => {
  const view = functionSource("configurationView");
  const save = functionSource("handleConfigurationSave");
  const reset = functionSource("resetConfigurationEditor");

  assert.match(save, /configurationEditorStale = true/);
  assert.match(view, /放弃本地编辑并载入最新配置/);
  assert.match(view, /configurationEditorStale \? "disabled" : ""/);
  assert.match(reset, /configurationEditorStale = false/);
  assert.match(reset, /const binding = currentConfigurationBinding\(\)/);
  assert.match(reset, /configurationEditorBinding = binding/);
  assert.match(reset, /createConfigurationFormState/);
});

test("configuration save materializes the bounded form and preserves 409 state", () => {
  const save = functionSource("handleConfigurationSave");
  const applyConfiguration = functionSource("applyConfigurationState");

  assert.match(save, /configurationDocumentFromForm/);
  assert.match(save, /materialized\.configuration/);
  assert.match(save, /configurationEditorStale = true/);
  assert.match(applyConfiguration, /!configurationEditorDirty/);
  assert.doesNotMatch(save, /JSON\.parse/);
  assert.doesNotMatch(app, /configuration-document/);
});

test("completed v1 reports a manual restart boundary without a restart endpoint", () => {
  const handler = functionSource("handleExternalConfirmation");

  assert.match(handler, /confirmationResult\?\.item\?\.status === "completed"/);
  assert.match(handler, /configurationNotice = "已保存，重启服务后生效"/);
  assert.match(app, /系统不会自动重启/);
  assert.doesNotMatch(app, /fetch\([^\n]*(?:restart|reboot)/i);
});
