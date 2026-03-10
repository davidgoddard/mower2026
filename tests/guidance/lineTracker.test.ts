import test from "node:test";
import assert from "node:assert/strict";
import { LineTracker } from "../../src/guidance/lineTracker.js";

test("LineTracker commands right turn when mower is left of the desired line", () => {
  const tracker = new LineTracker({
    nominalSpeedMetersPerSecond: 0.6,
    maxSpeedMetersPerSecond: 0.8,
    crossTrackGain: -20,
    headingGain: 1.5,
    maxYawRateDegreesPerSecond: 90,
  });

  const intent = tracker.track(
    {
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: 10, yMeters: 0, headingDegrees: 0 },
    },
    {
      xMeters: 2,
      yMeters: 0.5,
      headingDegrees: 0,
      speedMetersPerSecond: 0.3,
      yawRateDegreesPerSecond: 0,
      confidence: 1,
      timestampMillis: 100,
    },
  );

  assert.equal(intent.yawRateDemandDegreesPerSecond < 0, true);
  assert.equal(Number(intent.forwardSpeedMetersPerSecond.toFixed(3)), 0.48);
});
