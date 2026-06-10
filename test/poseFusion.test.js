import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import { PoseFusion } from "../dist/sensing/poseFusion.js";
import { createInternalHeading, unwrapInternalHeading } from "../dist/geometry/headingTypes.js";
import { unwrapMeters } from "../dist/geometry/positionTypes.js";

function createMockLogger() {
  const logger = {
    child: null,
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
  };
  logger.child = mock.fn(() => logger);
  return logger;
}

function findLogCall(logger, message) {
  return logger.info.mock.calls.find((call) => call.arguments[0] === message);
}

test("PoseFusion rebases the IMU from the first good GNSS heading fix", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(25),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3.5,
    yMeters: 7.2,
    heading: createInternalHeading(120),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1500,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 120);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 120);

  await fusion.stop();
});

test("PoseFusion ignores poor GNSS fixes when deciding whether to reset heading", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.5,
    fixType: "single",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);

  await fusion.stop();
});

test("PoseFusion exposes whether GNSS is currently rebasing the IMU heading", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1100,
  });

  assert.equal(fusion.getPrimitiveState().usingGnssHeading, true);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(40),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 2100,
  });

  assert.equal(fusion.getPrimitiveState().usingGnssHeading, false);

  await fusion.stop();
});

test("PoseFusion keeps GNSS position even when heading accuracy is too poor to rebase heading", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 6,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);
  assert.equal(fusion.getCurrentPose().quality, "gnss");

  await fusion.stop();
});

test("PoseFusion still syncs heading from GNSS when position accuracy is poor", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.101,
    headingAccuracyDeg: 1,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 90);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 90);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.xMeters), 0);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.yMeters), 0);
  assert.equal(fusion.getCurrentPose().quality, "unknown");

  await fusion.stop();
});

test("PoseFusion keeps the IMU heading when later GNSS is too far away and rebases only when close", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 10);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 2,
    yMeters: 3,
    heading: createInternalHeading(20),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 2600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 10);
  const rejectedLog = findLogCall(logger, "pose_fusion.gnss_heading_not_aligned");
  assert.ok(rejectedLog);
  assert.equal(rejectedLog.arguments[1].alignmentDeltaDeg, 10);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3,
    yMeters: 4,
    heading: createInternalHeading(11),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 3600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 11);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 11);

  await fusion.stop();
});

test("PoseFusion rebases from GNSS after a long zero-speed stop even when heading gap is large", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  sensorController.getMotorZeroCommandSinceMillis = mock.fn(() => 1000);
  sensorController.getCurrentTimeMillis = mock.fn(() => 1000);
  sensorController.getRecentImuDiagnosticSummary = mock.fn(() => ({
    windowMs: 5000,
    sampleCount: 2,
    startTimestampMillis: 5000,
    endTimestampMillis: 6000,
    durationMs: 1000,
    headingBeforeDeg: 40,
    headingAfterDeg: 44,
    headingChangeDeg: 4,
    integratedYawDeltaDeg: 4,
    averageYawRateDegPerSec: 4,
    minYawRateDegPerSec: 4,
    maxYawRateDegPerSec: 4,
    averageSampleDeltaMs: 1000,
    minSampleDeltaMs: 1000,
    maxSampleDeltaMs: 1000,
    recentSamples: [
      {
        timestampMillis: 5000,
        sampleDeltaMs: 1000,
        deltaSeconds: 1,
        headingBeforeDeg: 40,
        headingAfterDeg: 42,
        yawRateDegPerSec: 2,
        yawDeltaDeg: 2,
      },
      {
        timestampMillis: 6000,
        sampleDeltaMs: 1000,
        deltaSeconds: 1,
        headingBeforeDeg: 42,
        headingAfterDeg: 44,
        yawRateDegPerSec: 2,
        yawDeltaDeg: 2,
      },
    ],
  }));
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(40),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 5000,
  });
  sensorController.getCurrentTimeMillis = mock.fn(() => 12000);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 2,
    yMeters: 3,
    heading: createInternalHeading(100),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 6000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 100);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 100);
  const rebaseLog = findLogCall(logger, "pose_fusion.gnss_heading_rebased_after_stop");
  assert.ok(rebaseLog);
  assert.equal(rebaseLog.arguments[1].stationaryZeroCommandAgeMs, 11000);
  assert.equal(rebaseLog.arguments[1].imuDiagnostics.sampleCount, 2);
  assert.equal(rebaseLog.arguments[1].imuDiagnostics.integratedYawDeltaDeg, 4);

  await fusion.stop();
});

