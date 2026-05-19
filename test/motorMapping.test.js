import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMotorDirectionMapping,
  clampNormalizedWheelTargets,
  mapNormalizedWheelTargetsToRaw,
  mapRawMotorFeedbackToAppConvention,
} from "../dist/index.js";

test("motor mapping converts normalized app wheel outputs to raw signs", () => {
  const mapping = buildMotorDirectionMapping(-1, -1);
  const normalized = clampNormalizedWheelTargets({ leftPercent: 0.4, rightPercent: 0.5 });
  const raw = mapNormalizedWheelTargetsToRaw(mapping, normalized);

  assert.equal(raw.leftPercent, -0.4);
  assert.equal(raw.rightPercent, -0.5);
});

test("motor mapping clamps wheel outputs to normalized bounds", () => {
  const normalized = clampNormalizedWheelTargets({ leftPercent: -1.4, rightPercent: 2.1 });
  assert.equal(normalized.leftPercent, -1);
  assert.equal(normalized.rightPercent, 1);
});

test("motor mapping converts raw feedback to app forward-positive convention", () => {
  const mapping = buildMotorDirectionMapping(-1, -1);
  const physical = mapRawMotorFeedbackToAppConvention(mapping, {
    timestampMillis: 1000,
    leftEncoderDelta: -12,
    rightEncoderDelta: -15,
    leftPwmAppliedPercent: -40,
    rightPwmAppliedPercent: -45,
    leftMotorCurrentAmps: 1.2,
    rightMotorCurrentAmps: 1.3,
    watchdogHealthy: true,
    faultFlags: 0,
  });

  assert.equal(physical.leftEncoderDelta, 12);
  assert.equal(physical.rightEncoderDelta, 15);
  assert.equal(physical.leftPwmAppliedPercent, 40);
  assert.equal(physical.rightPwmAppliedPercent, 45);
});
