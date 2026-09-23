import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDashboardErrors } from "../public/status-error-summary.js";

test("four DingTalk token failures become one actionable profile-specific message", () => {
  const diagnostic = 'dws failed with exit code 5: { "error": { "message": "旧版登录态已无法由当前认证服务刷新；profile: \\"ding7430919261148c4f:1137300121374851\\": MCP token exchange failed: invalidParameter.authCode.notFound" } }';
  const summary = summarizeDashboardErrors(
    ["daily messages", "unread", "mentions", "todos"]
      .map((source) => `${source}: ${diagnostic}`),
  );
  assert.equal(summary.length, 1);
  assert.match(summary[0], /dws auth login --profile/);
  assert.match(summary[0], /ding7430919261148c4f:1137300121374851/);
  assert.doesNotMatch(summary[0], /exit code|MCP token exchange|daily messages/);
});

test("other diagnostics remain visible within a bounded banner", () => {
  const summary = summarizeDashboardErrors([
    `GitHub: ${"x".repeat(300)}`,
    "brain: unavailable",
    "report: failed",
    "extra: failed",
  ]);
  assert.equal(summary.length, 4);
  assert.ok(summary[0].length <= 180);
  assert.equal(summary[3], "另有 1 项异常");
});
