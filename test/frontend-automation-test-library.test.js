import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("automation test library is a first-class navigation view", () => {
  assert.match(html, /data-view="automation-tests"/u);
  assert.match(html, />自动化测试库</u);
  assert.match(app, /"automation-tests": "自动化测试库"/u);
  assert.match(app, /automationTestsView/u);
});

test("test library cards disclose reuse bindings, versions, and immutable source", () => {
  assert.match(app, /asset\.version/u);
  assert.match(app, /requiredProfilesByWorkspace/u);
  assert.match(app, /workspaceByRepository/u);
  assert.match(app, /查看受版本保护的脚本/u);
  assert.match(app, /data-automation-test-source/u);
  assert.match(app, /activeAutomationTestSource/u);
  assert.match(app, /code\.textContent = activeAutomationTestSource/u);
  assert.match(app, /runtimeEffective\?\.configuration/u);
  assert.match(app, /已保存，等待重启/u);
  assert.match(app, /本页卡片仅表示当前运行时实际执行的配置/u);
  assert.doesNotMatch(app, /<pre><code>\$\{escapeHtml\(asset\.source\)\}/u);
  assert.match(styles, /\.automation-test-library/u);
  assert.match(styles, /\.automation-test-card/u);
});
