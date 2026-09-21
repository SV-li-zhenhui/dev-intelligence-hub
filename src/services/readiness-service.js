import { types as utilTypes } from "node:util";

const PROBE_KINDS = new Set(["recovery", "external_action", "capacity"]);
const REQUIRED_PROBE_KINDS = [...PROBE_KINDS];
const SAFE_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_LABEL = /^[a-z][a-z0-9._-]{0,63}$/;
const CAPACITY_SEVERITIES = new Set(["warning", "critical"]);
const MAX_PROBES = 24;
const MAX_ITEMS_PER_PROBE = 16;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const READINESS_OPTION_KEYS = new Set(["probes", "probeTimeoutMs"]);

const LIVENESS = Object.freeze({ schemaVersion: 1, live: true });

class InvalidProbeResult extends Error {}

function invalidConfiguration(message) {
  throw new TypeError(message);
}

function invalidResult() {
  throw new InvalidProbeResult();
}

function dataObject(value, expected, onInvalid) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    onInvalid();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    onInvalid();
  }
  const result = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      onInvalid();
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function dataArray(value, maximum, onInvalid) {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    onInvalid();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) onInvalid();
    result.push(descriptor.value);
  }
  return result;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSortedStrings(value, pattern) {
  const items = dataArray(value, MAX_ITEMS_PER_PROBE, invalidResult);
  const unique = new Set();
  for (const item of items) {
    if (
      typeof item !== "string" ||
      item !== item.normalize("NFC") ||
      !pattern.test(item) ||
      unique.has(item)
    ) {
      invalidResult();
    }
    unique.add(item);
  }
  return [...unique].sort(compareText);
}

function normalizeRecoveryResult(value) {
  const entries = dataObject(value, ["blockerCodes"], invalidResult);
  return {
    blockerCodes: uniqueSortedStrings(entries.get("blockerCodes"), SAFE_CODE),
  };
}

function normalizeExternalActionResult(value) {
  const entries = dataObject(value, ["unknownActionTypes"], invalidResult);
  return {
    unknownActionTypes: uniqueSortedStrings(
      entries.get("unknownActionTypes"),
      SAFE_LABEL,
    ),
  };
}

function normalizeCapacityResult(value) {
  const entries = dataObject(value, ["warnings"], invalidResult);
  const warnings = dataArray(
    entries.get("warnings"),
    MAX_ITEMS_PER_PROBE,
    invalidResult,
  ).map((warning) => {
    const fields = dataObject(
      warning,
      ["resource", "severity", "usedPercent"],
      invalidResult,
    );
    const resource = fields.get("resource");
    const severity = fields.get("severity");
    const usedPercent = fields.get("usedPercent");
    if (
      typeof resource !== "string" ||
      resource !== resource.normalize("NFC") ||
      !SAFE_LABEL.test(resource) ||
      !CAPACITY_SEVERITIES.has(severity) ||
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      Object.is(usedPercent, -0) ||
      usedPercent < 0 ||
      usedPercent > 100
    ) {
      invalidResult();
    }
    return { resource, severity, usedPercent };
  });
  warnings.sort((left, right) =>
    compareText(left.resource, right.resource) ||
    compareText(left.severity, right.severity) ||
    left.usedPercent - right.usedPercent,
  );
  for (let index = 1; index < warnings.length; index += 1) {
    if (warnings[index - 1].resource === warnings[index].resource) {
      invalidResult();
    }
  }
  return { warnings };
}

function normalizeProbeResult(kind, value) {
  if (kind === "recovery") return normalizeRecoveryResult(value);
  if (kind === "external_action") return normalizeExternalActionResult(value);
  return normalizeCapacityResult(value);
}

function normalizeProbes(value) {
  const candidates = dataArray(value, MAX_PROBES, () =>
    invalidConfiguration("probes must be a bounded plain array"));
  const ids = new Set();
  const probes = candidates.map((candidate) => {
    const entries = dataObject(candidate, ["id", "kind", "check"], () =>
      invalidConfiguration("probe must be a plain data record"));
    const id = entries.get("id");
    const kind = entries.get("kind");
    const check = entries.get("check");
    if (
      typeof id !== "string" ||
      id !== id.normalize("NFC") ||
      !SAFE_ID.test(id) ||
      ids.has(id) ||
      !PROBE_KINDS.has(kind) ||
      typeof check !== "function" ||
      utilTypes.isProxy(check)
    ) {
      invalidConfiguration("probe contract is invalid or duplicated");
    }
    ids.add(id);
    return Object.freeze({
      id,
      kind,
      check: Function.prototype.bind.call(check, candidate),
    });
  });
  probes.sort((left, right) =>
    compareText(left.kind, right.kind) || compareText(left.id, right.id));
  return Object.freeze(probes);
}

function readinessOptions(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidConfiguration("ReadinessService options must be a plain data record");
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !READINESS_OPTION_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalidConfiguration("ReadinessService options must be a plain data record");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

async function runProbe(probe, timeoutMs, activeRuns) {
  if (activeRuns.has(probe.id)) return { status: "timeout" };
  const controller = new AbortController();
  const context = Object.freeze({ signal: controller.signal });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout" });
    }, timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => probe.check(context))
    .then(
      (value) => ({ status: "success", value }),
      () => ({ status: "failure" }),
    );
  const active = { work };
  activeRuns.set(probe.id, active);
  work.then(() => {
    if (activeRuns.get(probe.id) === active) activeRuns.delete(probe.id);
  }).catch(() => {});
  const outcome = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return outcome;
}

