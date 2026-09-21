import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareIsolatedValidationEnvironment,
  VALIDATION_CONTROLLED_VARIABLES,
  VALIDATION_ISOLATED_VARIABLES,
} from "../scripts/system-validation-environment.mjs";

test("validation children receive only allowlisted system values and empty profiles", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "validation-env-parent-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const playwrightBrowsersPath = path.join(parent, "playwright-browsers");
  const context = await prepareIsolatedValidationEnvironment({
    temporaryRoot: parent,
    playwrightBrowsersPath,
    sourceEnvironment: {
      Path: "C:\\trusted-tools",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      LANG: "zh_CN.UTF-8",
      HOME: "C:\\Users\\host",
      USERPROFILE: "C:\\Users\\host",
      APPDATA: "C:\\Users\\host\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\host\\AppData\\Local",
      OPENAI_API_KEY: "must-not-pass",
      ANTHROPIC_API_KEY: "must-not-pass",
      GH_TOKEN: "must-not-pass",
      GITHUB_TOKEN: "must-not-pass",
      NPM_TOKEN: "must-not-pass",
      NODE_OPTIONS: "--require=must-not-pass.js",
      HTTP_PROXY: "http://user:password@example.invalid",
      UNKNOWN_HOST_STATE: "must-not-pass",
    },
  });
  t.after(() => context.cleanup());

  assert.equal(context.environment.PATH, "C:\\trusted-tools");
  assert.equal(context.environment.SystemRoot, "C:\\Windows");
  assert.equal(context.environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(context.environment.LANG, "zh_CN.UTF-8");
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "NODE_OPTIONS",
    "HTTP_PROXY",
    "UNKNOWN_HOST_STATE",
  ]) {
    assert.equal(Object.hasOwn(context.environment, name), false, name);
  }
  for (const name of VALIDATION_ISOLATED_VARIABLES) {
    assert.equal(path.isAbsolute(context.environment[name]), true, name);
    assert.equal(
      path.relative(context.directory, context.environment[name]).startsWith(".."),
      false,
      name,
    );
    await access(context.environment[name]);
  }
  assert.deepEqual(
    Object.fromEntries(
      VALIDATION_CONTROLLED_VARIABLES.map((name) => [
        name,
        context.environment[name],
      ]),
    ),
    {
      GCM_INTERACTIVE: "Never",
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_GLOBAL: path.join(context.directory, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
    },
  );
  assert.deepEqual(context.evidence, {
    schemaVersion: 2,
    policy: "isolated-profile-allowlist-v2",
    inheritedVariables: ["ComSpec", "LANG", "PATH", "SystemRoot"],
    isolatedVariables: [...VALIDATION_ISOLATED_VARIABLES],
    controlledVariables: [...VALIDATION_CONTROLLED_VARIABLES],
    credentialVariablesInherited: false,
    dependencyInstallationNetwork: "offline",
  });

  const directory = context.directory;
  await context.cleanup();
  await assert.rejects(access(directory), { code: "ENOENT" });
  await context.cleanup();
});

test("validation rejects ambiguous case-insensitive environment names", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "validation-env-ambiguous-"));
  t.after(() => rm(parent, { force: true, recursive: true }));

  await assert.rejects(
    prepareIsolatedValidationEnvironment({
      temporaryRoot: parent,
      sourceEnvironment: {
        PATH: "C:\\trusted-tools",
        Path: "C:\\host-controlled-tools",
      },
    }),
    /ambiguous validation environment variable: PATH/u,
  );
});
