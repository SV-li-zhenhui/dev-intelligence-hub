import {
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";
import { workProposalError } from "../domain/work-proposal-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { createConfiguredCodeJobBrainDirectory } from "./code-job-brain-directory.js";
import {
  codeJobBrainDigest,
  CodeJobGrantFactory,
  prepareCodeJobGrantVerification,
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

function providerAuthority(configuration, providerId) {
  const provider = configuration.brainProviders[providerId];
  if (!provider) return null;
  return {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv ?? null,
    ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
    remote: provider.remote ?? null,
  };
}

function roleAuthority(configuration, roleId) {
  const role = configuration.employees.roles[roleId];
  const policy = configuration.workCoordination.policy;
  return {
    prerequisites: {
      executor: globalExecutorAuthority(configuration),
      workCoordinationEnabled: configuration.workCoordination.enabled,
      memoryEnabled: configuration.memory.enabled,
    },
    role: role
      ? {
          enabled: role.enabled,
          allowedIntents: [...role.permissions.allowedIntents].sort(),
          brain: {
            provider: role.brain.provider,
            remoteData: role.brain.remoteData,
          },
          provider: providerAuthority(configuration, role.brain.provider),
        }
      : null,
    codePolicy: {
      admitted: policy.codeActionRoles.includes(roleId),
      operations: [...(policy.codeOperationsByRole[roleId] ?? [])].sort(),
    },
  };
}

function workspaceAuthority(configuration, workspaceId) {
  const executor = configuration.codeExecutor;
  const workspace = executor.workspaces?.find(
    (entry) => entry.id === workspaceId,
  );
  const requiredProfileIds = [
    ...(executor.requiredProfilesByWorkspace?.[workspaceId] ?? []),
  ].sort();
  return {
    workspace: workspace ?? null,
    requiredProfiles: requiredProfileIds.map((profileId) => ({
      id: profileId,
      configuration: executor.profiles?.[profileId] ?? null,
    })),
  };
}

function globalExecutorAuthority(configuration) {
  const executor = configuration.codeExecutor;
  return {
    enabled: executor.enabled,
    docker: executor.docker ?? null,
    brokerLimits: executor.brokerLimits ?? {},
    executorLimits: executor.executorLimits ?? {},
    maxArtifactBytes: executor.maxArtifactBytes ?? null,
  };
}

function grantAuthority(configuration, { repository, workspaceId, roleId }) {
  return {
    policyVersion: configuration.workCoordination.policy.version,
    role: roleAuthority(configuration, roleId),
    repository: {
      tracked: configuration.trackedRepositories.includes(repository),
      workspaceId:
        configuration.workCoordination.policy.workspaceByRepository[
          repository
        ] ?? null,
    },
    executor: workspaceAuthority(configuration, workspaceId),
  };
}

function advanceAuthority(previous, fingerprint) {
  return {
    epoch: previous.epoch + (previous.fingerprint === fingerprint ? 0 : 1),
    fingerprint,
  };
}

function roleAuthorityDigest(authority) {
  return canonicalJsonDigest({
    schemaVersion: 1,
    ...authority,
  });
}

function grantAuthorityDigest(authority, scope) {
  return canonicalJsonDigest({
    schemaVersion: 1,
    executorAuthorityDigest: scope.executorAuthorityDigest,
    scope: {
      repository: scope.repository,
      workspaceId: scope.workspaceId,
      roleId: scope.roleId,
      operation: scope.operation,
      policyVersion: scope.policyVersion,
    },
    authorization: authority,
  });
}

function executorWorkspaceAuthorityDigest(value, workspaceId) {
  const workspace = value?.workspaces?.find((entry) => entry.id === workspaceId);
  if (
    !workspace ||
    typeof workspace.authorityDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(workspace.authorityDigest)
  ) {
    throw invalid("代码执行器工作区授权无效");
  }
  return workspace.authorityDigest;
}

function legacyConfigurationAuthorityDigest(configuration) {
  // This exact projection is the persisted pre-scope digest algorithm.
  const roles = Object.fromEntries(
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
  const providers = Object.fromEntries(
    Object.entries(configuration.brainProviders).map(
      ([providerId, provider]) => [
        providerId,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv ?? null,
          remote: provider.remote ?? null,
        },
      ],
    ),
  );
  return canonicalJsonDigest({
    trackedRepositories: configuration.trackedRepositories,
    codeExecutor: configuration.codeExecutor,
    workCoordination: {
      enabled: configuration.workCoordination.enabled,
      policy: configuration.workCoordination.policy,
    },
    memoryEnabled: configuration.memory.enabled,
    roles,
    brainProviders: providers,
  });
}

function legacyWorkspaceAuthorityDigest(value, authority, workspaceId) {
  return canonicalJsonDigest({
    executorAuthorityDigest: executorWorkspaceAuthorityDigest(value, workspaceId),
    configurationAuthorityDigest: authority.digest,
    configurationAuthorityEpoch: authority.epoch,
  });
}

class AuthorityHistory {
  #versions;
  #executorAuthority;
  #scopeTimelines;
  #roleTimelines;
  #legacyStates;

  constructor(versions, executorAuthority) {
    this.#versions = versions;
    this.#executorAuthority = executorAuthority;
    this.#scopeTimelines = new Map();
    this.#roleTimelines = new Map();
    this.#legacyStates = null;
  }

  versionAt(index) {
    return this.#versions[index];
  }

  verificationTimeline(grant) {
    const scope = {
      executorAuthorityDigest: executorWorkspaceAuthorityDigest(
        this.#executorAuthority,
        grant.workspaceId,
      ),
      policyVersion: grant.policyVersion,
      repository: grant.repository,
      workspaceId: grant.workspaceId,
      roleId: grant.requestedBy.roleId,
      operation: grant.operation,
    };
    const scopedDigests = this.#scopeTimeline(scope);
    let legacyStates = this.#legacyStates;
    if (!legacyStates) {
      let legacyAuthority = { digest: null, epoch: 0 };
      legacyStates = this.#versions.map(({ configuration }) => {
        const digest = legacyConfigurationAuthorityDigest(configuration);
        legacyAuthority = {
          digest,
          epoch:
            legacyAuthority.epoch +
            (legacyAuthority.digest === digest ? 0 : 1),
        };
        return legacyAuthority;
      });
      this.#legacyStates = legacyStates;
    }
    const legacyDigests = legacyStates.map((authority) =>
      legacyWorkspaceAuthorityDigest(
        this.#executorAuthority,
        authority,
        grant.workspaceId,
      ),
    );
    return {
      scopedDigests,
      legacyStates,
      legacyDigests,
    };
  }

  scopeAuthorityDigestAt(index, scope) {
    return this.#scopeTimeline(scope)[index];
  }

  roleAuthorityDigestAt(index, roleId) {
    let timeline = this.#roleTimelines.get(roleId);
    if (!timeline) {
      let authority = { epoch: 0, fingerprint: null };
      timeline = this.#versions.map(({ configuration }) => {
        authority = advanceAuthority(
          authority,
          canonicalJsonDigest(roleAuthority(configuration, roleId)),
        );
        return roleAuthorityDigest(authority);
      });
      this.#roleTimelines.set(roleId, timeline);
    }
    return timeline[index];
  }

  #scopeTimeline(scope) {
    const key = canonicalJsonDigest(scope);
    let timeline = this.#scopeTimelines.get(key);
    if (timeline) return timeline;
    let authority = { epoch: 0, fingerprint: null };
    timeline = this.#versions.map(({ configuration }) => {
      authority = advanceAuthority(
        authority,
        canonicalJsonDigest(
          grantAuthority(configuration, {
            repository: scope.repository,
            workspaceId: scope.workspaceId,
            roleId: scope.roleId,
          }),
        ),
      );
      return grantAuthorityDigest(authority, scope);
    });
    this.#scopeTimelines.set(key, timeline);
    return timeline;
  }

}

