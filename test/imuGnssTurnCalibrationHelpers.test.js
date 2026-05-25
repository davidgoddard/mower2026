import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTurnCalibrationSummary,
  fieldHeadingToInternalDegrees,
  headingDeltaDegrees,
  internalHeadingToFieldDegrees,
  isGnssHeadingReady,
  normalizeFieldHeadingDegrees,
  normalizeInternalHeadingDegrees,
} from "../external-hardware/manual-tests/imu_gnss_turn_calibration_helpers.js";

test("imu/gnss turn calibration helpers normalize heading conventions", () => {
  assert.equal(normalizeInternalHeadingDegrees(190), -170);
  assert.equal(normalizeInternalHeadingDegrees(-190), 170);
  assert.equal(normalizeFieldHeadingDegrees(-10), 350);
  assert.equal(fieldHeadingToInternalDegrees(90), 0);
  assert.equal(internalHeadingToFieldDegrees(0), 90);
});

test("imu/gnss turn calibration helpers detect a ready GNSS heading", () => {
  assert.equal(
    isGnssHeadingReady({
      fixType: "fixed",
      headingDegrees: 123.4,
      headingAccuracyDegrees: 0.8,
      sampleAgeMillis: 250,
    }),
    true,
  );
  assert.equal(
    isGnssHeadingReady({
      fixType: "fixed",
      headingDegrees: 123.4,
      headingAccuracyDegrees: 1.2,
      sampleAgeMillis: 250,
    }),
    false,
  );
});

test("imu/gnss turn calibration helpers calculate a scale correction from start/end headings", () => {
  const summary = buildTurnCalibrationSummary({
    startRawImuHeadingInternalDeg: 0,
    startGnssHeadingInternalDeg: 0,
    startOffsetInternalDeg: 0,
    endRawImuHeadingInternalDeg: 170,
    endGnssHeadingInternalDeg: 180,
  });

  assert.equal(summary.imuTurnInternalDeg, 170);
  assert.equal(summary.gnssTurnInternalDeg, 180);
  assert.equal(summary.startAlignmentErrorInternalDeg, 0);
  assert.equal(summary.endAlignmentErrorInternalDeg, 10);
  assert.equal(Number(summary.scaleCorrection.toFixed(5)), Number((180 / 170).toFixed(5)));
  assert.equal(headingDeltaDegrees(10, 100), 90);
});
