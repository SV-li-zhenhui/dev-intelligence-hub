import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scheduled refresh keeps a bounded diagnostic log without dumping dashboard data", async () => {
  const script = await readFile(
    path.join(root, "scripts", "Refresh-And-Notify.ps1"),
    "utf8",
  );

  assert.match(script, /\$maximumLogBytes\s*=\s*5MB/);
  assert.match(script, /\$maximumArchives\s*=\s*5/);
  assert.match(script, /function Rotate-LogFile/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.doesNotMatch(script, /\$result\s*\|\s*ConvertTo-Json/);
  assert.doesNotMatch(script, /\$_\s*\|\s*Out-String/);
  assert.match(script, /Get-ConfiguredPort/);
  assert.match(script, /api\/live/);
  assert.doesNotMatch(script, /127\.0\.0\.1:4173/);
  assert.match(script, /X-MyDashboard-Action/);
  assert.doesNotMatch(script, /Start-Process|npm\s+(?:start|run)|node\s+src/);
});

test("process management is PID and health bound and never kills an arbitrary listener", async () => {
  const manager = await readFile(
    path.join(root, "scripts", "Manage-MyDashboard.ps1"),
    "utf8",
  );
  const starter = await readFile(
    path.join(root, "scripts", "Start-MyDashboard.ps1"),
    "utf8",
  );
  const launcher = await readFile(
    path.join(root, "scripts", "launch-mydashboard-process.mjs"),
    "utf8",
  );
  const managedEntry = await readFile(
    path.join(root, "scripts", "run-managed-dashboard.mjs"),
    "utf8",
  );

  assert.match(
    manager,
    /ValidateSet\("Start", "Stop", "Restart", "Status", "Restore"\)/,
  );
  assert.match(manager, /processStartTime/);
  assert.match(manager, /Liveness\.service -ne "mydashboard"/);
  assert.match(manager, /Liveness\.processId/);
  assert.match(manager, /Liveness\.instanceId/);
  assert.match(manager, /Liveness\.startIdentity/);
  assert.match(manager, /api\/live/);
  assert.match(manager, /api\/system\/claim/);
  assert.match(manager, /api\/system\/shutdown/);
  assert.match(manager, /X-MyDashboard-Control-Token/);
  assert.match(manager, /Flush\(\$true\)/);
  assert.match(manager, /private runtime/i);
  assert.match(manager, /System\.Threading\.Mutex/);
  assert.match(manager, /WaitOne/);
  assert.match(manager, /it was not force-killed and control state was retained/);
  assert.doesNotMatch(manager, /taskkill|Stop-Process\s+-Name|Get-NetTCPConnection.*Stop-Process/);
  assert.match(manager, /launch-mydashboard-process\.mjs/);
  assert.match(manager, /manage-offline-restore\.mjs/);
  assert.match(manager, /Assert-OfflineRestoreAllowed/);
  assert.match(manager, /Invoke-OfflineRestoreRecoveryIfPresent/);
  assert.match(manager, /MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST/);
  assert.match(launcher, /detached: true/);
  assert.match(launcher, /windowsHide: true/);
  assert.match(launcher, /stdio: "ignore"/);
  assert.match(launcher, /createHmac/);
  assert.match(launcher, /realpathSync\.native/);
  assert.match(launcher, /managedEntryScript/);
  assert.doesNotMatch(launcher, /--(?:token|secret|credential)/i);
  assert.match(launcher, /child\.unref\(\)/);
  assert.ok(
    managedEntry.indexOf("delete process.env") < managedEntry.indexOf("await import"),
    "the managed entry must erase inherited credentials before loading application code",
  );
  assert.doesNotMatch(manager, /C:\\Program Files\\nodejs/);
  assert.match(starter, /Manage-MyDashboard\.ps1/);
  assert.doesNotMatch(starter, /Start-Process|C:\\Program Files\\nodejs/);
});
