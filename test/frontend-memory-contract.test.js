import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../public/styles.css", import.meta.url),
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
  const memorySearchSource =
    /async function loadMemories[\s\S]*?(?=function memoryAnswerRequest)/
      .exec(appSource)?.[0] || "";

  assert.notEqual(memorySearchSource, "");
  assert.doesNotMatch(appSource, /\/api\/memory\/(append|create|rebuild)/);
  assert.doesNotMatch(memorySearchSource, /\/api\/brain/);
  assert.doesNotMatch(memorySearchSource, /method:\s*"POST"/);
});

test("memory questions use the bounded cited-answer contract", () => {
  assert.match(appSource, /\/api\/memory\/answer/);
  assert.match(appSource, /method:\s*"POST"/);
  assert.match(appSource, /"content-type":\s*"application\/json"/);
  assert.match(appSource, /"x-mydashboard-action":\s*"1"/);
  assert.match(appSource, /schemaVersion:\s*1/);
  assert.match(appSource, /mode === "local"/);
  assert.match(appSource, /kind:\s*"query"/);
  assert.match(appSource, /kind:\s*"context"/);
  assert.match(appSource, /contextDigest/);
  assert.match(appSource, /recordIds/);
});

test("memory answers expose reproducible citations and guard request races", () => {
  assert.match(appSource, /escapeHtml\(memoryString\(memoryAnswerResult\.answer\)\)/);
  assert.match(appSource, /escapeHtml\(memoryString\(claim\?\.statement\)\)/);
  assert.match(appSource, /memory-citation-link/);
  assert.match(appSource, /memory-rerun-local/);
  assert.match(appSource, /new AbortController\(\)/);
  assert.match(appSource, /memoryAnswerRequestSequence/);
  assert.match(appSource, /memorySearchRequestSequence/);
  assert.match(appSource, /sequence !== memoryAnswerRequestSequence/);
  assert.match(appSource, /sequence !== memorySearchRequestSequence/);
});

test("asking with draft filters first synchronizes the visible local result set", () => {
  const handler = /async function handleMemoryQuestion[\s\S]*?(?=async function handleMemoryLocalRerun)/
    .exec(appSource)?.[0] || "";

  assert.match(appSource, /function memoryFiltersEqual\(/);
  assert.match(handler, /cancelMemoryAnswerRequest\(\)/);
  assert.match(handler, /memorySearchAbortController !== null/);
  assert.match(handler, /memoryFiltersEqual\(filters, memoryFilters\)/);
  assert.match(handler, /await loadMemories\(filters, \{ resetAnswer: true \}\)/);
  assert.ok(handler.indexOf("await loadMemories") < handler.indexOf("await loadMemoryAnswer"));
});

test("memory answer UI stays usable on narrow screens", () => {
  assert.match(styleSource, /\.memory-answer-panel/);
  assert.match(styleSource, /\.memory-context-record/);
  assert.match(styleSource, /@media \(max-width: 540px\)/);
  assert.match(styleSource, /\.memory-record-meta\s*\{[\s\S]*?grid-template-columns: 1fr;/);
});
