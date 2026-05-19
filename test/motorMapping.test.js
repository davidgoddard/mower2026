import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMotorDirectionMapping,
  mapPhysicalWheelTargetsToRaw,
  mapRawMotorFeedbackToPhysical,
} from "../dist/index.js";

test("motor mapping converts app forward-positive wheel targets to raw motor signs", () => {
  const mapping = buildMotorDirectionMapping(-1, -1);
  const raw = mapPhysicalWheelTargetsToRaw(mapping, {
    leftMetersPerSecond: 0.4,
    rightMetersPerSecond: 0.5,
  });

  assert.equal(raw.leftMetersPerSecond, -0.4);
  assert.equal(raw.rightMetersPerSecond, -0.5);
});

test("motor mapping converts raw feedback to app forward-positive convention", () => {
  const mapping = buildMotorDirectionMapping(-1, -1);
  const physical = mapRawMotorFeedbackToPhysical(mapping, {
    timestampMillis: 1000,
    leftWheelActualMetersPerSecond: -0.2,
    rightWheelActualMetersPerSecond: -0.3,
    leftEncoderDelta: -12,
    rightEncoderDelta: -15,
    leftPwmApplied: -40,
    rightPwmApplied: -45,
    leftMotorCurrentAmps: 1.2,
    rightMotorCurrentAmps: 1.3,
    watchdogHealthy: true,
    faultFlags: 0,
  });

  assert.equal(physical.leftWheelActualMetersPerSecond, 0.2);
  assert.equal(physical.rightWheelActualMetersPerSecond, 0.3);
  assert.equal(physical.leftEncoderDelta, 12);
  assert.equal(physical.rightEncoderDelta, 15);
  assert.equal(physical.leftPwmApplied, 40);
  assert.equal(physical.rightPwmApplied, 45);
});
