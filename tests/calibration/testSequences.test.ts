import test from "node:test";
import assert from "node:assert/strict";
import { buildCalibrationSequence } from "../../src/calibration/testSequences.js";

test("buildCalibrationSequence stays within the declared safe area", () => {
  const sequence = buildCalibrationSequence({
    safeRadiusMeters: 2,
    straightRunDistanceMeters: 1.8,
    arrivalTargetDistanceMeters: 1.5,
  });

  const straight = sequence.find((trial) => trial.id === "straight-forward");
  const arrival = sequence.find((trial) => trial.id === "arrival-forward");

  assert.equal(sequence.length >= 8, true);
  assert.equal(straight?.distanceMeters, 1.5);
  assert.equal(arrival?.targetPose?.xMeters, 1.4);
});
