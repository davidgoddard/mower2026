import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationApproachPlan,
  buildVerificationApproachTarget,
  buildDrivePathPoints,
  buildDrivePathPointsForDirection,
  buildPerimeterFollowPlan,
  buildPerimeterDrivePathPoints,
  buildPerimeterJoinPlan,
  buildPerimeterPathPointsFromPlan,
  buildVerificationPathPoints,
  buildVerificationPathPointsFromPlan,
  findNearestPathPointIndex,
} from "../dist/pathfollowing/pathVerification.js";
import {
  advancePassedTargets,
  buildSegmentedBoundaryExecutionTargets,
  buildSegmentedBoundaryTargets,
  selectSegmentedBoundaryTargetIndex,
} from "../dist/pathfollowing/segmentedBoundaryExecutor.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";

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
  updatedAt: "2026-06-04T00:00:00.000Z",
};

test("buildVerificationPathPoints rotates the path from the tangential join point and closes the loop", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(2.2, 0.1, createInternalHeading(0), "gnss");

  assert.equal(findNearestPathPointIndex(points, pose), 2);

  const verificationPoints = buildVerificationPathPoints(points, pose);
  assert.deepEqual(
    verificationPoints.map((point) => point.xMeters),
    [2, 1, 0, 3, 2],
  );
  assert.deepEqual(
    verificationPoints.map((point) => point.yMeters),
    [0, 0, 0, 0, 0],
  );
});

test("buildVerificationPathPoints preserves a closed-loop perimeter without inflating it", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");

  const verificationPoints = buildVerificationPathPoints(points, pose);

  // Recorded geometry only, no outward inflation. Length = 4 unique vertices + duplicate join.
  assert.equal(verificationPoints.length, 5);
  assert.equal(verificationPoints[0].xMeters, verificationPoints.at(-1).xMeters);
  assert.equal(verificationPoints[0].yMeters, verificationPoints.at(-1).yMeters);
  assert.equal(verificationPoints.every((point) => point.xMeters >= 0 && point.xMeters <= 1), true);
  assert.equal(verificationPoints.every((point) => point.yMeters >= 0 && point.yMeters <= 1), true);
});


test("buildDrivePathPoints rotates the path from the tangential join point without closing the loop", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(2.2, 0.1, createInternalHeading(0), "gnss");

  const drivePoints = buildDrivePathPoints(points, pose);
  assert.deepEqual(
    drivePoints.map((point) => point.xMeters),
    [2, 1, 0, 3],
  );
  assert.deepEqual(
    drivePoints.map((point) => point.yMeters),
    [0, 0, 0, 0],
  );
});

test("buildDrivePathPoints can rotate the path in reverse from the nearest point", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(2.2, 0.1, createInternalHeading(180), "gnss");

  const drivePoints = buildDrivePathPointsForDirection(points, pose, "reverse");
  assert.deepEqual(
    drivePoints.map((point) => point.xMeters),
    [2, 1, 0, 3],
  );
});

test("buildDrivePathPoints follows recorded closed obstacle loops without outward inflation", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");

  const drivePoints = buildDrivePathPointsForDirection(points, pose, "forward");

  assert.equal(drivePoints.length, 5);
  assert.equal(drivePoints.every((point) => point.xMeters >= 0 && point.xMeters <= 1), true);
  assert.equal(drivePoints.every((point) => point.yMeters >= 0 && point.yMeters <= 1), true);
});

test("buildPerimeterDrivePathPoints follows mowing perimeters exactly", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");

  const drivePoints = buildPerimeterDrivePathPoints(points, pose);

  assert.deepEqual(
    drivePoints.map((point) => [point.xMeters, point.yMeters]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  );
});

test("buildPerimeterJoinPlan uses the nearest point and the direction closest to current heading", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(2.1, 0.1, createInternalHeading(180), "gnss");

  const plan = buildPerimeterJoinPlan(points, pose);

  assert.ok(plan);
  assert.equal(plan.nearestIndex, 2);
  assert.equal(plan.pathDirection, "reverse");
  assert.equal(plan.approachTarget.xMeters, 2);
  assert.equal(plan.approachTarget.yMeters, 0);

  const perimeterPoints = buildPerimeterPathPointsFromPlan(points, plan);
  assert.deepEqual(
    perimeterPoints.map((point) => point.xMeters),
    [2, 1, 0, 3],
  );
});

