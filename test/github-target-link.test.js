import assert from "node:assert/strict";
import test from "node:test";

import { githubTargetUrl } from "../public/github-target-link.js";

test("GitHub target links use fixed PR and issue routes", () => {
  assert.equal(
    githubTargetUrl({
      resourceId: "octo-org/dashboard#42",
      resourceType: "pull_request",
    }),
    "https://github.com/octo-org/dashboard/pull/42",
  );
  assert.equal(
    githubTargetUrl({
      resourceId: "octo-org/dashboard#7",
      resourceType: "issue",
    }),
    "https://github.com/octo-org/dashboard/issues/7",
  );
});

test("GitHub target links reject ambiguous or unsafe targets", () => {
  for (const input of [
    null,
    {},
    { resourceId: "octo-org/dashboard", resourceType: "pull_request" },
    { resourceId: "octo-org/dashboard#0", resourceType: "pull_request" },
    { resourceId: "octo-org/dashboard#1", resourceType: "repository" },
    { resourceId: "octo org/dashboard#1", resourceType: "pull_request" },
    { resourceId: "octo-org/dashboard#1/../../settings", resourceType: "pull_request" },
    { resourceId: "evil.example/repo#1", resourceType: "pull_request" },
    { resourceId: "owner/repo#9007199254740992", resourceType: "pull_request" },
  ]) {
    assert.equal(githubTargetUrl(input), null);
  }
});
