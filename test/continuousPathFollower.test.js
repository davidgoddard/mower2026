import test from "node:test";
import assert from "node:assert/strict";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import {
  buildCommittedCornerCaptureTarget,
  capContinuousWheelCommands,
  computeContinuousPathBaseSpeed,
  computeFittedArcWheelCommands,
  computeContinuousPathWheelCommands,
  ContinuousPathFollower,
  limitContinuousWheelCommandChange,
  selectContinuousLookaheadTargetIndex,
} from "../dist/pathfollowing/continuousPathFollower.js";

test("fitted arc control commands one continuous curvature without pivoting", () => {
  const arc = {
    kind: "arc",
    startIndex: 0,
    endIndex: 9,
    executionStartIndex: 0,
    executionEndIndex: 9,
    maxDeviationMeters: 0.01,
    centerX: 0,
    centerY: 0,
    radiusMeters: 2,
    direction: 1,
  };
  const onArc = computeFittedArcWheelCommands(
    createPose(2, 0, createInternalHeading(90), "gnss"),
    arc,
    0.75,
    0.6,
  );
  const outsideArc = computeFittedArcWheelCommands(
    createPose(2.1, 0, createInternalHeading(90), "gnss"),
    arc,
    0.75,
    0.6,
  );

  assert.equal(onArc.pivoting, false);
  assert.equal(onArc.left > 0 && onArc.right > 0, true);
  assert.equal(onArc.left < onArc.right, true);
  assert.equal(outsideArc.left < onArc.left, true);
  assert.equal(outsideArc.right > onArc.right, true);
});

test("continuous follower locks one recovery segment through pivot and capture", async () => {
  const poses = [
    createPose(0, 0, createInternalHeading(180), "gnss"),
    createPose(0, 0, createInternalHeading(180), "gnss"),
    createPose(0, 0, createInternalHeading(0), "gnss"),
    createPose(0.5, 0, createInternalHeading(0), "gnss"),
    createPose(2, 0, createInternalHeading(0), "gnss"),
  ];
  let poseIndex = 0;
  const commands = [];
  const events = [];
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => poses[Math.min(poseIndex++, poses.length - 1)],
    },
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
    baseSpeed: 0.65,
  });

  const result = await follower.executePath([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 0, capturedAt: 3 },
  ], {
    loopPath: false,
    strictOrderedProgress: true,
    initialTargetIndex: 1,
    pivotIfInnerWheelBelow: 0.25,
    minimumSpeed: 0.65,
    maximumSpeed: 0.65,
  });

  assert.equal(result.completed, true);
  assert.deepEqual(events.map((event) => event.message), [
    "continuous_path.recovery_align_started",
    "continuous_path.recovery_capture_started",
    "continuous_path.recovery_capture_completed",
  ]);
  const pivotCommands = commands.filter(({ left, right }) => left * right < 0);
  assert.equal(pivotCommands.length > 0, true);
  assert.equal(pivotCommands.every(({ left, right }) => Math.sign(left) === -Math.sign(right)), true);
  assert.equal(new Set(pivotCommands.map(({ left }) => Math.sign(left))).size, 1);
});

test("continuous follower completes a perimeter near its final target without entering final recovery", async () => {
  const commands = [];
  const events = [];
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => createPose(0.12, 0.08, createInternalHeading(180), "gnss"),
    },
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
    pivotIfInnerWheelBelow: 0.4,
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

test("computeContinuousPathWheelCommands stays in pivot mode until heading error is substantially reduced", () => {
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
    true,
  );

  assert.equal(commands.pivoting, true);
  assert.equal(commands.left < 0 || commands.right < 0, true);
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


test("limitContinuousWheelCommandChange slews abrupt speed changes", () => {
  assert.equal(Math.abs(limitContinuousWheelCommandChange(0.8, 0.2, 0.1) - 0.7) < 1e-9, true);
  assert.equal(Math.abs(limitContinuousWheelCommandChange(-0.4, 0.4, 0.1) + 0.3) < 1e-9, true);
  assert.equal(limitContinuousWheelCommandChange(0.5, 0.55, 0.1), 0.55);
});

test("tight-arc pivot uses an exit margin to avoid pivot and arc chatter", () => {
  const pose = createPose(0.9, 0, createInternalHeading(0), "gnss");
  const previousPoint = { xMeters: 0, yMeters: 0, capturedAt: 1 };
  const currentTarget = { xMeters: 1, yMeters: 0, capturedAt: 2 };
  const lookaheadTarget = { xMeters: 1.966, yMeters: 0.259, capturedAt: 3 };
  const options = { minimumSpeed: 0.6, pivotIfInnerWheelBelow: 0.3 };

  const entering = computeContinuousPathWheelCommands(
    pose, previousPoint, currentTarget, lookaheadTarget, 0.75, false, options,
  );
  const staying = computeContinuousPathWheelCommands(
    pose, previousPoint, currentTarget, lookaheadTarget, 0.75, true, options,
  );

  assert.equal(entering.pivoting, false);
  assert.equal(staying.pivoting, true);
});