test("buildPerimeterFollowPlan re-evaluates the nearest perimeter point after the approach turn", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const poseAfterTurn = createPose(0.92, 0.08, createInternalHeading(0), "gnss");
  const followPlan = buildPerimeterFollowPlan(points, poseAfterTurn, "forward", TEST_PARAMETERS);

  assert.ok(followPlan);
  assert.equal(followPlan.nearestIndex, 1);
  assert.equal(followPlan.joinPoint.xMeters, 1);
  assert.equal(followPlan.joinPoint.yMeters, 0);

  const perimeterPoints = buildPerimeterPathPointsFromPlan(points, followPlan, TEST_PARAMETERS);
  assert.deepEqual(
    perimeterPoints.map((point) => [point.xMeters, point.yMeters]),
    [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
  );
});

test("buildPerimeterFollowPlan preserves the chosen direction when rejoining after turn", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];

  const poseAfterTurn = createPose(2.1, 0.05, createInternalHeading(180), "gnss");
  const followPlan = buildPerimeterFollowPlan(points, poseAfterTurn, "reverse", TEST_PARAMETERS);

  assert.ok(followPlan);
  assert.equal(followPlan.pathDirection, "reverse");
  assert.equal(followPlan.nearestIndex, 2);

  const perimeterPoints = buildPerimeterPathPointsFromPlan(points, followPlan, TEST_PARAMETERS);
  assert.deepEqual(
    perimeterPoints.map((point) => point.xMeters),
    [2, 1, 0, 3],
  );
});

test("buildVerificationApproachTarget stops 10cm short of the perimeter point", () => {
  const pose = createPose(0, 0, createInternalHeading(0), "gnss");

  const approachTarget = buildVerificationApproachTarget(
    { xMeters: 1, yMeters: 0, capturedAt: 1 },
    pose,
  );

  assert.equal(approachTarget.xMeters, 0.9);
  assert.equal(approachTarget.yMeters, 0);
});

test("buildVerificationApproachPlan stages to the outer edge with a tangential join", () => {
  const straightPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
  ];

  const farPose = createPose(0.2, 0.4, createInternalHeading(90), "gnss");
  const farPlan = buildVerificationApproachPlan(straightPoints, farPose);
  assert.ok(farPlan);
  assert.equal(farPlan.turnOnly, false);
  assert.equal(farPlan.pathDirection, "forward");
  // Pose (0.2, 0.4) is closer to (0,0) than to any other recorded point, so
  // (0,0) is the join point. The tangent heading there points toward (1,0)
  // (i.e. 0°), so the standoff stages 10 cm before the join along that line.
  assert.equal(farPlan.joinPoint.xMeters, 0);
  assert.equal(farPlan.joinPoint.yMeters, 0);
  assert.equal(Number(farPlan.approachTarget.xMeters.toFixed(6)), -0.1);
  assert.equal(Number(farPlan.approachTarget.yMeters.toFixed(6)), 0);

  const loopPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
  ];
  // Pose (0.15, 0.05) is ~0.158m from the join point — well within the
  // default verificationTurnOnlyDistanceMeters (0.30m), so the plan is a
  // turn-only join rather than a tangent drive.
  const nearPose = createPose(0.15, 0.05, createInternalHeading(90), "gnss");
  const nearPlan = buildVerificationApproachPlan(loopPoints, nearPose);
  assert.ok(nearPlan);
  assert.equal(nearPlan.turnOnly, true);
  assert.equal(nearPlan.pathDirection, "forward");
  assert.equal(nearPlan.joinPoint.xMeters, 0);
  assert.equal(nearPlan.joinPoint.yMeters, 0);
});

