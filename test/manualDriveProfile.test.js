import test from 'node:test';
import assert from 'node:assert/strict';
import { computeManualDriveDemand, normalizeManualTurnDemand } from '../dist/index.js';

test('normalizeManualTurnDemand applies deadband and saturates', () => {
  assert.equal(normalizeManualTurnDemand(0), 0);
  assert.equal(normalizeManualTurnDemand(4), 0);
  assert.equal(normalizeManualTurnDemand(-4), 0);
  assert.equal(Math.sign(normalizeManualTurnDemand(84)), 1);
  assert.equal(Math.sign(normalizeManualTurnDemand(-84)), -1);
});

test('computeManualDriveDemand produces stopped, arc, and spin modes', () => {
  const stopped = computeManualDriveDemand({
    speedDemand: 0,
    turnDemand: 0,
    maxWheelSpeedMetersPerSecond: 0.75,
  });
  assert.equal(stopped.mode, 'stopped');
  assert.equal(stopped.requestedLeftMetersPerSecond, 0);
  assert.equal(stopped.requestedRightMetersPerSecond, 0);

  const arc = computeManualDriveDemand({
    speedDemand: 0.6,
    turnDemand: 0.5,
    maxWheelSpeedMetersPerSecond: 0.75,
  });
  assert.equal(arc.mode, 'arc');
  assert.equal(arc.requestedRightMetersPerSecond > arc.requestedLeftMetersPerSecond, true);

  const spin = computeManualDriveDemand({
    speedDemand: 0.01,
    turnDemand: 1,
    maxWheelSpeedMetersPerSecond: 0.75,
  });
  assert.equal(spin.mode, 'spin');
  assert.equal(Math.round(spin.requestedLeftMetersPerSecond + spin.requestedRightMetersPerSecond), 0);
});

