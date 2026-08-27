import assert from "node:assert/strict";
import test from "node:test";

import {
  inferTestingProduct,
  testingOwnerRouting,
} from "../public/review-handoff-routing.js";

test("configured test owners override the safe defaults", () => {
  const routing = testingOwnerRouting({
    workCoordination: {
      policy: {
        testingOwnersByProduct: {
          qt: ["qt-tester-primary", "qt-tester-secondary"],
          bs: ["bs-tester"],
        },
      },
    },
  });

  assert.deepEqual(routing.products, ["qt", "bs"]);
  assert.deepEqual(routing.ownersByProduct.bs, ["bs-tester"]);
  assert.equal(routing.ownerLabel("qt-tester-secondary"), "@qt-tester-secondary");
});

test("B/S wording selects the web bucket without confusing B-scan with B/S", () => {
  assert.equal(inferTestingProduct("B/S 前端版本验证"), "bs");
  assert.equal(inferTestingProduct("Web version smoke test"), "bs");
  assert.equal(inferTestingProduct("B-scan Qt widget"), "qt");
});