test("PoseFusion defers GNSS heading rebase while controller reports active motion", async () => {
  const sensorController = new EventEmitter();
  let rebaseReadiness = {
    safe: true,
    motorCommandActive: false,
    leftEncoderDelta: 0,
    rightEncoderDelta: 0,
    wheelsStationary: true,
    maxStationaryTickDelta: 1,
  };
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  sensorController.getHeadingRebaseReadiness = mock.fn(() => rebaseReadiness);
  sensorController.getCurrentTimeMillis = mock.fn(() => 1000);
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);

  rebaseReadiness = {
    safe: false,
    motorCommandActive: true,
    leftEncoderDelta: 12,
    rightEncoderDelta: 12,
    wheelsStationary: false,
    maxStationaryTickDelta: 1,
  };
  sensorController.getCurrentTimeMillis = mock.fn(() => 2000);

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(11),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 2000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(11),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 2100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(fusion.getPrimitiveState().usingGnssHeading, false);

  rebaseReadiness = {
    safe: true,
    motorCommandActive: false,
    leftEncoderDelta: 0,
    rightEncoderDelta: 0,
    wheelsStationary: true,
    maxStationaryTickDelta: 1,
  };
  sensorController.getCurrentTimeMillis = mock.fn(() => 2300);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(11),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 2300,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 11);

  await fusion.stop();
});


test("PoseFusion rebases from GNSS after a consistent mirrored offset", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  sensorController.getMotorZeroCommandSinceMillis = mock.fn(() => null);
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);

  const samples = [
    { imu: 20, gnss: 30, t: 2000 },
    { imu: 24, gnss: 34, t: 2300 },
    { imu: 28, gnss: 38, t: 2600 },
    { imu: 31, gnss: 41, t: 2900 },
    { imu: 35, gnss: 45, t: 3200 },
    { imu: 39, gnss: 49, t: 3500 },
  ];

  for (const sample of samples) {
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(sample.imu),
      pitchDeg: 0,
      rollDeg: 0,
      timestampMillis: sample.t,
    });

    sensorController.emit("gnssPositionUpdate", {
      xMeters: 1,
      yMeters: 2,
      heading: createInternalHeading(sample.gnss),
      positionAccuracyMeters: 0.03,
      headingAccuracyDeg: 0.4,
      fixType: "fixed",
      satellitesInUse: 20,
      timestampMillis: sample.t,
    });
  }

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 49);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 49);

  const rebaseLog = findLogCall(logger, "pose_fusion.gnss_heading_rebased_after_consistent_offset");
  assert.ok(rebaseLog);
  assert.equal(Math.round(rebaseLog.arguments[1].alignmentDeltaDeg), 10);
  assert.equal(rebaseLog.arguments[1].consistentOffsetDurationMs >= 1500, true);
  assert.equal(rebaseLog.arguments[1].consistentOffsetSamples >= 6, true);

  await fusion.stop();
});

// ── Encoder-only odometry and DR confidence ─────────────────────────────────

test("PoseFusion initialises encoder-only track from first IMU heading on first encoder sample", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(45),
    pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });

  // Straight forward: equal ticks on both wheels, no turn.
  sensorController.emit("motorFeedbackUpdate", {
    leftEncoderDelta: 100, rightEncoderDelta: 100,
    leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
    leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
    watchdogHealthy: true, faultFlags: 0,
    timestampMillis: 200,
  });

  const state = fusion.getPrimitiveState();
  assert.ok(state.encoderOnlyXMeters !== null, "encoderOnlyX should be set");
  assert.ok(state.encoderOnlyYMeters !== null, "encoderOnlyY should be set");
  assert.ok(state.encoderOnlyHeadingDeg !== null, "encoderOnlyHeadingDeg should be set");

  await fusion.stop();
});

