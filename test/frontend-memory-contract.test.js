import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

test("memory view searches the unified local journal with all supported filters", () => {
  assert.match(appSource, /\/api\/memory\/query\?/);
  for (const field of [
    "query",
    "roleId",
    "repository",
    "eventType",
    "from",
    "to",
  ]) {
    assert.match(appSource, new RegExp(`name=\\"${field}\\"`));
  }
  assert.match(appSource, /memoryNextCursor/);
  assert.match(appSource, /本地索引正常/);
});

test("memory search never asks a model or exposes a write endpoint", () => {
  assert.doesNotMatch(appSource, /\/api\/memory\/(append|create|rebuild)/);
  assert.doesNotMatch(appSource, /\/api\/brain/);
});
