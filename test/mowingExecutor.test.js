import test from "node:test";
import assert from "node:assert/strict";
import { MowingExecutor, buildMowingReturnPath, isMowingExecutionPathSafe } from "../dist/pathfollowing/mowingExecutor.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import { systemStop } from "../dist/control/systemStop.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("mowing return path takes the shorter perimeter route back to the recorded start", () => {
  const perimeter = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 10, yMeters: 0, capturedAt: 2 },
    { xMeters: 10, yMeters: 10, capturedAt: 3 },
    { xMeters: 0, yMeters: 10, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const path = buildMowingReturnPath(
    perimeter,
    { xMeters: 9.8, yMeters: 9.8 },
    { xMeters: -0.2, yMeters: 9.8 },
  );

  assert.deepEqual(path.map(({ xMeters, yMeters }) => [xMeters, yMeters]), [
    [9.8, 9.8],
    [10, 10],
    [0, 10],
    [-0.2, 9.8],
  ]);
});

test("connector geometry is rejected when its route leaves the mowing area", () => {
  const area = [
    { xMeters: -1.1, yMeters: -1.1, capturedAt: 1 },
    { xMeters: 1.1, yMeters: -1.1, capturedAt: 2 },
    { xMeters: 1.1, yMeters: 0.1, capturedAt: 3 },
    { xMeters: -1.1, yMeters: 0.1, capturedAt: 4 },
    { xMeters: -1.1, yMeters: -1.1, capturedAt: 5 },
  ];
  const points = [
    { xMeters: -1, yMeters: -1, capturedAt: 6 },
    { xMeters: 0, yMeters: 0.5, capturedAt: 7 },
    { xMeters: 1, yMeters: -1, capturedAt: 8 },
  ];

  assert.equal(isMowingExecutionPathSafe(points, area, []), false);
  assert.equal(isMowingExecutionPathSafe([points[0], points[2]], area, []), true);
});

test("MowingExecutor exposes a failed IMU alignment turn to strip execution", async () => {
  const executor = new MowingExecutor({
    plan: { headingDeg: 0, stripSpacingMeters: 0.3, bladeWidthMeters: 0.4, stripCount: 0, strips: [], connectors: [] },
    areaPoints: [],
    obstaclePointsArray: [],
    driveController: { async executeDrive() { throw new Error("translation must not start"); } },
    turnController: { async executeTurn() { return { status: "error" }; } },
    poseFusion: { getCurrentPose() { return createPose(0, 0, createInternalHeading(0), "gnss"); } },
    continuousPathFollower: { async executePath() { return { completed: true, reason: "reached_end" }; } },
    logger: createLogger(),
  });

  const status = await executor["turnToHeading"](90);
  assert.equal(status, "error");
});

test("MowingExecutor retries one low-current translation stall on the same mowing-strip target", async () => {
  systemStop.clearStop("transient-strip-stall-retry-test");
  try {
    const areaPoints = [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 10, yMeters: 0, capturedAt: 2 },
      { xMeters: 10, yMeters: 10, capturedAt: 3 },
      { xMeters: 0, yMeters: 10, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ];
    const operation = {
      kind: "drive",
      phase: "mowing_strip",
      stripIndex: 12,
      targetX: 9,
      targetY: 1,
      errorCode: "strip_drive_failed",
      continuation: { stage: "connector_follow", stripIndex: 12 },
    };
    let driveCalls = 0;
    let executor;
    const accepted = [];
    executor = new MowingExecutor({
      plan: {
        headingDeg: 0,
        stripSpacingMeters: 0.38,
        bladeWidthMeters: 0.4,
        stripCount: 0,
        strips: [],
        connectors: [],
      },
      areaPoints,
      obstaclePointsArray: [],
      driveController: {
        async executeDrive() {
          driveCalls += 1;
          if (driveCalls === 1) {
            accepted.push(executor.acceptTransientTranslationStallRetry({
              motionKind: "translation",
              currentHigh: false,
              faultFlags: 0,
              leftMotorCurrentAmps: 1,
              rightMotorCurrentAmps: 1,
            }));
            systemStop.requestStop("sensors", "motor_stall_detected");
            return { status: "stopped", maxCteMeters: 0 };
          }
          return { status: "success", maxCteMeters: 0 };
        },
      },
      turnController: { async executeTurn() { return { status: "success" }; } },
      poseFusion: {
        getCurrentPose() {
          return createPose(1, 1, createInternalHeading(0), "gnss");
        },
      },
      continuousPathFollower: {
        async executePath() { return { completed: true, reason: "reached_end" }; },
      },
      logger: createLogger(),
      transientStallRetryDelayMs: 0,
    });

    const continuation = await executor["executeResumeOperation"](operation);

    assert.deepEqual(accepted, [true]);
    assert.equal(driveCalls, 2);
    assert.deepEqual(continuation, operation.continuation);
    assert.equal(systemStop.isStopped(), false);
  } finally {
    systemStop.clearStop("transient-strip-stall-retry-test-cleanup");
  }
});

test("MowingExecutor does not retry a mowing strip more than once", async () => {
  systemStop.clearStop("bounded-strip-stall-retry-test");
  try {
    const areaPoints = [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 10, yMeters: 0, capturedAt: 2 },
      { xMeters: 10, yMeters: 10, capturedAt: 3 },
      { xMeters: 0, yMeters: 10, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ];
    const operation = {
      kind: "drive",
      phase: "mowing_strip",
      stripIndex: 12,
      targetX: 9,
      targetY: 1,
      errorCode: "strip_drive_failed",
      continuation: { stage: "connector_follow", stripIndex: 12 },
    };
    let driveCalls = 0;
    let executor;
    const accepted = [];
    executor = new MowingExecutor({
      plan: {
        headingDeg: 0,
        stripSpacingMeters: 0.38,
        bladeWidthMeters: 0.4,
        stripCount: 0,
        strips: [],
        connectors: [],
      },
      areaPoints,
      obstaclePointsArray: [],
      driveController: {
        async executeDrive() {
          driveCalls += 1;
          accepted.push(executor.acceptTransientTranslationStallRetry({
            motionKind: "translation",
            currentHigh: false,
            faultFlags: 0,
            leftMotorCurrentAmps: 1,
            rightMotorCurrentAmps: 1,
          }));
          systemStop.requestStop("sensors", "motor_stall_detected");
          return { status: "stopped", maxCteMeters: 0 };
        },
      },
      turnController: { async executeTurn() { return { status: "success" }; } },
      poseFusion: {
        getCurrentPose() {
          return createPose(1, 1, createInternalHeading(0), "gnss");
        },
      },
      continuousPathFollower: {
        async executePath() { return { completed: true, reason: "reached_end" }; },
      },
      logger: createLogger(),
      transientStallRetryDelayMs: 0,
    });

    const continuation = await executor["executeResumeOperation"](operation);

    assert.deepEqual(accepted, [true, false]);
    assert.equal(driveCalls, 2);
    assert.equal(continuation, null);
    assert.equal(executor.getStatus().phase, "stopped");
    assert.equal(systemStop.snapshot().reason, "motor_stall_detected");
  } finally {
    systemStop.clearStop("bounded-strip-stall-retry-test-cleanup");
  }
});