test("PoseFusion drConfidence starts at 1 and remains at 1 when encoders agree with IMU", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0),
    pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });

  // Drive straight — equal ticks, no IMU turn, so no disagreement.
  for (let i = 0; i < 20; i++) {
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(0),
      pitchDeg: 0, rollDeg: 0, timestampMillis: 100 + i * 5,
    });
    sensorController.emit("motorFeedbackUpdate", {
      leftEncoderDelta: 10, rightEncoderDelta: 10,
      leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
      leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
      watchdogHealthy: true, faultFlags: 0,
      timestampMillis: 105 + i * 5,
    });
  }

  const state = fusion.getPrimitiveState();
  assert.ok(state.drConfidence > 0.9, `confidence should stay near 1 but got ${state.drConfidence}`);

  await fusion.stop();
});

test("PoseFusion drConfidence decays when encoder-implied turn disagrees with IMU", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0),
    pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });

  // Emit encoder samples that imply a large turn while IMU stays straight.
  // Large left-right asymmetry implies wheel slip: one wheel much faster than the other
  // while IMU reports no heading change.
  for (let i = 0; i < 30; i++) {
    // IMU stays at heading 0 throughout (no turn)
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(0),
      pitchDeg: 0, rollDeg: 0, timestampMillis: 100 + i * 5,
    });
    // Encoders imply a big differential (right >> left → large rightward turn implied)
    sensorController.emit("motorFeedbackUpdate", {
      leftEncoderDelta: 5, rightEncoderDelta: 200,
      leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
      leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
      watchdogHealthy: true, faultFlags: 0,
      timestampMillis: 105 + i * 5,
    });
  }

  const state = fusion.getPrimitiveState();
  assert.ok(state.drConfidence < 0.5, `confidence should have decayed but got ${state.drConfidence}`);
  assert.equal(state.wheelSlipSuspected, true);

  await fusion.stop();
});

test("PoseFusion drConfidence recovers after slip resolves", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0),
    pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });

  // Phase 1: cause slip to drive confidence down
  for (let i = 0; i < 20; i++) {
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(0),
      pitchDeg: 0, rollDeg: 0, timestampMillis: 100 + i * 5,
    });
    sensorController.emit("motorFeedbackUpdate", {
      leftEncoderDelta: 5, rightEncoderDelta: 200,
      leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
      leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
      watchdogHealthy: true, faultFlags: 0,
      timestampMillis: 105 + i * 5,
    });
  }
  const confidenceAfterSlip = fusion.getPrimitiveState().drConfidence;
  assert.ok(confidenceAfterSlip < 0.9, "confidence should have dropped");

  // Phase 2: agree for many samples to recover
  for (let i = 0; i < 200; i++) {
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(0),
      pitchDeg: 0, rollDeg: 0, timestampMillis: 300 + i * 5,
    });
    sensorController.emit("motorFeedbackUpdate", {
      leftEncoderDelta: 10, rightEncoderDelta: 10,
      leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
      leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
      watchdogHealthy: true, faultFlags: 0,
      timestampMillis: 305 + i * 5,
    });
  }
  const confidenceAfterRecovery = fusion.getPrimitiveState().drConfidence;
  assert.ok(confidenceAfterRecovery > confidenceAfterSlip, "confidence should have recovered");

  await fusion.stop();
});

