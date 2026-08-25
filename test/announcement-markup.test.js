import assert from "node:assert/strict";
import test from "node:test";

import { announcementDetailMarkup } from "../public/announcement-markup.js";

test("DingTalk announcement markdown becomes readable semantic markup", () => {
  const markup = announcementDetailMarkup(
    "## 📋 PR 提醒 — v4.0.440 **时间**: 2026-08-25 09:00 | " +
    "**Open 总数**: 0 **今日新增**: 0 --- ### 前端（0 个 Open PR） > 当前无符合条件的 Open PR。",
  );

  assert.match(markup, /<h2 class="announcement-title">📋 PR 提醒 — v4\.0\.440<\/h2>/u);
  assert.match(markup, /<strong>时间<\/strong>: 2026-08-25 09:00/u);
  assert.match(markup, /<strong>Open 总数<\/strong>: 0/u);
  assert.match(markup, /<h3>前端（0 个 Open PR） &gt; 当前无符合条件的 Open PR。<\/h3>/u);
  assert.doesNotMatch(markup, /\*\*|##|---/u);
});

test("announcement markup escapes external HTML before applying the allowlist", () => {
  const markup = announcementDetailMarkup(
    "## <img src=x onerror=alert(1)> **时间**: <script>alert(1)</script>",
  );

  assert.doesNotMatch(markup, /<img|<script/u);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});
