const SOURCE_FIELDS = Object.freeze([
  "clean",
  "headOid",
  "runtimeByteCount",
  "runtimeDigest",
  "runtimeFileCount",
  "schemaVersion",
  "treeOid",
]);
const OBJECT_IDENTITY = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const INSTANCE_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function runtimeSourceIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime source identity is missing");
  }
  const fields = Object.keys(value).sort();
  if (
    fields.join("\0") !== [...SOURCE_FIELDS].sort().join("\0") ||
    value.schemaVersion !== 1 ||
    !OBJECT_IDENTITY.test(value.headOid) ||
    !OBJECT_IDENTITY.test(value.treeOid) ||
    value.clean !== true ||
    !SHA_256.test(value.runtimeDigest) ||
    !Number.isSafeInteger(value.runtimeFileCount) ||
    value.runtimeFileCount <= 0 ||
    !Number.isSafeInteger(value.runtimeByteCount) ||
    value.runtimeByteCount <= 0
  ) {
    throw new Error("runtime source identity is invalid");
  }
  return Object.freeze(structuredClone(value));
}

function assertMatchingRuntimeSource(actualValue, expected) {
  let actual;
  try {
    actual = runtimeSourceIdentity(actualValue);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("is missing")) {
      throw error;
    }
    throw new Error("runtime source identity does not match");
  }
  if (SOURCE_FIELDS.some((field) => actual[field] !== expected[field])) {
    throw new Error("runtime source identity does not match");
  }
  return actual;
}

function expectedLiveServiceIdentity(value, expectedRuntimeSource) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      ["instanceId", "processId", "runtimeSource", "startIdentity"]
        .sort()
        .join("\0") ||
    !Number.isSafeInteger(value.processId) ||
    value.processId <= 0 ||
    !INSTANCE_ID.test(value.instanceId) ||
    !SHA_256.test(value.startIdentity)
  ) {
    throw new Error("expected dashboard live process identity is invalid");
  }
  const runtimeSource = assertMatchingRuntimeSource(
    value.runtimeSource,
    expectedRuntimeSource,
  );
  return Object.freeze({
    processId: value.processId,
    instanceId: value.instanceId,
    startIdentity: value.startIdentity,
    runtimeSource,
  });
}

function dashboardBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("dashboard base URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("dashboard base URL must be an HTTP loopback origin");
  }
  return url.origin;
}

async function fetchJson(fetchFn, url, label) {
  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`${label} request failed`);
  }
  if (!response?.ok) {
    throw new Error(`${label} request returned HTTP ${String(response?.status)}`);
  }
  try {
    const value = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid response");
    }
    return value;
  } catch {
    throw new Error(`${label} response is invalid`);
  }
}

export async function verifyLiveDashboard({
  baseUrl,
  expectedRuntimeSource,
  expectedLiveService,
  fetchFn = fetch,
}) {
  if (typeof fetchFn !== "function") {
    throw new TypeError("fetchFn must be a function");
  }
  const origin = dashboardBaseUrl(baseUrl);
  const expected = runtimeSourceIdentity(expectedRuntimeSource);
  const expectedService = expectedLiveServiceIdentity(
    expectedLiveService,
    expected,
  );
  const live = await fetchJson(fetchFn, `${origin}/api/live`, "dashboard liveness");
  if (
    live.schemaVersion !== 1 ||
    live.live !== true ||
    live.service !== "mydashboard" ||
    live.managed !== true ||
    live.lifecycleState !== "running" ||
    !Number.isSafeInteger(live.processId) ||
    live.processId <= 0 ||
    !INSTANCE_ID.test(live.instanceId) ||
    !SHA_256.test(live.startIdentity)
  ) {
    throw new Error("dashboard is not a running managed service");
  }
  const liveRuntimeSource = assertMatchingRuntimeSource(
    live.runtimeSource,
    expected,
  );
  const health = await fetchJson(
    fetchFn,
    `${origin}/api/health`,
    "dashboard health",
  );
  if (
    health.ok !== true ||
    health.service !== "mydashboard" ||
    health.processId !== live.processId
  ) {
    throw new Error("dashboard health does not match the live process");
  }
  assertMatchingRuntimeSource(health.runtimeSource, expected);

  const identity = Object.freeze({
    processId: live.processId,
    instanceId: live.instanceId,
    startIdentity: live.startIdentity,
    runtimeSource: liveRuntimeSource,
  });
  if (
    expectedService !== null &&
    ["processId", "instanceId", "startIdentity"].some(
      (field) => identity[field] !== expectedService[field],
    )
  ) {
    throw new Error("dashboard live process identity does not match");
  }
  return identity;
}