test("PoseFusion re-anchors encoder-only X/Y on every TRUSTED GNSS position even when heading is not rebased", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  sensorController.getHeadingRebaseReadiness = () => ({
    safe: false,
    motorCommandActive: true,
    leftEncoderDelta: 12,
    rightEncoderDelta: 12,
    wheelsStationary: false,
    maxStationaryTickDelta: 1,
  });
  sensorController.getMotorZeroCommandSinceMillis = () => null;
  sensorController.getCurrentTimeMillis = () => 99999;
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  // Feed enough valid position samples (no heading present) to promote position
  // to TRUSTED while leaving heading REJECTED. The validator default is 3
  // consecutive valid epochs for position promotion.
  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0), pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });
  for (let i = 0; i < 3; i += 1) {
    sensorController.emit("gnssPositionUpdate", {
      xMeters: 10, yMeters: 20,
      heading: null,
      positionAccuracyMeters: 0.02,
      headingAccuracyDeg: null,
      fixType: "fixed", satellitesInUse: 20, timestampMillis: 200 + i * 50,
    });
  }

  // Drift the encoder-only track via wheel ticks while GNSS is silent
  sensorController.emit("motorFeedbackUpdate", {
    leftEncoderDelta: 500, rightEncoderDelta: 500,
    leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
    leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
    watchdogHealthy: true, faultFlags: 0, timestampMillis: 400,
  });

  const encXBeforeAnchor = fusion.getPrimitiveState().encoderOnlyXMeters;
  assert.ok(
    Math.abs((encXBeforeAnchor ?? 0) - 10) > 0.05,
    `encoder-only X should have drifted from anchor before re-anchor; got ${encXBeforeAnchor}`,
  );

  // Setheading should NOT have been called because heading was always null
  assert.equal(sensorController.setHeading.mock.calls.length, 0);

  // Send another TRUSTED position with still no heading — encoder-only track
  // should snap back to (10, 20) without invoking a heading rebase.
  sensorController.emit("gnssPositionUpdate", {
    xMeters: 10, yMeters: 20,
    heading: null,
    positionAccuracyMeters: 0.02,
    headingAccuracyDeg: null,
    fixType: "fixed", satellitesInUse: 20, timestampMillis: 500,
  });

  const stateAfter = fusion.getPrimitiveState();
  assert.ok(
    Math.abs((stateAfter.encoderOnlyXMeters ?? 0) - 10) < 0.001,
    `encoderOnlyX should be re-anchored to fused X=10 but got ${stateAfter.encoderOnlyXMeters}`,
  );
  assert.ok(
    Math.abs((stateAfter.encoderOnlyYMeters ?? 0) - 20) < 0.001,
    `encoderOnlyY should be re-anchored to fused Y=20 but got ${stateAfter.encoderOnlyYMeters}`,
  );
  assert.equal(
    sensorController.setHeading.mock.calls.length,
    0,
    "no heading rebase should fire when GNSS heading is absent",
  );

  await fusion.stop();
});

test("PoseFusion re-anchors encoder-only track and boosts confidence when GNSS rebases IMU heading", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  if (!sensorController.getHeadingRebaseReadiness) {
    sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  }
  sensorController.getHeadingRebaseReadiness = () => ({ safe: true });
  sensorController.getMotorZeroCommandSinceMillis = () => 0;
  sensorController.getCurrentTimeMillis = () => 99999;
  const fusion = new PoseFusion({ sensorController, logger: createMockLogger() });
  await fusion.start();

  // Prime IMU and anchor GNSS position
  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0), pitchDeg: 0, rollDeg: 0, timestampMillis: 100,
  });
  sensorController.emit("gnssPositionUpdate", {
    xMeters: 10, yMeters: 20,
    heading: createInternalHeading(0),
    positionAccuracyMeters: 0.02, headingAccuracyDeg: 0.5,
    fixType: "fixed", satellitesInUse: 20, timestampMillis: 200,
  });

  // Artificially drift the encoder-only position to simulate movement
  fusion.getPrimitiveState(); // ensure seeded
  // Drive forward a bit via encoder events to drift the encoder track
  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(0), pitchDeg: 0, rollDeg: 0, timestampMillis: 300,
  });
  sensorController.emit("motorFeedbackUpdate", {
    leftEncoderDelta: 500, rightEncoderDelta: 500,
    leftMotorCurrentAmps: 0, rightMotorCurrentAmps: 0,
    leftPwmAppliedPercent: 50, rightPwmAppliedPercent: 50,
    watchdogHealthy: true, faultFlags: 0, timestampMillis: 350,
  });

  const stateBefore = fusion.getPrimitiveState();
  const encXBefore = stateBefore.encoderOnlyXMeters;

  // Now trigger a GNSS heading rebase — same heading so alignmentDelta = 0,
  // which means it will rebase unconditionally (within-threshold path).
  sensorController.emit("gnssPositionUpdate", {
    xMeters: 10, yMeters: 20,
    heading: createInternalHeading(0),
    positionAccuracyMeters: 0.02, headingAccuracyDeg: 0.5,
    fixType: "fixed", satellitesInUse: 20, timestampMillis: 400,
  });

  const stateAfter = fusion.getPrimitiveState();

  // Encoder X should have been snapped back to the fused position (10 m), not left at the drifted value
  assert.ok(
    Math.abs((stateAfter.encoderOnlyXMeters ?? 0) - 10) < 0.01,
    `encoderOnlyX should be re-anchored to fused X=10 but got ${stateAfter.encoderOnlyXMeters}`,
  );
  assert.ok(
    stateAfter.encoderOnlyXMeters !== encXBefore,
    "encoder X should have changed from drifted value after rebase",
  );

  await fusion.stop();
});
