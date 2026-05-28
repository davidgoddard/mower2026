import test from "node:test";
import assert from "node:assert/strict";
import { PurePursuitFollower } from "../dist/pathfollowing/purePursuitFollower.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createFollower() {
  return new PurePursuitFollower(
    {
      targetSpeed: 0.6,
      wheelBase: 0.35,
      controlRateHz: 15,
      arrivalThreshold: 0.12,
      logger: createLogger(),
    },
    {
      pathStore: {
        async loadPath() {
          throw new Error("not_used");
        },
      },
      motorController: {
        async setWheelSpeeds() {},
        async stop() {},
      },
      getCurrentPose() {
        return createPose(0, 0, createInternalHeading(0), "gnss");
      },
      getCurrentSpeed() {
        return 0;
      },
    },
  );
}

test("uses configured pure pursuit lookahead limits", () => {
  const follower = new PurePursuitFollower(
    {
      targetSpeed: 0.6,
      wheelBase: 0.35,
      controlRateHz: 15,
      arrivalThreshold: 0.12,
      minLookaheadMeters: 0.4,
      baseLookaheadMeters: 0.9,
      maxLookaheadMeters: 1.8,
      logger: createLogger(),
    },
    {
      pathStore: {
        async loadPath() {
          throw new Error("not_used");
        },
      },
      motorController: {
        async setWheelSpeeds() {},
        async stop() {},
      },
      getCurrentPose() {
        return createPose(0, 0, createInternalHeading(0), "gnss");
      },
      getCurrentSpeed() {
        return 0;
      },
    },
  );

  assert.equal(follower.minLookahead, 0.4);
  assert.equal(follower.baseLookahead, 0.9);
  assert.equal(follower.maxLookahead, 1.8);
});

test("uses in-place turns instead of one-wheel pivots for tight pure pursuit curvature", () => {
  const follower = createFollower();

  const wheelSpeeds = follower.calculateWheelSpeeds(10);

  assert.equal(wheelSpeeds.left < 0, true);
  assert.equal(wheelSpeeds.right > 0, true);
  assert.equal(Math.abs(wheelSpeeds.left) >= follower.minActiveWheelSpeed, true);
  assert.equal(Math.abs(wheelSpeeds.right) >= follower.minActiveWheelSpeed, true);
});

test("keeps both pure pursuit wheels at the minimum active speed or higher", () => {
  const follower = new PurePursuitFollower(
    {
      targetSpeed: 0.1,
      wheelBase: 0.35,
      controlRateHz: 15,
      arrivalThreshold: 0.12,
      logger: createLogger(),
    },
    {
      pathStore: {
        async loadPath() {
          throw new Error("not_used");
        },
      },
      motorController: {
        async setWheelSpeeds() {},
        async stop() {},
      },
      getCurrentPose() {
        return createPose(0, 0, createInternalHeading(0), "gnss");
      },
      getCurrentSpeed() {
        return 0;
      },
    },
  );

  const straightSpeeds = follower.calculateWheelSpeeds(0);

  assert.equal(straightSpeeds.left, follower.minActiveWheelSpeed);
  assert.equal(straightSpeeds.right, follower.minActiveWheelSpeed);
});

test("does not declare path completion before reaching the final segment", () => {
  const follower = createFollower();
  const pose = createPose(0.05, 0, createInternalHeading(0), "gnss");
  const path = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.04, yMeters: 0, capturedAt: 3 },
  ];

  follower.currentWaypointIndex = 0;
  follower.hasBeenAwayFromFinalPoint = true;
  follower.passedWaypointIndexes = new Set([0, 2]);

  assert.equal(follower.hasReachedEnd(pose, path, true), false);

  follower.currentWaypointIndex = path.length - 1;
  assert.equal(follower.hasReachedEnd(pose, path, true), false);

  follower.passedWaypointIndexes = new Set([0, 1, 2]);
  assert.equal(follower.hasReachedEnd(pose, path, true), true);
});

test("keeps waypoint progress near a duplicated loop join point", () => {
  const follower = createFollower();
  const pose = createPose(0.03, 0, createInternalHeading(0), "gnss");
  const path = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  assert.equal(follower.findClosestWaypointIndex(pose, path), 0);
  assert.equal(follower.findClosestWaypointIndex(pose, path, 3), 4);

  follower.currentWaypointIndex = 4;
  follower.hasBeenAwayFromFinalPoint = true;
  follower.passedWaypointIndexes = new Set([0, 1, 2, 3, 4]);

  assert.equal(follower.hasReachedEnd(pose, path, true), true);
});
