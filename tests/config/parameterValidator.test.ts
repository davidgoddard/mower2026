import test from "node:test";
import assert from "node:assert/strict";
import { defaultParameters } from "../../src/config/defaults.js";
import { validateParameters } from "../../src/config/parameterValidator.js";

test("default parameters validate successfully", () => {
  assert.deepEqual(validateParameters(defaultParameters), []);
});

test("planner stripe width may not exceed physical cutting width", () => {
  const issues = validateParameters({
    ...defaultParameters,
    effectivePlanningStripeWidthMeters: 0.41,
  });

  assert.equal(issues.some((issue) => issue.field === "effectivePlanningStripeWidthMeters"), true);
});

test("heading tolerance that is too loose is rejected", () => {
  const issues = validateParameters({
    ...defaultParameters,
    headingArrivalToleranceDegrees: 15,
  });

  assert.equal(issues.some((issue) => issue.field === "headingArrivalToleranceDegrees"), true);
});