function freezeItems(items) {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
}

function freezeResult(value) {
  freezeItems(value.recoveryBlockers);
  freezeItems(value.unknownExternalActions);
  freezeItems(value.capacityWarnings);
  freezeItems(value.probeFailures);
  Object.freeze(value.probeSummary);
  return Object.freeze(value);
}

function compactOverflowResult(checkedAt, probeSummary) {
  return freezeResult({
    schemaVersion: 1,
    checkedAt,
    ready: false,
    recoveryBlockers: [],
    unknownExternalActions: [],
    capacityWarnings: [],
    probeFailures: [{
      probeId: "readiness",
      code: "OUTPUT_LIMIT_EXCEEDED",
    }],
    probeSummary: { ...probeSummary },
  });
}

export class ReadinessService {
  #probes;
  #probeTimeoutMs;
  #inFlight = null;
  #activeProbeRuns = new Map();

  constructor(options = {}) {
    const entries = readinessOptions(options);
    const probes = entries.has("probes") ? entries.get("probes") : [];
    const probeTimeoutMs = entries.has("probeTimeoutMs")
      ? entries.get("probeTimeoutMs")
      : 5_000;
    if (
      !Number.isSafeInteger(probeTimeoutMs) ||
      probeTimeoutMs < 1 ||
      probeTimeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new TypeError("probeTimeoutMs must be a bounded positive integer");
    }
    this.#probes = normalizeProbes(probes);
    this.#probeTimeoutMs = probeTimeoutMs;
    Object.freeze(this);
  }

  liveness() {
    return LIVENESS;
  }

  readiness() {
    if (this.#inFlight !== null) return this.#inFlight;
    const cycle = this.#check();
    this.#inFlight = cycle;
    cycle.finally(() => {
      if (this.#inFlight === cycle) this.#inFlight = null;
    }).catch(() => {});
    return cycle;
  }

  async #check() {
    const checkedAt = new Date().toISOString();
    const outcomes = await Promise.all(
      this.#probes.map(async (probe) => ({
        probe,
        outcome: await runProbe(
          probe,
          this.#probeTimeoutMs,
          this.#activeProbeRuns,
        ),
      })),
    );
    const recoveryBlockers = [];
    const unknownExternalActions = [];
    const capacityWarnings = [];
    const probeFailures = [];
    const configuredKinds = new Set(this.#probes.map(({ kind }) => kind));
    const missingKinds = REQUIRED_PROBE_KINDS.filter(
      (kind) => !configuredKinds.has(kind),
    );
    for (const kind of missingKinds) {
      probeFailures.push({ probeId: kind, code: "PROBE_MISSING" });
    }
    let succeeded = 0;
    let failed = missingKinds.length;
    let timedOut = 0;

    for (const { probe, outcome } of outcomes) {
      if (outcome.status === "timeout") {
        timedOut += 1;
        probeFailures.push({ probeId: probe.id, code: "PROBE_TIMEOUT" });
        continue;
      }
      if (outcome.status === "failure") {
        failed += 1;
        probeFailures.push({ probeId: probe.id, code: "PROBE_FAILED" });
        continue;
      }
      let normalized;
      try {
        normalized = normalizeProbeResult(probe.kind, outcome.value);
      } catch (error) {
        if (!(error instanceof InvalidProbeResult)) throw error;
        failed += 1;
        probeFailures.push({
          probeId: probe.id,
          code: "PROBE_RESULT_INVALID",
        });
        continue;
      }
      succeeded += 1;
      if (probe.kind === "recovery") {
        for (const code of normalized.blockerCodes) {
          recoveryBlockers.push({ probeId: probe.id, code });
        }
      } else if (probe.kind === "external_action") {
        for (const actionType of normalized.unknownActionTypes) {
          unknownExternalActions.push({ probeId: probe.id, actionType });
        }
      } else {
        for (const warning of normalized.warnings) {
          capacityWarnings.push({ probeId: probe.id, ...warning });
        }
      }
    }

    recoveryBlockers.sort((left, right) =>
      compareText(left.probeId, right.probeId) || compareText(left.code, right.code));
    unknownExternalActions.sort((left, right) =>
      compareText(left.probeId, right.probeId) ||
      compareText(left.actionType, right.actionType));
    capacityWarnings.sort((left, right) =>
      compareText(left.probeId, right.probeId) ||
      compareText(left.resource, right.resource));
    probeFailures.sort((left, right) =>
      compareText(left.probeId, right.probeId) || compareText(left.code, right.code));

    const probeSummary = {
      total: this.#probes.length + missingKinds.length,
      succeeded,
      failed,
      timedOut,
    };
    const result = {
      schemaVersion: 1,
      checkedAt,
      ready:
        recoveryBlockers.length === 0 &&
        unknownExternalActions.length === 0 &&
        !capacityWarnings.some(({ severity }) => severity === "critical") &&
        probeFailures.length === 0,
      recoveryBlockers,
      unknownExternalActions,
      capacityWarnings,
      probeFailures,
      probeSummary,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
      return compactOverflowResult(checkedAt, probeSummary);
    }
    return freezeResult(result);
  }
}
