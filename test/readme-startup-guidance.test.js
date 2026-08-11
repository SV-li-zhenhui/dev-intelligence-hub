import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("README quick start uses the managed lifecycle and labels foreground start", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const quickStart = readme.match(/## 使用[\s\S]*?```powershell\s*([\s\S]*?)```/u)?.[1];

  assert.ok(quickStart, "README quick start block is missing");
  assert.match(
    quickStart,
    /\.\\scripts\\Manage-MyDashboard\.ps1 -Action Start -OpenBrowser/u,
  );
  assert.doesNotMatch(quickStart, /npm start/u);
  assert.match(
    readme,
    /`npm start`[^\n]*(?:前台|foreground)[^\n]*(?:受管|managed)/iu,
  );
});
