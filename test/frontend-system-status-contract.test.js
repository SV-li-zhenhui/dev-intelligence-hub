import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { renderSystemStatus } from "../public/system-status-view.js";

const root = path.resolve(import.meta.dirname, "..");

function statusState() {
  return {
    liveness: { schemaVersion: 1, live: true },
    readiness: {
      schemaVersion: 1,
      checkedAt: "2026-08-08T01:02:03.004Z",
      ready: false,
      recoveryBlockers: [{ probeId: "recovery", code: "STORE_RECOVERY_PENDING" }],
      unknownExternalActions: [{
        probeId: "external",
        actionType: "github.pull-request-merge",
      }],
      capacityWarnings: [{
        probeId: "storage",
        resource: "data_volume",
        severity: "critical",
        usedPercent: 98.9,
      }],
      probeFailures: [{ probeId: "secondary", code: "PROBE_TIMEOUT" }],
    },
    maintenance: { mode: "open", activeOperations: 2 },
    pullRequestDiscovery: {
      available: true,
      enabled: true,
      refreshedAt: "2026-08-13T01:02:03.004Z",
      complete: true,
      stale: false,
      effectiveUpdatedWindow: {
        mode: "rolling",
        days: 7,
        refreshStartedAt: "2026-08-13T01:02:03.004Z",
        fromInclusive: "2026-08-06T01:02:03.004Z",
      },
    },
    backups: {
      available: true,
      items: [{
        backupId: "backup-safe",
        createdAt: "2026-08-08T00:00:00.000Z",
        fileCount: 5,
        totalBytes: 2048,
      }],
    },
  };
}

test("system status presents every API blocker without inventing controls", () => {
  const markup = renderSystemStatus({ state: statusState() });

  for (const value of [
    "Liveness",
    "Readiness",
    "恢复流程尚未完成",
    "保持岗位暂停",
    "STORE_RECOVERY_PENDING",
    "合并 PR",
    "不要手动重试",
    "github.pull-request-merge",
    "数据卷",
    "立即释放空间",
    "data_volume",
    "98.9%",
    "健康检查超时",
    "PROBE_TIMEOUT",
    "backup-safe",
    "重新检查",
    "创建备份",
    "PR 自动发现",
    "完整",
    "近 7 天",
    "2026-08-06T01:02:03.004Z",
  ]) {
    assert.equal(markup.includes(value), true, value);
  }
  assert.match(markup, /class="system-status-issue"/u);
  assert.doesNotMatch(markup, /data-system-backup-restore|data-system-restart/u);
});

test("system status escapes probe and backup output", () => {
  const state = statusState();
  state.readiness.recoveryBlockers[0].code = "<img src=x onerror=alert(1)>";
  state.backups.items[0].backupId = "<script>unsafe</script>";
  const markup = renderSystemStatus({ state });

  assert.doesNotMatch(markup, /<img|<script>/u);
  assert.match(markup, /&lt;img/u);
  assert.match(markup, /&lt;script&gt;/u);
});

test("dashboard wires system status as a separately loaded view", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(path.join(root, "public", "index.html"), "utf8"),
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "public", "styles.css"), "utf8"),
  ]);

  assert.match(html, /data-view="system"/u);
  assert.match(app, /from "\.\/system-status-view\.js"/u);
  assert.match(app, /fetch\("\/api\/system\/status"/u);
  assert.match(app, /fetch\("\/api\/system\/backups"/u);
  assert.match(
    app,
    /fetch\("\/api\/system\/backups",\s*\{[\s\S]*?"content-type": "application\/json"[\s\S]*?body: "\{\}"/u,
  );
  assert.match(app, /currentView === "system"/u);
  assert.match(styles, /\.system-status-grid/u);
  assert.match(
    styles,
    /\.system-status-backups li strong\s*\{[^}]*display:\s*block;[^}]*overflow-wrap:\s*anywhere;/u,
  );
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.system-status-grid/u);
});