test("MowingExecutor completes only after following the perimeter return path", async () => {
  const followedPaths = [];
  const executor = new MowingExecutor({
    plan: { headingDeg: 0, stripSpacingMeters: 0.3, bladeWidthMeters: 0.4, stripCount: 0, strips: [], connectors: [] },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 10, yMeters: 0, capturedAt: 2 },
      { xMeters: 10, yMeters: 10, capturedAt: 3 },
      { xMeters: 0, yMeters: 10, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController: { async executeDrive() { return { status: "success", maxCteMeters: 0 }; } },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: { getCurrentPose() { return createPose(9.8, 9.8, createInternalHeading(0), "gnss"); } },
    continuousPathFollower: {
      async executePath(points) {
        followedPaths.push(points);
        return { completed: true, reason: "reached_end", completedWaypoints: points.length - 1 };
      },
    },
    logger: createLogger(),
    returnToStartAfterMowing: true,
    mowingStartPoint: { xMeters: -0.2, yMeters: 9.8 },
  });

  const status = await executor.execute();
  assert.equal(status.phase, "complete");
  assert.equal(followedPaths.length, 1);
  assert.deepEqual(
    followedPaths[0].at(-1) && [followedPaths[0].at(-1).xMeters, followedPaths[0].at(-1).yMeters],
    [-0.2, 9.8],
  );
});

test("MowingExecutor refuses to start without GNSS-quality pose", async () => {
  systemStop.clearStop("poor-gnss-start-test");
  try {
    let driveCalls = 0;
    const executor = new MowingExecutor({
      plan: {
        headingDeg: 0,
        stripSpacingMeters: 0.3,
        bladeWidthMeters: 0.4,
        stripCount: 0,
        strips: [],
        connectors: [],
      },
      areaPoints: [],
      obstaclePointsArray: [],
      driveController: {
        async executeDrive() {
          driveCalls += 1;
          return { status: "success", maxCteMeters: 0 };
        },
      },
      turnController: { async executeTurn() { return { status: "success" }; } },
      poseFusion: {
        getCurrentPose() {
          return createPose(0, 0, createInternalHeading(0), "dead-reckoning");
        },
      },
      continuousPathFollower: {
        async executePath() { return { completed: true, reason: "reached_end" }; },
      },
      logger: createLogger(),
    });

    const status = await executor.execute();

    assert.equal(status.phase, "stopped");
    assert.equal(status.error, "poor_gnss");
    assert.equal(systemStop.snapshot().reason, "poor_gnss");
    assert.equal(driveCalls, 0);
  } finally {
    systemStop.clearStop("poor-gnss-start-test-cleanup");
  }
});

test("MowingExecutor rejoins an unmown strip with the pivot-and-straight drive after tracing its boundary", async () => {
  const driveTargets = [];
  const savedStates = [];
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 0,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(options) {
        driveTargets.push([
          options.targetPosition.xMeters,
          options.targetPosition.yMeters,
        ]);
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: {
      getCurrentPose() {
        return createPose(0, 0, createInternalHeading(90), "gnss");
      },
    },
    continuousPathFollower: {
      async executePath() { return { completed: true, reason: "reached_end" }; },
    },
    logger: createLogger(),
    updateResumeState(state) { savedStates.push(state); },
  });

  const status = await executor["approachStripEntryAfterBoundaryTrace"](4, { x: 0.8, y: 0.2 });

  assert.equal(status, null);
  assert.deepEqual(driveTargets, [[0.8, 0.2]]);
  assert.equal(savedStates.at(-1).activeOperation.kind, "drive");
  assert.deepEqual(savedStates.at(-1).activeOperation.continuation, {
    stage: "strip_turn",
    stripIndex: 4,
  });
});

test("MowingExecutor traces the full boundary back to the original encounter point", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const strip = {
    start: { xMeters: 0, yMeters: 0, capturedAt: 10 },
    end: { xMeters: 0, yMeters: 1, capturedAt: 11 },
    startBoundary: { kind: "area" },
    endBoundary: { kind: "area" },
    centerOffsetMeters: 0,
    sequenceIndex: 0,
    traversalReversed: false,
  };
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [strip],
    connectors: [],
  };

  const driveController = {
    async executeDrive() {
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnCalls = [];
  const turnController = {
    async executeTurn(request) {
      turnCalls.push(request);
      return { status: "success" };
    },
  };
  const poses = [
    createPose(0.1, -0.2, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(90), "gnss"),
  ];
  const poseFusion = {
    getCurrentPose() {
      return poses.shift() ?? createPose(0.92, 0.08, createInternalHeading(90), "gnss");
    },
  };

  const followCalls = [];
  const checkpointWaypoints = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan,
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(followCalls.length >= 1, true);
  assert.equal(followCalls[0].options.loopPath, false);
  assert.equal(followCalls[0].options.strictOrderedProgress, true);
  assert.equal(followCalls[0].options.pivotAtWaypointTurnDeg, 20);
  assert.equal(followCalls[0].options.pivotAtWaypointDistanceMeters, 0.15);
  assert.equal(followCalls[0].options.minimumSpeed, 1);
  assert.equal(followCalls[0].options.maximumSpeed, 1);
  assert.equal("pivotIfInnerWheelBelow" in followCalls[0].options, false);
  assert.equal(followCalls[0].options.completionToleranceMeters, 0.35);
  assert.equal(turnCalls.length >= 1, true);
  const traversedPoints = followCalls.flatMap((call) => call.pathPoints.map((point) => [point.xMeters, point.yMeters]));
  assert.equal(traversedPoints.some(([x, y]) => x === 0 && y === 0), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 1 && y === 0), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 1 && y === 1), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 0 && y === 1), true);
});

