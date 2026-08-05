import {
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";
import { workProposalError } from "../domain/work-proposal-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { createConfiguredCodeJobBrainDirectory } from "./code-job-brain-directory.js";
import {
  codeJobBrainDigest,
  CodeJobGrantFactory,
} from "./code-job-grant-factory.js";

function invalid(message = "代码任务授权已不符合当前活动配置") {
  return workProposalError("INVALID_CODE_JOB_AUTHORITY", message);
}

function method(value, name, owner) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${owner} is invalid`);
  }
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${owner} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`${owner} is invalid`);
}

function activeConfiguration(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.configurationDigest !== "string"
  ) {
    throw invalid("当前没有可用的活动配置");
  }
  const configuration = normalizeConfigurationDocument(value.configuration);
  if (canonicalJsonDigest(configuration) !== value.configurationDigest) {
    throw invalid("活动配置摘要不一致");
  }
  return {
    version: value.version,
    digest: value.configurationDigest,
    configuration,
  };
}

function configurationAuthorityDigest(configuration) {
  const roleAuthority = Object.fromEntries(
    Object.entries(configuration.employees.roles).map(([roleId, role]) => [
      roleId,
      {
        enabled: role.enabled,
        allowedIntents: role.permissions.allowedIntents,
        brain: {
          provider: role.brain.provider,
          remoteData: role.brain.remoteData,
        },
      },
    ]),
  );
  const providerAuthority = Object.fromEntries(
    Object.entries(configuration.brainProviders).map(([providerId, provider]) => [
      providerId,
      {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKeyEnv: provider.apiKeyEnv ?? null,
        remote: provider.remote ?? null,
      },
    ]),
  );
  return canonicalJsonDigest({
    trackedRepositories: configuration.trackedRepositories,
    codeExecutor: configuration.codeExecutor,
    workCoordination: {
      enabled: configuration.workCoordination.enabled,
      policy: configuration.workCoordination.policy,
    },
    memoryEnabled: configuration.memory.enabled,
    roles: roleAuthority,
    brainProviders: providerAuthority,
  });
}

function scopedExecutorAuthority(value, authorityDigest, authorityEpoch) {
  if (!value || !Array.isArray(value.workspaces)) {
    throw invalid("代码执行器授权无效");
  }
  return {
    workspaces: value.workspaces.map((workspace) => ({
      ...workspace,
      authorityDigest: canonicalJsonDigest({
        executorAuthorityDigest: workspace.authorityDigest,
        configurationAuthorityDigest: authorityDigest,
        configurationAuthorityEpoch: authorityEpoch,
      }),
    })),
  };
}

function enabledCodeRoles(configuration) {
  const roles = configuration.employees.roles;
  return configuration.workCoordination.policy.codeActionRoles.filter(
    (roleId) => {
      const role = roles[roleId];
      return (
        role?.enabled === true &&
        role.permissions.allowedIntents.includes("propose_code_action")
      );
    },
  );
}

function roleBrains(roles, roleIds) {
  return Object.fromEntries(roleIds.map((roleId) => [roleId, roles[roleId].brain]));
}

function roleOperations(policy, roleIds) {
  return Object.fromEntries(
    roleIds.map((roleId) => [roleId, policy.codeOperationsByRole[roleId]]),
  );
}

function requireTrackedRepository(configuration, repository) {
  if (!configuration.trackedRepositories.includes(repository)) {
    throw invalid("代码任务仓库已不在活动跟踪范围内");
  }
}

function decisionAuthorization(value) {
  const keys = value && typeof value === "object" ? Reflect.ownKeys(value) : [];
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    keys.length !== 2 ||
    !keys.includes("beforeGenerate") ||
    !keys.includes("brainDigest")
  ) {
    throw new TypeError("code brain authorization is invalid");
  }
  const brainDigest = Object.getOwnPropertyDescriptor(value, "brainDigest");
  if (
    !brainDigest?.enumerable ||
    !("value" in brainDigest) ||
    typeof brainDigest.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(brainDigest.value)
  ) {
    throw new TypeError("code brain authorization is invalid");
  }
  return {
    beforeGenerate: method(value, "beforeGenerate", "code brain authorization"),
    brainDigest: brainDigest.value,
  };
}

function decisionRoleId(value) {
  const descriptor = value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "roleId")
    : null;
  if (
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(descriptor.value)
  ) {
    throw new TypeError("code brain roleId is invalid");
  }
  return descriptor.value;
}

function roleBrainDigest(configuration, roleId) {
  const role = configuration.employees.roles[roleId];
  if (!role) return null;
  return codeJobBrainDigest({
    roleId,
    brain: role.brain,
    brainProviders: configuration.brainProviders,
  });
}

function configurationHistory(value, current) {
  if (!value || !Array.isArray(value.versions)) {
    throw invalid("配置历史不可用");
  }
  if (value.versions.length !== current.version) {
    throw invalid("配置历史与当前活动版本不一致");
  }
  const versions = value.versions.map((entry, index) => {
    const version = activeConfiguration(entry);
    if (version.version !== index + 1) {
      throw invalid("配置历史版本不连续");
    }
    return version;
  });
  const latest = versions.at(-1);
  if (
    !latest ||
    latest.version !== current.version ||
    latest.digest !== current.digest
  ) {
    throw invalid("配置历史与当前活动版本不一致");
  }
  return versions;
}

function currentAuthority(versions) {
  let previousDigest = null;
  let epoch = 0;
  let digest = null;
  for (const version of versions) {
    digest = configurationAuthorityDigest(version.configuration);
    if (digest !== previousDigest) {
      epoch += 1;
      previousDigest = digest;
    }
  }
  return { digest, epoch };
}

export class VersionedCodeJobAuthority {
  #readActive;
  #readSnapshot;
  #executorAuthority;
  #startupCodeExecutorDigest;
  #brainDependencies;
  #grantFactoryFactory;
  #brainDirectoryFactory;
  #actionAdmission;
  #cache;
  #contexts;

  constructor({
    configurationReader,
    executorAuthority,
    startupConfiguration,
    brainDependencies = {},
    actionAdmissionGate,
    grantFactoryFactory = (options) => new CodeJobGrantFactory(options),
    brainDirectoryFactory = createConfiguredCodeJobBrainDirectory,
  } = {}) {
    this.#readActive = method(
      configurationReader,
      "readActive",
      "configurationReader",
    );
    this.#readSnapshot = method(
      configurationReader,
      "readSnapshot",
      "configurationReader",
    );
    this.#actionAdmission = method(
      actionAdmissionGate,
      "run",
      "actionAdmissionGate",
    );
    if (typeof grantFactoryFactory !== "function") {
      throw new TypeError("grantFactoryFactory must be a function");
    }
    if (typeof brainDirectoryFactory !== "function") {
      throw new TypeError("brainDirectoryFactory must be a function");
    }
    const startup = normalizeConfigurationDocument(startupConfiguration);
    this.#executorAuthority = executorAuthority;
    this.#startupCodeExecutorDigest = canonicalJsonDigest(startup.codeExecutor);
    this.#brainDependencies = brainDependencies;
    this.#grantFactoryFactory = grantFactoryFactory;
    this.#brainDirectoryFactory = brainDirectoryFactory;
    this.#cache = null;
    this.#contexts = new Map();
    Object.freeze(this);
  }

  async create(value) {
    const context = await this.#current();
    const result = await context.grants.create(value);
    const repository = result?.grant?.repository;
    if (typeof repository !== "string") {
      throw invalid("代码任务授权创建器返回了无效结果");
    }
    requireTrackedRepository(context.configuration, repository);
    return result;
  }

  async verify(value) {
    const current = await this.#current();
    let currentError;
    try {
      return await this.#verifyWithContext(value, current, current.configuration);
    } catch (error) {
      if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      currentError = error;
    }
    for await (const context of this.#historicalContexts(current)) {
      try {
        return await this.#verifyWithContext(
          value,
          context,
          current.configuration,
        );
      } catch (error) {
        if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      }
    }
    throw currentError;
  }

  async decide(value, authorization) {
    const { beforeGenerate, brainDigest } = decisionAuthorization(authorization);
    const roleId = decisionRoleId(value);
    const current = await this.#current();
    let context = current.brainDigests.get(roleId) === brainDigest
      ? current
      : null;
    if (context === null) {
      for await (const candidate of this.#historicalContexts(current)) {
        if (candidate.brainDigests.get(roleId) === brainDigest) {
          context = candidate;
          break;
        }
      }
    }
    if (!context) {
      throw invalid("岗位大脑封印已不受当前活动配置授权");
    }
    const directory = this.#directory(context);
    return directory.decide(value, {
      beforeGenerate: async () => {
        await beforeGenerate();
        const latest = await this.#current();
        if (
          latest.authorityDigest !== context.authorityDigest ||
          latest.authorityEpoch !== context.authorityEpoch
        ) {
          throw invalid("岗位大脑配置在调用前已变化");
        }
      },
      brainDigest,
      admitGenerate: this.#actionAdmission,
    });
  }

  async #current() {
    const active = activeConfiguration(await this.#readActive());
    if (
      this.#cache?.version === active.version &&
      this.#cache.digest === active.digest
    ) {
      return this.#cache;
    }
    const versions = configurationHistory(await this.#readSnapshot(), active);
    const authority = currentAuthority(versions);
    this.#cache = this.#context(active, authority);
    return this.#cache;
  }

  #context(active, authority) {
    const contextKey = `${active.version}:${active.digest}:${authority.epoch}`;
    const cached = this.#contexts.get(contextKey);
    if (cached) return cached;
    const configuration = active.configuration;
    if (
      configuration.codeExecutor.enabled !== true ||
      configuration.workCoordination.enabled !== true ||
      configuration.memory.enabled !== true ||
      canonicalJsonDigest(configuration.codeExecutor) !==
        this.#startupCodeExecutorDigest
    ) {
      throw invalid("代码执行边界已变化，需要重启后才能接纳新动作");
    }
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    if (roleIds.length === 0) {
      throw invalid("活动配置没有可执行代码动作的岗位");
    }
    const grants = this.#grantFactoryFactory({
      executorAuthority: scopedExecutorAuthority(
        this.#executorAuthority,
        authority.digest,
        authority.epoch,
      ),
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      brainByRole: roleBrains(configuration.employees.roles, roleIds),
      brainProviders: configuration.brainProviders,
    });
    method(grants, "create", "versioned code job grant factory");
    method(grants, "verify", "versioned code job grant factory");
    const context = {
      version: active.version,
      digest: active.digest,
      authorityDigest: authority.digest,
      authorityEpoch: authority.epoch,
      configuration,
      brainDigests: new Map(
        roleIds.map((roleId) => [
          roleId,
          roleBrainDigest(configuration, roleId),
        ]),
      ),
      grants,
      directory: null,
    };
    this.#contexts.set(contextKey, context);
    if (this.#contexts.size > 32) {
      this.#contexts.delete(this.#contexts.keys().next().value);
    }
    return context;
  }

  async *#historicalContexts(current) {
    const versions = configurationHistory(await this.#readSnapshot(), current);
    for (let index = versions.length - 2; index >= 0; index -= 1) {
      const version = versions[index];
      const digest = configurationAuthorityDigest(version.configuration);
      if (digest !== current.authorityDigest) break;
      try {
        yield this.#context(version, {
          digest,
          epoch: current.authorityEpoch,
        });
      } catch (error) {
        if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      }
    }
  }

  async #verifyWithContext(value, context, activeConfigurationValue) {
    const grant = await context.grants.verify(value);
    if (!grant || typeof grant.repository !== "string") {
      throw invalid("代码任务授权校验器返回了无效结果");
    }
    requireTrackedRepository(activeConfigurationValue, grant.repository);
    return grant;
  }

  #directory(context) {
    if (context.directory) return context.directory;
    const directory = this.#brainDirectoryFactory({
      brainProviders: context.configuration.brainProviders,
      roles: context.configuration.employees.roles,
      dependencies: this.#brainDependencies,
    });
    method(directory, "decide", "versioned code job brain directory");
    context.directory = directory;
    return directory;
  }
}
