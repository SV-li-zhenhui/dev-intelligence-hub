import { OllamaStructuredProvider } from "../adapters/ollama-structured-provider.js";
import { OpenAiCompatibleProvider } from "../adapters/openai-compatible-provider.js";
import { BrainRouter } from "./brain-router.js";
import { ConfiguredRoleEmployee } from "./configured-role-employee.js";

const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const PROVIDER_KEYS = new Set([
  "kind",
  "baseUrl",
  "apiKeyEnv",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "contextTokens",
  "remote",
]);
const COMMON_PROVIDER_OPTION_KEYS = Object.freeze([
  "baseUrl",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
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

function declaredRemote(config, name) {
  if (config.remote !== undefined && typeof config.remote !== "boolean") {
    throw new TypeError(`${name}.remote is invalid`);
  }
  return config.remote === true;
}

function providerWithBoundary(provider, remote) {
  return Object.freeze({
    id: provider.id,
    remote: provider.remote || remote,
    generate: provider.generate.bind(provider),
  });
}

function providerOptions(id, value, dependencies) {
  const name = `brainProviders.${id}`;
  const config = exactConfig(value, PROVIDER_KEYS, name);
  const remote = declaredRemote(config, name);
  const common = {
    ...selectOptions(config, COMMON_PROVIDER_OPTION_KEYS),
    id,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  };
  if (config.kind === "ollama") {
    return providerWithBoundary(
      new OllamaStructuredProvider({
        ...common,
        ...selectOptions(config, ["contextTokens"]),
      }),
      remote,
    );
  }
  if (config.kind === "openai-compatible") {
    return providerWithBoundary(
      new OpenAiCompatibleProvider({
        ...common,
        ...selectOptions(config, ["apiKeyEnv"]),
        environment: dependencies.environment ?? process.env,
      }),
      remote,
    );
  }
  throw new TypeError(
    `brain provider kind is unsupported: ${String(config.kind)}`,
  );
}

function createProviders(value, dependencies) {
  return dataEntries(value, "brainProviders").map(([id, config]) =>
    providerOptions(id, config, dependencies),
  );
}

export function createConfiguredBrainRouter({
  brainProviders = {},
  dependencies = {},
} = {}) {
  return new BrainRouter({
    providers: createProviders(brainProviders, dependencies),
  });
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

export function createConfiguredWorkforce({
  brainProviders = {},
  roles = {},
  store,
  onRun = async () => {},
  clock,
  dependencies = {},
} = {}) {
  if (typeof onRun !== "function") throw new TypeError("onRun is invalid");
  const brainRouter = createConfiguredBrainRouter({
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
      brainRouter,
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
  });
}
