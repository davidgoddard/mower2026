import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticCalibrationController, resolveRelativeTargetPose } from "../../src/calibration/automaticCalibrationController.js";
import type { CalibrationTrialDefinition } from "../../src/calibration/calibrationTypes.js";
import type { PoseEstimate } from "../../src/estimation/estimatorTypes.js";

function estimate(
  timestampMillis: number,
  xMeters: number,
  yMeters: number,
  headingDegrees: number,
  speedMetersPerSecond = 0,
  yawRateDegreesPerSecond = 0,
): PoseEstimate {
  return {
    timestampMillis,
    xMeters,
    yMeters,
    headingDegrees,
    speedMetersPerSecond,
    yawRateDegreesPerSecond,
    confidence: 1,
  };
}

const options = {
  maxWheelSpeedMetersPerSecond: 0.75,
  headingToleranceDegrees: 3,
  positionToleranceMeters: 0.05,
  settleDurationMillis: 400,
} as const;

test("resolveRelativeTargetPose projects local targets into world coordinates", () => {
  const target = resolveRelativeTargetPose(
    {
      xMeters: 2,
      yMeters: 3,
      headingDegrees: 90,
    },
    {
      xMeters: 1,
      yMeters: 0.2,
      headingDegrees: -15,
    },
  );

  assert.equal(Number(target.xMeters.toFixed(3)), 1.8);
  assert.equal(Number(target.yMeters.toFixed(3)), 4);
  assert.equal(target.headingDegrees, 75);
});

test("spin controller commands a left pivot for positive heading error and settles at target", () => {
  const definition: CalibrationTrialDefinition = {
    id: "spin-left-90",
    stage: "spin_left",
    motion: "spin",
    description: "",
    direction: "left",
    targetHeadingChangeDegrees: 90,
    maxDurationMillis: 10_000,
    profile: {
      speedScale: 1,
      turnScale: 0.6,
      lineGainScale: 1,
    },
  };
  const controller = new AutomaticCalibrationController(definition, estimate(0, 0, 0, 0), options);

  const driving = controller.step(estimate(100, 0, 0, 0), 100);
  assert.equal(driving.completed, false);
  assert.equal(driving.wheelTargets.leftMetersPerSecond < 0, true);
  assert.equal(driving.wheelTargets.rightMetersPerSecond > 0, true);

  const settling = controller.step(estimate(500, 0, 0, 89.2, 0, 1.5), 500);
  assert.equal(settling.completed, false);
  assert.deepEqual(settling.wheelTargets, {
    leftMetersPerSecond: 0,
    rightMetersPerSecond: 0,
  });

  const done = controller.step(estimate(950, 0, 0, 89.5, 0, 0.8), 950);
  assert.equal(done.completed, true);
});

test("drive-line controller slows near the target and corrects cross-track error", () => {
  const definition: CalibrationTrialDefinition = {
    id: "straight-forward",
    stage: "straight_forward",
    motion: "drive_line",
    description: "",
    direction: "forward",
    distanceMeters: 1.5,
    maxDurationMillis: 10_000,
    profile: {
      speedScale: 0.6,
      turnScale: 1,
      lineGainScale: 1,
    },
  };
  const controller = new AutomaticCalibrationController(definition, estimate(0, 0, 0, 0), options);

  const driving = controller.step(estimate(200, 0.5, 0.1, 4, 0.3, 0), 200);
  assert.equal(driving.completed, false);
  assert.equal(driving.crossTrackErrorMeters !== undefined, true);
  assert.equal(driving.wheelTargets.leftMetersPerSecond !== driving.wheelTargets.rightMetersPerSecond, true);

  const settling = controller.step(estimate(1_000, 1.5, 0.01, 0.5, 0.01, 0), 1_100);
  assert.equal(settling.completed, false);

  const done = controller.step(estimate(1_500, 1.5, 0.01, 0.5, 0.01, 0), 1_600);
  assert.equal(done.completed, true);
  assert.deepEqual(done.wheelTargets, {
    leftMetersPerSecond: 0,
    rightMetersPerSecond: 0,
  });
});
