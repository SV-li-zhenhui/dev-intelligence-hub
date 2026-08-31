import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { normalizeConfigurationDocument } from "../src/domain/configuration-contract.js";

const root = path.resolve(import.meta.dirname, "..");

test("the published example configuration is valid and disabled-safe", async () => {
  const source = await readFile(path.join(root, "config.example.json"), "utf8");
  const configuration = normalizeConfigurationDocument(JSON.parse(source));

  assert.deepEqual(configuration.trackedRepositories, []);
  assert.deepEqual(configuration.githubRead, {
    enabled: false,
    issueActiveWindowDays: 14,
  });
  assert.equal(configuration.brain.enabled, false);
  assert.equal(configuration.codeExecutor.enabled, false);
  assert.equal(configuration.changePackages.enabled, false);
  assert.equal(configuration.githubActions.enabled, false);
  assert.deepEqual(configuration.githubActions.enabledActions, []);
  assert.equal(configuration.workflowRouting.enabled, false);
  assert.equal(configuration.workCoordination.enabled, false);
  assert.equal(configuration.memory.enabled, false);
  assert.equal(configuration.memory.answering.enabled, false);
  assert.equal(configuration.employees.prReviewer.enabled, false);
  assert.deepEqual(Object.keys(configuration.employees.roles), [
    "developer",
    "orchestrator",
    "pr-engineer",
    "requirements-analyst",
    "tester",
  ]);
  assert.equal(
    Object.values(configuration.employees.roles).every(
      ({ initialPaused }) => initialPaused === true,
    ),
    true,
  );
  assert.equal(configuration.dingtalk.enabled, false);
});

test("the published example contains no credential value or private machine identity", async () => {
  const source = await readFile(path.join(root, "config.example.json"), "utf8");
  for (const forbidden of [
    /github_pat_/iu,
    /gh[opusr]_[A-Za-z0-9_]{8,}/u,
    /sk-[A-Za-z0-9_-]{8,}/u,
    /"[A-Za-z]:[\\/]/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("private runtime configuration is ignored while the safe example remains tracked", async () => {
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^config\.json$/mu);
  assert.match(ignore, /^config\.local\.json$/mu);
  assert.doesNotMatch(ignore, /^config\.example\.json$/mu);
});
