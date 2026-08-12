import test from "node:test";
import assert from "node:assert/strict";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import {
  buildCommittedCornerCaptureTarget,
  capContinuousWheelCommands,
  computeContinuousPathBaseSpeed,
  computeContinuousPathWheelCommands,
  ContinuousPathFollower,
  limitContinuousWheelCommandChange,
  selectContinuousLookaheadTargetIndex,
} from "../dist/pathfollowing/continuousPathFollower.js";

test("continuous follower aligns excessive entry misalignment once without a fallback drive", async () => {
  let pose = createPose(0, 0, createInternalHeading(180), "gnss");
  let driveCalls = 0;
  let turnCalls = 0;
  const commands = [];
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => pose,
    },
    driveController: {
      executeDrive: async () => {
        driveCalls += 1;
        return { status: "success" };
      },
    },
    turnController: {
      executeTurn: async () => {
        turnCalls += 1;
        pose = createPose(0, 0, createInternalHeading(0), "gnss");
        return { status: "success" };
      },
    },
    sensorController: {
      beginMotionSession: () => {},
      endMotionSession: () => {},
      setMotorWheelOutputs: async (left, right) => {
        commands.push({ left, right });
        pose = createPose(1, 0, createInternalHeading(0), "gnss");
      },
      requestNeutralMotorOutputs: async () => {},
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    sleep: async () => {},
    baseSpeed: 0.65,
  });

  const result = await follower.executePath([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ], {
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 1,
    minimumSpeed: 0.65,
    maximumSpeed: 0.65,
  });

  assert.equal(result.completed, true);
  assert.equal(driveCalls, 0);
  assert.equal(turnCalls, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].left >= 0 && commands[0].right >= 0, true);
});

test("continuous follower delegates one genuine waypoint corner through the drive controller", async () => {
  let pose = createPose(0.86, 0, createInternalHeading(0), "gnss");
  const driveRequests = [];
  const follower = new ContinuousPathFollower({
    poseFusion: { getCurrentPose: () => pose },
    driveController: {
      executeDrive: async (request) => {
        driveRequests.push(request);
        pose = createPose(1, 0.4, createInternalHeading(90), "gnss");
        return { status: "success" };
      },
    },
    turnController: { executeTurn: async () => ({ status: "success" }) },
    sensorController: {
      beginMotionSession: () => {},
      endMotionSession: () => {},
      setMotorWheelOutputs: async () => {},
      requestNeutralMotorOutputs: async () => {},
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    sleep: async () => {},
  });

  const result = await follower.executePath([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
  ], {
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 1,
    pivotAtWaypointTurnDeg: 20,
    pivotAtWaypointDistanceMeters: 0.15,
    completionToleranceMeters: 0.7,
  });

  assert.equal(result.completed, true);
  assert.equal(driveRequests.length, 1);
  assert.equal(driveRequests[0].targetPosition.xMeters, 1);
  assert.equal(driveRequests[0].targetPosition.yMeters, 0.4);
  assert.equal(driveRequests[0].alwaysTurnToFaceTarget, true);
});

test("continuous follower refuses recovery motion from materially outside the route", async () => {
  let driveCalls = 0;
  let neutralCalls = 0;
  let motionSessionEnded = false;
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => createPose(0, 0.8, createInternalHeading(180), "gnss"),
    },
    driveController: {
      executeDrive: async () => {
        driveCalls += 1;
        return { status: "success" };
      },
    },
    turnController: { executeTurn: async () => ({ status: "success" }) },
    sensorController: {
      beginMotionSession: () => {},
      endMotionSession: () => { motionSessionEnded = true; },
      setMotorWheelOutputs: async () => {},
      requestNeutralMotorOutputs: async () => { neutralCalls += 1; },
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    sleep: async () => {},
  });

  const result = await follower.executePath([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ], {
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 1,
  });

  assert.equal(result.completed, false);
  assert.equal(result.error, "continuous_path_pose_too_far_from_route");
  assert.equal(driveCalls, 0);
  assert.equal(neutralCalls, 1);
  assert.equal(motionSessionEnded, true);
});

