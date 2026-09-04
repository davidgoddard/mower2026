import test from "node:test";
import assert from "node:assert/strict";

import { AdaptiveTerrainSteering } from "../dist/control/adaptiveTerrainSteering.js";

function feedback(overrides = {}) {
  return {
    leftEncoderDelta: 10,
    rightEncoderDelta: 30,
    leftPwmAppliedPercent: 100,
    rightPwmAppliedPercent: 100,
    leftMotorCurrentAmps: 4,
    rightMotorCurrentAmps: 2,
    watchdogHealthy: true,
    faultFlags: 0,
    timestampMillis: 1,
    ...overrides,
  };
}

test("terrain steering gradually helps a corroborated loaded wheel", () => {
  const steering = new AdaptiveTerrainSteering();
  const first = steering.observe(feedback(), true);
  const second = steering.observe(feedback({ timestampMillis: 2 }), true);

  assert.equal(first.evidenceAccepted, true);
  assert.equal(first.trimPercent < 0, true);
  assert.equal(second.trimPercent < first.trimPercent, true);
  assert.equal(Math.abs(second.trimPercent) <= 0.08, true);
});

test("terrain steering decays when evidence is absent or unsafe", () => {
  const steering = new AdaptiveTerrainSteering();
  steering.observe(feedback(), true);
  steering.observe(feedback({ timestampMillis: 2 }), true);
  const before = steering.getSnapshot().trimPercent;

  const symmetric = steering.observe(feedback({
    leftEncoderDelta: 20,
    rightEncoderDelta: 20,
    leftMotorCurrentAmps: 3,
    rightMotorCurrentAmps: 3,
    timestampMillis: 3,
  }), true);
  assert.equal(symmetric.evidenceAccepted, false);
  assert.equal(Math.abs(symmetric.trimPercent) < Math.abs(before), true);

  const faulted = steering.observe(feedback({ faultFlags: 1, timestampMillis: 4 }), true);
  assert.equal(faulted.evidenceAccepted, false);
  assert.equal(faulted.trimPercent, 0);
});

test("terrain steering clears a trim when feedback becomes stale", () => {
  const steering = new AdaptiveTerrainSteering();
  steering.observe(feedback(), true, 1_000);
  steering.observe(feedback(), true, 1_050);
  assert.equal(steering.getSnapshot(1_100).trimPercent < 0, true);
  assert.equal(steering.getSnapshot(1_301).trimPercent, 0);
});
