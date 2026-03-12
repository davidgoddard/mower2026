import test from "node:test";
import assert from "node:assert/strict";
import {
  computeArrivalCalibrationMetrics,
  computeSpinCalibrationMetrics,
  computeStraightCalibrationMetrics,
} from "../../src/calibration/metrics.js";
import type { CalibrationSample, CalibrationTrialDefinition } from "../../src/calibration/calibrationTypes.js";

function sample(
  timestampMillis: number,
  xMeters: number,
  yMeters: number,
  headingDegrees: number,
): CalibrationSample {
  return {
    timestampMillis,
    estimate: {
      timestampMillis,
      xMeters,
      yMeters,
      headingDegrees,
      speedMetersPerSecond: 0.3,
      yawRateDegreesPerSecond: 0,
      confidence: 1,
    },
  };
}

test("computeSpinCalibrationMetrics measures final error and antenna excursion", () => {
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
      turnScale: 0.5,
      lineGainScale: 1,
    },
  };
  const metrics = computeSpinCalibrationMetrics(definition, [
    sample(0, 0, 0, 0),
    sample(1_000, 0.12, 0.05, 100),
    sample(2_000, 0.08, 0.02, 92),
  ]);

  assert.equal(metrics.finalHeadingErrorDegrees, 2);
  assert.equal(Number(metrics.peakOvershootDegrees.toFixed(3)), 10);
  assert.equal(Number(metrics.antennaPositionExcursionMeters.toFixed(3)), 0.13);
});

test("computeStraightCalibrationMetrics measures cross-track bias", () => {
  const definition: CalibrationTrialDefinition = {
    id: "straight-forward",
    stage: "straight_forward",
    motion: "drive_line",
    description: "",
    direction: "forward",
    distanceMeters: 2,
    maxDurationMillis: 10_000,
    profile: {
      speedScale: 1,
      turnScale: 1,
      lineGainScale: 1,
    },
  };
  const metrics = computeStraightCalibrationMetrics(definition, [
    sample(0, 0, 0, 0),
    sample(1_000, 1, 0.1, 2),
    sample(2_000, 2, 0.2, 3),
  ]);

  assert.equal(Number(metrics.meanSignedCrossTrackErrorMeters.toFixed(3)), 0.1);
  assert.equal(Number(metrics.peakCrossTrackErrorMeters.toFixed(3)), 0.2);
  assert.equal(Number(metrics.finalCrossTrackErrorMeters.toFixed(3)), 0.2);
  assert.equal(Number(metrics.achievedDistanceMeters.toFixed(3)), 2);
});

test("computeArrivalCalibrationMetrics measures final target error", () => {
  const definition: CalibrationTrialDefinition = {
    id: "arrival-forward",
    stage: "target_arrival",
    motion: "arrive_target",
    description: "",
    targetPose: {
      xMeters: 1,
      yMeters: 0,
      headingDegrees: 0,
    },
    maxDurationMillis: 10_000,
    profile: {
      speedScale: 1,
      turnScale: 1,
      lineGainScale: 1,
    },
  };
  const metrics = computeArrivalCalibrationMetrics(definition, [
    sample(0, 0, 0, 0),
    sample(1_000, 0.7, 0.1, 4),
    sample(2_000, 1.02, -0.03, 2),
  ]);

  assert.equal(Number(metrics.finalPositionErrorMeters.toFixed(3)), 0.036);
  assert.equal(metrics.finalHeadingErrorDegrees, 2);
});

test("computeArrivalCalibrationMetrics resolves target pose relative to the starting heading", () => {
  const definition: CalibrationTrialDefinition = {
    id: "arrival-rotated",
    stage: "target_arrival",
    motion: "arrive_target",
    description: "",
    targetPose: {
      xMeters: 1,
      yMeters: 0,
      headingDegrees: 0,
    },
    maxDurationMillis: 10_000,
    profile: {
      speedScale: 1,
      turnScale: 1,
      lineGainScale: 1,
    },
  };
  const metrics = computeArrivalCalibrationMetrics(definition, [
    sample(0, 2, 3, 90),
    sample(1_000, 2.02, 3.98, 89),
    sample(2_000, 2.01, 4.03, 91),
  ]);

  assert.equal(Number(metrics.finalPositionErrorMeters.toFixed(3)), 0.032);
  assert.equal(metrics.finalHeadingErrorDegrees, 1);
});
