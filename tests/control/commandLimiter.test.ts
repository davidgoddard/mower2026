import test from "node:test";
import assert from "node:assert/strict";
import { CommandLimiter } from "../../src/control/commandLimiter.js";

test("CommandLimiter constrains wheel step changes", () => {
  const limiter = new CommandLimiter({
    maxWheelSpeedMetersPerSecond: 1,
    maxWheelAccelerationStepMetersPerSecond: 0.2,
    maxWheelDecelerationStepMetersPerSecond: 0.4,
  });

  const result = limiter.limit(
    {
      leftMetersPerSecond: 0.1,
      rightMetersPerSecond: 0.1,
    },
    {
      leftMetersPerSecond: 0.8,
      rightMetersPerSecond: -0.5,
    },
  );

  assert.equal(Number(result.leftMetersPerSecond.toFixed(3)), 0.3);
  assert.equal(Number(result.rightMetersPerSecond.toFixed(3)), -0.3);
});
