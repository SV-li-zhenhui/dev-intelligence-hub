import { normalizeConfigurationDocument } from "../domain/configuration-contract.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  isTerminalWorkProposalStatus,
  normalizeBoundWorkProposal,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { WorkProposalRunnerService } from "./work-proposal-runner.js";

const ACTIVE_PROPOSAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter((status) => !isTerminalWorkProposalStatus(status)),
);
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const STALE_CONFIGURATION_CODES = new Set([
  "CONFIGURATION_PROPOSAL_STALE",
  "CONFIGURATION_STATE_REVISION_CONFLICT",
  "CONFIGURATION_ACTIVATION_STALE",
  "CONFIGURATION_DRAFT_REVISION_CONFLICT",
]);
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function invalidProposal(message = "配置变更工作提案无效") {
  return workProposalError("INVALID_CONFIGURATION_CHANGE_PROPOSAL", message);
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function ownErrorCode(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(value, new TypeError("clock is invalid"));
}

function normalizeInput(value) {
  const error = invalidProposal();
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "attempt", "downstreamRef"],
    error,
  );
  if (!ACTIVE_PROPOSAL_STATUSES.has(value.status)) throw error;
  assertWorkProposalExactKeys(
    value.proposal,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    error,
  );
  const { contentDigest, ...proposalContent } = value.proposal;
  const proposal = normalizeBoundWorkProposal(proposalContent);
  if (proposal.contentDigest !== contentDigest) throw error;
  if (proposal.kind !== "configuration_change_proposal") throw error;
  assertWorkProposalExactKeys(
    proposal.binding,
    ["eventId", "subject", "dispatchIntentId"],
    error,
  );
  if (proposal.binding.eventId !== proposal.source.eventId) throw error;
  const intent = normalizeWorkIntent({
    schemaVersion: 1,
    type: "propose_configuration_change",
    ...proposal.payload,
  });
  return {
    proposal,
    intent,
    status: value.status,
    attempt: safeWorkProposalInteger(value.attempt, "attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef:
      value.downstreamRef === null || typeof value.downstreamRef === "string"
        ? value.downstreamRef
        : (() => { throw error; })(),
  };
}

function ownScalar(object, segment) {
  if (
    object === null ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.getPrototypeOf(object) !== Object.prototype
  ) {
    throw invalidProposal("配置变更只能遍历普通对象");
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, segment);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw invalidProposal("配置变更路径不存在");
  }
  return descriptor.value;
}

function applyScalarChanges(configuration, changes) {
  const candidate = structuredClone(normalizeConfigurationDocument(configuration));
  let changed = 0;
  for (const change of changes) {
    let parent = candidate;
    for (const segment of change.path.slice(0, -1)) {
      parent = ownScalar(parent, segment);
    }
    const leaf = change.path.at(-1);
    const current = ownScalar(parent, leaf);
    if (
      current === null ||
      typeof current === "object" ||
      !["string", "number", "boolean"].includes(typeof current) ||
      typeof change.value !== typeof current
    ) {
      throw invalidProposal("配置变更只能同类型替换现有标量字段");
    }
    if (!Object.is(current, change.value)) {
      parent[leaf] = change.value;
      changed += 1;
    }
  }
  if (changed === 0) throw invalidProposal("配置变更提案没有实际变化");
  try {
    return normalizeConfigurationDocument(candidate);
  } catch (cause) {
    throw invalidProposal("配置变更后的完整文档无效", { cause });
  }
}

