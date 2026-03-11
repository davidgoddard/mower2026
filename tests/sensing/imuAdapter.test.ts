import test from "node:test";
import assert from "node:assert/strict";
import { ImuAdapter } from "../../src/sensing/imuAdapter.js";
import { ImuFaultFlag } from "../../src/protocols/faultFlags.js";

test("ImuAdapter surfaces three-axis gyro and accelerometer samples", () => {
  const adapter = new ImuAdapter({
    staleAfterMillis: 250,
    now: () => 1_100,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    angularVelocity: {
      xDegreesPerSecond: 1.2,
      yDegreesPerSecond: -0.4,
      zDegreesPerSecond: 12.5,
    },
    acceleration: {
      xMetersPerSecondSquared: 0.1,
      yMetersPerSecondSquared: -0.2,
      zMetersPerSecondSquared: 9.7,
    },
  });

  assert.deepEqual(bundle.imu, {
    timestampMillis: 1_000,
    angularVelocity: {
      xDegreesPerSecond: 1.2,
      yDegreesPerSecond: -0.4,
      zDegreesPerSecond: 12.5,
    },
    acceleration: {
      xMetersPerSecondSquared: 0.1,
      yMetersPerSecondSquared: -0.2,
      zMetersPerSecondSquared: 9.7,
    },
  });
  assert.equal(bundle.faultFlags, 0);
  assert.equal(bundle.stale, false);
});

test("ImuAdapter marks stale samples", () => {
  const adapter = new ImuAdapter({
    staleAfterMillis: 250,
    now: () => 2_000,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    angularVelocity: {
      xDegreesPerSecond: 0,
      yDegreesPerSecond: 0,
      zDegreesPerSecond: 0,
    },
    acceleration: {
      xMetersPerSecondSquared: 0,
      yMetersPerSecondSquared: 0,
      zMetersPerSecondSquared: 9.81,
    },
  });

  assert.equal(bundle.stale, true);
  assert.equal(bundle.faultFlags, ImuFaultFlag.StaleSample);
});
