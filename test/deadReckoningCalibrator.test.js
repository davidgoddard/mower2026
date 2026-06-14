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

test("DeadReckoningCalibrator accepts forward arc geometry when both wheels move forward", () => {
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

  const arcPhase = {
    startAnchor: {
      xMeters: 0,
      yMeters: 0,
      headingDeg: 0,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 2000,
    },
    endAnchor: {
      xMeters: 1.5909902576697321,
      yMeters: 3.840990257669732,
      headingDeg: 90,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 4000,
    },
    gnssDistanceMeters: 4.15745789630079,
    gnssHeadingChangeDeg: 90,
    leftTotalTicks: 1000,
    rightTotalTicks: 800,
    leftSignedTicks: 1000,
    rightSignedTicks: 800,
    arcSamples: [
      { timestampMillis: 3000, imuHeadingDeg: 0, leftTicksTotal: 0, rightTicksTotal: 0, leftSignedTicksTotal: 0, rightSignedTicksTotal: 0, inSteadyState: true },
      { timestampMillis: 3500, imuHeadingDeg: 45, leftTicksTotal: 500, rightTicksTotal: 400, leftSignedTicksTotal: 500, rightSignedTicksTotal: 400, inSteadyState: true },
      { timestampMillis: 4000, imuHeadingDeg: 90, leftTicksTotal: 1000, rightTicksTotal: 800, leftSignedTicksTotal: 1000, rightSignedTicksTotal: 800, inSteadyState: true },
    ],
    steadyStateSamples: [
      { timestampMillis: 3000, imuHeadingDeg: 0, leftTicksTotal: 0, rightTicksTotal: 0, leftSignedTicksTotal: 0, rightSignedTicksTotal: 0, inSteadyState: true },
      { timestampMillis: 3500, imuHeadingDeg: 45, leftTicksTotal: 500, rightTicksTotal: 400, leftSignedTicksTotal: 500, rightSignedTicksTotal: 400, inSteadyState: true },
      { timestampMillis: 4000, imuHeadingDeg: 90, leftTicksTotal: 1000, rightTicksTotal: 800, leftSignedTicksTotal: 1000, rightSignedTicksTotal: 800, inSteadyState: true },
    ],
    derivedEncoderMetersPerTick: null,
    arcTrackingRmsErrorFraction: null,
    arcGeometry: null,
  };

  const analysed = calibrator.analyseArcPhase(arcPhase, "cw", straightPhase, warnings);

  assert.notEqual(analysed.arcGeometry, null);
  assert.ok(Math.abs(analysed.arcTrackingRmsErrorFraction) < 1e-9);
  assert.ok(Math.abs(analysed.arcGeometry.drEndpointErrorMeters) < 1e-9);
  assert.equal(warnings.length, 0);
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
