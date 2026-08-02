import { digestValue } from "../domain/code-executor-contract.js";

export const MAXIMUM_CODE_JOB_CONTEXT_BYTES = 128 * 1024;

export class CodeJobContextPackerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeJobContextPackerError";
    this.code = code;
    this.statusCode = 413;
  }
}

function contextError() {
  return new CodeJobContextPackerError(
    "CODE_BRAIN_CONTEXT_UNFIT",
    "Code brain fixed context cannot fit within the configured byte limit",
  );
}

function maximumContextBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumBytes is invalid");
  }
  return value;
}

export function codeJobContextBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    code: typeof value.code === "string" ? value.code.slice(0, 128) : null,
    message:
      typeof value.message === "string" ? value.message.slice(0, 512) : null,
  };
}

function compactSignal(detail) {
  let parsed;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const signal = {};
  for (const key of [
    "path",
    "query",
    "bytes",
    "exitCode",
    "durationMs",
    "timedOut",
    "truncated",
  ]) {
    if (["string", "number", "boolean"].includes(typeof parsed[key])) {
      signal[key] = parsed[key];
    } else if (parsed[key] === null) {
      signal[key] = null;
    }
  }
  for (const key of ["created", "modified", "deleted", "matches", "files"]) {
    if (Array.isArray(parsed[key])) signal[`${key}Count`] = parsed[key].length;
  }
  const error = compactError(parsed.error);
  if (error !== null) signal.error = error;
  return signal;
}

function summarizeObservation(observation) {
  const detail = observation.detail;
  return {
    actionType: observation.actionType,
    status: observation.status,
    detail: JSON.stringify({
      compacted: true,
      detailDigest: digestValue(detail),
      originalBytes: Buffer.byteLength(detail, "utf8"),
      signal: compactSignal(detail),
    }),
  };
}

function withObservations(context, observations) {
  return { ...context, observations };
}

export function packCodeJobBrainContext(
  value,
  { maximumBytes = MAXIMUM_CODE_JOB_CONTEXT_BYTES } = {},
) {
  const limit = maximumContextBytes(maximumBytes);
  const context = structuredClone(value);
  if (codeJobContextBytes(context) <= limit) return context;

  const fixed = withObservations(context, []);
  if (codeJobContextBytes(fixed) > limit) throw contextError();

  const observations = context.observations;
  if (!Array.isArray(observations) || observations.length === 0) return fixed;

  const newest = structuredClone(observations.at(-1));
  let packedObservations = [
    ...observations.slice(0, -1).map(summarizeObservation),
    newest,
  ];
  let packed = withObservations(context, packedObservations);
  while (packedObservations.length > 1 && codeJobContextBytes(packed) > limit) {
    packedObservations = packedObservations.slice(1);
    packed = withObservations(context, packedObservations);
  }
  if (codeJobContextBytes(packed) <= limit) return packed;

  packedObservations = [summarizeObservation(observations.at(-1))];
  packed = withObservations(context, packedObservations);
  if (codeJobContextBytes(packed) <= limit) return packed;
  return fixed;
}
