import {
  attentionDigest,
  normalizeAttentionAnswer,
} from "../domain/attention-contract.js";
import {
  normalizeWorkProposalResult,
} from "../domain/work-proposal-contract.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTimestamp,
  SHA256_PATTERN,
} from "./work-ledger-values.js";

const RESULT_ATTESTATION_SCHEMA_VERSION = 1;
const ATTENTION_REQUEST_ID = /^attention-[a-f0-9]{64}$/;
const ATTENTION_RESULT_ID = /^attention-result-[a-f0-9]{64}$/;

function invalid() {
  throw new TypeError("work result attestation is invalid");
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function normalizeAttentionResult(value) {
  if (
    !hasExactLedgerKeys(value, [
      "resultId",
      "contentDigest",
      "requestId",
      "requestContentDigest",
      "producerBindingDigest",
      "kind",
      "answer",
      "requestRevision",
      "revision",
      "at",
    ])
  ) {
    invalid();
  }
  let answer;
  try {
    answer = normalizeAttentionAnswer(value.answer);
  } catch {
    invalid();
  }
  if (
    !new Set(["answered", "rejected"]).has(value.kind) ||
    (value.kind === "rejected") !== (answer.type === "reject") ||
    answer.type === "later"
  ) {
    invalid();
  }
  let at;
  try {
    at = normalizeLedgerTimestamp(value.at, "result.at");
  } catch {
    invalid();
  }
  const core = {
    requestId: boundedLedgerString(value.requestId, "requestId", 74),
    requestContentDigest: digest(value.requestContentDigest),
    producerBindingDigest: digest(value.producerBindingDigest),
    kind: value.kind,
    answer,
    requestRevision: positiveInteger(value.requestRevision),
    revision: positiveInteger(value.revision),
    at,
  };
  const contentDigest = attentionDigest(core);
  if (
    !ATTENTION_REQUEST_ID.test(core.requestId) ||
    core.requestId !== `attention-${core.requestContentDigest}` ||
    value.contentDigest !== contentDigest ||
    value.resultId !== `attention-result-${contentDigest}` ||
    !ATTENTION_RESULT_ID.test(value.resultId) ||
    core.requestRevision >= core.revision
  ) {
    invalid();
  }
  return {
    resultId: value.resultId,
    contentDigest,
    ...core,
  };
}

function normalizeAttentionPayload(value) {
  if (
    !hasExactLedgerKeys(value, [
      "requestId",
      "requestContentDigest",
      "producer",
      "producerBindingDigest",
      "requestKey",
      "result",
    ]) ||
    !hasExactLedgerKeys(value.producer, ["roleId", "workItemId"])
  ) {
    invalid();
  }
  const producer = {
    roleId: boundedLedgerString(value.producer.roleId, "roleId", 128),
    workItemId: boundedLedgerString(
      value.producer.workItemId,
      "workItemId",
      256,
    ),
  };
  const requestKey = boundedLedgerString(value.requestKey, "requestKey", 192);
  const producerBindingDigest = attentionDigest({ requestKey, producer });
  const result = normalizeAttentionResult(value.result);
  const requestId = boundedLedgerString(value.requestId, "requestId", 74);
  const requestContentDigest = digest(value.requestContentDigest);
  if (
    requestId !== result.requestId ||
    requestContentDigest !== result.requestContentDigest ||
    value.producerBindingDigest !== producerBindingDigest ||
    producerBindingDigest !== result.producerBindingDigest
  ) {
    invalid();
  }
  return {
    requestId,
    requestContentDigest,
    producer,
    producerBindingDigest,
    requestKey,
    result,
  };
}

function seal(kind, intentId, payload, decisionContentDigest) {
  const core = {
    schemaVersion: RESULT_ATTESTATION_SCHEMA_VERSION,
    kind,
    intentId: boundedLedgerString(intentId, "intentId", 192),
    payload,
    decisionContentDigest: digest(decisionContentDigest),
  };
  return {
    ...core,
    attestationDigest: ledgerDigest(core),
  };
}

export function createProposalResultAttestation({
  result,
  intentId,
  decisionContentDigest,
}) {
  return seal(
    "proposal_result",
    intentId,
    normalizeWorkProposalResult(result),
    decisionContentDigest,
  );
}

export function createAttentionResultAttestation({
  entry,
  intentId,
  decisionContentDigest,
}) {
  return seal(
    "attention_result",
    intentId,
    normalizeAttentionPayload({
      requestId: entry.requestId,
      requestContentDigest: entry.requestContentDigest,
      producer: entry.producer,
      producerBindingDigest: entry.producerBindingDigest,
      requestKey: entry.requestKey,
      result: entry.result,
    }),
    decisionContentDigest,
  );
}

export function normalizeWorkResultAttestation(value) {
  if (
    !hasExactLedgerKeys(value, [
      "schemaVersion",
      "kind",
      "intentId",
      "payload",
      "decisionContentDigest",
      "attestationDigest",
    ]) ||
    value.schemaVersion !== RESULT_ATTESTATION_SCHEMA_VERSION ||
    !new Set(["proposal_result", "attention_result"]).has(value.kind)
  ) {
    invalid();
  }
  const payload = value.kind === "proposal_result"
    ? normalizeWorkProposalResult(value.payload)
    : normalizeAttentionPayload(value.payload);
  const core = {
    schemaVersion: RESULT_ATTESTATION_SCHEMA_VERSION,
    kind: value.kind,
    intentId: boundedLedgerString(value.intentId, "intentId", 192),
    payload,
    decisionContentDigest: digest(value.decisionContentDigest),
  };
  const attestationDigest = ledgerDigest(core);
  if (value.attestationDigest !== attestationDigest) invalid();
  return { ...core, attestationDigest };
}
