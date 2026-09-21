import assert from "node:assert/strict";
import test from "node:test";

import {
  githubSourceEventUrl,
  githubTargetUrl,
} from "../public/github-target-link.js";

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

test("GitHub source event links open the matching issue or pull request", () => {
  assert.equal(
    githubSourceEventUrl("issue.observed · ExampleOrg/ProductApp#11651"),
    "https://github.com/ExampleOrg/ProductApp/issues/11651",
  );
  assert.equal(
    githubSourceEventUrl("pull_request.status · ExampleOrg/SoftwareApp#24193"),
    "https://github.com/ExampleOrg/SoftwareApp/pull/24193",
  );
});

test("GitHub source event links reject non-GitHub or ambiguous context", () => {
  for (const value of [
    null,
    "workflow-event · ExampleOrg/ProductApp#11651",
    "issue.observed · ExampleOrg/ProductApp",
    "issue.observed · evil.example/repo#1",
    "pull_request.status · ExampleOrg/SoftwareApp#1/../../settings",
  ]) {
    assert.equal(githubSourceEventUrl(value), null);
  }
});
