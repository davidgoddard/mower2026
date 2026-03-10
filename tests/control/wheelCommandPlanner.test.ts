import test from "node:test";
import assert from "node:assert/strict";
import { WheelCommandPlanner } from "../../src/control/wheelCommandPlanner.js";

test("WheelCommandPlanner converts yaw demand into differential wheel targets", () => {
  const planner = new WheelCommandPlanner({
    wheelBaseMeters: 0.5,
    maxWheelSpeedMetersPerSecond: 1,
  });

  const targets = planner.plan({
    forwardSpeedMetersPerSecond: 0.5,
    yawRateDemandDegreesPerSecond: 90,
  });

  assert.equal(Number(targets.leftMetersPerSecond.toFixed(3)), 0.107);
  assert.equal(Number(targets.rightMetersPerSecond.toFixed(3)), 0.893);
});
