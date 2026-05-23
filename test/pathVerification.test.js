import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDrivePathPoints,
  buildVerificationPathPoints,
  findNearestPathPointIndex,
} from "../dist/pathfollowing/pathVerification.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";

test("buildVerificationPathPoints rotates the path from the nearest point and closes the loop", () => {
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
    [2, 3, 0, 1, 2],
  );
  assert.deepEqual(
    verificationPoints.map((point) => point.yMeters),
    [0, 0, 0, 0, 0],
  );
});

test("buildVerificationPathPoints drops a duplicated closed-loop endpoint before rotating", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 0, capturedAt: 4 },
  ];
  const pose = createPose(1.1, 0.2, createInternalHeading(0), "gnss");

  const verificationPoints = buildVerificationPathPoints(points, pose);
  assert.deepEqual(
    verificationPoints.map((point) => point.xMeters),
    [1, 1, 0, 1],
  );
  assert.deepEqual(
    verificationPoints.map((point) => point.yMeters),
    [0, 1, 0, 0],
  );
});


test("buildDrivePathPoints rotates the path from the nearest point without closing the loop", () => {
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
    [2, 3, 0, 1],
  );
  assert.deepEqual(
    drivePoints.map((point) => point.yMeters),
    [0, 0, 0, 0],
  );
});
