import test from "node:test";
import assert from "node:assert/strict";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import {
  computeContinuousPathBaseSpeed,
  computeContinuousPathWheelCommands,
  selectContinuousLookaheadTargetIndex,
} from "../dist/pathfollowing/continuousPathFollower.js";

const TEST_PARAMETERS = {
  version: 3,
  closedLoopToleranceMeters: 0.05,
  closedLoopDetectionToleranceMeters: 0.35,
  verificationApproachStandoffMeters: 0.1,
  verificationTurnOnlyDistanceMeters: 0.3,
  mowingStandoffMeters: 0.15,
  segmentedDriveSimplificationToleranceMeters: 0.05,
  segmentedDriveMaxVertexTurnDeg: 10,
  segmentedDriveMaxSegmentLengthMeters: 0.5,
  segmentedDriveMinSegmentLengthMeters: 0.05,
  segmentedDriveMaxCteMeters: 0.05,
  pathRetryReverseDistanceMeters: 0.5,
  turnAlignmentThresholdDeg: 2,
  updatedAt: "2026-06-19T00:00:00.000Z",
};

test("selectContinuousLookaheadTargetIndex chooses a forward point beyond the current waypoint", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.25, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.5, yMeters: 0, capturedAt: 4 },
  ];

  const targetIndex = selectContinuousLookaheadTargetIndex(points, 0, TEST_PARAMETERS);

  assert.equal(targetIndex >= 2, true);
});

test("computeContinuousPathWheelCommands steers right when lookahead lies to the right of heading", () => {
  const pose = createPose(0, 0, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: 1, yMeters: -0.5, capturedAt: 3 };

  const commands = computeContinuousPathWheelCommands(
    pose,
    previousPoint,
    currentTarget,
    lookaheadTarget,
    0.65,
  );

  assert.equal(commands.left > commands.right, true);
});

test("computeContinuousPathWheelCommands pivots when heading error is extreme", () => {
  const pose = createPose(0, 0, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: -1, yMeters: 0, capturedAt: 3 };

  const commands = computeContinuousPathWheelCommands(
    pose,
    previousPoint,
    currentTarget,
    lookaheadTarget,
    0.65,
  );

  assert.equal(commands.left < 0, true);
  assert.equal(commands.right > 0, true);
});

test("computeContinuousPathWheelCommands pivots at a sharp corner near the waypoint", () => {
  const pose = createPose(0.95, 0.02, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: 1, yMeters: 1, capturedAt: 3 };

  const commands = computeContinuousPathWheelCommands(
    pose,
    previousPoint,
    currentTarget,
    lookaheadTarget,
    0.75,
    false,
    {
      pivotAtWaypointTurnDeg: 35,
      pivotAtWaypointDistanceMeters: 0.2,
      minimumSpeed: 0.6,
    },
  );

  assert.equal(commands.left < 0, true);
  assert.equal(commands.right > 0, true);
});

test("computeContinuousPathWheelCommands pivots instead of demanding a crawl arc when the inner wheel would drop too low", () => {
  const pose = createPose(0, 0, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: 0.4, yMeters: 0.7, capturedAt: 3 };

  const commands = computeContinuousPathWheelCommands(
    pose,
    previousPoint,
    currentTarget,
    lookaheadTarget,
    0.75,
    false,
    {
      minimumSpeed: 0.6,
      pivotIfInnerWheelBelow: 0.45,
    },
  );

  assert.equal(commands.left < 0 || commands.right < 0, true);
  assert.equal(commands.pivoting, true);
});

test("computeContinuousPathBaseSpeed stays high on gentle clean path sections", () => {
  const speed = computeContinuousPathBaseSpeed(0.65, 3, 2, 0.01);

  assert.equal(speed > 0.6, true);
  assert.equal(speed <= 0.65, true);
});

test("computeContinuousPathBaseSpeed slows down on tighter, less stable path sections", () => {
  const speed = computeContinuousPathBaseSpeed(0.65, 35, 20, 0.08);

  assert.equal(speed < 0.55, true);
  assert.equal(speed >= 0.45, true);
});

test("computeContinuousPathBaseSpeed honors a higher minimum speed override", () => {
  const speed = computeContinuousPathBaseSpeed(0.75, 35, 20, 0.08, 0.6);

  assert.equal(speed >= 0.6, true);
  assert.equal(speed <= 0.75, true);
});
