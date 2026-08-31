import assert from "node:assert/strict";
import test from "node:test";

import {
  githubWorkItemFromUrl,
  manualHistoricalWorkMarkup,
  manualWorkAssignmentMarkup,
  ownerWorkRequestForItem,
} from "../public/manual-work-assignment.js";

const pullRequest = {
  id: "github:pr:ExampleOrg/SoftwareApp#23991",
  kind: "pull_request",
  repo: "ExampleOrg/SoftwareApp",
  number: 23991,
  title: "新增 Retina Thickness-Trend 分析页面",
  url: "https://github.com/ExampleOrg/SoftwareApp/pull/23991",
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
    repository: "ExampleOrg/SoftwareApp",
    number: 23991,
  });
  assert.match(request.description, /github\.com\/ExampleOrg\/SoftwareApp\/pull\/23991/);
  assert.equal(request.acceptanceCriteria.length, 2);
});

test("an Issue development assignment becomes an audited capability request", () => {
  const request = ownerWorkRequestForItem({
    kind: "issue",
    repo: "ExampleOrg/ProductApp",
    number: 12917,
    title: "Retina Thickness Change 页面",
    url: "https://github.com/ExampleOrg/ProductApp/issues/12917",
  }, {
    workType: "development",
    priority: "urgent",
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });

  assert.equal(request.schemaVersion, 6);
  assert.deepEqual(request.issue, {
    repository: "ExampleOrg/ProductApp",
    number: 12917,
  });
  assert.equal(request.workType, "development");
  assert.match(request.description, /ExampleOrg\/ProductApp #12917/);
});

test("an approved PR testing handoff binds the configured GitHub test owner", () => {
  const request = ownerWorkRequestForItem(pullRequest, {
    workType: "testing",
    priority: "high",
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    responsiblePerson: { login: "qt-tester-primary", product: "qt" },
  });

  assert.equal(request.schemaVersion, 3);
  assert.deepEqual(request.responsiblePerson, {
    login: "qt-tester-primary",
    product: "qt",
  });
  assert.deepEqual(request.pullRequest, {
    repository: pullRequest.repo,
    number: pullRequest.number,
  });
  assert.match(request.title, /负责人 @qt-tester-primary/);
  assert.match(request.description, /指定测试负责人/);
});

test("review and self-fix handoffs preserve their named responsible person", () => {
  const reviewer = ownerWorkRequestForItem(pullRequest, {
    workType: "pull_request",
    priority: "high",
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    responsiblePerson: { login: "qt-reviewer", product: "qt" },
  });
  const developer = ownerWorkRequestForItem(pullRequest, {
    workType: "development",
    priority: "high",
    requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    responsiblePerson: { login: "local-owner", product: "qt" },
  });

  assert.equal(reviewer.schemaVersion, 4);
  assert.deepEqual(reviewer.responsiblePerson, {
    login: "qt-reviewer",
    product: "qt",
  });
  assert.deepEqual(reviewer.pullRequest, {
    repository: pullRequest.repo,
    number: pullRequest.number,
  });
  assert.ok(
    reviewer.acceptanceCriteria.includes(
      "PR Review / 推进结果明确交付给 @qt-reviewer",
    ),
  );
  assert.equal(developer.schemaVersion, 4);
  assert.deepEqual(developer.pullRequest, reviewer.pullRequest);
  assert.match(developer.description, /指定负责人：@local-owner/);
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

test("a GitHub PR or Issue URL becomes a bounded manual work item", () => {
  assert.deepEqual(
    githubWorkItemFromUrl(
      "https://github.com/ExampleOrg/SoftwareApp/pull/23991?notification_referrer_id=1#discussion",
    ),
    {
      id: "github:pr:ExampleOrg/SoftwareApp#23991",
      kind: "pull_request",
      repo: "ExampleOrg/SoftwareApp",
      number: 23991,
      title: "ExampleOrg/SoftwareApp #23991",
      url: "https://github.com/ExampleOrg/SoftwareApp/pull/23991",
      summary: "由你通过 GitHub 地址人工加入日常任务",
    },
  );
  assert.deepEqual(
    githubWorkItemFromUrl("https://github.com/ExampleOrg/ProductApp/issues/12917/"),
    {
      id: "github:issue:ExampleOrg/ProductApp#12917",
      kind: "issue",
      repo: "ExampleOrg/ProductApp",
      number: 12917,
      title: "ExampleOrg/ProductApp #12917",
      url: "https://github.com/ExampleOrg/ProductApp/issues/12917",
      summary: "由你通过 GitHub 地址人工加入日常任务",
    },
  );
});

test("manual GitHub URL parsing rejects ambiguous or untrusted targets", () => {
  for (const value of [
    "http://github.com/acme/repo/pull/1",
    "https://evil.example/acme/repo/pull/1",
    "https://user@github.com/acme/repo/pull/1",
    "https://github.com/acme/repo/pulls/1",
    "https://github.com/acme/repo/issues/not-a-number",
    "https://github.com/acme/repo/issues/1/comments",
  ]) {
    assert.throws(
      () => githubWorkItemFromUrl(value),
      /GitHub PR 或 Issue 地址无效/,
    );
  }
});

test("work view exposes an explicit historical task form", () => {
  const markup = manualHistoricalWorkMarkup();

  assert.match(markup, /人工加入历史任务/);
  assert.match(markup, /name="sourceUrl"/);
  assert.match(markup, /name="workType"/);
  assert.match(markup, /data-manual-historical-work/);
  assert.match(markup, /不会扩大自动扫描范围/);
});

test("manual Issue work keeps its canonical GitHub identity", () => {
  const request = ownerWorkRequestForItem(
    githubWorkItemFromUrl("https://github.com/ExampleOrg/ProductApp/issues/12917"),
    {
      workType: "development",
      priority: "high",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    },
  );

  assert.equal(request.schemaVersion, 6);
  assert.deepEqual(request.issue, {
    repository: "ExampleOrg/ProductApp",
    number: 12917,
  });
});