test("MowingExecutor can skip the initial area perimeter trace and begin strip mowing from the perimeter", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [
      {
        start: { xMeters: 0, yMeters: 0, capturedAt: 10 },
        end: { xMeters: 0, yMeters: 1, capturedAt: 11 },
        startBoundary: { kind: "area" },
        endBoundary: { kind: "area" },
        centerOffsetMeters: 0,
        sequenceIndex: 0,
        traversalReversed: false,
      },
    ],
    connectors: [],
  };

  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnCalls = [];
  const turnController = {
    async executeTurn(request) {
      turnCalls.push(request);
      return { status: "success" };
    },
  };
  const poses = [
    createPose(0.1, -0.2, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(90), "gnss"),
    createPose(1, 0, createInternalHeading(90), "gnss"),
  ];
  const poseFusion = {
    getCurrentPose() {
      return poses.shift() ?? createPose(1, 0, createInternalHeading(90), "gnss");
    },
  };
  const followCalls = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan,
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
    skipInitialBoundaryTrace: true,
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(followCalls.length, 0);
  assert.equal(driveTargets.length >= 1, true);
});

test("MowingExecutor turns toward the 50cm-ahead perimeter lead target and follows in one continuous run", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [
      {
        start: { xMeters: 0, yMeters: 0, capturedAt: 10 },
        end: { xMeters: 0, yMeters: 1, capturedAt: 11 },
        startBoundary: { kind: "area" },
        endBoundary: { kind: "area" },
        centerOffsetMeters: 0,
        sequenceIndex: 0,
        traversalReversed: false,
      },
    ],
    connectors: [],
  };

  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const poses = [
    createPose(0.1, -0.2, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(0), "gnss"),
    createPose(0.92, 0.08, createInternalHeading(90), "gnss"),
    createPose(1, 0, createInternalHeading(0), "gnss"),
  ];
  const poseFusion = {
    getCurrentPose() {
      return poses.shift() ?? createPose(1, 0, createInternalHeading(0), "gnss");
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const followCalls = [];
  const checkpointWaypoints = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan,
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(driveTargets.some(([x, y]) => x === 1 && y === 0.3), false);
  assert.equal(followCalls.length >= 1, true);
  assert.equal(followCalls[0].pathPoints.length >= 2, true);
  assert.equal(followCalls[0].pathPoints[0].xMeters >= 0.9, true);
  assert.equal(followCalls[0].pathPoints[0].yMeters >= 0, true);
});

test("MowingExecutor follows longer multi-point connectors with the continuous follower", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 2,
    strips: [
      {
        start: { xMeters: 0.5, yMeters: 0, capturedAt: 10 },
        end: { xMeters: 0.5, yMeters: 1, capturedAt: 11 },
        startBoundary: { kind: "area" },
        endBoundary: { kind: "area" },
        centerOffsetMeters: 0.5,
        sequenceIndex: 0,
        traversalReversed: false,
      },
      {
        start: { xMeters: 1.8, yMeters: 1, capturedAt: 12 },
        end: { xMeters: 1.8, yMeters: 0, capturedAt: 13 },
        startBoundary: { kind: "area" },
        endBoundary: { kind: "area" },
        centerOffsetMeters: 1.8,
        sequenceIndex: 1,
        traversalReversed: false,
      },
    ],
    connectors: [[
      { xMeters: 0.5, yMeters: 0.85, capturedAt: 20 },
      { xMeters: 1.15, yMeters: 0.95, capturedAt: 21 },
      { xMeters: 1.8, yMeters: 0.85, capturedAt: 22 },
    ]],
  };

  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
    getCurrentPose() {
      return createPose(0.5, 0.85, createInternalHeading(90), "gnss");
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(0.5, 0.85, createInternalHeading(90), "gnss");
    },
  };

  const followCalls = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan,
    initialEntryPlan: {
      entryPoint: { xMeters: 0.5, yMeters: 0, capturedAt: 30 },
      approachTarget: { xMeters: 0.5, yMeters: 0.15 },
      segmentIndex: 0,
      distanceMeters: 0.15,
      tangentHeadingDeg: 90,
    },
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(followCalls.length >= 1, true);
  assert.equal(followCalls.at(-1).pathPoints[0].xMeters, 0.5);
  assert.equal(followCalls.at(-1).pathPoints[0].yMeters, 0.85);
  assert.equal(followCalls.at(-1).options.loopPath, false);
  assert.equal(followCalls.at(-1).options.strictOrderedProgress, true);
  assert.equal(followCalls.at(-1).options.pivotAtWaypointTurnDeg, 20);
  assert.equal(followCalls.at(-1).options.pivotAtWaypointDistanceMeters, 0.15);
  assert.equal(followCalls.at(-1).options.minimumSpeed, 1);
  assert.equal(followCalls.at(-1).options.maximumSpeed, 1);
  assert.equal("pivotIfInnerWheelBelow" in followCalls.at(-1).options, false);
});

test("MowingExecutor uses the turn-and-line drive controller for a long two-point connector", async () => {
  const driveRequests = [];
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 26,
      stripSpacingMeters: 0.38,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 20, yMeters: 0, capturedAt: 2 },
      { xMeters: 20, yMeters: 20, capturedAt: 3 },
      { xMeters: 0, yMeters: 20, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(request) {
        driveRequests.push(request);
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: {
      getCurrentPose() {
        return createPose(15.734661679079084, 17.384028260956246, createInternalHeading(24.04), "gnss");
      },
    },
    continuousPathFollower: {
      async executePath() {
        assert.fail("a two-point connector must not enter continuous following");
      },
    },
    logger: createLogger(),
  });

  const result = await executor["followConnector"]([
    { xMeters: 15.744475424812707, yMeters: 17.403234714308642, capturedAt: 1 },
    { xMeters: 12.48110393941283, yMeters: 14.966004617521396, capturedAt: 2 },
  ], 3, { stage: "strip_approach", stripIndex: 4 });

  assert.equal(result.completed, true);
  assert.equal(driveRequests.length, 1);
  assert.equal(driveRequests[0].targetPosition.xMeters, 12.48110393941283);
  assert.equal(driveRequests[0].targetPosition.yMeters, 14.966004617521396);
  assert.equal(driveRequests[0].minimumDriveDistanceMeters, 0.15);
});

