import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as routing from "../public/review-handoff-routing.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function appFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const rest = app.slice(start);
  const next = rest.search(/\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next);
}
function context(extra = {}) {
  return vm.createContext({
    ...routing,
    activeConfigurationDocument: () => ({}),
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;"),
    confirmationHistoryStatuses: [["completed"], ["failed"]],
    confirmationHistoryKinds: [["github.work-proposal-review"]],
    confirmationHistoryStatusLabel: (value) => value,
    confirmationHistoryKindLabel: (value) => value,
    relativeTime: (value) => value,
    ...extra,
  });
}
const handoff = (status) => ({
  selection: { workType: "testing", responsiblePerson: { login: "tester-one", product: "qt" } },
  requestId: "12345678-1234-4234-8234-123456789abc",
  acceptedRequestId: "approve-request-42",
  status, attempts: status === "pending" ? 0 : 1,
  diagnosticCode: status === "retrying" ? "ROLE_PAUSED" : null,
  workItemId: status === "completed" ? "work-testing-42" : null,
  roleId: status === "completed" ? "tester" : null,
});
const historyItem = (status) => ({
  id: "review-42", kind: "github.work-proposal-review", status: "completed",
  requestedBy: { roleId: "pr-engineer", workItemId: "work-42" },
  title: "Review", summary: "Reviewed", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  reviewHandoff: handoff(status),
});

test("failed Review static handoffs do not bind absent controls", () => {
  for (const saved of [undefined, handoff("pending")]) {
    const item = { ...historyItem("pending"), status: "failed", reviewHandoff: saved };
    const sandbox = context({ item });
    vm.runInContext(["reviewHandoffStatusText", "reviewHandoffMarkup", "bindReviewHandoffControls"].map(appFunction).join("\n"), sandbox);
    const markup = sandbox.reviewHandoffMarkup("COMMENT", item);
    assert.match(markup, /class="review-handoff"/);
    assert.doesNotMatch(markup, /data-review-handoff/);
    sandbox.confirmationContent = { querySelector: () => ({ querySelector: () => null }) };
    assert.doesNotThrow(() => sandbox.bindReviewHandoffControls(item));
  }
});

test("history normalization preserves and renders every durable handoff phase", () => {
  const sandbox = context();
  vm.runInContext(["normalizedConfirmationHistoryItems", "reviewHandoffStatusText", "confirmationHistoryItemMarkup"].map(appFunction).join("\n"), sandbox);
  for (const [status, expected] of [["pending", "服务端正在分配"], ["retrying", "ROLE_PAUSED"], ["completed", "work-testing-42"]]) {
    const [item] = sandbox.normalizedConfirmationHistoryItems([historyItem(status)]);
    assert.equal(item.reviewHandoff?.status, status);
    assert.match(sandbox.confirmationHistoryItemMarkup(item), new RegExp(expected));
  }
  const forged = historyItem("completed");
  forged.reviewHandoff.selection.responsiblePerson.login = "<script>";
  assert.equal(sandbox.normalizedConfirmationHistoryItems([forged])[0].reviewHandoff, undefined);
});

test("pending handoff controls still bind and change the visible owner fields", () => {
  const controls = new Map();
  for (const name of ["handoff", "testing-owner", "testing-product", "testing-person", "external-owner", "external-product", "external-person"]) {
    controls.set(`[data-review-${name}]`, {
      value: name === "handoff" ? "testing" : "qt",
      dataset: { reviewResponsibleKind: "external_reviewer" },
      events: {},
      addEventListener(type, callback) { this.events[type] = callback; },
    });
  }
  const sandbox = context({ confirmationContent: { querySelector: () => ({ querySelector: (name) => controls.get(name) }) } });
  vm.runInContext(appFunction("bindReviewHandoffControls"), sandbox);
  sandbox.bindReviewHandoffControls({});
  assert.equal(controls.get("[data-review-testing-owner]").hidden, false);
  assert.equal(controls.get("[data-review-external-owner]").hidden, true);
  controls.get("[data-review-handoff]").value = "pull_request";
  controls.get("[data-review-handoff]").events.change();
  assert.equal(controls.get("[data-review-testing-owner]").hidden, true);
  assert.equal(controls.get("[data-review-external-owner]").hidden, false);
});
