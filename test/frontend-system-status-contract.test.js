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
    "STORE_RECOVERY_PENDING",
    "github.pull-request-merge",
    "data_volume",
    "98.9%",
    "PROBE_TIMEOUT",
    "backup-safe",
    "创建备份",
  ]) {
    assert.equal(markup.includes(value), true, value);
  }
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
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.system-status-grid/u);
});
