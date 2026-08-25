import assert from "node:assert/strict";
import test from "node:test";

import { githubItemDetailMarkup } from "../public/github-item-detail.js";

test("GitHub issue detail presents description, images, and latest discussion", () => {
  const markup = githubItemDetailMarkup({
    kind: "issue",
    description: "# Problem Statement\n1. 启动失败\n<img src=x onerror=alert(1)>\n- Repeatable: 10%",
    latestComment: {
      author: "SV-author",
      body: "已经增加日志，可以先移出 **v4.0.440**",
      updatedAt: "2026-08-08T09:12:06.000Z",
    },
  });

  assert.match(markup, /<h3>问题说明<\/h3>/u);
  assert.match(markup, /<h4>Problem Statement<\/h4>/u);
  assert.match(markup, /<li>启动失败<\/li>/u);
  assert.match(markup, /正文包含图片/u);
  assert.match(markup, /最新评论/u);
  assert.match(markup, /评论者 @SV-author/u);
  assert.match(markup, /<strong>v4\.0\.440<\/strong>/u);
  assert.doesNotMatch(markup, /<img|onerror=/u);
});

test("GitHub detail escapes external HTML and ignores unrelated cards", () => {
  assert.equal(githubItemDetailMarkup({ kind: "announcement" }), "");
  const markup = githubItemDetailMarkup({
    kind: "pull_request",
    description: "<script>alert('private')</script> & behavior",
  });
  assert.doesNotMatch(markup, /<script>/u);
  assert.match(markup, /alert\(&#039;private&#039;\) &amp; behavior/u);
});
