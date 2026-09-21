import assert from "node:assert/strict";
import test from "node:test";

import {
  fixedPullRequestUpdatedWindowFromLocalDates,
  pullRequestUpdatedWindowFormPresentation,
  pullRequestUpdatedWindowOperationFromForm,
  validatePullRequestUpdatedWindowFormValue,
} from "../public/pull-request-updated-window-form.js";

test("fixed PR windows convert inclusive YYYYMMDD ranges to UTC half-open bounds", () => {
  assert.deepEqual(
    fixedPullRequestUpdatedWindowFromLocalDates({
      fromDate: "20260801",
      throughDate: "20260812",
      timeZone: "Asia/Shanghai",
    }),
    {
      mode: "fixed",
      fromInclusive: "2026-07-31T16:00:00.000Z",
      untilExclusive: "2026-08-12T16:00:00.000Z",
      timeZone: "Asia/Shanghai",
    },
  );
});

test("fixed PR windows preserve local midnights across DST and non-hour offsets", () => {
  assert.deepEqual(
    fixedPullRequestUpdatedWindowFromLocalDates({
      fromDate: "20260308",
      throughDate: "20260309",
      timeZone: "America/New_York",
    }),
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00.000Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
    },
  );
  assert.deepEqual(
    fixedPullRequestUpdatedWindowFromLocalDates({
      fromDate: "20260802",
      throughDate: "20260803",
      timeZone: "Asia/Kathmandu",
    }),
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T18:15:00.000Z",
      untilExclusive: "2026-08-03T18:15:00.000Z",
      timeZone: "Asia/Kathmandu",
    },
  );
});

test("persisted fixed PR windows restore their inclusive local dates and UTC preview", () => {
  assert.deepEqual(
    pullRequestUpdatedWindowFormPresentation({
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00.000Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
    }),
    {
      mode: "fixed",
      fromDate: "20260308",
      throughDate: "20260309",
      timeZone: "America/New_York",
      preview: "2026-03-08T05:00:00.000Z ≤ updatedAt < 2026-03-10T04:00:00.000Z",
    },
  );
  assert.deepEqual(pullRequestUpdatedWindowFormPresentation(undefined), {
    mode: "unlimited",
    recommendationDays: 7,
  });
});

test("PR window form validation rejects malformed, reversed, and nonexistent local dates", () => {
  for (const input of [
    { fromDate: "20260229", throughDate: "20260301", timeZone: "UTC" },
    { fromDate: "20260812", throughDate: "20260801", timeZone: "UTC" },
    { fromDate: "2026-08-01", throughDate: "20260812", timeZone: "UTC" },
    { fromDate: "20111230", throughDate: "20111230", timeZone: "Pacific/Apia" },
    { fromDate: "20001029", throughDate: "20001029", timeZone: "America/Havana" },
    { fromDate: "99991231", throughDate: "99991231", timeZone: "UTC" },
    { fromDate: "20260801", throughDate: "20260812", timeZone: "Invalid/Zone" },
  ]) {
    assert.throws(
      () => fixedPullRequestUpdatedWindowFromLocalDates(input),
      /日期|时区|午夜|开始/u,
    );
  }

  assert.deepEqual(validatePullRequestUpdatedWindowFormValue({ mode: "rolling", days: 7 }), {
    mode: "rolling",
    days: 7,
  });
  assert.throws(
    () => validatePullRequestUpdatedWindowFormValue({ mode: "rolling", days: 0 }),
    /1.*3650/u,
  );
});

test("PR window form choices become one explicit slot operation", () => {
  const path = ["githubRead", "pullRequestUpdatedWindow"];
  assert.deepEqual(
    pullRequestUpdatedWindowOperationFromForm({
      existing: false,
      mode: "rolling",
      days: "7",
      fromDate: "",
      throughDate: "",
      timeZone: "Asia/Shanghai",
    }),
    { operation: "add", path, value: { mode: "rolling", days: 7 } },
  );
  assert.deepEqual(
    pullRequestUpdatedWindowOperationFromForm({
      existing: true,
      mode: "fixed",
      days: "7",
      fromDate: "20260801",
      throughDate: "20260812",
      timeZone: "Asia/Shanghai",
    }),
    {
      operation: "replace",
      path,
      value: {
        mode: "fixed",
        fromInclusive: "2026-07-31T16:00:00.000Z",
        untilExclusive: "2026-08-12T16:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
    },
  );
  assert.deepEqual(
    pullRequestUpdatedWindowOperationFromForm({
      existing: true,
      mode: "unlimited",
      days: "7",
      fromDate: "",
      throughDate: "",
      timeZone: "UTC",
    }),
    { operation: "remove", path },
  );
  assert.equal(
    pullRequestUpdatedWindowOperationFromForm({
      existing: false,
      mode: "unlimited",
      days: "7",
      fromDate: "",
      throughDate: "",
      timeZone: "UTC",
    }),
    null,
  );
});
