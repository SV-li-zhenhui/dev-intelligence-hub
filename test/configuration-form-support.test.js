import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfigurationStructureOperation,
  CONFIGURATION_FORM_LIMITS,
  configurationDocumentFromForm,
  configurationFormPathKey,
  configurationReferences,
  createConfigurationFormState,
  removeConfigurationEntity,
  resetConfigurationFormState,
  setConfigurationFormField,
} from "../public/configuration-form-support.js";
import { normalizeConfigurationDocument } from "../src/domain/configuration-contract.js";
import {
  configurationFieldDescriptor,
  configurationStructureTemplate,
} from "../public/configuration-form-schema.js";

function assignedBrain(provider = "ollama", model = "qwen3.5:9b") {
  return {
    provider,
    model,
    remoteData: {
      requirements: false,
      code: false,
      memory: false,
    },
  };
}

function role(name, brain = assignedBrain()) {
  const workerId = `employee-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return {
    name,
    mission: `${name} 的测试使命`,
    enabled: true,
    scheduleMinutes: 3,
    initialPaused: true,
    workerId,
    permissions: {
      allowedIntents: ["ask_user", "handoff", "complete"],
    },
    brain,
  };
}

function representativeConfiguration() {
  return normalizeConfigurationDocument({
    port: 4173,
    refreshMinutes: 10,
    browserPollSeconds: 60,
    githubLogin: "SV-li-zhenhui",
    trackedRepositories: ["SVisions/OCT-Software", "SVisions/OCT-Product"],
    prResponsibility: { historicalAfterDays: 60 },
    codeExecutor: {
      enabled: true,
      docker: {
        executable: "docker.exe",
        host: "npipe:////./pipe/docker_engine",
      },
      workspaces: [
        {
          id: "oct-software",
          sourceRoot: "D:/code/OCT-Software",
          writablePaths: ["Source", "Tests"],
          excludePaths: [".git", "Build"],
        },
        {
          id: "dashboard",
          sourceRoot: "D:/claude/MyDashboard",
          writablePaths: ["public", "src", "test"],
          excludePaths: [".git", "data"],
        },
      ],
      profiles: {
        "node-unit": {
          kind: "node-test",
          image: `node@sha256:${"a".repeat(64)}`,
          timeoutMs: 120_000,
        },
        "node-contract": {
          kind: "node-test",
          image: `node@sha256:${"b".repeat(64)}`,
          timeoutMs: 180_000,
        },
      },
      requiredProfilesByWorkspace: {
        "oct-software": ["node-contract"],
        dashboard: ["node-unit", "node-contract"],
      },
      brokerLimits: {
        maxFiles: 100,
        maxFileBytes: 1_048_576,
        maxTotalBytes: 8_388_608,
        maxSearchMatches: 2_000,
        maxWriteBytes: 1_048_576,
      },
      executorLimits: { maxSessions: 4, maxActionsPerSession: 100 },
      maxArtifactBytes: 16_777_216,
    },
    changePackages: {
      enabled: true,
      gitCommand: "git.exe",
      gitTimeoutMs: 30_000,
    },
    githubActions: {
      enabled: true,
      actorAccountId: "SV-li-zhenhui",
      tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
      ghCommand: "gh.exe",
      networkEnv: {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "127.0.0.1,localhost",
      },
      timeoutMs: 120_000,
    },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [
        {
          id: "all-condition-kinds",
          source: "root",
          enabled: true,
          priority: 100,
          fallback: false,
          condition: {
            op: "all",
            conditions: [
              {
                op: "any",
                conditions: [
                  { op: "equals", path: "eventType", value: "pull_request.updated" },
                  { op: "atLeast", path: "payload.riskScore", value: 5 },
                ],
              },
              {
                op: "not",
                condition: { op: "equals", path: "payload.draft", value: true },
              },
              {
                op: "oneOf",
                path: "payload.state",
                values: ["open", "reopened", null, false, 1],
              },
              { op: "hasAny", path: "payload.labels", values: ["review", "risk:high"] },
              { op: "hasAll", path: "payload.labels", values: ["backend"] },
              { op: "globAny", path: "payload.files", patterns: ["Source/**"] },
              { op: "globAll", path: "payload.files", patterns: ["**/*.cpp"] },
            ],
          },
          targets: [
            { type: "role", id: "pr-engineer" },
            { type: "node", id: "verification" },
          ],
          onMatch: "continue",
        },
        {
          id: "fallback-owner",
          source: "root",
          enabled: true,
          priority: 0,
          fallback: true,
          condition: null,
          targets: [{ type: "person", id: "SV-li-zhenhui" }],
          onMatch: "stop",
        },
      ],
    },
    workCoordination: {
      enabled: true,
      tickSeconds: 30,
      intakeLimit: 100,
      workLimit: 20,
      dispatchLimit: 50,
      attentionLimit: 50,
      proposalLimit: 50,
      conditionLimit: 50,
      codeJobLimit: 10,
      codeJobMemoryLimit: 50,
      leaseDurationMs: 180_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 150_000,
      maxAttempts: 3,
      retryBaseMs: 30_000,
      retryMaxMs: 900_000,
      factMaximumAgeMs: 900_000,
      codeJobMaximumTurns: 20,
      codeJobObservationLimit: 50,
      policy: {
        version: 2,
        capabilityRoles: {
          coordination: "orchestrator",
          requirements: "requirements-analyst",
          "pr-review": "pr-engineer",
          development: "developer",
          testing: "tester",
        },
        githubReviewRoles: ["pr-engineer"],
        codeActionRoles: ["developer", "tester"],
        codeOperationsByRole: {
          developer: ["inspect", "modify", "verify"],
          tester: ["inspect", "verify"],
        },
        workspaceByRepository: {
          "SVisions/OCT-Software": "oct-software",
          "SVisions/OCT-Product": "dashboard",
        },
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 20_000,
      maximumStateBytes: 67_108_864,
      imports: { localSessions: true, git: true },
      answering: {
        enabled: true,
        maximumRecords: 12,
        maximumContextBytes: 114_688,
        maximumConcurrent: 1,
        brain: assignedBrain("remote-openai", "gpt-5-mini"),
        localBrain: assignedBrain(),
      },
    },
    brain: {
      enabled: true,
      provider: "ollama",
      model: "qwen3.5:9b",
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 45_000,
      numCtx: 8_192,
      contextTokens: 8_192,
      maxAssessmentsPerRefresh: 3,
    },
    brainProviders: {
      ollama: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 120_000,
        maxResponseBytes: 131_072,
        maxRequestBytes: 262_144,
        contextTokens: 8_192,
        remote: false,
      },
      "remote-openai": {
        kind: "openai-compatible",
        baseUrl: "https://models.example.invalid/v1",
        apiKeyEnv: "MYDASHBOARD_OPENAI_API_KEY",
        timeoutMs: 120_000,
        maxResponseBytes: 131_072,
        maxRequestBytes: 262_144,
        remote: true,
      },
      unused: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11435",
        contextTokens: 4_096,
        remote: false,
      },
    },
    employees: {
      prReviewer: {
        enabled: true,
        name: "PR 推进员工",
        initialPaused: true,
        policyVersion: 1,
        tickMinutes: 2,
        maxJobsPerTick: 2,
        maxAttempts: 3,
        retryMinutes: [1, 5, 30],
        maxPatchCharacters: 24_000,
        memoryLimit: 1_000,
        memoryOutboxLimit: 100,
        jobLimit: 500,
        allowRemoteCodeContext: false,
        brain: {
          model: "qwen3.5:9b",
          timeoutMs: 45_000,
          numCtx: 8_192,
          contextTokens: 8_192,
          maxAssessmentsPerRefresh: 3,
        },
      },
      roles: {
        "pr-engineer": role(
          "PR Engineer",
          assignedBrain("remote-openai", "gpt-5-mini"),
        ),
        orchestrator: role("Orchestrator"),
        "requirements-analyst": role("Requirements"),
        developer: role("Developer"),
        tester: role("Tester"),
        unused: role("Unused"),
      },
    },
    dingtalk: {
      enabled: true,
      selfUserId: "1137300121374851",
      notifyMinimumScore: 80,
      maxNotificationsPerRun: 5,
    },
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("a complete supported configuration round-trips without losing fields", () => {
  const configuration = representativeConfiguration();
  const state = createConfigurationFormState(configuration, {
    expectedStateRevision: 12,
    expectedActiveVersion: 4,
    draftId: "draft-4",
    draftRevision: 2,
    targetVersion: null,
  });
  const result = configurationDocumentFromForm(state);

  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, configuration);
  assert.notStrictEqual(result.configuration, configuration);
  assertDeepFrozen(state);
  assertDeepFrozen(result);
});

test("form saves reject remote legacy brains but accept remote role and memory brains", () => {
  const configuration = representativeConfiguration();
  let state = createConfigurationFormState(configuration);
  state = setConfigurationFormField(state, {
    path: ["brain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  assert.equal(configurationDocumentFromForm(state).ok, false);

  state = createConfigurationFormState(configuration);
  state = setConfigurationFormField(state, {
    path: ["employees", "roles", "developer", "brain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  state = setConfigurationFormField(state, {
    path: ["memory", "answering", "localBrain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.employees.roles.developer.brain.provider,
    "remote-openai",
  );
  assert.equal(result.configuration.memory.answering.localBrain.provider, "remote-openai");
});

test("unknown schemas and unknown nested fields fail closed", () => {
  const configuration = structuredClone(representativeConfiguration());
  configuration.unrecognized = true;
  assert.throws(
    () => createConfigurationFormState(configuration),
    /unsupported configuration field.*unrecognized/i,
  );

  const nested = structuredClone(representativeConfiguration());
  nested.brainProviders.ollama.futureCapability = true;
  assert.throws(
    () => createConfigurationFormState(nested),
    /unsupported configuration field.*futureCapability/i,
  );

  const routing = structuredClone(representativeConfiguration());
  routing.workflowRouting.schemaVersion = 2;
  assert.throws(
    () => createConfigurationFormState(routing),
    /unsupported workflow routing schema version/i,
  );
});

test("dangerous keys, accessors, hostile prototypes, and sparse arrays are rejected", () => {
  const prototypePollution = structuredClone(representativeConfiguration());
  Object.defineProperty(prototypePollution.brainProviders, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  assert.throws(() => createConfigurationFormState(prototypePollution), /dangerous key/i);
  assert.equal({}.polluted, undefined);

  const accessor = structuredClone(representativeConfiguration());
  Object.defineProperty(accessor, "port", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(() => createConfigurationFormState(accessor), /data properties/i);

  const arrayAccessor = structuredClone(representativeConfiguration());
  let arrayAccessorCalled = false;
  Object.defineProperty(arrayAccessor.trackedRepositories, "0", {
    enumerable: true,
    get() {
      arrayAccessorCalled = true;
      return "SVisions/OCT-Software";
    },
  });
  assert.throws(() => createConfigurationFormState(arrayAccessor), /data properties/i);
  assert.equal(arrayAccessorCalled, false);

  const hostilePrototype = structuredClone(representativeConfiguration());
  Object.setPrototypeOf(hostilePrototype.memory, { inherited: true });
  assert.throws(() => createConfigurationFormState(hostilePrototype), /plain object/i);

  const sparse = structuredClone(representativeConfiguration());
  sparse.trackedRepositories = new Array(2);
  sparse.trackedRepositories[1] = "SVisions/OCT-Software";
  assert.throws(() => createConfigurationFormState(sparse), /dense array/i);
});

test("shared object aliases and cumulative clone budgets fail before expansion", () => {
  const aliased = structuredClone(representativeConfiguration());
  const sharedImportPolicy = { enabled: true };
  aliased.memory.imports = {
    localSessions: sharedImportPolicy,
    git: sharedImportPolicy,
  };
  assert.throws(
    () => createConfigurationFormState(aliased),
    /shared object reference|alias/i,
  );

  const oversized = structuredClone(representativeConfiguration());
  const repositories = Array.from(
    { length: 34 },
    () => "x".repeat(CONFIGURATION_FORM_LIMITS.maxTextBytes),
  );
  let lateAccessorCalled = false;
  Object.defineProperty(repositories, "33", {
    enumerable: true,
    get() {
      lateAccessorCalled = true;
      throw new Error("clone must stop before this entry");
    },
  });
  oversized.trackedRepositories = repositories;
  assert.throws(
    () => createConfigurationFormState(oversized),
    (error) => error?.code === "FORM_LIMIT_EXCEEDED",
  );
  assert.equal(lateAccessorCalled, false);
});

test("temporary incomplete scalar edits are representable and do not mutate prior state", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const incomplete = setConfigurationFormField(initial, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });

  assert.equal(initial.edits.length, 0);
  assert.equal(incomplete.edits.length, 1);
  assert.equal(configurationDocumentFromForm(incomplete).ok, false);
  assert.deepEqual(configurationDocumentFromForm(incomplete).issues, [
    {
      path: "refreshMinutes",
      code: "INCOMPLETE_INTEGER",
      message: "请输入整数。",
    },
  ]);

  const completed = setConfigurationFormField(incomplete, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "15",
  });
  const result = configurationDocumentFromForm(completed);
  assert.equal(result.ok, true);
  assert.equal(result.configuration.refreshMinutes, 15);
  assert.equal(initial.baseDocument.refreshMinutes, 10);
  assertDeepFrozen(completed);
});

test("current editable scalar constraints match the authoritative configuration contract", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  const cases = [
    { path: ["port"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["refreshMinutes"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["browserPollSeconds"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["githubLogin"], kind: "text", rawValue: "invalid login", value: "invalid login" },
    {
      path: ["prResponsibility", "historicalAfterDays"],
      kind: "integer",
      rawValue: "-1",
      value: -1,
    },
    {
      path: ["workflowRouting", "maxHops"],
      kind: "integer",
      rawValue: "33",
      value: 33,
    },
    {
      path: ["changePackages", "gitCommand"],
      kind: "text",
      rawValue: "",
      value: "",
    },
    {
      path: ["githubActions", "actorAccountId"],
      kind: "text",
      rawValue: "invalid login",
      value: "invalid login",
    },
    {
      path: ["workCoordination", "tickSeconds"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["memory", "maximumRecords"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["memory", "answering", "maximumRecords"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["dingtalk", "selfUserId"],
      kind: "text",
      rawValue: "",
      value: "",
    },
    {
      path: ["dingtalk", "notifyMinimumScore"],
      kind: "integer",
      rawValue: "101",
      value: 101,
    },
    {
      path: ["dingtalk", "maxNotificationsPerRun"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
  ];

  for (const entry of cases) {
    const { value, ...edit } = entry;
    const edited = setConfigurationFormField(initial, edit);
    const result = configurationDocumentFromForm(edited);
    const displayPath = entry.path.join(".");
    assert.equal(result.ok, false, `${displayPath} must not be marked valid`);
    assert.equal(
      result.issues.some(({ path }) => path === displayPath),
      true,
      `${displayPath} must return a field issue`,
    );

    const canonicalCandidate = structuredClone(configuration);
    let parent = canonicalCandidate;
    for (const segment of entry.path.slice(0, -1)) parent = parent[segment];
    parent[entry.path.at(-1)] = value;
    assert.throws(
      () => normalizeConfigurationDocument(canonicalCandidate),
      undefined,
      `${displayPath} must remain aligned with the authoritative validator`,
    );
  }

  const wrongType = structuredClone(configuration);
  wrongType.port = "4173";
  assert.throws(() => createConfigurationFormState(wrongType), /port/i);
});

test("path identity preserves dotted entity ids without conflating segment boundaries", () => {
  const dottedEntity = ["brainProviders", "provider.with.dot"];
  const nestedFields = ["brainProviders", "provider", "with", "dot"];

  assert.equal(
    dottedEntity.join("."),
    nestedFields.join("."),
    "the old display-path key collides",
  );
  assert.notEqual(
    configurationFormPathKey(dottedEntity),
    configurationFormPathKey(nestedFields),
  );
  assert.equal(
    configurationFormPathKey(["workflowRouting", "rules", 0, "priority"]),
    configurationFormPathKey(["workflowRouting", "rules", "0", "priority"]),
    "numeric and string array indices address the same JavaScript property",
  );
});

test("forged form edits fail closed without polluting prototypes or invoking getters", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const pollutionKey = "__mydashboard_configuration_form_polluted__";
  const dangerous = {
    ...initial,
    edits: [
      {
        path: ["__proto__", pollutionKey],
        kind: "text",
        rawValue: "polluted",
      },
    ],
    dirty: true,
  };

  try {
    assert.throws(
      () => configurationDocumentFromForm(dangerous),
      /unsafe|dangerous/i,
    );
    assert.equal(Object.prototype[pollutionKey], undefined);
    assert.equal({}[pollutionKey], undefined);
  } finally {
    delete Object.prototype[pollutionKey];
  }

  let getterCalled = false;
  const getterEdit = {
    path: ["refreshMinutes"],
    kind: "integer",
  };
  Object.defineProperty(getterEdit, "rawValue", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "15";
    },
  });
  const accessor = { ...initial, edits: [getterEdit], dirty: true };
  assert.throws(() => configurationDocumentFromForm(accessor), /data properties/i);
  assert.equal(getterCalled, false);

  let directEditGetterCalled = false;
  const directEdit = {
    path: ["refreshMinutes"],
    kind: "integer",
  };
  Object.defineProperty(directEdit, "rawValue", {
    enumerable: true,
    get() {
      directEditGetterCalled = true;
      return "15";
    },
  });
  assert.throws(() => setConfigurationFormField(initial, directEdit), /data properties/i);
  assert.equal(directEditGetterCalled, false);

  let identityGetterCalled = false;
  const identity = { kind: "provider" };
  Object.defineProperty(identity, "id", {
    enumerable: true,
    get() {
      identityGetterCalled = true;
      return "unused";
    },
  });
  assert.throws(
    () => configurationReferences(initial.baseDocument, identity),
    /data properties/i,
  );
  assert.equal(identityGetterCalled, false);
});

test("forged unknown edit paths, kinds, raw values, and duplicate paths are rejected", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const editState = (edit, edits = [edit]) => ({
    ...initial,
    edits,
    dirty: true,
  });

  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["unknownField"], kind: "text", rawValue: "value" }),
      ),
    /unknown configuration field/i,
  );
  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["refreshMinutes"], kind: "command", rawValue: "15" }),
      ),
    /unsupported form edit kind/i,
  );
  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["refreshMinutes"], kind: "integer", rawValue: { value: "15" } }),
      ),
    /expects text input/i,
  );
  assert.throws(
    () =>
      removeConfigurationEntity(
        editState({ path: ["refreshMinutes"], kind: "integer", rawValue: "15" }, [
          { path: ["refreshMinutes"], kind: "integer", rawValue: "15" },
          { path: ["refreshMinutes"], kind: "integer", rawValue: "20" },
        ]),
        { kind: "provider", id: "unused" },
      ),
    /duplicate configuration form edit path/i,
  );
});

test("credential controls accept environment references but never secret values", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const invalid = setConfigurationFormField(initial, {
    path: ["brainProviders", "remote-openai", "apiKeyEnv"],
    kind: "text",
    rawValue: "sk-secret-value",
  });
  const rejected = configurationDocumentFromForm(invalid);
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.issues, [
    {
      path: "brainProviders.remote-openai.apiKeyEnv",
      code: "INVALID_ENV_REFERENCE",
      message: "这里只能填写环境变量名称，不能填写凭据值。",
    },
  ]);
  assert.equal(
    JSON.stringify(rejected).includes("sk-secret-value"),
    false,
    "validation DTO must not echo a rejected credential value",
  );

  const valid = setConfigurationFormField(initial, {
    path: ["githubActions", "tokenEnv"],
    kind: "text",
    rawValue: "MYDASHBOARD_GITHUB_TOKEN_NEXT",
  });
  assert.equal(
    configurationDocumentFromForm(valid).configuration.githubActions.tokenEnv,
    "MYDASHBOARD_GITHUB_TOKEN_NEXT",
  );

  for (const mutate of [
    (configuration) => {
      configuration.githubActions.tokenEnv = ["MYDASHBOARD_GITHUB_TOKEN"];
    },
    (configuration) => {
      configuration.brainProviders["remote-openai"].apiKeyEnv = [
        "MYDASHBOARD_OPENAI_API_KEY",
      ];
    },
  ]) {
    const wrongType = structuredClone(representativeConfiguration());
    mutate(wrongType);
    assert.throws(
      () => createConfigurationFormState(wrongType),
      /environment variable name/i,
    );
  }
});

test("reference graph blocks deleting providers, roles, workspaces, and profiles in use", () => {
  const configuration = representativeConfiguration();
  const state = createConfigurationFormState(configuration);

  assert.deepEqual(
    configurationReferences(configuration, { kind: "provider", id: "remote-openai" })
      .map(({ path }) => path),
    [
      "employees.roles.pr-engineer.brain.provider",
      "memory.answering.brain.provider",
    ],
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "provider", id: "remote-openai" })
      .reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "role", id: "developer" }).reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "workspace", id: "oct-software" })
      .reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "profile", id: "node-contract" })
      .reason,
    "referenced",
  );

  const editedState = setConfigurationFormField(state, {
    path: ["githubLogin"],
    kind: "text",
    rawValue: "SV-li-zhenhui-next",
  });
  const removedProvider = removeConfigurationEntity(editedState, {
    kind: "provider",
    id: "unused",
  });
  assert.equal(removedProvider.removed, true);
  assert.equal(removedProvider.state.dirty, true);
  assert.equal(removedProvider.state.edits.length, 1);
  assert.deepEqual(removedProvider.state.entityOperations, [
    { operation: "remove", kind: "provider", id: "unused" },
  ]);
  assert.equal(
    "unused" in removedProvider.state.baseDocument.brainProviders,
    true,
    "persistent baseline remains unchanged until the draft is saved",
  );
  assert.equal(
    removedProvider.state.baseDocument.githubLogin,
    configuration.githubLogin,
  );
  const removedDocument = configurationDocumentFromForm(removedProvider.state);
  assert.equal(removedDocument.ok, true);
  assert.equal("unused" in removedDocument.configuration.brainProviders, false);
  assert.equal(removedDocument.configuration.githubLogin, "SV-li-zhenhui-next");
  assert.equal("unused" in state.baseDocument.brainProviders, true);

  const removedRole = removeConfigurationEntity(state, {
    kind: "role",
    id: "unused",
  });
  assert.equal(removedRole.removed, true);
  assert.equal("unused" in removedRole.state.baseDocument.employees.roles, true);
  assert.equal(
    "unused" in configurationDocumentFromForm(removedRole.state).configuration.employees.roles,
    false,
  );
  assertDeepFrozen(removedRole);

  const dottedConfiguration = structuredClone(configuration);
  dottedConfiguration.brainProviders["unused.with.dot"] = structuredClone(
    dottedConfiguration.brainProviders.unused,
  );
  const dottedState = createConfigurationFormState(dottedConfiguration);
  const dottedRemoval = removeConfigurationEntity(dottedState, {
    kind: "provider",
    id: "unused.with.dot",
  });
  assert.equal(dottedRemoval.removed, true);
  assert.equal(
    Object.hasOwn(dottedRemoval.state.baseDocument.brainProviders, "unused.with.dot"),
    true,
  );
  const dottedDocument = configurationDocumentFromForm(dottedRemoval.state).configuration;
  assert.equal(Object.hasOwn(dottedDocument.brainProviders, "unused.with.dot"), false);
  assert.equal(
    Object.hasOwn(dottedDocument.brainProviders, "unused"),
    true,
    "entity deletion uses the exact id rather than its display path",
  );
});

test("form DTO boundaries have explicit immutable limits", () => {
  assert.deepEqual(CONFIGURATION_FORM_LIMITS, {
    maxDocumentBytes: 2 * 1024 * 1024,
    maxDepth: 32,
    maxArrayItems: 4_096,
    maxObjectFields: 4_096,
    maxCloneNodes: 100_000,
    maxPathSegments: 32,
    maxEdits: 4_096,
    maxEntityOperations: 4_096,
    maxReferences: 4_096,
    maxTextBytes: 64 * 1024,
  });
  assertDeepFrozen(CONFIGURATION_FORM_LIMITS);

  const state = createConfigurationFormState(representativeConfiguration());
  assert.throws(
    () =>
      setConfigurationFormField(state, {
        path: Array.from({ length: CONFIGURATION_FORM_LIMITS.maxPathSegments + 1 }, () => "x"),
        kind: "text",
        rawValue: "value",
      }),
    /path exceeds/i,
  );
});

test("structured array operations preserve baseline and retain a dirty audit trail", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["trackedRepositories"],
    value: "SVisions/New-Product",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["trackedRepositories"],
    index: 2,
    value: "SVisions/Renamed-Product",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["trackedRepositories"],
    index: 2,
  });

  assert.deepEqual(state.baseDocument.trackedRepositories, configuration.trackedRepositories);
  assert.equal(state.entityOperations.length, 3);
  assert.equal(state.dirty, true, "net-zero structural changes remain auditable and dirty");
  assert.deepEqual(
    configurationDocumentFromForm(state).configuration.trackedRepositories,
    configuration.trackedRepositories,
  );

  const reset = resetConfigurationFormState(state);
  assert.equal(reset.dirty, false);
  assert.deepEqual(reset.edits, []);
  assert.deepEqual(reset.entityOperations, []);
  assert.deepEqual(reset.baseDocument, initial.baseDocument);
  assert.deepEqual(reset.binding, initial.binding);
});

test("structured map operations add, replace and remove entries without raw JSON", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const provider = {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    remote: false,
    contextTokens: 8_192,
  };
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders"],
    key: "temporary",
    value: provider,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["brainProviders"],
    key: "temporary",
    value: { ...provider, timeoutMs: 60_000 },
  });
  let materialized = configurationDocumentFromForm(state);
  assert.equal(materialized.ok, true);
  assert.equal(materialized.configuration.brainProviders.temporary.timeoutMs, 60_000);

  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["brainProviders"],
    key: "temporary",
  });
  materialized = configurationDocumentFromForm(state);
  assert.equal(materialized.ok, true);
  assert.equal(Object.hasOwn(materialized.configuration.brainProviders, "temporary"), false);
  assert.equal(state.dirty, true);
  assert.equal(state.entityOperations.length, 3);

  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brainProviders"],
        key: "raw-json",
        rawValue: '{"kind":"ollama"}',
      }),
    /unsupported|unknown|value/i,
  );
});

test("structured operations cover routing, roles, policies and profile bindings", () => {
  const configuration = structuredClone(representativeConfiguration());
  let state = createConfigurationFormState(configuration);
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["employees", "roles", "developer", "permissions", "allowedIntents"],
    value: "orchestrate",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["workflowRouting", "rules", 0, "targets"],
    index: 0,
    value: { type: "role", id: "developer" },
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["workflowRouting", "rules", 0, "condition"],
    value: { op: "equals", path: "eventType", value: "pull_request.updated" },
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["workCoordination", "policy", "workspaceByRepository"],
    key: "SVisions/New-Product",
    value: "oct-software",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["codeExecutor", "requiredProfilesByWorkspace"],
    key: "oct-software",
    value: ["node-contract", "node-unit"],
  });

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.employees.roles.developer.permissions.allowedIntents.includes(
      "orchestrate",
    ),
    true,
  );
  assert.deepEqual(result.configuration.workflowRouting.rules[0].targets[0], {
    type: "role",
    id: "developer",
  });
  assert.equal(result.configuration.workflowRouting.rules[0].condition.op, "equals");
  assert.equal(
    result.configuration.workCoordination.policy.workspaceByRepository[
      "SVisions/New-Product"
    ],
    "oct-software",
  );
  assert.deepEqual(
    result.configuration.codeExecutor.requiredProfilesByWorkspace["oct-software"],
    ["node-contract", "node-unit"],
  );
});

test("structured operation boundary rejects getters, aliases, prototypes and disallowed paths", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let getterCalled = false;
  const input = {
    operation: "add",
    path: ["trackedRepositories"],
  };
  Object.defineProperty(input, "value", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "SVisions/Unsafe";
    },
  });
  assert.throws(() => applyConfigurationStructureOperation(initial, input), /data properties/i);
  assert.equal(getterCalled, false);

  const shared = { type: "role", id: "developer" };
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["workflowRouting", "rules"],
        value: {
          id: "aliased",
          source: "root",
          enabled: false,
          priority: 0,
          fallback: false,
          condition: { op: "equals", path: "eventType", value: "test" },
          targets: [shared, shared],
          onMatch: "stop",
        },
      }),
    /shared object reference/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brain"],
        key: "provider",
        value: "unsafe",
      }),
    /not an editable collection|allowlist/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["trackedRepositories"],
        value: Object.create(null),
      }),
    /plain object/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brainProviders"],
        key: "remote-secret",
        value: {
          kind: "openai-compatible",
          baseUrl: "https://models.example.invalid/v1",
          apiKeyEnv: "sk-secret-value",
          remote: true,
        },
      }),
    /environment variable reference|credential/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["trackedRepositories"],
        value: "x".repeat(CONFIGURATION_FORM_LIMITS.maxTextBytes + 1),
      }),
    /form limit/i,
  );
});

test("provider, role, workspace and profile support add, replace and remove", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let state = initial;
  const cases = [
    {
      path: ["brainProviders"],
      key: "temporary-provider",
      value: configurationStructureTemplate(["brainProviders"]).value,
      replacement(value) {
        return { ...structuredClone(value), timeoutMs: 60_000 };
      },
    },
    {
      path: ["employees", "roles"],
      key: "temporary-role",
      value: configurationStructureTemplate(["employees", "roles"]).value,
      replacement(value) {
        return { ...structuredClone(value), name: "临时岗位（已修改）" };
      },
    },
    {
      path: ["codeExecutor", "workspaces"],
      index: initial.baseDocument.codeExecutor.workspaces.length,
      value: configurationStructureTemplate(["codeExecutor", "workspaces"]).value,
      replacement(value) {
        return { ...structuredClone(value), sourceRoot: "D:/temporary" };
      },
    },
    {
      path: ["codeExecutor", "profiles"],
      key: "temporary-profile",
      value: configurationStructureTemplate(["codeExecutor", "profiles"]).value,
      replacement(value) {
        return { ...structuredClone(value), timeoutMs: 90_000 };
      },
    },
  ];

  for (const entry of cases) {
    const identity = Object.hasOwn(entry, "key")
      ? { key: entry.key }
      : { index: entry.index };
    state = applyConfigurationStructureOperation(state, {
      operation: "add",
      path: entry.path,
      ...identity,
      value: entry.value,
    });
    state = applyConfigurationStructureOperation(state, {
      operation: "replace",
      path: entry.path,
      ...identity,
      value: entry.replacement(entry.value),
    });
    state = applyConfigurationStructureOperation(state, {
      operation: "remove",
      path: entry.path,
      ...identity,
    });
  }

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, initial.baseDocument);
  assert.equal(state.entityOperations.length, cases.length * 3);
  assert.equal(state.dirty, true);
});

test("every primitive field can round-trip through its declarative edit kind", () => {
  const configuration = representativeConfiguration();
  let state = createConfigurationFormState(configuration);

  function visit(value, path) {
    if (value === null || typeof value !== "object") {
      const descriptor = configurationFieldDescriptor(path, value);
      const rawValue =
        descriptor.kind === "boolean"
          ? value
          : descriptor.kind === "scalar"
            ? JSON.stringify(value)
            : `${value}`;
      state = setConfigurationFormField(state, {
        path,
        kind: descriptor.kind,
        rawValue,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key]);
  }

  visit(configuration, []);
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, configuration);
});

test("declarative field constraints reject canonical-invalid values across every group", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  const cases = [
    { path: ["codeExecutor", "docker", "host"], kind: "text", rawValue: "https://docker.invalid", value: "https://docker.invalid" },
    { path: ["codeExecutor", "workspaces", 0, "id"], kind: "text", rawValue: "Unsafe_ID", value: "Unsafe_ID" },
    { path: ["codeExecutor", "profiles", "node-unit", "image"], kind: "text", rawValue: "node:latest", value: "node:latest" },
    { path: ["brainProviders", "ollama", "timeoutMs"], kind: "integer", rawValue: `${2 * 1_024 * 1_024 + 1}`, value: 2 * 1_024 * 1_024 + 1 },
    { path: ["employees", "roles", "developer", "mission"], kind: "text", rawValue: "x".repeat(4_097), value: "x".repeat(4_097) },
    { path: ["employees", "roles", "developer", "permissions", "allowedIntents", 0], kind: "text", rawValue: "unknown_intent", value: "unknown_intent" },
    { path: ["workflowRouting", "rules", 0, "priority"], kind: "integer", rawValue: "10001", value: 10_001 },
    { path: ["workflowRouting", "rules", 0, "condition", "conditions", 0, "conditions", 0, "path"], kind: "text", rawValue: "payload.__proto__", value: "payload.__proto__" },
    { path: ["workCoordination", "policy", "codeOperationsByRole", "developer", 0], kind: "text", rawValue: "execute", value: "execute" },
    { path: ["memory", "answering", "maximumConcurrent"], kind: "integer", rawValue: "17", value: 17 },
    { path: ["dingtalk", "selfUserId"], kind: "text", rawValue: "", value: "" },
  ];

  for (const entry of cases) {
    const { value, ...edit } = entry;
    const result = configurationDocumentFromForm(
      setConfigurationFormField(initial, edit),
    );
    assert.equal(result.ok, false, `${entry.path.join(".")} must fail in the form`);

    const canonical = structuredClone(configuration);
    let parent = canonical;
    for (const segment of entry.path.slice(0, -1)) parent = parent[segment];
    parent[entry.path.at(-1)] = value;
    assert.throws(
      () => normalizeConfigurationDocument(canonical),
      undefined,
      `${entry.path.join(".")} must fail in the canonical contract`,
    );
  }
});

test("generic structural deletion is reference-safe and delete plus recreate stays dirty", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const provider = structuredClone(initial.baseDocument.brainProviders.ollama);
  const removed = applyConfigurationStructureOperation(initial, {
    operation: "remove",
    path: ["brainProviders"],
    key: "ollama",
  });
  const blocked = configurationDocumentFromForm(removed);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issues.some(({ code }) => code === "ENTITY_REFERENCED"), true);

  const recreated = applyConfigurationStructureOperation(removed, {
    operation: "add",
    path: ["brainProviders"],
    key: "ollama",
    value: provider,
  });
  const restored = configurationDocumentFromForm(recreated);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.configuration, initial.baseDocument);
  assert.equal(recreated.dirty, true);
  assert.equal(recreated.entityOperations.length, 2);
});