test("buildVerificationApproachPlan chooses nearest point before heading alignment", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
  ];
  const pose = createPose(0.1, 0.05, createInternalHeading(90), "gnss");

  const plan = buildVerificationApproachPlan(points, pose);

  assert.ok(plan);
  assert.equal(plan.nearestIndex, 0);
  assert.equal(plan.joinPoint.xMeters, 0);
  assert.equal(plan.joinPoint.yMeters, 0);
});

test("buildVerificationPathPointsFromPlan preserves the chosen direction", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    { xMeters: 3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(2.2, 0.1, createInternalHeading(180), "gnss");
  const plan = buildVerificationApproachPlan(points, pose);
  assert.ok(plan);
  assert.equal(plan.pathDirection, "reverse");

  const verificationPoints = buildVerificationPathPointsFromPlan(points, pose, plan);
  assert.deepEqual(
    verificationPoints.map((point) => point.xMeters),
    [2, 1, 0, 3, 2],
  );
});

test("buildVerificationPathPointsFromPlan preserves the original join point even if the live pose moves near another vertex", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const planningPose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");
  const plan = buildVerificationApproachPlan(points, planningPose, TEST_PARAMETERS);
  assert.ok(plan);
  assert.equal(plan.nearestIndex, 0);

  const movedPose = createPose(0.95, 0.05, createInternalHeading(0), "gnss");
  const verificationPoints = buildVerificationPathPointsFromPlan(points, movedPose, plan, TEST_PARAMETERS);

  assert.deepEqual(
    verificationPoints.map((point) => [point.xMeters, point.yMeters]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  );
});

test("buildSegmentedBoundaryTargets fuses gentle wiggles within tolerance into a single chord", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.2, yMeters: 0.01, capturedAt: 2 },
    { xMeters: 0.4, yMeters: -0.01, capturedAt: 3 },
    { xMeters: 1, yMeters: 0, capturedAt: 4 },
  ];

  const targets = buildSegmentedBoundaryTargets(points, TEST_PARAMETERS);

  assert.deepEqual(targets.map((point) => point.yMeters), [0, 0, 0]);
  assert.deepEqual(targets.map((point) => point.xMeters), [0, 0.5, 1]);
});

test("buildSegmentedBoundaryTargets keeps a vertex whose turn exceeds the configured limit", () => {
  // 90-degree corner: simplifier must keep the corner vertex even though chord
  // tolerance alone would also keep it; this test asserts the turn-angle gate works.
  // The two 1 m straight chords are then resampled at the 0.5 m max segment length
  // so the segment drive controller has frequent re-anchor opportunities.
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
  ];

  const targets = buildSegmentedBoundaryTargets(points, TEST_PARAMETERS);

  assert.deepEqual(
    targets.map((point) => [point.xMeters, point.yMeters]),
    [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [1, 0.5],
      [1, 1],
    ],
  );
});

test("buildSegmentedBoundaryExecutionTargets resumes from the nearest target and skips the current pose", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(1.01, 0.01, createInternalHeading(0), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 0,
    segmentedDriveMaxVertexTurnDeg: 0,
    segmentedDriveMaxSegmentLengthMeters: 2,
  };

  const targets = buildSegmentedBoundaryExecutionTargets(points, parameters, pose);

  assert.deepEqual(
    targets.map((point) => [point.xMeters, point.yMeters]),
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
  );
});

test("buildSegmentedBoundaryExecutionTargets can preserve target order while still dropping points already under the mower", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.02, 0.01, createInternalHeading(0), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 0,
    segmentedDriveMaxVertexTurnDeg: 0,
    segmentedDriveMaxSegmentLengthMeters: 2,
  };

  const targets = buildSegmentedBoundaryExecutionTargets(points, parameters, pose, false);

  assert.deepEqual(
    targets.map((point) => [point.xMeters, point.yMeters]),
    [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  );
});

test("buildSegmentedBoundaryExecutionTargets can preserve the intentional first loop target at the current pose", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.01, 0.01, createInternalHeading(0), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 0,
    segmentedDriveMaxVertexTurnDeg: 0,
    segmentedDriveMaxSegmentLengthMeters: 2,
  };

  const targets = buildSegmentedBoundaryExecutionTargets(points, parameters, pose, false, true);

  assert.deepEqual(
    targets.map((point) => [point.xMeters, point.yMeters]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  );
});

