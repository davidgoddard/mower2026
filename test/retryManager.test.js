import test from "node:test";
import assert from "node:assert/strict";
import { RetryManager } from "../dist/retry/retryManager.js";
import { CheckpointStore } from "../dist/retry/checkpointStore.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() { return this; },
  };
}

function createPathCheckpointStore(waypoints) {
  const store = new CheckpointStore({ logger: createLogger() });
  store.addCheckpoint({
    id: "cp-1",
    timestamp: Date.now(),
    pose: createPose(0, 0, createInternalHeading(0), "gnss"),
    context: "path",
    metadata: {
      type: "path",
      waypoints,
    },
  });
  return store;
}

test("RetryManager treats stall as recoverable in path context", async () => {
  const waypoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ];
  const checkpointStore = createPathCheckpointStore(waypoints);
  const calls = [];
  const retryManager = new RetryManager(
    {
      logger: createLogger(),
      checkpointStore,
      reverseDurationMs: 250,
      pathRetryReverseDistanceMeters: 0.5,
    },
    {
      motorController: {
        async stop() {
          calls.push("stop");
        },
      },
      driveController: {
        async driveSegment(target, direction) {
          calls.push({ type: "driveSegment", target, direction });
        },
        async reverseForDuration(durationMs) {
          calls.push({ type: "reverseForDuration", durationMs });
        },
      },
      async pathRestart(restartWaypoints) {
        calls.push({ type: "pathRestart", restartWaypoints });
      },
      getCurrentPose() {
        return createPose(0.25, 0, createInternalHeading(0), "gnss");
      },
    },
  );

  retryManager.startSession("session-1", "path");
  retryManager.recordCompletedTarget({ xMeters: 0, yMeters: 0, capturedAt: 1 });

  const result = await retryManager.handleObstruction({
    type: "stall",
    timestamp: Date.now(),
    context: "path",
    motorCurrents: { left: 2.1, right: 3.2 },
    position: createPose(0.25, 0, createInternalHeading(0), "gnss"),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0], "stop");
  assert.deepEqual(calls[1], {
    type: "driveSegment",
    target: { xMeters: 0, yMeters: 0 },
    direction: -1,
  });
  assert.equal(calls[2].type, "pathRestart");
});

test("RetryManager treats wheel slip as recoverable in path context", async () => {
  const waypoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ];
  const checkpointStore = createPathCheckpointStore(waypoints);
  const calls = [];
  const retryManager = new RetryManager(
    {
      logger: createLogger(),
      checkpointStore,
    },
    {
      motorController: {
        async stop() {
          calls.push("stop");
        },
      },
      driveController: {
        async driveSegment() {
          calls.push("driveSegment");
        },
        async reverseForDuration() {
          calls.push("reverseForDuration");
        },
      },
      async pathRestart() {
        calls.push("pathRestart");
      },
      getCurrentPose() {
        return createPose(0.25, 0, createInternalHeading(0), "gnss");
      },
    },
  );

  retryManager.startSession("session-2", "path");
  retryManager.recordCompletedTarget({ xMeters: 0, yMeters: 0, capturedAt: 1 });

  const result = await retryManager.handleObstruction({
    type: "wheel_slip",
    timestamp: Date.now(),
    context: "path",
    motorCurrents: { left: 2.1, right: 3.2 },
    position: createPose(0.25, 0, createInternalHeading(0), "gnss"),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0], "stop");
  assert.equal(calls[1], "driveSegment");
  assert.equal(calls[2], "pathRestart");
});

test("RetryManager returns to the obstruction pose before restarting when no recent targets exist", async () => {
  const waypoints = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ];
  const checkpointStore = createPathCheckpointStore(waypoints);
  const calls = [];
  const retryManager = new RetryManager(
    {
      logger: createLogger(),
      checkpointStore,
      reverseDurationMs: 250,
      pathRetryReverseDistanceMeters: 0.5,
    },
    {
      motorController: {
        async stop() {
          calls.push("stop");
        },
      },
      driveController: {
        async driveSegment(target, direction) {
          calls.push({ type: "driveSegment", target, direction });
        },
        async reverseForDuration(durationMs) {
          calls.push({ type: "reverseForDuration", durationMs });
        },
      },
      async pathRestart(restartWaypoints) {
        calls.push({ type: "pathRestart", restartWaypoints });
      },
      getCurrentPose() {
        return createPose(0.1, 0, createInternalHeading(0), "gnss");
      },
    },
  );

  retryManager.startSession("session-3", "path");

  const result = await retryManager.handleObstruction({
    type: "stall",
    timestamp: Date.now(),
    context: "path",
    motorCurrents: { left: 2.1, right: 3.2 },
    position: createPose(0.35, 0, createInternalHeading(0), "gnss"),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0], "stop");
  assert.deepEqual(calls[1], {
    type: "reverseForDuration",
    durationMs: 250,
  });
  assert.deepEqual(calls[2], {
    type: "driveSegment",
    target: { xMeters: 0.35, yMeters: 0 },
    direction: 1,
  });
  assert.equal(calls[3].type, "pathRestart");
});
