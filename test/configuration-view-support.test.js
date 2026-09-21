import assert from "node:assert/strict";
import test from "node:test";

import {
  configurationImpactCategories,
  createConfigurationFetch,
  isCurrentConfigurationRequest,
  normalizeConfigurationBinding,
  sameConfigurationBinding,
} from "../public/configuration-view-support.js";

test("configuration impact keeps authoritative counts while bounding path details", () => {
  const paths = Array.from({ length: 12 }, (_, index) => `roles.role-${index}`);
  const categories = configurationImpactCategories({
    securityTightening: { count: 27, paths },
    authority_expansion: ["githubActions.enabled"],
    benign_claim_change: { count: 0, paths: [] },
    restart_required: { count: 3, paths: ["brains.local.model"] },
  });

  assert.deepEqual(categories, [
    { label: "安全收紧", count: 27, paths },
    {
      label: "权限扩展",
      count: 1,
      paths: ["githubActions.enabled"],
    },
    {
      label: "需要重启",
      count: 3,
      paths: ["brains.local.model"],
    },
  ]);
});

test("configuration fetch aborts a stalled request with an actionable timeout", async () => {
  let cleared = null;
  const configurationFetch = createConfigurationFetch({
    timeoutMs: 45_000,
    fetchFn(_input, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    },
    setTimeoutFn(callback) {
      queueMicrotask(callback);
      return "configuration-timeout";
    },
    clearTimeoutFn(handle) {
      cleared = handle;
    },
  });

  await assert.rejects(
    configurationFetch("/api/configuration"),
    (error) =>
      error?.code === "CONFIGURATION_REQUEST_TIMEOUT" &&
      error?.message === "配置请求超时，请检查本地服务后重试。",
  );
  assert.equal(cleared, "configuration-timeout");
});

test("only the newest non-aborted configuration request may change UI state", () => {
  assert.equal(
    isCurrentConfigurationRequest({
      sequence: 4,
      currentSequence: 5,
      lastAppliedSequence: 3,
      signal: { aborted: false },
    }),
    false,
  );
  assert.equal(
    isCurrentConfigurationRequest({
      sequence: 5,
      currentSequence: 5,
      lastAppliedSequence: 5,
      signal: { aborted: true },
    }),
    false,
  );
  assert.equal(
    isCurrentConfigurationRequest({
      sequence: 5,
      currentSequence: 5,
      lastAppliedSequence: 4,
      signal: { aborted: false },
    }),
    true,
  );
});

test("draft and rollback bindings normalize missing resources before comparison", () => {
  const rollbackPreview = normalizeConfigurationBinding({
    expectedStateRevision: 7,
    expectedActiveVersion: 3,
    targetVersion: 1,
  });
  assert.deepEqual(rollbackPreview, {
    expectedStateRevision: 7,
    expectedActiveVersion: 3,
    draftId: null,
    draftRevision: null,
    targetVersion: 1,
  });
  assert.equal(
    sameConfigurationBinding(rollbackPreview, {
      expectedStateRevision: 7,
      expectedActiveVersion: 3,
      draftId: null,
      draftRevision: null,
      targetVersion: 1,
    }),
    true,
  );
  assert.equal(
    sameConfigurationBinding(rollbackPreview, {
      expectedStateRevision: 8,
      expectedActiveVersion: 3,
      targetVersion: 1,
    }),
    false,
  );
});
