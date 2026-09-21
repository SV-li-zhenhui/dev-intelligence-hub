import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VALIDATION_INHERITED_VARIABLES = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

export const VALIDATION_ISOLATED_VARIABLES = Object.freeze([
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

export const VALIDATION_CONTROLLED_VARIABLES = Object.freeze([
  "GCM_INTERACTIVE",
  "GH_PROMPT_DISABLED",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "NO_COLOR",
  "PLAYWRIGHT_BROWSERS_PATH",
]);

function sourceValue(source, requestedName) {
  const matches = Object.keys(source).filter(
    (name) => name.toLowerCase() === requestedName.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new Error(`ambiguous validation environment variable: ${requestedName}`);
  }
  return matches.length === 1 ? source[matches[0]] : undefined;
}

function inheritedEnvironment(source) {
  const environment = {};
  const inheritedVariables = [];
  for (const name of VALIDATION_INHERITED_VARIABLES) {
    const value = sourceValue(source, name);
    if (typeof value !== "string" || value.length === 0) continue;
    environment[name] = value;
    inheritedVariables.push(name);
  }
  inheritedVariables.sort();
  return { environment, inheritedVariables };
}

export function allowlistedValidationToolEnvironment(
  sourceEnvironment = process.env,
) {
  const { environment } = inheritedEnvironment(sourceEnvironment);
  return Object.freeze({
    ...environment,
    GCM_INTERACTIVE: "Never",
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  });
}

function dependencyCacheDirectory(source) {
  const configured = sourceValue(source, "NPM_CONFIG_CACHE");
  if (typeof configured === "string" && path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  const localAppData = sourceValue(source, "LOCALAPPDATA");
  if (typeof localAppData === "string" && path.isAbsolute(localAppData)) {
    return path.join(path.resolve(localAppData), "npm-cache");
  }
  const home = sourceValue(source, "HOME");
  return typeof home === "string" && path.isAbsolute(home)
    ? path.join(path.resolve(home), ".npm")
    : null;
}

async function createDirectories(directory) {
  const profile = path.join(directory, "profile");
  const locations = {
    APPDATA: path.join(profile, "appdata"),
    HOME: profile,
    LOCALAPPDATA: path.join(profile, "localappdata"),
    TEMP: path.join(directory, "temp"),
    TMP: path.join(directory, "temp"),
    USERPROFILE: profile,
    XDG_CACHE_HOME: path.join(profile, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(profile, "xdg-config"),
    XDG_DATA_HOME: path.join(profile, "xdg-data"),
    XDG_STATE_HOME: path.join(profile, "xdg-state"),
  };
  await Promise.all(
    [...new Set(Object.values(locations))].map((candidate) =>
      mkdir(candidate, { recursive: true, mode: 0o700 })
    ),
  );
  return Object.freeze(locations);
}

export async function prepareIsolatedValidationEnvironment({
  sourceEnvironment = process.env,
  temporaryRoot = os.tmpdir(),
  playwrightBrowsersPath,
} = {}) {
  if (
    sourceEnvironment === null ||
    typeof sourceEnvironment !== "object" ||
    Array.isArray(sourceEnvironment) ||
    typeof temporaryRoot !== "string" ||
    !path.isAbsolute(temporaryRoot) ||
    (playwrightBrowsersPath !== undefined &&
      (typeof playwrightBrowsersPath !== "string" ||
        !path.isAbsolute(playwrightBrowsersPath)))
  ) {
    throw new TypeError("validation environment request is invalid");
  }
  const directory = await mkdtemp(
    path.join(temporaryRoot, "mydashboard-validation-env-"),
  );
  let cleaned = false;
  try {
    const { environment, inheritedVariables } = inheritedEnvironment(
      sourceEnvironment,
    );
    const isolated = await createDirectories(directory);
    Object.assign(environment, isolated);
    const browserDirectory = playwrightBrowsersPath === undefined
      ? path.join(directory, "playwright-browsers")
      : path.resolve(playwrightBrowsersPath);
    if (playwrightBrowsersPath === undefined) {
      await mkdir(browserDirectory, { recursive: true, mode: 0o700 });
    }
    const gitConfig = path.join(directory, "gitconfig");
    await writeFile(gitConfig, "", { flag: "wx", mode: 0o600 });
    Object.assign(environment, {
      GCM_INTERACTIVE: "Never",
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
    });
    const evidence = Object.freeze({
      schemaVersion: 2,
      policy: "isolated-profile-allowlist-v2",
      inheritedVariables: Object.freeze(inheritedVariables),
      isolatedVariables: VALIDATION_ISOLATED_VARIABLES,
      controlledVariables: VALIDATION_CONTROLLED_VARIABLES,
      credentialVariablesInherited: false,
      dependencyInstallationNetwork: "offline",
    });
    return Object.freeze({
      directory,
      dependencyCacheDirectory: dependencyCacheDirectory(sourceEnvironment),
      environment: Object.freeze(environment),
      evidence,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { force: true, recursive: true });
      },
    });
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}
