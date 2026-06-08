import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { DeadReckoningCalibrator } from "../dist/control/deadReckoningCalibrator.js";

function createMockLogger() {
  const logger = {
    child: null,
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    transition: () => {},
    flush: () => {},
    close: () => {},
  };
  logger.child = mock.fn(() => logger);
  return logger;
}

test("DeadReckoningCalibrator rejects pivot geometry with excessive DR endpoint error", () => {
  const calibrator = new DeadReckoningCalibrator({
    sensorController: {},
    poseFusion: {},
    poseCalibration: {},
    logger: createMockLogger(),
  });

  const warnings = [];
  const straightPhase = {
    startAnchor: {
      xMeters: 0,
      yMeters: 0,
      headingDeg: 0,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 0,
    },
    endAnchor: {
      xMeters: 5,
      yMeters: 0,
      headingDeg: 0,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 1000,
    },
    gnssDistanceMeters: 5,
    gnssHeadingChangeDeg: 0,
    leftTotalTicks: 1000,
    rightTotalTicks: 1000,
    leftSignedTicks: 1000,
    rightSignedTicks: 1000,
    arcSamples: [],
    steadyStateSamples: [],
    derivedEncoderMetersPerTick: 0.005,
    arcTrackingRmsErrorFraction: null,
    arcGeometry: null,
  };

  const pivotPhase = {
    startAnchor: {
      xMeters: 0,
      yMeters: 0,
      headingDeg: 0,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 2000,
    },
    endAnchor: {
      xMeters: 0,
      yMeters: 0,
      headingDeg: 180,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 4000,
    },
    gnssDistanceMeters: 0,
    gnssHeadingChangeDeg: 180,
    leftTotalTicks: 1000,
    rightTotalTicks: 1000,
    leftSignedTicks: 1000,
    rightSignedTicks: -1000,
    arcSamples: [
      { timestampMillis: 3000, imuHeadingDeg: 0, leftTicksTotal: 0, rightTicksTotal: 0, inSteadyState: true },
      { timestampMillis: 4000, imuHeadingDeg: 180, leftTicksTotal: 1000, rightTicksTotal: 1000, inSteadyState: true },
    ],
    steadyStateSamples: [
      { timestampMillis: 3000, imuHeadingDeg: 0, leftTicksTotal: 0, rightTicksTotal: 0, inSteadyState: true },
      { timestampMillis: 4000, imuHeadingDeg: 180, leftTicksTotal: 1000, rightTicksTotal: 1000, inSteadyState: true },
    ],
    derivedEncoderMetersPerTick: null,
    arcTrackingRmsErrorFraction: null,
    arcGeometry: null,
  };

  const analysed = calibrator.analysePivotPhase(pivotPhase, "cw", straightPhase, warnings);

  assert.equal(analysed.arcGeometry, null);
  assert.equal(analysed.arcTrackingRmsErrorFraction, 0);
  assert.equal(
    warnings.some((warning) => warning.includes("DR endpoint error too large")),
    true,
  );
});

test("DeadReckoningCalibrator uses live GNSS diagnostics when the local anchor buffer is empty", () => {
  const calibrator = new DeadReckoningCalibrator({
    sensorController: {},
    poseFusion: {
      getDiagnosticSnapshot: () => ({
        gnss: {
          raw: {
            x: 8.29,
            y: 13.13,
            fixType: "fixed",
            positionAccuracyMeters: 0.012,
            headingDeg: 115.2,
            headingAccuracyDeg: 0.8,
            sampleAgeMs: 7,
            timestampMillis: 12345,
          },
        },
      }),
    },
    poseCalibration: {},
    logger: createMockLogger(),
  });

  const anchor = calibrator.buildCurrentAnchor(calibrator.poseFusion.getDiagnosticSnapshot());

  assert.equal(anchor.fixType, "fixed");
  assert.equal(anchor.headingDeg, 115.2);
  assert.equal(anchor.positionAccuracyMeters, 0.012);
  assert.equal(anchor.xMeters, 8.29);
  assert.equal(anchor.yMeters, 13.13);
});