test("MowingExecutor simplifies a safe short multi-point connector to a direct transfer", async () => {
  const driveTargets = [];
  const driveRequests = [];
  const driveController = {
    async executeDrive(options) {
      driveRequests.push(options);
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(0.5, 0.85, createInternalHeading(90), "gnss");
    },
  };
  const followCalls = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 2,
      strips: [
        {
          start: { xMeters: 0.5, yMeters: 0, capturedAt: 10 },
          end: { xMeters: 0.5, yMeters: 1, capturedAt: 11 },
          startBoundary: { kind: "area" },
          endBoundary: { kind: "area" },
          centerOffsetMeters: 0.5,
          sequenceIndex: 0,
          traversalReversed: false,
        },
        {
          start: { xMeters: 1, yMeters: 1, capturedAt: 12 },
          end: { xMeters: 1, yMeters: 0, capturedAt: 13 },
          startBoundary: { kind: "area" },
          endBoundary: { kind: "area" },
          centerOffsetMeters: 1,
          sequenceIndex: 1,
          traversalReversed: false,
        },
      ],
      connectors: [[
        { xMeters: 0.5, yMeters: 0.85, capturedAt: 20 },
        { xMeters: 0.75, yMeters: 0.95, capturedAt: 21 },
        { xMeters: 1, yMeters: 0.85, capturedAt: 22 },
      ]],
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 2, yMeters: 0, capturedAt: 2 },
      { xMeters: 2, yMeters: 1, capturedAt: 3 },
      { xMeters: 0, yMeters: 1, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const result = await executor["followConnector"]([
    { xMeters: 0.5, yMeters: 0.85, capturedAt: 20 },
    { xMeters: 0.75, yMeters: 0.95, capturedAt: 21 },
    { xMeters: 1, yMeters: 0.85, capturedAt: 22 },
  ], 0, {
    stage: "strip_approach",
    stripIndex: 1,
  });

  assert.equal(result.completed, true);
  assert.deepEqual(driveTargets, [[1, 0.85]]);
  assert.equal(driveRequests[0].minimumDriveDistanceMeters, 0.15);
  assert.equal(followCalls.length, 0);
});

test("MowingExecutor retains a routed short connector when the direct segment crosses an obstacle", async () => {
  const followCalls = [];
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 0,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 2, yMeters: 0, capturedAt: 2 },
      { xMeters: 2, yMeters: 2, capturedAt: 3 },
      { xMeters: 0, yMeters: 2, capturedAt: 4 },
    ],
    obstaclePointsArray: [[
      { xMeters: 0.7, yMeters: 0.7, capturedAt: 5 },
      { xMeters: 0.9, yMeters: 0.7, capturedAt: 6 },
      { xMeters: 0.9, yMeters: 1.0, capturedAt: 7 },
      { xMeters: 0.7, yMeters: 1.0, capturedAt: 8 },
    ]],
    driveController: {
      async executeDrive() {
        assert.fail("unsafe direct connector must not use segment drive");
      },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(0.5, 0.85, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath(pathPoints, options) {
        followCalls.push({ pathPoints, options });
        return { completed: true, reason: "reached_end" };
      },
    },
    logger: createLogger(),
  });

  const connector = [
    { xMeters: 0.5, yMeters: 0.85, capturedAt: 10 },
    { xMeters: 0.5, yMeters: 1.2, capturedAt: 11 },
    { xMeters: 1.0, yMeters: 1.2, capturedAt: 12 },
    { xMeters: 1.0, yMeters: 0.85, capturedAt: 13 },
  ];
  const result = await executor["followConnector"](connector, 0, {
    stage: "strip_approach",
    stripIndex: 1,
  });

  assert.equal(result.completed, true);
  assert.equal(followCalls.length, 1);
  assert.deepEqual(followCalls[0].pathPoints, connector);
});

test("MowingExecutor locally replans an unsafe connector from the live pose", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 2, capturedAt: 3 },
    { xMeters: 0, yMeters: 2, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const obstaclePointsArray = [[
    { xMeters: 0.7, yMeters: 0.7, capturedAt: 6 },
    { xMeters: 0.9, yMeters: 0.7, capturedAt: 7 },
    { xMeters: 0.9, yMeters: 1.0, capturedAt: 8 },
    { xMeters: 0.7, yMeters: 1.0, capturedAt: 9 },
    { xMeters: 0.7, yMeters: 0.7, capturedAt: 10 },
  ]];
  const followCalls = [];
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 0,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints,
    obstaclePointsArray,
    driveController: {
      async executeDrive() {
        assert.fail("the obstacle-blocked repair must retain its routed path");
      },
    },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: {
      getCurrentPose() { return createPose(0.5, 0.85, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath(pathPoints) {
        followCalls.push(pathPoints);
        return { completed: true, reason: "reached_end" };
      },
    },
    logger: createLogger(),
  });

  const result = await executor["followConnector"]([
    { xMeters: 0.5, yMeters: 0.85, capturedAt: 11 },
    { xMeters: 0.5, yMeters: 2.2, capturedAt: 12 },
    { xMeters: 1.1, yMeters: 0.85, capturedAt: 13 },
  ], 14, { stage: "strip_approach", stripIndex: 15 });

  assert.equal(result.completed, true);
  assert.equal(followCalls.length, 1);
  assert.equal(isMowingExecutionPathSafe(followCalls[0], areaPoints, obstaclePointsArray), true);
  assert.deepEqual(
    [followCalls[0][0].xMeters, followCalls[0][0].yMeters],
    [0.5, 0.85],
  );
  assert.deepEqual(
    [followCalls[0].at(-1).xMeters, followCalls[0].at(-1).yMeters],
    [1.1, 0.85],
  );
});

test("MowingExecutor skips tiny direct connector corrections when already at the target", async () => {
  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(1.02, 1.01, createInternalHeading(0), "gnss");
    },
  };
  const continuousPathFollower = {
    async executePath() {
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [],
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const result = await executor["followConnector"]([
    { xMeters: 0.95, yMeters: 1.0, capturedAt: 1 },
    { xMeters: 1.0, yMeters: 1.0, capturedAt: 2 },
  ], 0, {
    stage: "strip_approach",
    stripIndex: 1,
  });

  assert.equal(result.completed, true);
  assert.equal(result.reason, "reached_end");
  assert.deepEqual(driveTargets, []);
});

