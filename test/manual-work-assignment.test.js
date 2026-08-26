import assert from "node:assert/strict";
import test from "node:test";

import {
  manualWorkAssignmentMarkup,
  ownerWorkRequestForItem,
} from "../public/manual-work-assignment.js";

const pullRequest = {
  id: "github:pr:SVisions/OCT-Software#23991",
  kind: "pull_request",
  repo: "SVisions/OCT-Software",
  number: 23991,
  title: "新增 Retina Thickness-Trend 分析页面",
  url: "https://github.com/SVisions/OCT-Software/pull/23991",
};

test("PR detail offers a manual assignment form with a direct review option", () => {
  const markup = manualWorkAssignmentMarkup(pullRequest);

  assert.match(markup, /手动分配工作/);
  assert.match(markup, /PR Review \/ 推进/);
  assert.match(markup, /开发实现/);
  assert.match(markup, /测试验证/);
  assert.match(markup, /data-manual-work-assignment/);
});

test("a PR review assignment freezes the structured PR target", () => {
  const request = ownerWorkRequestForItem(pullRequest, {
    workType: "pull_request",
    priority: "high",
    requestId: "12345678-1234-4123-8123-123456789abc",
  });

  assert.equal(request.schemaVersion, 2);
  assert.deepEqual(request.pullRequest, {
    repository: "SVisions/OCT-Software",
    number: 23991,
  });
  assert.match(request.description, /github\.com\/SVisions\/OCT-Software\/pull\/23991/);
  assert.equal(request.acceptanceCriteria.length, 2);
});

test("an Issue development assignment becomes an audited capability request", () => {
  const request = ownerWorkRequestForItem({
    kind: "issue",
    repo: "SVisions/OCT-Product",
    number: 12917,
    title: "Retina Thickness Change 页面",
    url: "https://github.com/SVisions/OCT-Product/issues/12917",
  }, {
    workType: "development",
    priority: "urgent",
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.pullRequest, undefined);
  assert.equal(request.workType, "development");
  assert.match(request.description, /SVisions\/OCT-Product #12917/);
});

test("assignment result replaces the form with its durable work item", () => {
  const markup = manualWorkAssignmentMarkup(pullRequest, {
    target: "pr-engineer",
    workItemId: "work-item-123",
    requestId: "request-123",
  });

  assert.match(markup, /已分配工作/);
  assert.match(markup, /pr-engineer/);
  assert.match(markup, /work-item-123/);
  assert.ok(!markup.includes("<form"));
});
