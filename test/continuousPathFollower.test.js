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
  isFittedArcCaptured,
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
  assert.equal(Math.abs(onArc.right - 0.75) < 1e-9, true);
  assert.equal(Math.abs(outsideArc.right - 0.75) < 1e-9, true);
  assert.equal((outsideArc.left / outsideArc.right) < (onArc.left / onArc.right), true);
});

test("2.12 metre fitted arc preserves curvature with the faster wheel at full output", () => {
  const radiusMeters = 2.12;
  const wheelbaseMeters = 0.55;
  const commands = computeFittedArcWheelCommands(
    createPose(radiusMeters, 0, createInternalHeading(90), "gnss"),
    {
      kind: "arc",
      startIndex: 0,
      endIndex: 20,
      executionStartIndex: 0,
      executionEndIndex: 20,
      maxDeviationMeters: 0.01,
      centerX: 0,
      centerY: 0,
      radiusMeters,
      direction: 1,
    },
    1,
    wheelbaseMeters,
  );
  const expectedInnerOuterRatio = (radiusMeters - (wheelbaseMeters / 2))
    / (radiusMeters + (wheelbaseMeters / 2));

  assert.equal(commands.pivoting, false);
  assert.equal(Math.abs(commands.right - 1) < 1e-9, true);
  assert.equal(Math.abs((commands.left / commands.right) - expectedInnerOuterRatio) < 1e-9, true);
});

test("fitted arcs require radial and tangent capture before committed forward control", () => {
  const arc = {
    kind: "arc",
    startIndex: 0,
    endIndex: 3,
    executionStartIndex: 0,
    executionEndIndex: 3,
    maxDeviationMeters: 0.01,
    centerX: 0,
    centerY: 0,
    radiusMeters: 2,
    direction: 1,
  };

  assert.equal(isFittedArcCaptured(createPose(2, 0, createInternalHeading(90), "gnss"), arc), true);
  assert.equal(isFittedArcCaptured(createPose(2.3, 0, createInternalHeading(90), "gnss"), arc), false);
  assert.equal(isFittedArcCaptured(createPose(2, 0, createInternalHeading(20), "gnss"), arc), false);
});

test("continuous follower keeps one dense fitted arc engaged despite ordinary tracking error", async () => {
  const radiusMeters = 2.12;
  const anglesDeg = [0, 10, 20, 30, 40, 50, 60];
  const points = anglesDeg.map((angleDeg, index) => {
    const angle = angleDeg * (Math.PI / 180);
    return {
      xMeters: Math.cos(angle) * radiusMeters,
      yMeters: Math.sin(angle) * radiusMeters,
      capturedAt: index + 1,
    };
  });
  const poses = anglesDeg.map((angleDeg, index) => {
    const angle = angleDeg * (Math.PI / 180);
    const radialOffset = index >= 2 && index < anglesDeg.length - 1 ? 0.12 : 0;
    return createPose(
      Math.cos(angle) * (radiusMeters + radialOffset),
      Math.sin(angle) * (radiusMeters + radialOffset),
      createInternalHeading(angleDeg + 90),
      "gnss",
    );
  });
  let poseIndex = 0;
  let cycles = 0;
  const commands = [];
  const events = [];
  const follower = new ContinuousPathFollower({
    poseFusion: {
      getCurrentPose: () => poses[Math.min(poseIndex, poses.length - 1)],
      getWheelbaseMeters: () => 0.55,
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
    sleep: async () => {
      poseIndex = Math.min(poseIndex + 1, poses.length - 1);
      cycles += 1;
      if (cycles > 20) {
        throw new Error("dense arc did not complete");
      }
    },
    baseSpeed: 1,
  });

  const result = await follower.executePath(points, {
    loopPath: false,
    strictOrderedProgress: true,
    preserveFirstTargetAtPose: true,
    completionToleranceMeters: 0.2,
    minimumSpeed: 1,
    maximumSpeed: 1,
    fittedPrimitives: [{
      kind: "arc",
      startIndex: 0,
      endIndex: points.length - 1,
      executionStartIndex: 0,
      executionEndIndex: points.length - 1,
      maxDeviationMeters: 0.01,
      centerX: 0,
      centerY: 0,
      radiusMeters,
      direction: 1,
    }],
  });

  assert.equal(result.completed, true);
  assert.equal(events.filter(({ message }) => message === "continuous_path.arc_engaged").length, 1);
  assert.equal(events.filter(({ message }) => message === "continuous_path.arc_acquisition_started").length, 0);
  assert.equal(commands.length > 0, true);
  assert.equal(commands.every(({ left, right }) => left >= 0 && right >= 0), true);
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

test("continuous follower measures recovery capture from the post-alignment pose", async () => {
  const poses = [
    createPose(0, 0, createInternalHeading(180), "gnss"),
    createPose(0.5, 0, createInternalHeading(180), "gnss"),
    createPose(0.5, 0, createInternalHeading(0), "gnss"),
    createPose(0.95, 0, createInternalHeading(0), "gnss"),
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
  assert.equal(events.filter(({ message }) => message === "continuous_path.recovery_align_started").length, 1);
  assert.equal(events.filter(({ message }) => message === "continuous_path.recovery_capture_started").length, 1);
  assert.equal(events.filter(({ message }) => message === "continuous_path.recovery_capture_completed").length, 1);
  assert.equal(commands.some(({ left, right }) => left > 0 && right > 0), true);
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


test("limitContinuousWheelCommandChange slews abrupt speed changes", () => {
  assert.equal(Math.abs(limitContinuousWheelCommandChange(0.8, 0.2, 1, 0.1) - 0.7) < 1e-9, true);
  assert.equal(Math.abs(limitContinuousWheelCommandChange(-0.4, 0.4, 1, 0.1) + 0.3) < 1e-9, true);
  assert.equal(limitContinuousWheelCommandChange(0.5, 0.55, 1, 0.1), 0.55);
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