function normalizeDraftRecord(value, proposal) {
  const error = invalidProposal("配置提案草稿返回无效");
  assertWorkProposalExactKeys(
    value,
    ["draft", "createdStateRevision", "currentHead"],
    error,
  );
  const draft = value.draft;
  if (
    draft === null ||
    typeof draft !== "object" ||
    Array.isArray(draft) ||
    typeof draft.draftId !== "string" ||
    !draft.draftId.startsWith("configuration-proposal-") ||
    draft.revision !== 1 ||
    !Number.isSafeInteger(draft.baseVersion) ||
    draft.baseVersion < 1 ||
    typeof draft.draftRevisionId !== "string" ||
    typeof draft.configurationDigest !== "string" ||
    draft.proposedBy !== `work-proposal:${proposal.contentDigest}` ||
    !Number.isSafeInteger(value.createdStateRevision) ||
    value.createdStateRevision < 1 ||
    typeof value.currentHead !== "boolean"
  ) {
    throw error;
  }
  return value;
}

function normalizeAuthoritySnapshot(value) {
  const error = invalidProposal("配置权威快照无效");
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.activeVersion) ||
    value.activeVersion < 1
  ) {
    throw error;
  }
  return { revision: value.revision, activeVersion: value.activeVersion };
}

function normalizeActive(value, expectedVersion) {
  const error = invalidProposal("活动配置返回无效");
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "configuration")
  ) {
    throw error;
  }
  if (value.version !== expectedVersion) {
    throw Object.assign(new Error("configuration authority changed during read"), {
      code: "CONFIGURATION_STATE_REVISION_CONFLICT",
    });
  }
  return normalizeConfigurationDocument(value.configuration);
}

function normalizeConfirmation(value, input, draftRecord) {
  const error = invalidProposal("配置确认结果无效");
  const action = value?.display?.payload?.action;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    value.kind !== "local.configuration-activate" ||
    !CONFIRMATION_STATUSES.has(value.status) ||
    typeof value.retryable !== "boolean" ||
    value.requestedBy?.roleId !== "configuration-owner" ||
    action?.type !== "activate_draft" ||
    action.draftId !== draftRecord.draft.draftId ||
    action.draftRevision !== draftRecord.draft.revision ||
    action.draftRevisionId !== draftRecord.draft.draftRevisionId ||
    action.documentDigest !== draftRecord.draft.configurationDigest ||
    action.expectedStateRevision !== draftRecord.createdStateRevision ||
    action.expectedActiveVersion !== draftRecord.draft.baseVersion ||
    (input.downstreamRef !== null && input.downstreamRef !== value.id)
  ) {
    throw error;
  }
  if (value.status === "failed") {
    if (
      value.failure === null ||
      typeof value.failure !== "object" ||
      typeof value.failure.code !== "string" ||
      value.retryable !== (value.failure.outcome === "absent")
    ) {
      throw error;
    }
  } else if (value.retryable) {
    throw error;
  }
  return value;
}

function nextAttemptAt(clock, pollIntervalMs) {
  return new Date(Date.parse(normalizeClock(clock)) + pollIntervalMs).toISOString();
}

