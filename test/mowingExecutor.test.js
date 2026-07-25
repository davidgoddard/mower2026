import test from "node:test";
import assert from "node:assert/strict";
import { MowingExecutor } from "../dist/pathfollowing/mowingExecutor.js";
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
  assert.equal(followCalls[0].options.minimumSpeed, 0.75);
  assert.equal(followCalls[0].options.maximumSpeed, 0.75);
  assert.equal(followCalls[0].options.pivotIfInnerWheelBelow, 0.4);
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
  assert.equal(followCalls.at(-1).options.minimumSpeed, 0.75);
  assert.equal(followCalls.at(-1).options.maximumSpeed, 0.75);
  assert.equal(followCalls.at(-1).options.pivotIfInnerWheelBelow, 0.4);
});

test("MowingExecutor simplifies a safe short multi-point connector to a direct transfer", async () => {
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

test("MowingExecutor resumes from a saved strip-drive operation without replanning", async () => {
  const driveTargets = [];
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([
        options.targetPosition.xMeters,
        options.targetPosition.yMeters,
      ]);
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
    areaPoints,
    obstaclePointsArray: [],
    driveController,
    turnController,
    poseFusion,
    continuousPathFollower,
    logger: createLogger(),
    resumeState: {
      version: 1,
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
  });

  const status = await executor.execute();

  assert.equal(status.phase, "complete");
  assert.deepEqual(driveTargets, [[0, 0.85]]);
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
  assert.equal(followCalls.length >= 2, true);
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
  const driveController = {
    async executeDrive(options) {
      driveTargets.push([options.targetPosition.xMeters, options.targetPosition.yMeters]);
      return { status: "success", maxCteMeters: 0 };
    },
    getCurrentPose() {
      return createPose(1, 2.2, createInternalHeading(270), "gnss");
    },
  };
  const turnController = {
    async executeTurn() {
      return { status: "success" };
    },
  };
  const poseFusion = {
    getCurrentPose() {
      return createPose(1, 2.2, createInternalHeading(270), "gnss");
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

test("MowingExecutor can seed area tracing from the nearest strip-adjacent perimeter anchor", async () => {
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
          start: { xMeters: 0.2, yMeters: 0, capturedAt: 10 },
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
  assert.deepEqual(driveTargets[0], [0.2, 0.15]);
  assert.equal(followCalls.length >= 1, true);
  if (checkpointWaypoints.length > 0) {
    assert.equal(
      checkpointWaypoints[0].some((point) => point.xMeters === 0.2 && point.yMeters === 0),
      true,
    );
  }
});

test("MowingExecutor persists the completed waypoint index when a continuous follow is interrupted", async () => {
  const savedStates = [];
  const connector = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.2, yMeters: 0, capturedAt: 2 },
    { xMeters: 0.4, yMeters: 0, capturedAt: 3 },
    { xMeters: 0.6, yMeters: 0, capturedAt: 4 },
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
    areaPoints: [],
    obstaclePointsArray: [],
    driveController: {
      async executeDrive() { return { status: "success", maxCteMeters: 0 }; },
    },
    turnController: {
      async executeTurn() { return { status: "success" }; },
    },
    poseFusion: {
      getCurrentPose() { return createPose(0.3, 0, createInternalHeading(0), "gnss"); },
    },
    continuousPathFollower: {
      async executePath() {
        return {
          completed: false,
          reason: "user_stopped",
          completedWaypoints: 2,
          pointCount: connector.length,
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
  assert.equal(saved.activeOperation.followOptions.initialTargetIndex, 2);
  assert.equal(saved.activeOperation.followOptions.pivotAtWaypointTurnDeg, 20);
  assert.equal(saved.activeOperation.followOptions.pivotAtWaypointDistanceMeters, 0.15);
  assert.equal(saved.activeOperation.followOptions.minimumSpeed, 0.75);
  assert.equal(saved.activeOperation.followOptions.maximumSpeed, 0.75);
  assert.equal(saved.activeOperation.followOptions.pivotIfInnerWheelBelow, 0.4);
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
  const resumeState = {
    version: 1,
    areaName: "Back lawn",
    savedAt: Date.now(),
    currentStripIndex: 0,
    totalStrips: 0,
    tracedBoundaryKeys: [],
    plan,
    areaPoints: [],
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
    areaPoints: [],
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
  assert.equal(followCalls[0].options.minimumSpeed, 0.75);
  assert.equal(followCalls[0].options.maximumSpeed, 0.75);
  assert.equal(followCalls[0].options.pivotIfInnerWheelBelow, 0.4);
});
