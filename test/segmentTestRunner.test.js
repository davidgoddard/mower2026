import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { SegmentTestRunner } from "../dist/control/segmentTestRunner.js";
import { createInternalHeading, unwrapRelativeAngle } from "../dist/geometry/headingTypes.js";
import { createPose, createPosition, createMeters, unwrapMeters } from "../dist/geometry/positionTypes.js";

function createMockLogger() {
  const logger = {
    child: null,
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
  };
  logger.child = mock.fn(() => logger);
  return logger;
}

test("SegmentTestRunner collects waypoints, drives home first, then tests random non-nearest waypoints", async () => {
  const logger = createMockLogger();
  const sensorController = {
    beginMotorOperation: mock.fn(() => {}),
    endMotorOperation: mock.fn(async () => {}),
    setMotorWheelOutputs: mock.fn(async () => {}),
    stopMotors: mock.fn(async () => {}),
  };

  const driveController = {
      executeDrive: mock.fn(async (request) => ({
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.12),
        errorY: createMeters(0.03),
        maxCteMeters: createMeters(0.05),
        avgCteMeters: createMeters(0.02),
      durationMs: 500,
      brakeDistanceUsed: createMeters(0.15),
      status: "success",
      timestamp: new Date().toISOString(),
    })),
    stopCurrentDrive: mock.fn(async () => {}),
  };

  const poses = [
    createPose(0, 0, createInternalHeading(0), "gnss"),
    createPose(1, 0, createInternalHeading(0), "gnss"),
    createPose(2, 0, createInternalHeading(0), "gnss"),
    createPose(3, 0, createInternalHeading(0), "gnss"),
    createPose(4, 0, createInternalHeading(0), "gnss"),
    createPose(5, 0, createInternalHeading(0), "gnss"),
    createPose(6, 0, createInternalHeading(0), "gnss"),
    createPose(6, 0, createInternalHeading(0), "gnss"),
    createPose(0, 0, createInternalHeading(0), "gnss"),
    createPose(0, 0, createInternalHeading(0), "gnss"),
    createPose(4, 0, createInternalHeading(0), "gnss"),
  ];
  let poseIndex = 0;
  const poseProvider = mock.fn(() => poses[Math.min(poseIndex++, poses.length - 1)]);

  const runner = new SegmentTestRunner({
    driveController,
    sensorController,
    poseProvider,
    logger,
    random: () => 0.5,
    collectDriveMs: 0,
    sleep: async () => {},
  });

  const results = await runner.run({ waypointCount: 7, testRunCount: 1 });

  assert.equal(results.length, 2);
  assert.equal(runner.getHistory().length, 2);
  assert.equal(sensorController.beginMotorOperation.mock.calls.length, 1);
  assert.equal(sensorController.endMotorOperation.mock.calls.length, 1);
  assert.equal(sensorController.setMotorWheelOutputs.mock.calls.length, 6);
  assert.equal(sensorController.stopMotors.mock.calls.length, 6);
  assert.equal(driveController.executeDrive.mock.calls.length, 2);
  assert.equal(poseProvider.mock.calls.length, 11);

  assert.equal(results[0].phase, "home");
  assert.equal(results[0].waypointLabel, "first waypoint");
  assert.equal(results[0].waypointIndex, 1);
  assert.equal(results[0].distanceToWaypointMeters, 6);
  assert.equal(Math.abs(results[0].requiredHeadingChangeDeg), 180);
  assert.equal(results[0].achievedHeadingChangeDeg, 0);
  assert.equal(results[0].driveStatus, "success");
  assert.equal(results[0].cteMeters, 0.02);
  assert.equal(results[0].maxCteMeters, 0.05);
  assert.equal(results[0].xErrorMeters, 0.12);
  assert.equal(results[0].yErrorMeters, 0.03);

  assert.equal(results[1].phase, "random");
  assert.equal(results[1].waypointIndex, 5);
  assert.equal(results[1].waypointLabel, "waypoint 5");
  assert.equal(results[1].distanceToWaypointMeters, 4);
  assert.equal(unwrapRelativeAngle(results[1].requiredHeadingChangeDeg), 0);
  assert.equal(results[1].achievedHeadingChangeDeg, 0);
  assert.equal(results[1].driveStatus, "success");

  assert.equal(unwrapMeters(driveController.executeDrive.mock.calls[0].arguments[0].targetPosition.xMeters), 0);
  assert.equal(unwrapMeters(driveController.executeDrive.mock.calls[1].arguments[0].targetPosition.xMeters), 4);

  const state = runner.getState();
  assert.equal(state.running, false);
  assert.equal(state.phase, "completed");
  assert.equal(state.collectedWaypoints, 7);
  assert.equal(state.totalWaypoints, 7);
  assert.equal(state.completedRuns, 2);
  assert.equal(state.totalRuns, 2);
  assert.equal(state.currentTargetLabel, "waypoint 5");
});

test("SegmentTestRunner waits for the collection settle period before sampling the next waypoint", async () => {
  const logger = createMockLogger();
  const sensorController = {
    beginMotorOperation: mock.fn(() => {}),
    endMotorOperation: mock.fn(async () => {}),
    setMotorWheelOutputs: mock.fn(async () => {}),
    stopMotors: mock.fn(async () => {}),
  };

  const driveController = {
      executeDrive: mock.fn(async () => ({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0, 0),
        finalPosition: createPosition(0, 0),
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
      durationMs: 0,
      brakeDistanceUsed: createMeters(0),
      status: "success",
      timestamp: new Date().toISOString(),
    })),
    stopCurrentDrive: mock.fn(async () => {}),
  };

  const poses = [
    createPose(0, 0, createInternalHeading(0), "gnss"),
    createPose(1, 0, createInternalHeading(0), "gnss"),
    createPose(2, 0, createInternalHeading(0), "gnss"),
  ];
  let poseIndex = 0;
  const poseProvider = mock.fn(() => poses[Math.min(poseIndex++, poses.length - 1)]);

  const sleepDelays = [];
  const runner = new SegmentTestRunner({
    driveController,
    sensorController,
    poseProvider,
    logger,
    random: () => 0.5,
    collectDriveMs: 1,
    collectSettleMs: 2,
    sleep: async (delayMs) => {
      sleepDelays.push(delayMs);
    },
  });

  const results = await runner.run({ waypointCount: 3, testRunCount: 0 });

  assert.equal(results.length, 1);
  assert.deepEqual(sleepDelays, [1, 2, 1, 2]);
  assert.equal(sensorController.setMotorWheelOutputs.mock.calls.length, 2);
  assert.equal(sensorController.stopMotors.mock.calls.length, 2);
  assert.equal(poseProvider.mock.calls.length, 5);
  assert.equal(runner.getState().phase, "completed");
});