function legacyExecutorAuthority(value, authority) {
  if (!value || !Array.isArray(value.workspaces)) {
    throw invalid("代码执行器授权无效");
  }
  return {
    workspaces: value.workspaces.map((workspace) => ({
      ...workspace,
      authorityDigest: canonicalJsonDigest({
        executorAuthorityDigest: workspace.authorityDigest,
        configurationAuthorityDigest: authority.digest,
        configurationAuthorityEpoch: authority.epoch,
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

function executableConfiguration(configuration) {
  return (
    configuration.codeExecutor.enabled === true &&
    configuration.workCoordination.enabled === true &&
    configuration.memory.enabled === true
  );
}

function configurationAdmitsRole(configuration, roleId) {
  const role = configuration.employees.roles[roleId];
  return (
    executableConfiguration(configuration) &&
    role?.enabled === true &&
    role.permissions.allowedIntents.includes("propose_code_action") &&
    configuration.workCoordination.policy.codeActionRoles.includes(roleId)
  );
}

function configurationAdmitsGrant(configuration, grant, executorAuthority) {
  const roleId = grant.requestedBy.roleId;
  const policy = configuration.workCoordination.policy;
  const workspace = executorAuthority?.workspaces?.find(
    ({ id }) => id === grant.workspaceId,
  );
  if (
    !configurationAdmitsRole(configuration, roleId) ||
    policy.version !== grant.policyVersion ||
    policy.workspaceByRepository[grant.repository] !== grant.workspaceId ||
    !policy.codeOperationsByRole[roleId]?.includes(grant.operation) ||
    !configuration.trackedRepositories.includes(grant.repository) ||
    !workspace ||
    roleBrainDigest(configuration, roleId) !== grant.brainDigest
  ) {
    return false;
  }
  return (
    canonicalJsonDigest({
      writablePaths: grant.writablePaths,
      requiredProfiles: grant.requiredProfiles,
    }) ===
    canonicalJsonDigest({
      writablePaths:
        grant.operation === "modify" ? workspace.writablePaths : [],
      requiredProfiles: workspace.requiredProfiles,
    })
  );
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
    const grant = prepareCodeJobGrantVerification(value);
    const current = await this.#current();
    requireTrackedRepository(current.configuration, grant.repository);
    const timeline = current.history.verificationTimeline(grant);
    const currentIndex = current.historyIndex;
    let currentError;
    try {
      return await this.#verifyWithContext(grant, current, current);
    } catch (error) {
      if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      currentError = error;
    }

    if (
      timeline.scopedDigests[currentIndex] ===
      grant.workspaceAuthorityDigest
    ) {
      const candidateIndex = this.#grantCandidateIndex(
        current,
        grant,
        timeline.scopedDigests,
        currentIndex - 1,
      );
      if (candidateIndex !== null) {
        const context = this.#context(
          current.history.versionAt(candidateIndex),
          current.history,
          candidateIndex,
        );
        try {
          return await this.#verifyWithContext(grant, context, current);
        } catch (error) {
          if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
        }
      }
    }

    if (
      timeline.legacyDigests[currentIndex] ===
      grant.workspaceAuthorityDigest
    ) {
      const candidateIndex = this.#grantCandidateIndex(
        current,
        grant,
        timeline.legacyDigests,
        currentIndex,
      );
      if (candidateIndex !== null) {
        const context = {
          ...this.#legacyContext(
            current.history.versionAt(candidateIndex),
            timeline.legacyStates[candidateIndex],
          ),
          currentAuthority: timeline.legacyStates[currentIndex],
        };
        try {
          return await this.#verifyLegacy(grant, context, current);
        } catch (error) {
          if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
        }
      }
    }
    throw currentError;
  }

  #grantCandidateIndex(current, grant, authorityDigests, maximumIndex) {
    for (let index = maximumIndex; index >= 0; index -= 1) {
      if (
        authorityDigests[index] === grant.workspaceAuthorityDigest &&
        configurationAdmitsGrant(
          current.history.versionAt(index).configuration,
          grant,
          this.#executorAuthority,
        )
      ) {
        return index;
      }
    }
    return null;
  }

  #brainCandidateContext(current, roleId, brainDigest) {
    for (let index = current.historyIndex - 1; index >= 0; index -= 1) {
      const version = current.history.versionAt(index);
      try {
        if (
          configurationAdmitsRole(version.configuration, roleId) &&
          roleBrainDigest(version.configuration, roleId) === brainDigest
        ) {
          return this.#context(version, current.history, index);
        }
      } catch (error) {
        if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      }
    }
    return null;
  }

  async decide(value, authorization) {
    const { beforeGenerate, brainDigest } = decisionAuthorization(authorization);
    const roleId = decisionRoleId(value);
    const current = await this.#current();
    let context = current.brainDigests.get(roleId) === brainDigest
      ? current
      : null;
    if (context === null) {
      context = this.#brainCandidateContext(current, roleId, brainDigest);
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
          latest.roleAuthorityDigest(roleId) !==
          context.roleAuthorityDigest(roleId)
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
    const history = new AuthorityHistory(versions, this.#executorAuthority);
    this.#contexts.clear();
    this.#cache = this.#context(active, history, versions.length - 1, {
      requireStartupBoundary: true,
    });
    return this.#cache;
  }

  #context(
    active,
    history,
    historyIndex,
    { requireStartupBoundary = false } = {},
  ) {
    const contextKey = `${active.version}:${active.digest}`;
    const cached = this.#contexts.get(contextKey);
    if (cached) return cached;
    const configuration = active.configuration;
    if (
      !executableConfiguration(configuration) ||
      (requireStartupBoundary &&
        canonicalJsonDigest(configuration.codeExecutor) !==
          this.#startupCodeExecutorDigest)
    ) {
      throw invalid("代码执行边界已变化，需要重启后才能接纳新动作");
    }
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    if (roleIds.length === 0) {
      throw invalid("活动配置没有可执行代码动作的岗位");
    }
    const scopeAuthorityDigest = (scope) =>
      history.scopeAuthorityDigestAt(historyIndex, scope);
    const grants = this.#grantFactoryFactory({
      executorAuthority: this.#executorAuthority,
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      brainByRole: roleBrains(configuration.employees.roles, roleIds),
      brainProviders: configuration.brainProviders,
      scopeAuthorityDigest,
    });
    method(grants, "create", "versioned code job grant factory");
    method(grants, "verify", "versioned code job grant factory");
    const context = {
      version: active.version,
      digest: active.digest,
      configuration,
      roleAuthorityDigest: (roleId) =>
        roleIds.includes(roleId)
          ? history.roleAuthorityDigestAt(historyIndex, roleId)
          : undefined,
      brainDigests: new Map(
        roleIds.map((roleId) => [
          roleId,
          roleBrainDigest(configuration, roleId),
        ]),
      ),
      grantAuthorityDigest: (grant) =>
        history.scopeAuthorityDigestAt(historyIndex, {
          executorAuthorityDigest: executorWorkspaceAuthorityDigest(
            this.#executorAuthority,
            grant.workspaceId,
          ),
          repository: grant.repository,
          workspaceId: grant.workspaceId,
          roleId: grant.requestedBy.roleId,
          operation: grant.operation,
          policyVersion: grant.policyVersion,
        }),
      grants,
      directory: null,
      history,
      historyIndex,
    };
    this.#contexts.set(contextKey, context);
    if (this.#contexts.size > 32) {
      this.#contexts.delete(this.#contexts.keys().next().value);
    }
    return context;
  }

  #legacyContext(active, authority) {
    const configuration = active.configuration;
    if (
      configuration.codeExecutor.enabled !== true ||
      configuration.workCoordination.enabled !== true ||
      configuration.memory.enabled !== true
    ) {
      throw invalid("旧版代码任务授权上下文已不可用");
    }
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    if (roleIds.length === 0) {
      throw invalid("旧版配置没有可执行代码动作的岗位");
    }
    const grants = this.#grantFactoryFactory({
      executorAuthority: legacyExecutorAuthority(
        this.#executorAuthority,
        authority,
      ),
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      brainByRole: roleBrains(configuration.employees.roles, roleIds),
      brainProviders: configuration.brainProviders,
    });
    method(grants, "verify", "legacy code job grant factory");
    return { authority, grants };
  }

  async #verifyWithContext(value, context, current) {
    const grant = await context.grants.verify(value);
    if (!grant || typeof grant.repository !== "string") {
      throw invalid("代码任务授权校验器返回了无效结果");
    }
    requireTrackedRepository(current.configuration, grant.repository);
    if (
      current.grantAuthorityDigest(grant) !== grant.workspaceAuthorityDigest
    ) {
      throw invalid("代码任务授权已被相关活动配置失效");
    }
    return grant;
  }

  async #verifyLegacy(value, context, current) {
    const grant = await context.grants.verify(value);
    if (!grant || typeof grant.repository !== "string") {
      throw invalid("旧版代码任务授权校验器返回了无效结果");
    }
    requireTrackedRepository(current.configuration, grant.repository);
    if (
      context.authority.digest !== context.currentAuthority.digest ||
      context.authority.epoch !== context.currentAuthority.epoch
    ) {
      throw invalid("旧版代码任务授权已被全局配置失效");
    }
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
