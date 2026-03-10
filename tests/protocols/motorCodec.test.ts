import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeMotorFeedbackSample,
  decodeWheelSpeedCommand,
  encodeMotorFeedbackSample,
  encodeWheelSpeedCommand,
  motorFeedbackSampleLength,
  wheelSpeedCommandLength,
} from "../../src/protocols/motorCodec.js";

test("motor command codec uses a compact fixed payload length", () => {
  assert.equal(wheelSpeedCommandLength(), 15);
});

test("motor feedback codec uses a compact fixed payload length", () => {
  assert.equal(motorFeedbackSampleLength(), 26);
});

test("wheel speed command codec round-trips values", () => {
  const command = {
    timestampMillis: 999,
    leftWheelTargetMetersPerSecond: 0.42,
    rightWheelTargetMetersPerSecond: -0.41,
    enableDrive: true,
    commandTimeoutMillis: 250,
    maxAccelerationMetersPerSecondSquared: 0.6,
    maxDecelerationMetersPerSecondSquared: 0.8,
  };

  assert.deepEqual(decodeWheelSpeedCommand(encodeWheelSpeedCommand(command)), command);
});

test("motor feedback codec round-trips values", () => {
  const sample = {
    timestampMillis: 5000,
    leftWheelActualMetersPerSecond: 0.35,
    rightWheelActualMetersPerSecond: 0.34,
    leftEncoderDelta: 1024,
    rightEncoderDelta: 1008,
    leftPwmApplied: 72,
    rightPwmApplied: 70,
    leftMotorCurrentAmps: 3.2,
    rightMotorCurrentAmps: 3.1,
    watchdogHealthy: true,
    faultFlags: 0x0002,
  };

  assert.deepEqual(decodeMotorFeedbackSample(encodeMotorFeedbackSample(sample)), sample);
});
