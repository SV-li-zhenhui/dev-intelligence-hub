import {
  assertWorkProposalExactKeys,
  cloneWorkProposalValue,
  normalizeWorkProposalDigest,
  workProposalDataEntries,
  workProposalDigest,
} from "./work-proposal-contract.js";

const WORK_INTENT_ID = /^work-intent-[a-f0-9]{64}$/;
export const LEGACY_UNKNOWN_WORK_INTENT_BINDING = "legacy_unknown";
const EXPECTED_BOUND_KIND = new Map([
  ["ask_user", "attention_request"],
  ["wait_condition", "wait_condition"],
  ["propose_github_review", "github_review_proposal"],
  [
    "propose_github_pull_request_action",
    "github_pull_request_action_proposal",
  ],
  ["propose_code_action", "code_action_proposal"],
  ["propose_configuration_change", "configuration_change_proposal"],
  ["handoff", "handoff"],
  ["complete", "complete"],
]);

function invalidBinding() {
  return new TypeError("work intent dispatch binding is invalid");
}

export function createWorkIntentDispatchBinding(boundIntent) {
  const normalized = cloneWorkProposalValue(boundIntent);
  return {
    bindingDigest: workProposalDigest(normalized),
    boundIntent: normalized,
  };
}

export function normalizeBoundWorkIntent(
  value,
  expected,
  error = invalidBinding(),
) {
  let normalized;
  try {
    normalized = cloneWorkProposalValue(value);
    assertWorkProposalExactKeys(
      normalized,
      [
        "intentId",
        "policyVersion",
        "kind",
        "requestedBy",
        "source",
        "binding",
        "payload",
      ],
      error,
    );
    assertWorkProposalExactKeys(
      normalized.requestedBy,
      ["roleId", "workItemId"],
      error,
    );
    assertWorkProposalExactKeys(
      normalized.source,
      ["assignmentId", "eventId"],
      error,
    );
    workProposalDataEntries(normalized.binding, error);
    workProposalDataEntries(normalized.payload, error);
  } catch {
    throw error;
  }
  const { intentId, ...content } = normalized;
  if (
    !WORK_INTENT_ID.test(intentId) ||
    intentId !== `work-intent-${workProposalDigest(content)}` ||
    !Number.isSafeInteger(normalized.policyVersion) ||
    normalized.policyVersion < 1 ||
    normalized.kind !== EXPECTED_BOUND_KIND.get(expected.intentType) ||
    normalized.requestedBy.roleId !== expected.roleId ||
    normalized.requestedBy.workItemId !== expected.workItemId ||
    normalized.source.assignmentId !== expected.assignmentId ||
    normalized.source.eventId !== expected.eventId
  ) {
    throw error;
  }
  return normalized;
}

export function normalizeWorkIntentDispatchBinding(
  value,
  error = invalidBinding(),
) {
  assertWorkProposalExactKeys(value, ["bindingDigest", "boundIntent"], error);
  let boundIntent;
  try {
    boundIntent = cloneWorkProposalValue(value.boundIntent);
  } catch {
    throw error;
  }
  const bindingDigest = normalizeWorkProposalDigest(value.bindingDigest, error);
  if (bindingDigest !== workProposalDigest(boundIntent)) throw error;
  return { bindingDigest, boundIntent };
}
