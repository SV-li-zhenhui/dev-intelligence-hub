import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCompleteTransition,
  assertGeneralTransition,
  assertHandoffTransition,
  assertRetryTransition,
} from "../src/services/work-ledger-transitions.js";

function transitionConflict(operation) {
  assert.throws(
    operation,
    (error) =>
      error.code === "WORK_LEDGER_TRANSITION_INVALID" &&
      error.statusCode === 409,
  );
}

test("superseded ledger work is terminal through every ordinary transition", () => {
  transitionConflict(() => assertGeneralTransition("superseded", "queued"));
  transitionConflict(() => assertRetryTransition("superseded"));
  transitionConflict(() => assertHandoffTransition("superseded"));
  transitionConflict(() => assertCompleteTransition("superseded"));
});
