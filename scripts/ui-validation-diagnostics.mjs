function sameHttpFailure(actual, expected) {
  return (
    actual?.method === expected.method &&
    actual?.url === expected.url &&
    actual?.status === expected.status
  );
}

function isBrowserResourceErrorFor(consoleError, expected) {
  const location = consoleError?.location;
  return (
    location?.url === expected.url &&
    Number(location.lineNumber ?? location.line) === 0 &&
    Number(location.columnNumber ?? location.column) === 0
  );
}

export function partitionBrowserFailures(
  { consoleErrors = [], httpErrors = [] },
  expectedHttpFailures = [],
) {
  const unexpectedConsoleErrors = [...consoleErrors];
  const unexpectedHttpErrors = [...httpErrors];
  const expectedConsoleErrors = [];
  const expectedHttpErrors = [];

  for (const expected of expectedHttpFailures) {
    const httpIndex = unexpectedHttpErrors.findIndex((actual) =>
      sameHttpFailure(actual, expected),
    );
    if (httpIndex < 0) {
      throw new Error(
        `expected HTTP failure was not observed: ${expected.method} ${expected.url} ${expected.status}`,
      );
    }
    expectedHttpErrors.push(unexpectedHttpErrors.splice(httpIndex, 1)[0]);

    const consoleIndex = unexpectedConsoleErrors.findIndex((consoleError) =>
      isBrowserResourceErrorFor(consoleError, expected),
    );
    if (consoleIndex >= 0) {
      expectedConsoleErrors.push(
        unexpectedConsoleErrors.splice(consoleIndex, 1)[0],
      );
    }
  }

  return {
    consoleErrors: unexpectedConsoleErrors,
    expectedConsoleErrors,
    httpErrors: unexpectedHttpErrors,
    expectedHttpErrors,
  };
}
