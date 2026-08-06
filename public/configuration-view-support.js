const IMPACT_CATEGORIES = [
  ["安全收紧", "securityTightening", "security_tightening"],
  ["权限扩展", "authorityExpansion", "authority_expansion"],
  ["普通配置变化", "benignClaimChange", "benign_claim_change"],
  ["需要重启", "restartRequired", "restart_required"],
];

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeConfigurationBinding(value) {
  if (!isPlainRecord(value)) return null;
  return {
    expectedStateRevision: Number.isSafeInteger(value.expectedStateRevision)
      ? value.expectedStateRevision
      : null,
    expectedActiveVersion: Number.isSafeInteger(value.expectedActiveVersion)
      ? value.expectedActiveVersion
      : null,
    draftId: typeof value.draftId === "string" ? value.draftId : null,
    draftRevision: Number.isSafeInteger(value.draftRevision)
      ? value.draftRevision
      : null,
    targetVersion: Number.isSafeInteger(value.targetVersion)
      ? value.targetVersion
      : null,
  };
}

export function sameConfigurationBinding(left, right) {
  const normalizedLeft = normalizeConfigurationBinding(left);
  const normalizedRight = normalizeConfigurationBinding(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft.expectedStateRevision ===
        normalizedRight.expectedStateRevision &&
      normalizedLeft.expectedActiveVersion ===
        normalizedRight.expectedActiveVersion &&
      normalizedLeft.draftId === normalizedRight.draftId &&
      normalizedLeft.draftRevision === normalizedRight.draftRevision &&
      normalizedLeft.targetVersion === normalizedRight.targetVersion,
  );
}

function normalizedImpactCategory(impact, [label, camelName, snakeName]) {
  const source = impact?.[camelName] ?? impact?.[snakeName];
  const paths = (Array.isArray(source) ? source : source?.paths)?.filter(
    (value) => typeof value === "string",
  ) || [];
  const count =
    isPlainRecord(source) &&
    Number.isSafeInteger(source.count) &&
    source.count >= paths.length
      ? source.count
      : paths.length;

  return { label, count, paths };
}

export function configurationImpactCategories(impact) {
  return IMPACT_CATEGORIES.map((definition) =>
    normalizedImpactCategory(impact, definition),
  ).filter((category) => category.count > 0);
}

export function createConfigurationFetch({
  fetchFn = globalThis.fetch?.bind(globalThis),
  timeoutMs = 45_000,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new TypeError("fetchFn must be a function");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("timer functions must be provided");
  }

  return async function configurationFetch(input, init = {}) {
    const controller = new AbortController();
    const callerSignal = init.signal;
    let timedOut = false;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    const timeoutHandle = setTimeoutFn(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await fetchFn(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error("配置请求超时，请检查本地服务后重试。");
        timeoutError.code = "CONFIGURATION_REQUEST_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeoutFn(timeoutHandle);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

export function isCurrentConfigurationRequest({
  sequence,
  currentSequence,
  lastAppliedSequence,
  signal,
}) {
  return (
    signal?.aborted !== true &&
    Number.isSafeInteger(sequence) &&
    sequence === currentSequence &&
    sequence >= lastAppliedSequence
  );
}