test("MowingExecutor publishes resume snapshots for the active step and clears them on completion", async () => {
  const savedStates = [];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [{
      start: { xMeters: 0, yMeters: 0, capturedAt: 10 },
      end: { xMeters: 0, yMeters: 1, capturedAt: 11 },
      startBoundary: { kind: "area" },
      endBoundary: { kind: "area" },
      centerOffsetMeters: 0,
      sequenceIndex: 0,
      traversalReversed: false,
    }],
    connectors: [],
  };
  const driveController = {
    async executeDrive() {
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(0, 0, createInternalHeading(90), "gnss");
    },
  };
  const continuousPathFollower = {
    async executePath() {
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    areaName: "Rear Lawn",
    plan,
    initialEntryPlan: {
      entryPoint: { xMeters: 0, yMeters: 0, capturedAt: 20 },
      approachTarget: { xMeters: 0, yMeters: 0.15 },
      segmentIndex: 0,
      distanceMeters: 0.15,
      tangentHeadingDeg: 90,
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 1, yMeters: 0, capturedAt: 2 },
      { xMeters: 1, yMeters: 1, capturedAt: 3 },
      { xMeters: 0, yMeters: 1, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
    updateResumeState(state) {
      savedStates.push(state);
    },
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(savedStates.length > 1, true);
  assert.equal(savedStates[0].areaName, "Rear Lawn");
  assert.equal(savedStates[0].activeOperation.kind, "drive");
  assert.equal(savedStates.at(-1), null);
});

test("MowingExecutor resumes a saved strip-drive operation directly when its segment is safe", async () => {
  const driveTargets = [];
  let skipTranslation = false;
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([
        options.targetPosition.xMeters,
        options.targetPosition.yMeters,
      ]);
      return {
        status: "success",
        maxCteMeters: 0,
        ...(skipTranslation ? { learnSkipReason: "below_minimum_drive_distance" } : {}),
      };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(0, 0.3, createInternalHeading(90), "gnss");
    },
  };
  const continuousPathFollower = {
    async executePath() {
      return { completed: true, reason: "reached_end" };
    },
  };
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [{
      start: { xMeters: 0, yMeters: 0, capturedAt: 10 },
      end: { xMeters: 0, yMeters: 1, capturedAt: 11 },
      startBoundary: { kind: "area" },
      endBoundary: { kind: "area" },
      centerOffsetMeters: 0,
      sequenceIndex: 0,
      traversalReversed: false,
    }],
    connectors: [],
  };
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const executorOptions = {
    areaName: "Rear Lawn",
    plan,
    initialEntryPlan: {
      entryPoint: { xMeters: 0, yMeters: 0, capturedAt: 20 },
      approachTarget: { xMeters: 0, yMeters: 0.15 },
      segmentIndex: 0,
      distanceMeters: 0.15,
      tangentHeadingDeg: 90,
    },
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
    resumeState: {
      version: 2,
      areaName: "Rear Lawn",
      savedAt: 1,
      currentStripIndex: 0,
      totalStrips: 1,
      tracedBoundaryKeys: ["area"],
      plan,
      areaPoints,
      obstaclePointsArray: [],
      initialEntryPlan: null,
      activeOperation: {
        kind: "drive",
        phase: "mowing_strip",
        stripIndex: 0,
        targetX: 0,
        targetY: 0.85,
        errorCode: "strip_drive_failed",
        continuation: { stage: "complete", stripIndex: 0 },
      },
    },
  };
  const executor = new MowingExecutor(executorOptions);

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.deepEqual(driveTargets, [[0, 0.85]]);

  skipTranslation = true;
  const skippedStatus = await new MowingExecutor(executorOptions).execute();
  assert.equal(skippedStatus.phase, "error");
});

test("MowingExecutor routes a displaced strip-drive resume instead of driving straight outside the area", async () => {
  const driveTargets = [];
  const followedPaths = [];
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 6, yMeters: 0, capturedAt: 2 },
    { xMeters: 6, yMeters: 6, capturedAt: 3 },
    { xMeters: 4, yMeters: 6, capturedAt: 4 },
    { xMeters: 4, yMeters: 2, capturedAt: 5 },
    { xMeters: 2, yMeters: 2, capturedAt: 6 },
    { xMeters: 2, yMeters: 6, capturedAt: 7 },
    { xMeters: 0, yMeters: 6, capturedAt: 8 },
    { xMeters: 0, yMeters: 0, capturedAt: 9 },
  ];
  const operation = {
    kind: "drive",
    phase: "mowing_strip",
    stripIndex: 56,
    targetX: 5,
    targetY: 5,
    errorCode: "strip_drive_failed",
    continuation: { stage: "connector_follow", stripIndex: 56 },
  };
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.38,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints,
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(request) {
        driveTargets.push([request.targetPosition.xMeters, request.targetPosition.yMeters]);
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(1, 5, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath(points) {
        followedPaths.push(points);
        return {
          completed: true,
          reason: "reached_end",
          completedWaypoints: points.length,
        };
      },
    },
    logger: createLogger(),
  });

  const continuation = await executor["executeResumeOperation"](operation);

  assert.deepEqual(continuation, operation.continuation);
  assert.deepEqual(driveTargets, []);
  assert.equal(followedPaths.length, 1);
  assert.equal(followedPaths[0].length >= 4, true);
  assert.equal(isMowingExecutionPathSafe(followedPaths[0], areaPoints, []), true);
});

test("MowingExecutor traces the boundary referenced by the strip, not whichever path is nearest", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const obstaclePoints = [[
    { xMeters: 2.8, yMeters: 1.2, capturedAt: 6 },
    { xMeters: 3.2, yMeters: 1.2, capturedAt: 7 },
    { xMeters: 3.2, yMeters: 1.8, capturedAt: 8 },
    { xMeters: 2.8, yMeters: 1.8, capturedAt: 9 },
    { xMeters: 2.8, yMeters: 1.2, capturedAt: 10 },
  ]];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 1,
    strips: [{
      start: { xMeters: 3, yMeters: 0.2, capturedAt: 11 },
      end: { xMeters: 3, yMeters: 1.2, capturedAt: 12 },
      startBoundary: { kind: "area" },
      endBoundary: { kind: "obstacle", obstacleIndex: 0 },
      centerOffsetMeters: 3,
      sequenceIndex: 0,
      traversalReversed: false,
    }],
    connectors: [],
  };

  const driveController = {
    async executeDrive() {
      return { status: "success", maxCteMeters: 0 };
    },
    getCurrentPose() {
      return createPose(3, 1.2, createInternalHeading(90), "gnss");
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(3, 1.2, createInternalHeading(90), "gnss");
    },
  };

  const followCalls = [];
  const continuousPathFollower = {
    async executePath(pathPoints) {
      followCalls.push(pathPoints);
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan,
    skipInitialBoundaryTrace: true,
    initialEntryPlan: {
      entryPoint: { xMeters: 3, yMeters: 0, capturedAt: 13 },
      approachTarget: { xMeters: 3, yMeters: 0.15 },
      segmentIndex: 0,
      distanceMeters: 0.15,
      tangentHeadingDeg: 90,
    },
    areaPoints,
    obstaclePointsArray: obstaclePoints,
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(followCalls.length, 1);
  const lastTrace = followCalls.at(-1);
  assert.equal(lastTrace.every((point) => point.xMeters >= 2.75 && point.xMeters <= 3.25), true);
  assert.equal(lastTrace.every((point) => point.yMeters >= 1.15 && point.yMeters <= 1.85), true);
});

