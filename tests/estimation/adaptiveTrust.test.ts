import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveTrust } from "../../src/estimation/adaptiveTrust.js";

test("AdaptiveTrust favors fixed RTK position over stale data", () => {
  const trust = new AdaptiveTrust();

  const result = trust.evaluate({
    position: {
      xMeters: 1,
      yMeters: 2,
      accuracyMeters: 0.01,
      timestampMillis: 100,
      fixQuality: "high",
    },
    heading: {
      headingDegrees: 90,
      accuracyDegrees: 0.5,
      timestampMillis: 100,
      source: "gnss",
    },
    faultFlags: 0,
    stale: false,
  });

  assert.deepEqual(result, {
    positionTrust: 0.9,
    headingTrust: 0.8,
    wheelTrust: 0,
  });
});

test("AdaptiveTrust suppresses stale measurements", () => {
  const trust = new AdaptiveTrust();

  assert.deepEqual(
    trust.evaluate({
      wheelOdometry: {
        leftDistanceMeters: 0.1,
        rightDistanceMeters: 0.1,
        leftSpeedMetersPerSecond: 0.2,
        rightSpeedMetersPerSecond: 0.2,
        timestampMillis: 10,
      },
      faultFlags: 0,
      stale: true,
    }),
    {
      positionTrust: 0,
      headingTrust: 0,
      wheelTrust: 0,
    },
  );
});
