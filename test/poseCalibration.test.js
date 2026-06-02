import test from "node:test";
import assert from "node:assert/strict";

import { PoseCalibration } from "../dist/config/poseCalibration.js";

function createMockLogger() {
  return {
    child: () => createMockLogger(),
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

test("PoseCalibration rejects implausible wheelbase values", () => {
  const calibration = new PoseCalibration({
    logger: createMockLogger(),
    parametersPath: "/tmp/pose-calibration-test.json",
  });

  assert.equal(calibration.isCalibrationPlausible(), true);

  calibration.setPerWheelCalibration(0.001, 0.001, 1.6);
  assert.equal(calibration.isCalibrationPlausible(), false);
});
