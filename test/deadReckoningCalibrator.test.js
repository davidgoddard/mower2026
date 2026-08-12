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

test("DeadReckoningCalibrator derives forward arc geometry without endpoint-based rejection", () => {
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
    derivedLeftMetersPerTick: 0.005,
    derivedRightMetersPerTick: 0.005,
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
      xMeters: 20,
      yMeters: 20,
      headingDeg: 90,
      positionAccuracyMeters: 0.02,
      fixType: "fixed",
      timestampMillis: 4000,
    },
    gnssDistanceMeters: Math.hypot(20, 20),
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
    derivedLeftMetersPerTick: null,
    derivedRightMetersPerTick: null,
    arcTrackingRmsErrorFraction: null,
    arcGeometry: null,
  };

  const analysed = calibrator.analyseArcPhase(arcPhase, "cw", straightPhase, warnings);

  assert.notEqual(analysed.arcGeometry, null);
  assert.ok(Math.abs(analysed.arcTrackingRmsErrorFraction) < 1e-9);
  assert.equal(warnings.length, 0);
});

test("DeadReckoningCalibrator derives independent wheel scales from the GNSS straight", () => {
  const calibrator = new DeadReckoningCalibrator({
    sensorController: {},
    poseFusion: {},
    poseCalibration: {},
    logger: createMockLogger(),
  });
  const anchor = {
    xMeters: 0,
    yMeters: 0,
    headingDeg: 0,
    positionAccuracyMeters: 0.02,
    fixType: "fixed",
    timestampMillis: 0,
  };
  const phase = {
    startAnchor: anchor,
    endAnchor: { ...anchor, xMeters: 10, timestampMillis: 1000 },
    gnssDistanceMeters: 10,
    gnssHeadingChangeDeg: 0,
    leftTotalTicks: 20_000,
    rightTotalTicks: 25_000,
    leftSignedTicks: 20_000,
    rightSignedTicks: 25_000,
    arcSamples: [],
    steadyStateSamples: [],
    derivedEncoderMetersPerTick: null,
    derivedLeftMetersPerTick: null,
    derivedRightMetersPerTick: null,
    arcTrackingRmsErrorFraction: null,
    arcGeometry: null,
  };

  const analysed = calibrator.analyseStraightPhase(phase, []);

  assert.equal(analysed.derivedLeftMetersPerTick, 0.0005);
  assert.equal(analysed.derivedRightMetersPerTick, 0.0004);
  assert.equal(analysed.derivedEncoderMetersPerTick, 0.00045);
});

test("DeadReckoningCalibrator removes high-rate samples from the polled result", () => {
  const calibrator = new DeadReckoningCalibrator({
    sensorController: {},
    poseFusion: {},
    poseCalibration: {},
    logger: createMockLogger(),
  });
  const sample = {
    timestampMillis: 1,
    imuHeadingDeg: 0,
    leftTicksTotal: 1,
    rightTicksTotal: 1,
    leftSignedTicksTotal: 1,
    rightSignedTicksTotal: 1,
    inSteadyState: true,
  };
  const phase = { arcSamples: [sample], steadyStateSamples: [sample] };

  const compact = calibrator.withoutTelemetrySamples(phase);

  assert.deepEqual(compact.arcSamples, []);
  assert.deepEqual(compact.steadyStateSamples, []);
  assert.equal(phase.arcSamples.length, 1);
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
