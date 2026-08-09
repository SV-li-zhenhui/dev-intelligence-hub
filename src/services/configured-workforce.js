import path from "node:path";

import { OllamaStructuredProvider } from "../adapters/ollama-structured-provider.js";
import { OpenAiCompatibleProvider } from "../adapters/openai-compatible-provider.js";
import {
  createProductionSupervisedCliBrainProvider,
} from "../adapters/supervised-cli-brain-provider.js";
import { ProductionCliCompositionGrant } from "../composition-root.js";
import { BrainRouter } from "./brain-router.js";
import { ConfiguredRoleEmployee } from "./configured-role-employee.js";

const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const PROVIDER_KEYS = new Set([
  "kind",
  "baseUrl",
  "apiKeyEnv",
  "protocol",
  "responseFormat",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "contextTokens",
  "remote",
]);
const PROVIDER_LIMIT_KEYS = Object.freeze([
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
]);
const CLI_PROVIDER_KEYS = new Set([
  "kind",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "remote",
]);
const ROLE_KEYS = new Set([
  "name",
  "mission",
  "enabled",
  "scheduleMinutes",
  "initialPaused",
  "workerId",
  "permissions",
  "brain",
  "taskBrain",
]);

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactConfig(value, allowed, name) {
  const entries = dataEntries(value, name);
  if (entries.some(([key]) => !allowed.has(key))) {
    throw new TypeError(`${name} contains an unknown field`);
  }
  return Object.fromEntries(entries);
}

function selectOptions(config, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
}

function testSupervisedCliRuntimeFacts(dependencies) {
  const protectedRoots = dependencies.supervisedCliProtectedRoots ?? [];
  if (
    !Array.isArray(protectedRoots) ||
    protectedRoots.some(
      (entry) => typeof entry !== "string" || !path.isAbsolute(entry),
    )
  ) {
    throw new TypeError("supervised CLI protected roots are invalid");
  }
  return Object.freeze({ protectedRoots: Object.freeze([...protectedRoots]) });
}

function productionSupervisedCliCapability(dependencies) {
  if (Object.hasOwn(dependencies, "supervisedCliProtectedRoots")) {
    throw new TypeError("production supervised CLI protected roots are invalid");
  }
  if (Object.hasOwn(dependencies, "supervisedCliCompositionCapability")) {
    throw new TypeError(
      "Production configured routing does not accept public composition authority",
    );
  }
  const symbols = Object.getOwnPropertySymbols(dependencies);
  if (
    symbols.length !== 1 ||
    !ProductionCliCompositionGrant.is(dependencies[symbols[0]])
  ) {
    throw new TypeError(
      "Production supervised CLI composition authority is invalid",
    );
  }
  return dependencies[symbols[0]];
}

function productionSupervisedCliProviderFactory(options, capability) {
  return createProductionSupervisedCliBrainProvider(options, capability);
}

function declaredRemote(config, name) {
  if (config.remote !== undefined && typeof config.remote !== "boolean") {
    throw new TypeError(`${name}.remote is invalid`);
  }
  return config.remote === true;
}

