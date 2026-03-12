import test from "node:test";
import assert from "node:assert/strict";
import { buildLaneMissionSequence } from "../../src/execution/laneMissionBuilder.js";
import { LaneExecutor } from "../../src/execution/laneExecutor.js";
import type { PoseEstimate } from "../../src/estimation/estimatorTypes.js";
import type { CoverageLane } from "../../src/planning/coverageTypes.js";

function integrateDifferentialDrive(pose: PoseEstimate, left: number, right: number, dtSeconds: number): PoseEstimate {
  const wheelBaseMeters = 0.52;
  const linearVelocity = (left + right) / 2;
  const yawRateRadiansPerSecond = (right - left) / wheelBaseMeters;
  const deltaHeadingDegrees = (yawRateRadiansPerSecond * dtSeconds * 180) / Math.PI;
  const headingMidRadians = ((pose.headingDegrees + (deltaHeadingDegrees / 2)) * Math.PI) / 180;

  return {
    ...pose,
    timestampMillis: pose.timestampMillis + Math.round(dtSeconds * 1000),
    xMeters: pose.xMeters + (linearVelocity * dtSeconds * Math.cos(headingMidRadians)),
    yMeters: pose.yMeters + (linearVelocity * dtSeconds * Math.sin(headingMidRadians)),
    headingDegrees: normalizeHeading(pose.headingDegrees + deltaHeadingDegrees),
    speedMetersPerSecond: linearVelocity,
    yawRateDegreesPerSecond: (yawRateRadiansPerSecond * 180) / Math.PI,
  };
}

function normalizeHeading(degrees: number): number {
  let normalized = degrees;
  while (normalized <= -180) {
    normalized += 360;
  }
  while (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

test("lane mission sequence decomposes a lane into turn-drive-turn-drive-arrive", () => {
  const lane: CoverageLane = {
    id: "lane-1",
    start: { xMeters: 2, yMeters: 1, headingDegrees: 0 },
    end: { xMeters: 8, yMeters: 1, headingDegrees: 0 },
    lengthMeters: 6,
    headingDegrees: 0,
  };

  const sequence = buildLaneMissionSequence({
    timestampMillis: 0,
    xMeters: 0,
    yMeters: 0,
    headingDegrees: 90,
    speedMetersPerSecond: 0,
    yawRateDegreesPerSecond: 0,
    confidence: 1,
  }, lane);

  assert.deepEqual(sequence.segments.map((segment) => segment.kind), ["turn", "drive", "turn", "drive", "arrive"]);
});

test("LaneExecutor completes one lane end-to-end in the emulator and stops", () => {
  const lane: CoverageLane = {
    id: "lane-1",
    start: { xMeters: 2, yMeters: 1, headingDegrees: 0 },
    end: { xMeters: 8, yMeters: 1, headingDegrees: 0 },
    lengthMeters: 6,
    headingDegrees: 0,
  };
  let pose: PoseEstimate = {
    timestampMillis: 0,
    xMeters: 0,
    yMeters: 0,
    headingDegrees: 90,
    speedMetersPerSecond: 0,
    yawRateDegreesPerSecond: 0,
    confidence: 1,
  };

  const executor = new LaneExecutor(buildLaneMissionSequence(pose, lane), {
    maxWheelSpeedMetersPerSecond: 0.75,
    headingToleranceDegrees: 4,
    arrivalToleranceMeters: 0.12,
    settleDurationMillis: 200,
    turnGain: 0.33,
    lineNominalSpeedMetersPerSecond: 0.5,
    lineMaxSpeedMetersPerSecond: 0.65,
    lineCrossTrackGain: 1.2,
    lineHeadingGain: 0.8,
    lineMaxYawRateDegreesPerSecond: 90,
    wheelBaseMeters: 0.52,
  });

  let snapshot = executor.step(pose, pose.timestampMillis);
  let iterations = 0;
  const visitedPhases = new Set<string>();
  while (!snapshot.completed && iterations < 600) {
    visitedPhases.add(snapshot.phase);
    pose = integrateDifferentialDrive(
      pose,
      snapshot.wheelTargets.leftMetersPerSecond,
      snapshot.wheelTargets.rightMetersPerSecond,
      0.1,
    );
    snapshot = executor.step(pose, pose.timestampMillis);
    iterations += 1;
  }

  assert.equal(snapshot.completed, true);
  assert.equal(visitedPhases.has("turning"), true);
  assert.equal(visitedPhases.has("driving"), true);
  assert.equal(snapshot.wheelTargets.leftMetersPerSecond, 0);
  assert.equal(snapshot.wheelTargets.rightMetersPerSecond, 0);
  assert.equal(Math.hypot(pose.xMeters - lane.end.xMeters, pose.yMeters - lane.end.yMeters) < 0.25, true);
});
