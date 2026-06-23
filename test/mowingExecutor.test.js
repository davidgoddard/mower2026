import test from "node:test";
import assert from "node:assert/strict";
import { MowingExecutor } from "../dist/pathfollowing/mowingExecutor.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPose } from "../dist/geometry/positionTypes.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

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
  assert.equal(followCalls.length >= 2, true);
  assert.equal(followCalls[0].options.loopPath, false);
  assert.equal(followCalls[0].options.strictOrderedProgress, true);
  assert.equal(turnCalls.length >= 2, true);
  const traversedPoints = followCalls.flatMap((call) => call.pathPoints.map((point) => [point.xMeters, point.yMeters]));
  assert.equal(traversedPoints.some(([x, y]) => x === 0 && y === 0), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 1 && y === 0), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 1 && y === 1), true);
  assert.equal(traversedPoints.some(([x, y]) => x === 0 && y === 1), true);
});

test("MowingExecutor drives a short capture segment after a perimeter corner turn", async () => {
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
  assert.equal(driveTargets.length > 0, true);
  assert.deepEqual(driveTargets[0], [1, 0.3]);
  assert.equal(followCalls.length >= 2, true);
  assert.deepEqual(
    followCalls[1].pathPoints.slice(0, 2).map((point) => [point.xMeters, point.yMeters]),
    [
      [1, 0.3],
      [1, 1],
    ],
  );
});

test("MowingExecutor follows multi-point connectors with the continuous follower", async () => {
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
  assert.equal(followCalls.length, 2);
  assert.deepEqual(
    followCalls[1].pathPoints.map((point) => [point.xMeters, point.yMeters]),
    [
      [0.5, 0.85],
      [0.75, 0.95],
      [1, 0.85],
    ],
  );
  assert.equal(followCalls[1].options.loopPath, false);
  assert.equal(followCalls[1].options.strictOrderedProgress, true);
});

test("MowingExecutor uses a direct lane transfer when no obstacle blocks the next strip", async () => {
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
    createPose(0.1, 0.1, createInternalHeading(90), "gnss"),
    createPose(0.1, 0.1, createInternalHeading(90), "gnss"),
    createPose(0.5, 0.85, createInternalHeading(90), "gnss"),
  ];
  const poseFusion = {
    getCurrentPose() {
      return poses[0] ?? createPose(0.5, 0.85, createInternalHeading(90), "gnss");
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

  const result = await executor["followDirectLaneTransfer"](1, 0.85);

  assert.equal(result.completed, true);
  assert.deepEqual(driveTargets, [[1, 0.85]]);
  assert.equal(followCalls.length, 0);
});

test("MowingExecutor keeps routed connector following when an obstacle blocks direct transfer", async () => {
  const poseFusion = {
    getCurrentPose() {
      return createPose(0, 0, createInternalHeading(0), "gnss");
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
    obstaclePointsArray: [[
      { xMeters: 0.4, yMeters: -0.2, capturedAt: 1 },
      { xMeters: 0.6, yMeters: -0.2, capturedAt: 2 },
      { xMeters: 0.6, yMeters: 0.2, capturedAt: 3 },
      { xMeters: 0.4, yMeters: 0.2, capturedAt: 4 },
      { xMeters: 0.4, yMeters: -0.2, capturedAt: 5 },
    ]],
    driveController: {
      async executeDrive() {
        return { status: "success", maxCteMeters: 0 };
      },
    },
    turnController: {
      async executeTurn() {
        return { status: "success" };
      },
    },
    poseFusion,
    continuousPathFollower: {
      async executePath() {
        return { completed: true, reason: "reached_end" };
      },
    },
    logger: createLogger(),
  });

  assert.equal(executor["shouldUseDirectLaneTransfer"](1, 0), false);
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
  ]);

  assert.equal(result.completed, true);
  assert.equal(result.reason, "reached_end");
  assert.deepEqual(driveTargets, []);
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