test("continuous follower does not abort for one route-deviation sample just over the limit", async () => {
  let pose = createPose(0, 0.253, createInternalHeading(0), "gnss");
  let driveCalls = 0;
  const follower = new ContinuousPathFollower({
    poseFusion: { getCurrentPose: () => pose },
    driveController: {
      executeDrive: async () => {
        driveCalls += 1;
        return { status: "success" };
      },
    },
    turnController: { executeTurn: async () => ({ status: "success" }) },
    sensorController: {
      beginMotionSession: () => {},
      endMotionSession: () => {},
      setMotorWheelOutputs: async () => {
        pose = createPose(1, 0, createInternalHeading(0), "gnss");
      },
      requestNeutralMotorOutputs: async () => {},
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    sleep: async () => {},
  });

  const result = await follower.executePath([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ], {
    parameters: TEST_PARAMETERS,
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 1,
  });

  assert.equal(result.completed, true);
  assert.equal(driveCalls, 0);
});

test("continuous follower completes a perimeter near its final target without entering final recovery", async () => {
  const commands = [];
  const events = [];
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => createPose(0.12, 0.08, createInternalHeading(180), "gnss"),
    },
    driveController: { executeDrive: async () => ({ status: "success" }) },
    turnController: { executeTurn: async () => ({ status: "success" }) },
    sensorController: {
      beginMotionSession: () => {},
      endMotionSession: () => {},
      setMotorWheelOutputs: async (left, right) => commands.push({ left, right }),
      requestNeutralMotorOutputs: async () => {},
    },
    logger: {
      info: (message, data) => events.push({ message, data }),
      debug: () => {},
    },
    sleep: async () => {},
  });

  const result = await follower.executePath([
    { xMeters: 1, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 1, capturedAt: 2 },
    { xMeters: 0, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 0, capturedAt: 4 },
  ], {
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 3,
    completionToleranceMeters: 0.35,
  });

  assert.equal(result.completed, true);
  assert.equal(commands.length, 0);
  assert.equal(events.some(({ message }) => message === "continuous_path.completion_proximity_reached"), true);
  assert.equal(events.some(({ message }) => message === "continuous_path.recovery_align_started"), false);
});

test("buildCommittedCornerCaptureTarget locks capture to the outgoing edge", () => {
  const target = buildCommittedCornerCaptureTarget(
    { xMeters: 1, yMeters: 1, capturedAt: 1 },
    { xMeters: 1, yMeters: 2, capturedAt: 2 },
  );

  assert.equal(target.xMeters, 1);
  assert.equal(target.yMeters, 1.4);
});

test("capContinuousWheelCommands preserves curvature while limiting the peak wheel output", () => {
  const capped = capContinuousWheelCommands({ left: 0.4, right: 1, pivoting: false }, 0.65);

  assert.equal(capped.right, 0.65);
  assert.equal(Math.abs(capped.left - 0.26) < 1e-9, true);
  assert.equal(capped.pivoting, false);
});

const TEST_PARAMETERS = {
  version: 4,
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
  continuousPathMinimumLookaheadMeters: 0.25,
  continuousPathMaximumLookaheadMeters: 1,
  continuousPathMaximumChordDeviationMeters: 0.05,
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

test("selectContinuousLookaheadTargetIndex does not look across a meaningful corner", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.2, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.2, yMeters: 0.2, capturedAt: 4 },
  ];

  assert.equal(selectContinuousLookaheadTargetIndex(points, 0, TEST_PARAMETERS), 2);
});

