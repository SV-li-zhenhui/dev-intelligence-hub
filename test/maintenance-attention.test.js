import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceAttentionCode } from "../src/domain/maintenance-attention.js";
import { maintenanceAttentionMarkup } from "../public/maintenance-attention.js";

test("only system retry requests for maintenance faults leave the business confirmation queue", () => {
  const item = { choices: [{ id: "configured-retry" }], context: [{ label: "判断依据", value: "已停止（STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED）" }] };
  assert.equal(maintenanceAttentionCode(item), "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  assert.equal(maintenanceAttentionCode({ ...item, choices: [{ id: "accept" }] }), null);
  for (const code of ["ROLE_TASK_BRAIN_NOT_CONFIGURED", "BRAIN_CREDENTIAL_UNAVAILABLE", "STRUCTURED_PROVIDER_UNAVAILABLE"]) {
    assert.equal(maintenanceAttentionCode({ ...item, context: [{ label: "判断依据", value: `已停止（${code}）` }] }), null);
  }
});

test("maintenance view groups faults and escapes task content without offering bulk retry", () => {
  const items = ["developer", "tester"].map((roleId, index) => ({
    requestId: `attention-${index.toString().repeat(64)}`,
    maintenanceCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    producer: { roleId }, context: [{ label: "来源事件", value: "<img src=x onerror=alert(1)>" }],
  }));
  const html = maintenanceAttentionMarkup({ items, total: 2, loaded: true });
  assert.equal((html.match(/<details>/g) || []).length, 1);
  assert.equal((html.match(/data-maintenance-attention=/g) || []).length, 2);
  assert.match(html, /会话保存或恢复故障 · 2 项/);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(html, /不会自动重试/);
});
