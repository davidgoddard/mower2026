import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCalibrationReport } from "../../src/calibration/progressAssessment.js";
import type { CalibrationReport } from "../../src/calibration/calibrationTypes.js";

test("summarizeCalibrationReport classifies green goals when metrics are tight", () => {
  const report: CalibrationReport = {
    area: {
      safeRadiusMeters: 2,
      straightRunDistanceMeters: 1.5,
      arrivalTargetDistanceMeters: 1.2,
    },
    trials: [
      {
        trial: { definition: {} as never, samples: [], completed: true },
        spinMetrics: {
          targetHeadingChangeDegrees: 90,
          achievedHeadingChangeDegrees: 89.8,
          finalHeadingErrorDegrees: 0.2,
          peakOvershootDegrees: 0.4,
          antennaPositionExcursionMeters: 0.03,
          durationMillis: 1000,
        },
      },
      {
        trial: { definition: {} as never, samples: [], completed: true },
        straightMetrics: {
          targetDistanceMeters: 1.5,
          achievedDistanceMeters: 1.5,
          rmsCrossTrackErrorMeters: 0.01,
          peakCrossTrackErrorMeters: 0.015,
          meanSignedCrossTrackErrorMeters: 0,
          finalCrossTrackErrorMeters: 0.01,
          headingRmsErrorDegrees: 0.5,
          durationMillis: 1000,
        },
      },
      {
        trial: { definition: {} as never, samples: [], completed: true },
        arrivalMetrics: {
          targetDistanceMeters: 1.2,
          finalPositionErrorMeters: 0.04,
          finalHeadingErrorDegrees: 0.4,
          peakCrossTrackErrorMeters: 0.01,
          durationMillis: 1000,
        },
      },
    ],
    recommendations: {
      pivotAntennaExcursionMeters: 0.03,
      recommendedTurnScale: 0.9,
      recommendedLineGainScale: 0.95,
      recommendedArrivalToleranceMeters: 0.05,
    },
  };

  const summary = summarizeCalibrationReport(report);
  assert.equal(summary.turn.quality, "green");
  assert.equal(summary.line.quality, "green");
  assert.equal(summary.arrival.quality, "green");
});

test("summarizeCalibrationReport classifies red goals when errors are large", () => {
  const report: CalibrationReport = {
    area: {
      safeRadiusMeters: 2,
      straightRunDistanceMeters: 1.5,
      arrivalTargetDistanceMeters: 1.2,
    },
    trials: [
      {
        trial: { definition: {} as never, samples: [], completed: true },
        spinMetrics: {
          targetHeadingChangeDegrees: 90,
          achievedHeadingChangeDegrees: 96,
          finalHeadingErrorDegrees: 4,
          peakOvershootDegrees: 6,
          antennaPositionExcursionMeters: 0.12,
          durationMillis: 1000,
        },
      },
      {
        trial: { definition: {} as never, samples: [], completed: true },
        straightMetrics: {
          targetDistanceMeters: 1.5,
          achievedDistanceMeters: 1.2,
          rmsCrossTrackErrorMeters: 0.08,
          peakCrossTrackErrorMeters: 0.11,
          meanSignedCrossTrackErrorMeters: 0.03,
          finalCrossTrackErrorMeters: 0.09,
          headingRmsErrorDegrees: 4,
          durationMillis: 1000,
        },
      },
      {
        trial: { definition: {} as never, samples: [], completed: true },
        arrivalMetrics: {
          targetDistanceMeters: 1.2,
          finalPositionErrorMeters: 0.18,
          finalHeadingErrorDegrees: 4,
          peakCrossTrackErrorMeters: 0.08,
          durationMillis: 1000,
        },
      },
    ],
    recommendations: {
      pivotAntennaExcursionMeters: 0.1,
      recommendedTurnScale: 0.7,
      recommendedLineGainScale: 0.7,
      recommendedArrivalToleranceMeters: 0.12,
    },
  };

  const summary = summarizeCalibrationReport(report);
  assert.equal(summary.turn.quality, "red");
  assert.equal(summary.line.quality, "red");
  assert.equal(summary.arrival.quality, "red");
});
