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

test("PoseFusion rebases the IMU from the first good GNSS heading fix", async () => {
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

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3.5,
    yMeters: 7.2,
    heading: createInternalHeading(120),
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

test("PoseFusion keeps GNSS position even when heading accuracy is too poor to rebase heading", async () => {
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
  assert.equal(fusion.getCurrentPose().quality, "gnss");

  await fusion.stop();
});

test("PoseFusion still syncs heading from GNSS when position accuracy is poor", async () => {
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
    positionAccuracyMeters: 0.101,
    headingAccuracyDeg: 1,
    fixType: "fixed",
    satellitesInUse: 12,
    timestampMillis: 1000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 90);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 90);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.xMeters), 0);
  assert.equal(unwrapMeters(fusion.getCurrentPose().position.yMeters), 0);
  assert.equal(fusion.getCurrentPose().quality, "unknown");

  await fusion.stop();
});

test("PoseFusion keeps the IMU heading when later GNSS is too far away and rebases only when close", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 10);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 2,
    yMeters: 3,
    heading: createInternalHeading(20),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 2600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 10);
  const rejectedLog = findLogCall(logger, "pose_fusion.gnss_heading_not_aligned");
  assert.ok(rejectedLog);
  assert.equal(rejectedLog.arguments[1].alignmentDeltaDeg, 10);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3,
    yMeters: 4,
    heading: createInternalHeading(11),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 3600,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 11);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 11);

  await fusion.stop();
});

test("PoseFusion rebases from GNSS after a long zero-speed stop even when heading gap is large", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  sensorController.getMotorZeroCommandSinceMillis = mock.fn(() => 1000);
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[0].arguments[0]), 10);

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(40),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 5000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 2,
    yMeters: 3,
    heading: createInternalHeading(100),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 6000,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 40);
  const heldOffLog = findLogCall(logger, "pose_fusion.gnss_heading_not_aligned");
  assert.ok(heldOffLog);
  assert.equal(heldOffLog.arguments[1].stationaryZeroCommandAgeMs, 5000);

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 3,
    yMeters: 4,
    heading: createInternalHeading(100),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 12001,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 100);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 100);
  const rebaseLog = findLogCall(logger, "pose_fusion.gnss_heading_rebased_after_stop");
  assert.ok(rebaseLog);
  assert.equal(rebaseLog.arguments[1].stationaryZeroCommandAgeMs, 11001);

  await fusion.stop();
});


test("PoseFusion rebases from GNSS after a consistent mirrored offset", async () => {
  const sensorController = new EventEmitter();
  sensorController.setHeading = mock.fn();
  sensorController.getMotorZeroCommandSinceMillis = mock.fn(() => null);
  const logger = createMockLogger();
  const fusion = new PoseFusion({
    sensorController,
    logger,
  });

  await fusion.start();

  sensorController.emit("imuHeadingUpdate", {
    heading: createInternalHeading(10),
    pitchDeg: 0,
    rollDeg: 0,
    timestampMillis: 1000,
  });

  sensorController.emit("gnssPositionUpdate", {
    xMeters: 1,
    yMeters: 2,
    heading: createInternalHeading(10),
    positionAccuracyMeters: 0.03,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis: 1100,
  });

  assert.equal(sensorController.setHeading.mock.calls.length, 1);

  const samples = [
    { imu: 20, gnss: 30, t: 2000 },
    { imu: 24, gnss: 34, t: 2300 },
    { imu: 28, gnss: 38, t: 2600 },
    { imu: 31, gnss: 41, t: 2900 },
    { imu: 35, gnss: 45, t: 3200 },
    { imu: 39, gnss: 49, t: 3500 },
  ];

  for (const sample of samples) {
    sensorController.emit("imuHeadingUpdate", {
      heading: createInternalHeading(sample.imu),
      pitchDeg: 0,
      rollDeg: 0,
      timestampMillis: sample.t,
    });

    sensorController.emit("gnssPositionUpdate", {
      xMeters: 1,
      yMeters: 2,
      heading: createInternalHeading(sample.gnss),
      positionAccuracyMeters: 0.03,
      headingAccuracyDeg: 0.4,
      fixType: "fixed",
      satellitesInUse: 20,
      timestampMillis: sample.t,
    });
  }

  assert.equal(sensorController.setHeading.mock.calls.length, 2);
  assert.equal(unwrapInternalHeading(sensorController.setHeading.mock.calls[1].arguments[0]), 49);
  assert.equal(unwrapInternalHeading(fusion.getCurrentPose().heading), 49);

  const rebaseLog = findLogCall(logger, "pose_fusion.gnss_heading_rebased_after_consistent_offset");
  assert.ok(rebaseLog);
  assert.equal(Math.round(rebaseLog.arguments[1].alignmentDeltaDeg), 10);
  assert.equal(rebaseLog.arguments[1].consistentOffsetDurationMs >= 1500, true);
  assert.equal(rebaseLog.arguments[1].consistentOffsetSamples >= 6, true);

  await fusion.stop();
});
