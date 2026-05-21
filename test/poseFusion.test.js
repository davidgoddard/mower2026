import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import { PoseFusion } from "../dist/sensing/poseFusion.js";
import { createInternalHeading, unwrapInternalHeading } from "../dist/geometry/headingTypes.js";
import { unwrapMeters } from "../dist/geometry/positionTypes.js";

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

function findLogCall(logger, message) {
  return logger.info.mock.calls.find((call) => call.arguments[0] === message);
}

test("PoseFusion resets the IMU baseline from a good GNSS heading fix", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(25),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  const gnssHeading = createInternalHeading(120);
  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3.5,
    yMeters: 7.2,
    heading: gnssHeading,
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1500,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 120);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 120);

  await fusion.stop();
});

test("PoseFusion ignores poor GNSS fixes when deciding whether to reset heading", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.5,
    fixType: "single",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);

  await fusion.stop();
});

test("PoseFusion rejects GNSS when heading accuracy is too poor even if fix and position are good", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 6,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);
  assert.equal(fusion.getCurrentPose().quality, "unknown");

  await fusion.stop();
});

test("PoseFusion rejects GNSS when position accuracy is too poor even if fix and heading are good", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const fusion = new PoseFusion({
    sensorController,
    logger: createMockLogger(),
  });

  await fusion.start();

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.06,
    headingAccuracyDeg: 1,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 0);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 0);
  assert.equal(fusion.getCurrentPose().quality, "unknown");

  await fusion.stop();
});

test("PoseFusion stationaryPose waits, samples five times, and returns the median GNSS pose", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const logger = createMockLogger();
  const sleepCalls = [];
  const updates = [
    { x: 1, y: 1, heading: 11 },
    { x: 2, y: 2, heading: 12 },
    { x: 3, y: 3, heading: 13 },
    { x: 4, y: 4, heading: 14 },
  ];
  let updateIndex = 0;

  const fusion = new PoseFusion({
    sensorController,
    logger,
    sleep: async (delayMs) => {
      sleepCalls.push(delayMs);
      const update = sleepCalls.length >= 17 && sleepCalls.length % 2 === 1
        ? updates[updateIndex++]
        : null;
      if (update) {
        sensorController.emit("gnssPositionUpdate", {
          xMeters: update.x,
          yMeters: update.y,
          heading: createInternalHeading(update.heading),
          positionAccuracyMeters: 0.03,
          headingAccuracyDeg: 0.4,
          fixType: "fixed",
          satellitesInUse: 20,
          timestampMillis: 1000 + updateIndex * 100,
        });
      }
    },
  });

  await fusion.start();
  sensorController.emit("gnssPositionUpdate", {
    xMeters: 0,
    yMeters: 0,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 900,
  });

  const stationaryPose = await fusion.stationaryPose();

  assert.equal(sleepCalls.length, 23);
  assert.equal(sleepCalls.every((delayMs) => delayMs === 50), true);
  assert.equal(unwrapMeters(stationaryPose.position.xMeters), 2);
  assert.equal(unwrapMeters(stationaryPose.position.yMeters), 2);
  assert.equal(unwrapInternalHeading(stationaryPose.heading), 12);
  assert.equal(stationaryPose.quality, "gnss");

  const logCall = findLogCall(logger, "pose_fusion.stationary_pose.sampled");
  assert.ok(logCall);
  assert.equal(logCall.arguments[1].sampleCount, 5);
  assert.equal(logCall.arguments[1].goodSampleCount, 5);
  assert.equal(logCall.arguments[1].samples.length, 5);
  assert.equal(logCall.arguments[1].selected.headingDeg, 12);
  assert.equal(logCall.arguments[1].selected.quality, "gnss");

  await fusion.stop();
});

test("PoseFusion stationaryPose falls back to the IMU pose when no good GNSS samples are available", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const logger = createMockLogger();
  const sleepCalls = [];

  const fusion = new PoseFusion({
    sensorController,
    logger,
    sleep: async (delayMs) => {
      sleepCalls.push(delayMs);
    },
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(42),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 10,
    yMeters: 20,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.5,
    headingAccuracyDeg: 3,
    fixType: "single",
    satellitesInUse: 12,
    timestampMillis: 1100,
  });

  const stationaryPose = await fusion.stationaryPose();

  assert.equal(sleepCalls.length, 23);
  assert.equal(sleepCalls.every((delayMs) => delayMs === 50), true);
  assert.equal(unwrapInternalHeading(stationaryPose.heading), 42);
  assert.equal(stationaryPose.quality, "unknown");
  assert.equal(sensorController.setHeading.mock.calls.length, 0);

  const logCall = findLogCall(logger, "pose_fusion.stationary_pose.fallback_to_imu");
  assert.ok(logCall);
  assert.equal(logCall.arguments[1].sampleCount, 5);
  assert.equal(logCall.arguments[1].samples.length, 5);
  assert.equal(logCall.arguments[1].selected.headingDeg, 42);
  assert.equal(logCall.arguments[1].selected.quality, "unknown");

  await fusion.stop();
});
