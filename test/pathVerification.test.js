import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationApproachPlan,
  buildVerificationApproachTarget,
  buildDrivePathPoints,
  buildDrivePathPointsForDirection,
  buildVerificationPathPoints,
  buildVerificationPathPointsFromPlan,
  findNearestPathPointIndex,
} from "../dist/pathfollowing/pathVerification.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";

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

test("buildVerificationPathPoints drops a duplicated closed-loop endpoint and expands the loop outward", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(1.1, 0.2, createInternalHeading(0), "gnss");

  const verificationPoints = buildVerificationPathPoints(points, pose);
  assert.equal(verificationPoints.length, 7);
  assert.equal(verificationPoints.at(0)?.xMeters, verificationPoints.at(-1)?.xMeters);
  assert.equal(verificationPoints.at(0)?.yMeters, verificationPoints.at(-1)?.yMeters);
  assert.equal(verificationPoints.some((point) => point.xMeters > 1.05), true);
  assert.equal(verificationPoints.some((point) => point.yMeters > 1.05), true);
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

test("buildDrivePathPoints offsets closed obstacle loops outward", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");

  const drivePoints = buildDrivePathPointsForDirection(points, pose, "forward");

  assert.equal(drivePoints.length, 8);
  assert.equal(drivePoints.some((point) => point.yMeters < -0.05), true);
  assert.equal(drivePoints.some((point) => point.xMeters > 1.05), true);
  assert.equal(drivePoints.some((point) => point.yMeters > 1.05), true);
  assert.equal(drivePoints.some((point) => point.xMeters < -0.05), true);
});

test("buildDrivePathPoints uses supplied obstacle outward offset", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const pose = createPose(0.1, -0.2, createInternalHeading(0), "gnss");

  const drivePoints = buildDrivePathPointsForDirection(points, pose, "forward", {
    version: 1,
    closedLoopToleranceMeters: 0.05,
    closedLoopDetectionToleranceMeters: 0.35,
    verificationApproachStandoffMeters: 0.1,
    verificationTurnOnlyDistanceMeters: 0.3,
    obstacleOutwardOffsetMeters: 0.2,
    updatedAt: "test",
  });

  assert.equal(drivePoints.some((point) => point.yMeters < -0.15), true);
  assert.equal(drivePoints.every((point) => point.yMeters >= -0.25), true);
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
  assert.equal(farPlan.joinPoint.xMeters, 1);
  assert.equal(farPlan.joinPoint.yMeters, 0);
  assert.equal(farPlan.approachTarget.xMeters, 0.9);
  assert.equal(farPlan.approachTarget.yMeters, 0);

  const loopPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
  ];
  const nearPose = createPose(0.15, 0.05, createInternalHeading(90), "gnss");
  const nearPlan = buildVerificationApproachPlan(loopPoints, nearPose);
  assert.ok(nearPlan);
  assert.equal(nearPlan.turnOnly, false);
  assert.equal(nearPlan.pathDirection, "forward");
  assert.equal(nearPlan.joinPoint.xMeters, 1);
  assert.equal(nearPlan.joinPoint.yMeters, 0);
  assert.equal(nearPlan.approachTarget.xMeters, 1);
  assert.equal(nearPlan.approachTarget.yMeters, -0.1);
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
