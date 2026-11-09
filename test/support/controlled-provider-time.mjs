import assert from 'node:assert/strict';

// For stub-runner lifecycle tests, never use admission/preparation wall time
// to decide whether a later cancellation or recovery phase was exercised.
// Real process/ACL supervision tests keep their real clocks and termination.
export function controlledProviderTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let milliseconds = 10_000;
  return Object.freeze({
    monotonicClock: () => milliseconds,
    advance(amount) {
      assert.ok(Number.isSafeInteger(amount) && amount >= 0);
      milliseconds += amount;
      t.mock.timers.tick(amount);
    },
    phase(name) {
      let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      return Object.freeze({
        enter,
        waitFor(outcome) {
          const tooEarly = () => assert.fail(`Provider settled before fixture phase: ${name}`);
          return Promise.race([entered, Promise.resolve(outcome).then(tooEarly, tooEarly)]);
        },
      });
    },
  });
}
