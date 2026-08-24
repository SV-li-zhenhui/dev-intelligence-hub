import assert from "node:assert/strict";
import test from "node:test";

import { githubTargetUrl } from "../public/github-target-link.js";

test("GitHub target links use fixed PR and issue routes", () => {
  assert.equal(
    githubTargetUrl({
      resourceId: "SVisions/OCT-Software#23178",
      resourceType: "pull_request",
    }),
    "https://github.com/SVisions/OCT-Software/pull/23178",
  );
  assert.equal(
    githubTargetUrl({
      resourceId: "SVisions/OCT-Software#20710",
      resourceType: "issue",
    }),
    "https://github.com/SVisions/OCT-Software/issues/20710",
  );
});

test("GitHub target links reject ambiguous or unsafe targets", () => {
  for (const input of [
    null,
    {},
    { resourceId: "SVisions/OCT-Software", resourceType: "pull_request" },
    { resourceId: "SVisions/OCT-Software#0", resourceType: "pull_request" },
    { resourceId: "SVisions/OCT-Software#1", resourceType: "repository" },
    { resourceId: "SVisions/OCT Software#1", resourceType: "pull_request" },
    { resourceId: "SVisions/OCT-Software#1/../../settings", resourceType: "pull_request" },
    { resourceId: "evil.example/repo#1", resourceType: "pull_request" },
    { resourceId: "owner/repo#9007199254740992", resourceType: "pull_request" },
  ]) {
    assert.equal(githubTargetUrl(input), null);
  }
});
