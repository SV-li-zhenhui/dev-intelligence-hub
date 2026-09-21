const productionTimeoutMs = 90_000;
const scaledTimeoutMs = 900;
const timeout = AbortSignal.timeout.bind(AbortSignal);

AbortSignal.timeout = (milliseconds) => {
  if (milliseconds !== productionTimeoutMs) {
    throw new Error("unexpected Codex login readiness timeout");
  }
  return timeout(scaledTimeoutMs);
};