test("MowingExecutor adjusts an outside initial entry target to a point inside the area", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 2, capturedAt: 3 },
    { xMeters: 0, yMeters: 2, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const driveTargets = [];
  let pose = createPose(1, 2.2, createInternalHeading(270), "gnss");
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      pose = createPose(
        options.targetPosition.xMeters,
        options.targetPosition.yMeters,
        pose.heading,
        "gnss",
      );
      return { status: "success", maxCteMeters: 0 };
    },
    getCurrentPose() {
      return pose;
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return pose;
    },
  };
  const continuousPathFollower = {
    async executePath() {
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    initialEntryPlan: {
      entryPoint: { xMeters: 1, yMeters: 2, capturedAt: 6 },
      approachTarget: { xMeters: 1, yMeters: 2.15 },
      segmentIndex: 0,
      distanceMeters: 0.15,
      tangentHeadingDeg: 0,
    },
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(driveTargets.length >= 1, true);
  assert.equal(driveTargets[0][1] < 2, true);
});

test("MowingExecutor skips tiny initial-entry approach drives when already at the staging point", async () => {
  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(1.02, 0.99, createInternalHeading(0), "gnss");
    },
  };
  const followCalls = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    initialEntryPlan: {
      entryPoint: { xMeters: 1, yMeters: 1.2, capturedAt: 6 },
      approachTarget: { xMeters: 1, yMeters: 1 },
      segmentIndex: 0,
      distanceMeters: 0.2,
      tangentHeadingDeg: 90,
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 2, yMeters: 0, capturedAt: 2 },
      { xMeters: 2, yMeters: 2, capturedAt: 3 },
      { xMeters: 0, yMeters: 2, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(driveTargets.length, 0);
  assert.equal(followCalls.length, 1);
});

test("MowingExecutor projects a nearby strip-derived area anchor onto the authoritative perimeter", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 1, capturedAt: 3 },
    { xMeters: 0, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poses = [
    createPose(1.9, -0.2, createInternalHeading(90), "gnss"),
    createPose(1.9, -0.2, createInternalHeading(90), "gnss"),
    createPose(1.8, 0.15, createInternalHeading(90), "gnss"),
    createPose(1.8, 0.15, createInternalHeading(90), "gnss"),
    createPose(1.8, 0.15, createInternalHeading(90), "gnss"),
  ];
  const poseFusion = {
    getCurrentPose() {
      return poses.shift() ?? createPose(1.8, 0.15, createInternalHeading(90), "gnss");
    },
  };
  const followCalls = [];
  const checkpointWaypoints = [];
  const continuousPathFollower = {
    async executePath(pathPoints, options) {
      followCalls.push({ pathPoints, options });
      return { completed: true, reason: "reached_end" };
    },
  };

  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 2,
      strips: [
        {
          start: { xMeters: 0.2, yMeters: -0.02, capturedAt: 10 },
          end: { xMeters: 0.2, yMeters: 1, capturedAt: 11 },
          startBoundary: { kind: "area" },
          endBoundary: { kind: "area" },
          centerOffsetMeters: 0.2,
          sequenceIndex: 0,
          traversalReversed: false,
        },
        {
          start: { xMeters: 1.8, yMeters: 0, capturedAt: 12 },
          end: { xMeters: 1.8, yMeters: 1, capturedAt: 13 },
          startBoundary: { kind: "area" },
          endBoundary: { kind: "area" },
          centerOffsetMeters: 1.8,
          sequenceIndex: 1,
          traversalReversed: false,
        },
      ],
      connectors: [[
        { xMeters: 0.2, yMeters: 0.85, capturedAt: 20 },
        { xMeters: 1.8, yMeters: 0.85, capturedAt: 21 },
      ]],
    },
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
    updateRecoveryCheckpoint(waypoints) {
      checkpointWaypoints.push(waypoints);
    },
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.deepEqual(driveTargets[0], [0.2, 0.13]);
  assert.equal(followCalls.length >= 1, true);
  if (checkpointWaypoints.length > 0) {
    assert.equal(
      checkpointWaypoints[0].some((point) => point.xMeters === 0.2 && point.yMeters === 0),
      true,
    );
  }
  assert.equal(
    followCalls[0].pathPoints.every((point) => point.yMeters >= 0),
    true,
  );
});

test("MowingExecutor persists the completed waypoint index when a continuous follow is interrupted", async () => {
  const savedStates = [];
  const connector = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.4, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.8, yMeters: 0, capturedAt: 3 },
    { xMeters: 1.2, yMeters: 0, capturedAt: 4 },
  ];
  const executor = new MowingExecutor({
    areaName: "Back lawn",
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.3,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: -1, yMeters: -1, capturedAt: 5 },
      { xMeters: 2, yMeters: -1, capturedAt: 6 },
      { xMeters: 2, yMeters: 1, capturedAt: 7 },
      { xMeters: -1, yMeters: 1, capturedAt: 8 },
      { xMeters: -1, yMeters: -1, capturedAt: 9 },
    ],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive() { return { status: "success", maxCteMeters: 0 }; },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(0.1, 0, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath() {
        return {
          completed: false,
          reason: "user_stopped",
          completedWaypoints: 1,
          pointCount: 2,
          algorithm: "continuous_path_follow",
        };
      },
    },
    logger: createLogger(),
    updateResumeState(state) { savedStates.push(state); },
  });

  const result = await executor["followConnector"](connector, 0, {
    stage: "strip_approach",
    stripIndex: 1,
  });

  assert.equal(result.completed, false);
  const saved = savedStates.at(-1);
  assert.equal(saved.activeOperation.kind, "follow_path");
  assert.equal(saved.activeOperation.pathPoints.length, 4);
  assert.equal(saved.activeOperation.followOptions.initialTargetIndex, 1);
  assert.equal(saved.activeOperation.followOptions.pivotAtWaypointTurnDeg, 20);
  assert.equal(saved.activeOperation.followOptions.pivotAtWaypointDistanceMeters, 0.15);
  assert.equal(saved.activeOperation.followOptions.minimumSpeed, 1);
  assert.equal(saved.activeOperation.followOptions.maximumSpeed, 1);
  assert.equal("pivotIfInnerWheelBelow" in saved.activeOperation.followOptions, false);
});

