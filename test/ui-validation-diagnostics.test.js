import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { partitionBrowserFailures } from "../scripts/ui-validation-diagnostics.mjs";

const systemStatusFailure = Object.freeze({
  method: "GET",
  url: "http://127.0.0.1:4173/api/system/status",
  status: 503,
});

test("expected HTTP failures bind to the exact response and browser resource location", () => {
  const result = partitionBrowserFailures(
    {
      httpErrors: [
        systemStatusFailure,
        {
          method: "GET",
          url: "http://127.0.0.1:4173/api/other",
          status: 503,
        },
      ],
      consoleErrors: [
        {
          text: "本地化的浏览器资源错误",
          location: {
            url: systemStatusFailure.url,
            lineNumber: 0,
            columnNumber: 0,
          },
        },
        {
          text: "application error",
          location: {
            url: "http://127.0.0.1:4173/app.js",
            lineNumber: 10,
            columnNumber: 2,
          },
        },
      ],
    },
    [systemStatusFailure],
  );

  assert.deepEqual(result.expectedHttpErrors, [systemStatusFailure]);
  assert.equal(result.expectedConsoleErrors.length, 1);
  assert.equal(result.expectedConsoleErrors[0].text, "本地化的浏览器资源错误");
  assert.deepEqual(result.httpErrors, [
    {
      method: "GET",
      url: "http://127.0.0.1:4173/api/other",
      status: 503,
    },
  ]);
  assert.equal(result.consoleErrors.length, 1);
  assert.equal(result.consoleErrors[0].text, "application error");
});

test("an expected status cannot consume another resource failure", () => {
  assert.throws(
    () =>
      partitionBrowserFailures(
        {
          httpErrors: [
            {
              method: "GET",
              url: "http://127.0.0.1:4173/api/other",
              status: 503,
            },
          ],
          consoleErrors: [],
        },
        [systemStatusFailure],
      ),
    /expected HTTP failure was not observed/,
  );
});

test("generic live UI validation isolates the real attention queue before navigation", async () => {
  const source = await readFile(
    new URL("../scripts/validate-ui.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function validate(name, viewport)");
  const end = source.indexOf("async function validateConfirmationQueue()", start);
  const validator = source.slice(start, end);
  const routeIndex = validator.indexOf("await routeEmptyAttentionQueue(page)");
  const navigationIndex = validator.indexOf("await page.goto(baseUrl");

  assert.ok(start >= 0 && end > start);
  assert.ok(routeIndex >= 0);
  assert.ok(navigationIndex >= 0);
  assert.ok(routeIndex < navigationIndex);
  assert.doesNotMatch(source, /closeIncidentalConfirmationDialog/);
});