test("selectContinuousLookaheadTargetIndex keeps lookahead across gentle curve points", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.2, yMeters: 0.015, capturedAt: 3 },
    { xMeters: 0.3, yMeters: 0.045, capturedAt: 4 },
    { xMeters: 0.4, yMeters: 0.09, capturedAt: 5 },
  ];

  assert.equal(selectContinuousLookaheadTargetIndex(points, 0, TEST_PARAMETERS) > 2, true);
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

test("computeContinuousPathWheelCommands uses a forward one-wheel arc when heading error is extreme", () => {
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

  assert.equal(commands.left >= 0 && commands.right >= 0, true);
  assert.equal(commands.pivoting, false);
  assert.equal(Math.min(commands.left, commands.right), 0);
});

test("computeContinuousPathWheelCommands does not independently pivot for accumulated lookahead curvature", () => {
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
    {
      minimumSpeed: 0.6,
    },
  );

  assert.equal(commands.left >= 0 && commands.right >= 0, true);
  assert.equal(commands.pivoting, false);
});

test("computeContinuousPathWheelCommands allows the inner wheel below mowing speed while preserving at least the requested outer-wheel speed", () => {
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
    {
      minimumSpeed: 0.6,
    },
  );

  assert.equal(commands.left >= 0 && commands.right >= 0, true);
  assert.equal(commands.pivoting, false);
  assert.equal(Math.max(commands.left, commands.right) >= 0.75, true);
  assert.equal(Math.min(commands.left, commands.right) < 0.45, true);
});

test("computeContinuousPathWheelCommands treats a coincident protected-corner lookahead as incoming guidance", () => {
  const commands = computeContinuousPathWheelCommands(
    createPose(0.8, 0, createInternalHeading(0), "gnss"),
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 0, capturedAt: 3 },
    1,
    {
      minimumSpeed: 1,
    },
  );

  assert.equal(commands.pivoting, false);
  assert.equal(commands.left > 0, true);
  assert.equal(commands.right > 0, true);
});

test("computeContinuousPathWheelCommands always leaves pivot ownership outside continuous steering", () => {
  const pose = createPose(0, 0, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: 0.766, yMeters: 0.643, capturedAt: 3 };

  const commands = computeContinuousPathWheelCommands(
    pose,
    previousPoint,
    currentTarget,
    lookaheadTarget,
    0.75,
  );

  assert.equal(commands.pivoting, false);
  assert.equal(commands.left >= 0 && commands.right >= 0, true);
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

test("continuous forward steering preserves the requested peak wheel output", () => {
  const commands = computeContinuousPathWheelCommands(
    createPose(0, 0.08, createInternalHeading(0), "gnss"),
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
    1,
  );

  assert.equal(commands.pivoting, false);
  assert.equal(Math.abs(Math.max(commands.left, commands.right) - 1) < 1e-9, true);
});

test("continuous steering uses the learned CTE gain supplied by straight driving", () => {
  const pose = createPose(0, 0.08, createInternalHeading(0), "gnss");
  const pathStart = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const pathTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookahead = { xMeters: 2, yMeters: 0, capturedAt: 3 };
  const gentle = computeContinuousPathWheelCommands(
    pose, pathStart, pathTarget, lookahead, 1, { cteGain: 0.2, headingGain: 0 },
  );
  const learned = computeContinuousPathWheelCommands(
    pose, pathStart, pathTarget, lookahead, 1, { cteGain: 1.2, headingGain: 0 },
  );

  assert.equal(Math.abs(learned.left - learned.right) > Math.abs(gentle.left - gentle.right), true);
});


test("limitContinuousWheelCommandChange slews abrupt speed changes", () => {
  assert.equal(Math.abs(limitContinuousWheelCommandChange(0.8, 0.2, 1, 0.1) - 0.7) < 1e-9, true);
  assert.equal(Math.abs(limitContinuousWheelCommandChange(-0.4, 0.4, 1, 0.1) + 0.3) < 1e-9, true);
  assert.equal(limitContinuousWheelCommandChange(0.5, 0.55, 1, 0.1), 0.55);
});