test("MowingExecutor locally replans once when a live connector leaves its route corridor", async () => {
  const connector = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.4, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.8, yMeters: 0, capturedAt: 3 },
    { xMeters: 1.2, yMeters: 0, capturedAt: 4 },
  ];
  const driveTargets = [];
  let followCallCount = 0;
  let pose = createPose(0, 0, createInternalHeading(0), "gnss");
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 90,
      stripSpacingMeters: 0.38,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: -1, yMeters: -1, capturedAt: 5 },
      { xMeters: 2, yMeters: -1, capturedAt: 6 },
      { xMeters: 2, yMeters: 1, capturedAt: 7 },
      { xMeters: -1, yMeters: 1, capturedAt: 8 },
      { xMeters: -1, yMeters: -1, capturedAt: 9 },
    ],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(request) {
        driveTargets.push([request.targetPosition.xMeters, request.targetPosition.yMeters]);
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return pose; },
    },
    continuousPathFollower: {
      async executePath() {
        followCallCount += 1;
        pose = createPose(0.6, 0.4, createInternalHeading(0), "gnss");
        return {
          completed: false,
          reason: "error",
          error: "continuous_path_pose_too_far_from_route",
          completedWaypoints: 2,
        };
      },
    },
    logger: createLogger(),
  });

  const result = await executor["followConnector"](
    connector,
    55,
    { stage: "strip_approach", stripIndex: 56 },
  );

  assert.equal(result.completed, true);
  assert.equal(followCallCount, 1);
  assert.deepEqual(driveTargets, [[1.2, 0]]);
});

test("MowingExecutor passes saved continuous-follow progress back to the follower on resume", async () => {
  const pathPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.2, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.4, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.6, yMeters: 0, capturedAt: 4 },
  ];
  const followCalls = [];
  const plan = {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    bladeWidthMeters: 0.4,
    stripCount: 0,
    strips: [],
    connectors: [],
  };
  const areaPoints = [
    { xMeters: -1, yMeters: -1, capturedAt: 10 },
    { xMeters: 1, yMeters: -1, capturedAt: 11 },
    { xMeters: 1, yMeters: 1, capturedAt: 12 },
    { xMeters: -1, yMeters: 1, capturedAt: 13 },
    { xMeters: -1, yMeters: -1, capturedAt: 14 },
  ];
  const resumeState = {
    version: 2,
    areaName: "Back lawn",
    savedAt: Date.now(),
    currentStripIndex: 0,
    totalStrips: 0,
    tracedBoundaryKeys: [],
    plan,
    areaPoints,
    obstaclePointsArray: [],
    initialEntryPlan: null,
    activeOperation: {
      kind: "follow_path",
      phase: "following_connector",
      stripIndex: 0,
      pathPoints,
      followOptions: {
        loopPath: false,
        strictOrderedProgress: true,
        initialTargetIndex: 2,
      },
      errorCode: "connector_failed",
      continuation: { stage: "complete", stripIndex: 0 },
    },
  };
  const executor = new MowingExecutor({
    areaName: "Back lawn",
    plan,
    areaPoints,
    obstaclePointsArray: [],
    driveController: {
      async executeDrive() { return { status: "success", maxCteMeters: 0 }; },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(0.4, 0, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath(points, options) {
        followCalls.push({ points, options });
        return {
          completed: true,
          reason: "reached_end",
          completedWaypoints: points.length,
          pointCount: points.length,
          algorithm: "continuous_path_follow",
        };
      },
    },
    logger: createLogger(),
    resumeState,
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].options.initialTargetIndex, 2);
  assert.equal(followCalls[0].options.pivotAtWaypointTurnDeg, 20);
  assert.equal(followCalls[0].options.pivotAtWaypointDistanceMeters, 0.15);
  assert.equal(followCalls[0].options.minimumSpeed, 1);
  assert.equal(followCalls[0].options.maximumSpeed, 1);
  assert.equal("pivotIfInnerWheelBelow" in followCalls[0].options, false);
});

test("MowingExecutor safely replans from a displaced pose to the pending connector target on resume", async () => {
  const savedStates = [];
  const followCalls = [];
  const operation = {
    kind: "follow_path",
    phase: "following_connector",
    stripIndex: 55,
    pathPoints: [
      { xMeters: 1, yMeters: 1, capturedAt: 1 },
      { xMeters: 2, yMeters: 1, capturedAt: 2 },
      { xMeters: 3, yMeters: 1, capturedAt: 3 },
      { xMeters: 4, yMeters: 1, capturedAt: 4 },
    ],
    followOptions: {
      loopPath: false,
      strictOrderedProgress: true,
      initialTargetIndex: 2,
    },
    errorCode: "connector_failed",
    continuation: { stage: "strip_approach", stripIndex: 56 },
  };
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 0,
      stripSpacingMeters: 0.38,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 10 },
      { xMeters: 5, yMeters: 0, capturedAt: 11 },
      { xMeters: 5, yMeters: 5, capturedAt: 12 },
      { xMeters: 0, yMeters: 5, capturedAt: 13 },
      { xMeters: 0, yMeters: 0, capturedAt: 14 },
    ],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive() { return { status: "success", maxCteMeters: 0 }; },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(2, 3, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath(points, options) {
        followCalls.push({ points, options });
        return {
          completed: true,
          reason: "reached_end",
          completedWaypoints: points.length,
          pointCount: points.length,
          algorithm: "continuous_path_follow",
        };
      },
    },
    logger: createLogger(),
    updateResumeState(state) { savedStates.push(state); },
  });

  const continuation = await executor["executeResumeOperation"](operation);

  assert.deepEqual(continuation, operation.continuation);
  assert.equal(followCalls.length, 1);
  assert.deepEqual(
    followCalls[0].points.map(({ xMeters, yMeters }) => [xMeters, yMeters]),
    [[2, 3], [3, 1], [4, 1]],
  );
  assert.equal(followCalls[0].options.initialTargetIndex, 1);
  assert.equal(followCalls[0].options.preserveFirstTargetAtPose, true);
  assert.deepEqual(
    savedStates.at(-1).activeOperation.pathPoints.map(({ xMeters, yMeters }) => [xMeters, yMeters]),
    [[2, 3], [3, 1], [4, 1]],
  );
});

