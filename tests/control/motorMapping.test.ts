import test from "node:test";
import assert from "node:assert/strict";
import { mapPhysicalWheelTargetsToRaw } from "../../src/control/motorMapping.js";
import { defaultParameters } from "../../src/config/defaults.js";

test("mapPhysicalWheelTargetsToRaw applies trim and motor direction signs", () => {
  const result = mapPhysicalWheelTargetsToRaw(
    {
      ...defaultParameters,
      leftMotorForwardSign: -1,
      rightMotorForwardSign: 1,
      leftMotorForwardScale: 0.9,
      leftMotorReverseScale: 0.8,
      rightMotorForwardScale: 1.1,
      rightMotorReverseScale: 1.2,
    },
    {
      leftMetersPerSecond: 0.5,
      rightMetersPerSecond: -0.25,
    },
  );

  assert.deepEqual(result, {
    leftMetersPerSecond: -0.45,
    rightMetersPerSecond: -0.3,
  });
});
