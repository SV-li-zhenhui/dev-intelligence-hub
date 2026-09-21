import { normalizeConfigurationDocument } from "./domain/configuration-contract.js";
import { ActionAdmissionGate } from "./lib/action-admission-gate.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { ConfigurationStore } from "./services/configuration-store.js";

const GUARD_NAME = "mydashboard-configuration-v1";

function port(source, methods, name) {
  if (!source || methods.some((method) => typeof source[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, source[method].bind(source)]),
    ),
  );
}

function migrationFailure(error) {
  if (error?.code === "INVALID_CONFIGURATION_DOCUMENT") {
    return Object.freeze({
      code: "INVALID_CONFIGURATION_DOCUMENT",
      message: "初始配置验证失败，系统已进入安全禁用模式",
    });
  }
  return null;
}

function normalizeBootstrapError(value) {
  if (value === null || value === undefined) return null;
  const code = Object.getOwnPropertyDescriptor(value, "code");
  const message = Object.getOwnPropertyDescriptor(value, "message");
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2 ||
    !code ||
    !message ||
    !("value" in code) ||
    !("value" in message) ||
    typeof code.value !== "string" ||
    typeof message.value !== "string" ||
    code.value.length < 1 ||
    code.value.length > 128 ||
    message.value.length < 1 ||
    message.value.length > 1_000
  ) {
    throw new TypeError("bootstrapError is invalid");
  }
  return Object.freeze({ code: code.value, message: message.value });
}

export async function createConfigurationRuntime(
  bootstrapConfiguration,
  {
    store,
    fallbackConfiguration,
    bootstrapError = null,
    clock,
    idFactory,
    limits,
    operationQueue = new OperationQueue(),
    actionAdmissionGate = new ActionAdmissionGate(),
    createGuard = (options) => new ProcessExclusiveGuard(options),
  } = {},
) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const actionAdmission = port(
    actionAdmissionGate,
    ["bindEffective", "cutover", "readStatus", "reconcileCutover", "run"],
    "configuration action admission gate",
  );
  const declaredBootstrapError = normalizeBootstrapError(bootstrapError);
  const guard = createGuard({ name: GUARD_NAME });
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("configuration guard is invalid");
  }
  let closePromise = null;
  const close = () => {
    closePromise ||= Promise.resolve().then(() => guard.close());
    return closePromise;
  };
  try {
    await guard.acquire();
    const service = new ConfigurationStore({
      store,
      exclusiveLease: guard,
      operationQueue,
      ...(clock ? { clock } : {}),
      ...(idFactory ? { idFactory } : {}),
      ...(limits ? { limits } : {}),
    });
    const recovered = await service.recover();
    let active = recovered.activeVersion === null
      ? null
      : await service.readActive();
    let safeMode = false;
    let observedMigrationFailure = declaredBootstrapError;
    if (!active && !observedMigrationFailure) {
      try {
        const imported = await service.importBootstrap({
          configuration: bootstrapConfiguration,
          importedBy: "bootstrap-file",
        });
        active = imported.active;
      } catch (error) {
        observedMigrationFailure = migrationFailure(error);
        if (!observedMigrationFailure) throw error;
      }
    }
    let startupConfiguration;
    if (active) {
      startupConfiguration = active.configuration;
      observedMigrationFailure = null;
    } else {
      safeMode = true;
      startupConfiguration = normalizeConfigurationDocument(fallbackConfiguration);
    }
    const snapshot = await service.readAuthoritySnapshot();
    const reader = port(
      service,
      [
        "readSnapshot",
        "readActivationReconciliationSnapshot",
        "readAuthoritySnapshot",
        "readControlPlaneSnapshot",
        "readActive",
        "readVersion",
        "readDraft",
        "readProjectionBatch",
      ],
      "configuration reader",
    );
    const draftMethods = [
      "createDraft",
      "createInitializationDraft",
      "reviseDraft",
    ];
    const proposalMethods = [
      ...draftMethods,
      "readProposalDraft",
      "createProposalDraft",
    ];
    actionAdmission.bindEffective(
      active === null
        ? null
        : {
            version: active.version,
            configurationDigest: active.configurationDigest,
          },
    );
    const runtime = {
      status: Object.freeze({
        safeMode,
        activeVersion: active?.version ?? null,
        stateRevision: snapshot.revision,
        migrationError: observedMigrationFailure,
      }),
      startupConfiguration,
      reader,
      draftManager: port(service, draftMethods, "configuration draft manager"),
      simulator: port(
        service,
        [
          "prepareInitialization",
          "prepareDraftActivation",
          "prepareProposalDraftActivation",
          "prepareRollback",
        ],
        "configuration simulator",
      ),
      activationExecutor: port(
        service,
        ["activateInitialization", "activateDraft", "activateRollback"],
        "configuration activation executor",
      ),
      runtimeAdmission: Object.freeze({
        readStatus: actionAdmission.readStatus,
        run: actionAdmission.run,
      }),
      cutoverFence: Object.freeze({
        cutover: actionAdmission.cutover,
        readStatus: actionAdmission.readStatus,
        reconcileCutover: actionAdmission.reconcileCutover,
      }),
      proposalPort: port(
        service,
        proposalMethods,
        "configuration proposal port",
      ),
      close,
    };
    return Object.freeze(runtime);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure while the process guard remains fail closed.
    }
    throw error;
  }
}