function confirmationTransition(item, clock, pollIntervalMs, draftRecord) {
  const evidence = [
    `confirmation:${item.id}`,
    `configuration-draft:${draftRecord.draft.draftRevisionId}`,
  ];
  if (["pending", "executing"].includes(item.status)) {
    return {
      status: "waiting_confirmation",
      downstreamRef: item.id,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  if (item.status === "completed") {
    return { status: "succeeded", summary: "配置变更已由 owner 确认并激活", evidence };
  }
  if (item.status === "rejected") {
    return { status: "rejected", summary: "owner 已拒绝配置变更提案", evidence };
  }
  if (item.status === "stale") {
    return { status: "stale", summary: "配置变更提案已失效", evidence };
  }
  if (item.retryable) {
    return {
      status: "waiting_retry",
      reason: item.failure.code,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  return {
    status: "unknown",
    summary: "配置激活结果无法确认",
    evidence: [...evidence, item.failure.code],
  };
}

export class ConfigurationChangeProposalHandler {
  #readActive;
  #readAuthoritySnapshot;
  #readProposalDraft;
  #createProposalDraft;
  #requestActivation;
  #clock;
  #pollIntervalMs;

  constructor({
    configurationReader,
    configurationProposalPort,
    confirmationRequester,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    const reader = requirePort(
      configurationReader,
      ["readActive", "readAuthoritySnapshot"],
      "configurationReader",
    );
    const proposals = requirePort(
      configurationProposalPort,
      ["readProposalDraft", "createProposalDraft"],
      "configurationProposalPort",
    );
    this.#readActive = reader.readActive;
    this.#readAuthoritySnapshot = reader.readAuthoritySnapshot;
    this.#readProposalDraft = proposals.readProposalDraft;
    this.#createProposalDraft = proposals.createProposalDraft;
    this.#requestActivation = requirePort(
      confirmationRequester,
      ["requestProposalDraftActivation"],
      "confirmationRequester",
    ).requestProposalDraftActivation;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#pollIntervalMs = positiveInteger(
      pollIntervalMs,
      "pollIntervalMs",
      MAX_POLL_INTERVAL_MS,
    );
  }

  async handle(value) {
    let input;
    try {
      input = normalizeInput(value);
    } catch {
      return {
        status: "failed",
        summary: "配置变更工作提案未通过本地验证",
        evidence: ["configuration-proposal:invalid"],
      };
    }
    const identity = {
      proposalId: input.proposal.proposalId,
      proposalContentDigest: input.proposal.contentDigest,
    };
    let draftRecord = await this.#readProposalDraft(identity);
    if (draftRecord === null) {
      const authority = normalizeAuthoritySnapshot(
        await this.#readAuthoritySnapshot(),
      );
      const active = normalizeActive(
        await this.#readActive(),
        authority.activeVersion,
      );
      let proposedConfiguration;
      try {
        proposedConfiguration = applyScalarChanges(
          active,
          input.intent.changes,
        );
      } catch (error) {
        if (ownErrorCode(error) === "INVALID_CONFIGURATION_CHANGE_PROPOSAL") {
          return {
            status: "failed",
            summary: "配置变更未通过现有标量与完整配置校验",
            evidence: ["configuration-proposal:rejected-locally"],
          };
        }
        throw error;
      }
      draftRecord = await this.#createProposalDraft({
        ...identity,
        configuration: proposedConfiguration,
        expectedStateRevision: authority.revision,
      });
    }
    draftRecord = normalizeDraftRecord(draftRecord, input.proposal);
    let confirmation;
    try {
      confirmation = await this.#requestActivation(identity);
    } catch (error) {
      if (STALE_CONFIGURATION_CODES.has(ownErrorCode(error))) {
        return {
          status: "stale",
          summary: "配置权威已变化，提案未获得新的激活权限",
          evidence: [`configuration-draft:${draftRecord.draft.draftRevisionId}`],
        };
      }
      throw error;
    }
    return confirmationTransition(
      normalizeConfirmation(confirmation, input, draftRecord),
      this.#clock,
      this.#pollIntervalMs,
      draftRecord,
    );
  }
}

export function createConfigurationChangeProposalRunnerService({
  enabled = false,
  runner,
  configurationReader,
  configurationProposalPort,
  confirmationRequester,
  clock,
  pollIntervalMs,
  leaseDurationMs,
  handlerTimeoutMs,
  retryBaseMs,
  retryMaxMs,
  defaultBatchLimit,
} = {}) {
  if (enabled === false) return null;
  if (enabled !== true) throw new TypeError("configuration proposal runner enabled flag is invalid");
  const handler = new ConfigurationChangeProposalHandler({
    configurationReader,
    configurationProposalPort,
    confirmationRequester,
    ...(clock === undefined ? {} : { clock }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });
  return new WorkProposalRunnerService({
    runner,
    handler,
    ...(clock === undefined ? {} : { clock }),
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
    ...(handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs }),
    ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
    ...(retryMaxMs === undefined ? {} : { retryMaxMs }),
    ...(defaultBatchLimit === undefined ? {} : { defaultBatchLimit }),
  });
}
