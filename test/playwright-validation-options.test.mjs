import assert from "node:assert/strict";
import test from "node:test";

import {
  validationBrowserLaunchOptions,
  WINDOWS_IME_ISOLATION_ARGUMENT,
} from "../scripts/playwright-validation-options.mjs";

test("isolates Windows browser validation from host TSF input methods", () => {
  const sourceArgs = ["--disable-gpu"];
  const options = validationBrowserLaunchOptions({
    args: sourceArgs,
    channel: "msedge",
    headless: true,
  }, "win32");

  assert.deepEqual(options, {
    args: ["--disable-gpu", WINDOWS_IME_ISOLATION_ARGUMENT],
    channel: "msedge",
    headless: true,
  });
  assert.deepEqual(sourceArgs, ["--disable-gpu"]);
  assert.deepEqual(
    validationBrowserLaunchOptions({
      args: [WINDOWS_IME_ISOLATION_ARGUMENT],
    }, "win32").args,
    [WINDOWS_IME_ISOLATION_ARGUMENT],
  );
});

test("leaves non-Windows browser validation options unchanged", () => {
  assert.deepEqual(
    validationBrowserLaunchOptions({ headless: true }, "linux"),
    { headless: true },
  );
});