function providerWithBoundary(provider, remote) {
  const attemptDescriptor = Object.getOwnPropertyDescriptor(
    provider,
    "singleAttempt",
  );
  if (
    attemptDescriptor &&
    (!("value" in attemptDescriptor) ||
      typeof attemptDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider singleAttempt is invalid");
  }
  return Object.freeze({
    id: provider.id,
    remote: provider.remote || remote,
    ...(attemptDescriptor?.value === true ? { singleAttempt: true } : {}),
    generate: provider.generate.bind(provider),
    ...(typeof provider.close === "function"
      ? { close: provider.close.bind(provider) }
      : {}),
  });
}

function providerOptions(
  id,
  value,
  dependencies,
  supervisedCliProviderFactory,
  cliRuntimeFacts,
) {
  const name = `brainProviders.${id}`;
  const config = exactConfig(value, PROVIDER_KEYS, name);
  const remote = declaredRemote(config, name);
  const common = {
    ...selectOptions(config, PROVIDER_LIMIT_KEYS),
    id,
  };
  if (config.kind === "ollama") {
    return providerWithBoundary(
      new OllamaStructuredProvider({
        ...common,
        ...selectOptions(config, ["baseUrl", "contextTokens"]),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      remote,
    );
  }
  if (config.kind === "openai-compatible") {
    return providerWithBoundary(
      new OpenAiCompatibleProvider({
        ...common,
        ...selectOptions(config, [
          "baseUrl",
          "apiKeyEnv",
          "protocol",
          "responseFormat",
        ]),
        environment: dependencies.environment ?? process.env,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      remote,
    );
  }
  if (["codex-cli", "claude-cli"].includes(config.kind)) {
    if (Object.keys(config).some((key) => !CLI_PROVIDER_KEYS.has(key))) {
      throw new TypeError(`${name} contains a field unsupported by CLI providers`);
    }
    return providerWithBoundary(
      supervisedCliProviderFactory({
        ...common,
        cliKind: config.kind,
      }, cliRuntimeFacts(dependencies)),
      remote,
    );
  }
  throw new TypeError(
    `brain provider kind is unsupported: ${String(config.kind)}`,
  );
}

function createProviders(
  value,
  dependencies,
  supervisedCliProviderFactory,
  cliRuntimeFacts,
) {
  return dataEntries(value, "brainProviders").map(([id, config]) =>
    providerOptions(
      id,
      config,
      dependencies,
      supervisedCliProviderFactory,
      cliRuntimeFacts,
    ),
  );
}

function configuredBrainRouter(
  {
    brainProviders = {},
    dependencies = {},
  } = {},
  supervisedCliProviderFactory,
  cliRuntimeFacts,
) {
  const providers = createProviders(
    brainProviders,
    dependencies,
    supervisedCliProviderFactory,
    cliRuntimeFacts,
  );
  const router = new BrainRouter({ providers });
  const runtimes = providers
    .filter((provider) => typeof provider.close === "function")
    .map((provider) => ({ close: provider.close, closed: false }));
  let closeAttempt = null;
  const close = () => {
    if (closeAttempt) return closeAttempt;
    const attempt = (async () => {
      let firstFailure = null;
      for (let index = runtimes.length - 1; index >= 0; index -= 1) {
        const runtime = runtimes[index];
        if (runtime.closed) continue;
        try {
          await runtime.close();
          runtime.closed = true;
        } catch (error) {
          firstFailure ||= error;
        }
      }
      if (firstFailure) throw firstFailure;
    })();
    closeAttempt = attempt;
    void attempt.then(
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
    );
    return attempt;
  };
  return Object.freeze({
    generate: router.generate.bind(router),
    describe: router.describe.bind(router),
    close,
  });
}

function testCliProviderFactory(value) {
  const dependencies = exactConfig(
    value,
    new Set(["supervisedCliProviderFactory"]),
    "configured brain router test dependencies",
  );
  if (typeof dependencies.supervisedCliProviderFactory !== "function") {
    throw new TypeError(
      "configured brain router test CLI provider factory is invalid",
    );
  }
  return dependencies.supervisedCliProviderFactory;
}

export function createConfiguredBrainRouter(options = {}) {
  if (arguments.length > 1) {
    throw new TypeError(
      "Production configured brain routing does not accept replacement CLI provider factories",
    );
  }
  return configuredBrainRouter(
    options,
    productionSupervisedCliProviderFactory,
    productionSupervisedCliCapability,
  );
}

export function createTestConfiguredBrainRouter(
  options = {},
  testDependencies = {},
) {
  return configuredBrainRouter(
    options,
    testCliProviderFactory(testDependencies),
    testSupervisedCliRuntimeFacts,
  );
}

function roleOptions(id, value) {
  if (!SAFE_ROLE_ID.test(id) || id === "pr-reviewer") {
    throw new TypeError(`configured role id is invalid: ${id}`);
  }
  const config = exactConfig(value, ROLE_KEYS, `employees.roles.${id}`);
  if (typeof config.initialPaused !== "boolean") {
    throw new TypeError(`employees.roles.${id}.initialPaused is invalid`);
  }
  return config;
}

function configuredWorkforce({
  brainProviders = {},
  roles = {},
  store,
  onRun = async () => {},
  clock,
  actionAdmissionGate,
  dependencies = {},
} = {}, brainRouterFactory) {
  if (typeof onRun !== "function") throw new TypeError("onRun is invalid");
  const brainRouter = brainRouterFactory({
    brainProviders,
    dependencies,
  });
  const employees = [];
  const workers = [];
  for (const [id, rawConfig] of dataEntries(roles, "employees.roles")) {
    const config = roleOptions(id, rawConfig);
    const employee = new ConfiguredRoleEmployee({
      definition: {
        id,
        name: config.name,
        mission: config.mission,
        enabled: config.enabled,
        scheduleMinutes: config.scheduleMinutes,
      },
      permissions: config.permissions,
      brain: config.brain,
      ...(Object.hasOwn(config, "taskBrain")
        ? { taskBrain: config.taskBrain }
        : {}),
      brainRouter,
      ...(actionAdmissionGate === undefined
        ? {}
        : { actionAdmissionGate }),
      store,
      initialPaused: config.initialPaused,
      ...(config.workerId ? { workerId: config.workerId } : {}),
      ...(clock ? { clock } : {}),
      onRun: (input) => onRun(input),
    });
    employees.push(employee);
    workers.push(employee.asRoleWorker());
  }
  return Object.freeze({
    employees: Object.freeze([...employees]),
    workers: Object.freeze([...workers]),
    close: brainRouter.close,
  });
}

export function createConfiguredWorkforce(options = {}) {
  if (arguments.length > 1) {
    throw new TypeError(
      "Production configured workforce does not accept replacement CLI provider factories",
    );
  }
  return configuredWorkforce(options, (routerOptions) =>
    configuredBrainRouter(
      routerOptions,
      productionSupervisedCliProviderFactory,
      productionSupervisedCliCapability,
    ));
}

export function createTestConfiguredWorkforce(
  options = {},
  testDependencies = {},
) {
  const supervisedCliProviderFactory = testCliProviderFactory(testDependencies);
  return configuredWorkforce(options, (routerOptions) =>
    configuredBrainRouter(
      routerOptions,
      supervisedCliProviderFactory,
      testSupervisedCliRuntimeFacts,
    ),
  );
}
