import test from "node:test";
import assert from "node:assert/strict";
import { PoseEstimator } from "../../src/estimation/poseEstimator.js";

test("PoseEstimator integrates straight wheel odometry", () => {
  const estimator = new PoseEstimator({ wheelBaseMeters: 0.5 });

  const estimate = estimator.ingest({
    wheelOdometry: {
      leftDistanceMeters: 1,
      rightDistanceMeters: 1,
      leftSpeedMetersPerSecond: 0.5,
      rightSpeedMetersPerSecond: 0.5,
      timestampMillis: 100,
    },
    faultFlags: 0,
    stale: false,
  });

  assert.equal(Number(estimate.xMeters.toFixed(3)), 0.8);
  assert.equal(Number(estimate.yMeters.toFixed(3)), 0);
  assert.equal(Number(estimate.headingDegrees.toFixed(3)), 0);
  assert.equal(estimate.speedMetersPerSecond, 0.5);
});

test("PoseEstimator blends GNSS position and heading toward measurements", () => {
  const estimator = new PoseEstimator({
    wheelBaseMeters: 0.5,
    initialPose: {
      xMeters: 0,
      yMeters: 0,
      headingDegrees: 0,
      speedMetersPerSecond: 0,
      yawRateDegreesPerSecond: 0,
      confidence: 0,
      timestampMillis: 0,
    },
  });

  const estimate = estimator.ingest({
    position: {
      xMeters: 10,
      yMeters: 0,
      accuracyMeters: 0.01,
      timestampMillis: 200,
      fixQuality: "high",
    },
    heading: {
      headingDegrees: 90,
      accuracyDegrees: 0.2,
      timestampMillis: 200,
      source: "gnss",
    },
    faultFlags: 0,
    stale: false,
  });

  assert.equal(Number(estimate.xMeters.toFixed(3)), 9);
  assert.equal(Number(estimate.headingDegrees.toFixed(3)), 72);
  assert.equal(estimate.confidence, 0.9);
});
