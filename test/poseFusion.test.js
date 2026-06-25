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

function emitImuHeading(sensorController, headingDeg, timestampMillis) {
  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(headingDeg),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis,
  });
}

function emitGnssPosition(sensorController, {
  xMeters = 1,
  yMeters = 2,
  headingDeg = null,
  positionAccuracyMeters = 0.03,
  headingAccuracyDeg = 0.4,
  fixType = "fixed",
  satellitesInUse = 20,
  timestampMillis,
}) {
  sensorController.emit("gnssPositionUpdate", {
    xMeters,
    yMeters,
    heading: headingDeg === null ? null : createInternalHeading(headingDeg),
    positionAccuracyMeters,
    headingAccuracyDeg,
    fixType,
    satellitesInUse,
    timestampMillis,
  });
}

function emitRepeatedGnssPositions(sensorController, count, options) {
  const start = options.timestampMillis ?? 1000;
  const step = options.stepMillis ?? 100;
  for (let index = 0; index < count; index += 1) {
    emitGnssPosition(sensorController, {
      ...options,
      timestampMillis: start + (index * step),
    });
  }
}

test("PoseFusion rebases the IMU once GNSS position has been trusted for enough epochs", async () => {
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

  emitImuHeading(sensorController, 25, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 3.5,
    yMeters: 7.2,
    headingDeg: 120,
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

  emitGnssPosition(sensorController, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 90,
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
  let rebaseReadiness = { safe: true };
  sensorController.getHeadingRebaseReadiness = () => rebaseReadiness;
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  emitImuHeading(sensorController, 10, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 10,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1100,
  });

  assert.equal(fusion.getPrimitiveState().usingGnssHeading, true);

  rebaseReadiness = { safe: false };
  emitGnssPosition(sensorController, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 50,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 2100,
  });

  assert.equal(fusion.getPrimitiveState().usingGnssHeading, false);

  await fusion.stop();
});

test("PoseFusion accepts trusted GNSS position even when heading does not validate", async () => {
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

  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 90,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 6,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 90);
  assert.equal(fusion.getCurrentPose().quality, "gnss");

  await fusion.stop();
});

test("PoseFusion does not sync heading from GNSS before position trust is established", async () => {
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

  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 90,
    positionAccuracyMeters: 0.101,
    headingAccuracyDeg: 1,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.xMeters), 0);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.yMeters), 0);
  assert.equal(fusion.getCurrentPose().quality, "unknown");

  await fusion.stop();
});

test("PoseFusion can apply a stationary-safe trusted GNSS heading update after bootstrap", async () => {
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

  emitImuHeading(sensorController, 10, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 10,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 10);

  emitGnssPosition(sensorController, {
    xMeters: 2,
    yMeters: 3,
    headingDeg: 20,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 2600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 20);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 20);

  await fusion.stop();
});

test("PoseFusion rebases from trusted GNSS when the controller reports a safe stationary override state", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  sensorController.getHeadingRebaseReadiness = mock.fn(() => ({
    safe: true,
    motorCommandActive: false,
    leftEncoderDelta: 0,
    rightEncoderDelta: 0,
    wheelsStationary: true,
    maxStationaryTickDelta: 1,
  }));
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  emitImuHeading(sensorController, 10, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 10,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);

  emitImuHeading(sensorController, 40, 5000);
  emitGnssPosition(sensorController, {
    xMeters: 2,
    yMeters: 3,
    headingDeg: 65,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 6000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 65);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 65);

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

  emitImuHeading(sensorController, 10, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 10,
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

  emitImuHeading(sensorController, 11, 2000);
  emitGnssPosition(sensorController, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 11,
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

  emitGnssPosition(sensorController, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 11,
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


test("PoseFusion applies a stationary-safe trusted GNSS heading correction after bootstrap", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  sensorController.getHeadingRebaseReadiness = () => ({
    safe: true,
    motorCommandActive: false,
    leftEncoderDelta: 0,
    rightEncoderDelta: 0,
    wheelsStationary: true,
    maxStationaryTickDelta: 1,
  });
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  emitImuHeading(sensorController, 10, 1000);
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 10,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);

  emitImuHeading(sensorController, 39, 3500);
  emitGnssPosition(sensorController, {
    xMeters: 1,
    yMeters: 2,
    headingDeg: 49,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 3500,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 49);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 49);

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
  emitRepeatedGnssPositions(sensorController, 3, {
    xMeters: 10,
    yMeters: 20,
    headingDeg: 0,
    positionAccuracyMeters: 0.02,
    headingAccuracyDeg: 0.5,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 200,
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
  emitGnssPosition(sensorController, {
    xMeters: 10,
    yMeters: 20,
    headingDeg: 0,
    positionAccuracyMeters: 0.02,
    headingAccuracyDeg: 0.5,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 400,
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