test("MowingExecutor resumes a saved two-point connector through DriveController", async () => {
  const driveRequests = [];
  const operation = {
    kind: "follow_path",
    phase: "following_connector",
    stripIndex: 3,
    pathPoints: [
      { xMeters: 15.744475424812707, yMeters: 17.403234714308642, capturedAt: 1 },
      { xMeters: 12.48110393941283, yMeters: 14.966004617521396, capturedAt: 2 },
    ],
    followOptions: { loopPath: false, strictOrderedProgress: true, initialTargetIndex: 1 },
    errorCode: "connector_failed",
    continuation: { stage: "strip_approach", stripIndex: 4 },
  };
  const executor = new MowingExecutor({
    plan: {
      headingDeg: 26,
      stripSpacingMeters: 0.38,
      bladeWidthMeters: 0.4,
      stripCount: 0,
      strips: [],
      connectors: [],
    },
    areaPoints: [
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 20, yMeters: 0, capturedAt: 2 },
      { xMeters: 20, yMeters: 20, capturedAt: 3 },
      { xMeters: 0, yMeters: 20, capturedAt: 4 },
      { xMeters: 0, yMeters: 0, capturedAt: 5 },
    ],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(request) {
        driveRequests.push(request);
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: {
      getCurrentPose() {
        return createPose(15.5, 17.2, createInternalHeading(24), "gnss");
      },
    },
    continuousPathFollower: {
      async executePath() {
        assert.fail("a resumed two-point connector must not enter continuous following");
      },
    },
    logger: createLogger(),
  });

  const continuation = await executor["executeResumeOperation"](operation);

  assert.deepEqual(continuation, operation.continuation);
  assert.equal(driveRequests.length, 1);
  assert.equal(driveRequests[0].targetPosition.xMeters, 12.48110393941283);
  assert.equal(driveRequests[0].targetPosition.yMeters, 14.966004617521396);
});

test("MowingExecutor stages a displaced obstacle-boundary resume before following only perimeter points", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 10, yMeters: 0, capturedAt: 2 },
    { xMeters: 10, yMeters: 10, capturedAt: 3 },
    { xMeters: 0, yMeters: 10, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const obstacle = [
    { xMeters: 4, yMeters: 4, capturedAt: 10 },
    { xMeters: 5, yMeters: 4, capturedAt: 11 },
    { xMeters: 5, yMeters: 5, capturedAt: 12 },
    { xMeters: 4, yMeters: 5, capturedAt: 13 },
    { xMeters: 4, yMeters: 4, capturedAt: 14 },
  ];
  const followedPaths = [];
  const driveTargets = [];
  const turnRequests = [];
  let pose = createPose(3, 4.5, createInternalHeading(90), "gnss");
  const plan = { headingDeg: 0, stripSpacingMeters: 0.3, bladeWidthMeters: 0.4, stripCount: 0, strips: [], connectors: [] };
  const resumeState = {
    version: 2,
    areaName: "Back lawn",
    savedAt: Date.now(),
    currentStripIndex: 0,
    totalStrips: 0,
    tracedBoundaryKeys: [],
    plan,
    areaPoints,
    obstaclePointsArray: [obstacle],
    initialEntryPlan: null,
    activeOperation: {
      kind: "follow_path",
      phase: "tracing_boundary",
      stripIndex: 0,
      pathPoints: obstacle,
      followOptions: { loopPath: false, strictOrderedProgress: true, initialTargetIndex: 1 },
      errorCode: "boundary_trace_failed",
      continuation: { stage: "complete", stripIndex: 0 },
      markBoundaryTraced: "obstacle:0",
    },
  };
  const executor = new MowingExecutor({
    areaName: "Back lawn",
    plan,
    areaPoints,
    obstaclePointsArray: [obstacle],
    driveController: {
      async executeDrive(request) {
        driveTargets.push([request.targetPosition.xMeters, request.targetPosition.yMeters]);
        pose = createPose(
          request.targetPosition.xMeters,
          request.targetPosition.yMeters,
          pose.heading,
          "gnss",
        );
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: {
      async executeTurn(request) {
        turnRequests.push(request);
        pose = createPose(pose.position.xMeters, pose.position.yMeters, createInternalHeading(0), "gnss");
        return { status: "success" };
      },
    },
    poseFusion: { getCurrentPose() { return pose; } },
    continuousPathFollower: {
      async executePath(points) {
        followedPaths.push(points);
        return { completed: true, reason: "reached_end", completedWaypoints: points.length };
      },
    },
    logger: createLogger(),
    resumeState,
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.deepEqual(driveTargets, [[3.9, 4]]);
  assert.equal(turnRequests.length, 1);
  assert.equal(followedPaths.length, 1);
  assert.equal(followedPaths[0][0].xMeters, 4);
  assert.equal(followedPaths[0][0].yMeters, 4);
  assert.equal(followedPaths[0].some((point) => point.xMeters === 3 && point.yMeters === 4.5), false);
  assert.notEqual(followedPaths[0], obstacle);
});

test("MowingExecutor recovers a nearby outside resume pose before continuing", async () => {
  const areaPoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 10, yMeters: 0, capturedAt: 2 },
    { xMeters: 10, yMeters: 10, capturedAt: 3 },
    { xMeters: 0, yMeters: 10, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const plan = { headingDeg: 0, stripSpacingMeters: 0.3, bladeWidthMeters: 0.4, stripCount: 0, strips: [], connectors: [] };
  let pose = createPose(-0.2, 5, createInternalHeading(180), "gnss");
  const driveTargets = [];
  const resumeState = {
    version: 2,
    areaName: "Back lawn",
    savedAt: Date.now(),
    currentStripIndex: 0,
    totalStrips: 0,
    tracedBoundaryKeys: [],
    plan,
    areaPoints,
    obstaclePointsArray: [],
    initialEntryPlan: null,
    activeOperation: {
      kind: "turn",
      phase: "mowing_strip",
      stripIndex: 0,
      targetHeadingDeg: 0,
      continuation: { stage: "complete", stripIndex: 0 },
    },
  };
  const executor = new MowingExecutor({
    areaName: "Back lawn",
    plan,
    areaPoints,
    obstaclePointsArray: [],
    driveController: {
      async executeDrive(request) {
        driveTargets.push([request.targetPosition.xMeters, request.targetPosition.yMeters]);
        pose = createPose(request.targetPosition.xMeters, request.targetPosition.yMeters, createInternalHeading(0), "gnss");
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: { async executeTurn() { return { status: "success" }; } },
    poseFusion: { getCurrentPose() { return pose; } },
    continuousPathFollower: { async executePath() { assert.fail("no path follow expected"); } },
    logger: createLogger(),
    resumeState,
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.equal(driveTargets.length, 1);
  assert.equal(driveTargets[0][0] > 0, true);
  assert.equal(Math.abs(driveTargets[0][1] - 5) < 1e-9, true);
});
