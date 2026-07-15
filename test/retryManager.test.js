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

function position(x, y = 0) {
  return createPose(x, y, createInternalHeading(0), "gnss").position;
}

test("RetryManager retries a high-current path obstruction using measured reverse progress", async () => {
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
      pathRetryReverseDistanceMeters: 0.2,
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
          return {
            status: "success",
            startPosition: position(0.25),
            finalPosition: position(0),
          };
        },
        async reverseForDuration(durationMs) {
          calls.push({ type: "reverseForDuration", durationMs });
          return { completed: true, startPosition: position(0.25), finalPosition: position(0) };
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
    type: "high_current",
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

for (const obstructionType of ["stall", "wheel_slip"]) {
  test(`RetryManager aborts ${obstructionType} instead of attempting recovery`, async () => {
    const checkpointStore = createPathCheckpointStore([
      { xMeters: 0, yMeters: 0, capturedAt: 1 },
      { xMeters: 1, yMeters: 0, capturedAt: 2 },
    ]);
    const calls = [];
    const retryManager = new RetryManager(
      { logger: createLogger(), checkpointStore },
      {
        motorController: {
          async stop() { calls.push("stop"); },
        },
        driveController: {
          async driveSegment() {
            calls.push("driveSegment");
            return { status: "success", startPosition: position(0), finalPosition: position(0.2) };
          },
          async reverseForDuration() {
            calls.push("reverseForDuration");
            return { completed: true, startPosition: position(0), finalPosition: position(-0.2) };
          },
        },
        async pathRestart() { calls.push("pathRestart"); },
        getCurrentPose() { return createPose(0.25, 0, createInternalHeading(0), "gnss"); },
      },
    );

    retryManager.startSession(`session-${obstructionType}`, "path");
    const result = await retryManager.handleObstruction({
      type: obstructionType,
      timestamp: Date.now(),
      context: "path",
      motorCurrents: { left: 2.1, right: 3.2 },
      position: createPose(0.25, 0, createInternalHeading(0), "gnss"),
    });

    assert.equal(result.success, false);
    assert.equal(result.error, `non_recoverable_${obstructionType}`);
    assert.deepEqual(calls, ["stop"]);
  });
}

test("RetryManager returns to the obstruction pose before restarting when fallback reverse makes progress", async () => {
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
        async stop() { calls.push("stop"); },
      },
      driveController: {
        async driveSegment(target, direction) {
          calls.push({ type: "driveSegment", target, direction });
          return {
            status: "success",
            startPosition: position(0.1),
            finalPosition: position(target.xMeters, target.yMeters),
          };
        },
        async reverseForDuration(durationMs) {
          calls.push({ type: "reverseForDuration", durationMs });
          return {
            completed: true,
            startPosition: position(0.35),
            finalPosition: position(0.1),
          };
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
    type: "high_current",
    timestamp: Date.now(),
    context: "path",
    motorCurrents: { left: 2.1, right: 3.2 },
    position: createPose(0.35, 0, createInternalHeading(0), "gnss"),
  });

  assert.equal(result.success, true);
  assert.equal(calls[0], "stop");
  assert.deepEqual(calls[1], { type: "reverseForDuration", durationMs: 250 });
  assert.deepEqual(calls[2], {
    type: "driveSegment",
    target: { xMeters: 0.35, yMeters: 0 },
    direction: 1,
  });
  assert.equal(calls[3].type, "pathRestart");
});

test("RetryManager does not restart the path when fallback reverse completes with no physical progress", async () => {
  const checkpointStore = createPathCheckpointStore([
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
  ]);
  const calls = [];
  const retryManager = new RetryManager(
    { logger: createLogger(), checkpointStore, reverseDurationMs: 250 },
    {
      motorController: { async stop() { calls.push("stop"); } },
      driveController: {
        async driveSegment() {
          calls.push("driveSegment");
          return { status: "success", startPosition: position(0), finalPosition: position(0) };
        },
        async reverseForDuration() {
          calls.push("reverseForDuration");
          return { completed: true, startPosition: position(0.35), finalPosition: position(0.35) };
        },
      },
      async pathRestart() { calls.push("pathRestart"); },
      getCurrentPose() { return createPose(0.35, 0, createInternalHeading(0), "gnss"); },
    },
  );

  retryManager.startSession("session-no-progress", "path");
  const result = await retryManager.handleObstruction({
    type: "high_current",
    timestamp: Date.now(),
    context: "path",
    motorCurrents: { left: 3, right: 3 },
    position: createPose(0.35, 0, createInternalHeading(0), "gnss"),
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "recovery_reverse_no_progress");
  assert.equal(calls.includes("pathRestart"), false);
  assert.equal(calls.includes("driveSegment"), false);
});