test("buildSegmentedBoundaryExecutionTargets can use raw saved points without runtime simplification", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.2, yMeters: 0.05, capturedAt: 2 },
    { xMeters: 0.4, yMeters: 0.15, capturedAt: 3 },
    { xMeters: 0.6, yMeters: 0.3, capturedAt: 4 },
  ];
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 1,
    segmentedDriveMaxVertexTurnDeg: 180,
    segmentedDriveMaxSegmentLengthMeters: 10,
  };

  const targets = buildSegmentedBoundaryExecutionTargets(points, parameters, undefined, true, false, true);

  assert.deepEqual(
    targets.map((point) => [point.xMeters, point.yMeters]),
    points.map((point) => [point.xMeters, point.yMeters]),
  );
});

test("selectSegmentedBoundaryTargetIndex advances past tiny overshoot points instead of turning back inward", () => {
  const points = [
    { xMeters: 6.3312, yMeters: 12.8272, capturedAt: 1 },
    { xMeters: 6.4161, yMeters: 12.8837, capturedAt: 2 },
    { xMeters: 6.5200, yMeters: 12.9500, capturedAt: 3 },
    { xMeters: 6.6400, yMeters: 13.0300, capturedAt: 4 },
  ];
  const pose = createPose(6.4586, 12.8936, createInternalHeading(120.6), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 0,
    segmentedDriveMaxVertexTurnDeg: 0,
    segmentedDriveMaxSegmentLengthMeters: 0.5,
    segmentedDriveMinSegmentLengthMeters: 0.05,
  };

  const nextTargetIndex = advancePassedTargets(points, pose, 0, parameters);
  const targetIndex = selectSegmentedBoundaryTargetIndex(points, nextTargetIndex, parameters);

  assert.equal(targetIndex >= 2, true);
});

test("selectSegmentedBoundaryTargetIndex keeps short forward progress when still before the next target", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.2, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.3, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(0.02, 0.01, createInternalHeading(0), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveSimplificationToleranceMeters: 0,
    segmentedDriveMaxVertexTurnDeg: 0,
    segmentedDriveMaxSegmentLengthMeters: 0.5,
    segmentedDriveMinSegmentLengthMeters: 0.05,
  };

  const nextTargetIndex = advancePassedTargets(points, pose, 0, parameters);
  const targetIndex = selectSegmentedBoundaryTargetIndex(points, nextTargetIndex, parameters);

  assert.equal(targetIndex >= 2, true);
});

test("selectSegmentedBoundaryTargetIndex can be forced to use the exact next target", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.2, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.3, yMeters: 0, capturedAt: 4 },
  ];

  const targetIndex = selectSegmentedBoundaryTargetIndex(points, 1, TEST_PARAMETERS, true);

  assert.equal(targetIndex, 1);
});

test("advancePassedTargets does not treat the starting join point as already completed when preserved", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const startPose = createPose(0.01, 0.01, createInternalHeading(0), "gnss");

  const nextTargetIndex = advancePassedTargets(points, startPose, 0, TEST_PARAMETERS, true);

  assert.equal(nextTargetIndex, 0);
});

test("advancePassedTargets marks the loop complete only after returning to the join point", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const endPose = createPose(0.02, 0.02, createInternalHeading(180), "gnss");
  const parameters = {
    ...TEST_PARAMETERS,
    segmentedDriveMinSegmentLengthMeters: 0.05,
  };

  const nextTargetIndex = advancePassedTargets(points, endPose, points.length - 1, parameters);

  assert.equal(nextTargetIndex, points.length);
});

test("advancePassedTargets can advance past a preserved closed-loop join point once motion progresses down the first segment", () => {
  const points = [
    { xMeters: 1, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 1, capturedAt: 2 },
    { xMeters: 0, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 0, capturedAt: 4 },
    { xMeters: 1, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(1, 0.2, createInternalHeading(90), "gnss");

  const nextTargetIndex = advancePassedTargets(
    points,
    pose,
    0,
    TEST_PARAMETERS,
    false,
    true,
  );

  assert.equal(nextTargetIndex, 1);
});
