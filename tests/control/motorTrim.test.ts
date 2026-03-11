import test from "node:test";
import assert from "node:assert/strict";
import { defaultParameters } from "../../src/config/defaults.js";
import { applyMotorTrim } from "../../src/control/motorTrim.js";

test("applyMotorTrim scales left and right wheel targets by direction", () => {
  const result = applyMotorTrim(
    {
      ...defaultParameters,
      leftMotorForwardScale: 1.2,
      leftMotorReverseScale: 0.8,
      rightMotorForwardScale: 0.5,
      rightMotorReverseScale: 0.6,
    },
    {
      leftMetersPerSecond: 0.4,
      rightMetersPerSecond: -0.3,
    },
  );

  assert.equal(Number(result.leftMetersPerSecond.toFixed(3)), 0.48);
  assert.equal(Number(result.rightMetersPerSecond.toFixed(3)), -0.18);
});

test("applyMotorTrim leaves zero wheel targets unchanged", () => {
  const result = applyMotorTrim(defaultParameters, {
    leftMetersPerSecond: 0,
    rightMetersPerSecond: 0,
  });

  assert.deepEqual(result, {
    leftMetersPerSecond: 0,
    rightMetersPerSecond: 0,
  });
});
