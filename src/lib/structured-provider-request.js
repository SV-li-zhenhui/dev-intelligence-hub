export function isAbortSignalLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

export function normalizeAbortSignal(value = null) {
  if (value === null) return null;
  if (!isAbortSignalLike(value)) throw new TypeError("signal is invalid");
  return value;
}

export async function runStructuredProviderRequest({
  controller,
  timeoutMs,
  signal,
  operation,
  cancellationError,
  timeoutError,
}) {
  let timer;
  let abortKind = null;
  let handleExternalAbort = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (abortKind) return;
      abortKind = "timeout";
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const cancellation = signal
    ? new Promise((_, reject) => {
        handleExternalAbort = () => {
          if (abortKind) return;
          abortKind = "external";
          controller.abort();
          reject(cancellationError());
        };
        signal.addEventListener("abort", handleExternalAbort, { once: true });
        if (signal.aborted) handleExternalAbort();
      })
    : null;
  const result = Promise.resolve()
    .then(() => {
      if (abortKind === "external") throw cancellationError();
      if (abortKind === "timeout") throw timeoutError();
      return operation();
    })
    .catch((error) => {
      if (!controller.signal.aborted) throw error;
      throw abortKind === "external" ? cancellationError() : timeoutError();
    });
  try {
    return await Promise.race(
      cancellation ? [result, timeout, cancellation] : [result, timeout],
    );
  } finally {
    clearTimeout(timer);
    if (handleExternalAbort) {
      signal.removeEventListener("abort", handleExternalAbort);
    }
  }
}
