import test from "node:test";
import assert from "node:assert/strict";
import { MotorFaultFlag } from "../../src/protocols/faultFlags.js";
import { MotorFeedbackAdapter } from "../../src/sensing/motorFeedbackAdapter.js";

test("MotorFeedbackAdapter converts encoder deltas into wheel odometry", () => {
  const adapter = new MotorFeedbackAdapter({
    leftMetersPerEncoderCount: 0.002,
    rightMetersPerEncoderCount: 0.0025,
    staleAfterMillis: 200,
    now: () => 1_100,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    leftWheelActualMetersPerSecond: 0.4,
    rightWheelActualMetersPerSecond: 0.38,
    leftEncoderDelta: 10,
    rightEncoderDelta: 12,
    leftPwmApplied: 42,
    rightPwmApplied: 40,
    watchdogHealthy: true,
    faultFlags: 0,
  });

  assert.deepEqual(bundle.wheelOdometry, {
    leftDistanceMeters: 0.02,
    rightDistanceMeters: 0.03,
    leftSpeedMetersPerSecond: 0.4,
    rightSpeedMetersPerSecond: 0.38,
    timestampMillis: 1_000,
  });
  assert.equal(bundle.stale, false);
  assert.equal(bundle.faultFlags, 0);
});

test("MotorFeedbackAdapter marks stale or unhealthy feedback as watchdog faults", () => {
  const adapter = new MotorFeedbackAdapter({
    leftMetersPerEncoderCount: 0.001,
    rightMetersPerEncoderCount: 0.001,
    staleAfterMillis: 100,
    now: () => 1_500,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    leftWheelActualMetersPerSecond: 0,
    rightWheelActualMetersPerSecond: 0,
    leftEncoderDelta: 0,
    rightEncoderDelta: 0,
    leftPwmApplied: 0,
    rightPwmApplied: 0,
    watchdogHealthy: false,
    faultFlags: 0,
  });

  assert.equal(bundle.stale, true);
  assert.equal(bundle.faultFlags, MotorFaultFlag.WatchdogExpired);
  assert.equal(bundle.wheelOdometry, undefined);
});

test("MotorFeedbackAdapter suppresses wheel odometry when encoder faults are present", () => {
  const adapter = new MotorFeedbackAdapter({
    leftMetersPerEncoderCount: 0.001,
    rightMetersPerEncoderCount: 0.001,
    staleAfterMillis: 100,
    now: () => 1_050,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    leftWheelActualMetersPerSecond: 0.2,
    rightWheelActualMetersPerSecond: 0.2,
    leftEncoderDelta: 10,
    rightEncoderDelta: 10,
    leftPwmApplied: 10,
    rightPwmApplied: 10,
    watchdogHealthy: true,
    faultFlags: MotorFaultFlag.LeftEncoderFault,
  });

  assert.equal(bundle.stale, false);
  assert.equal(bundle.faultFlags, MotorFaultFlag.LeftEncoderFault);
  assert.equal(bundle.wheelOdometry, undefined);
});
