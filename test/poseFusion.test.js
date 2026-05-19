import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import { PoseFusion } from "../dist/sensing/poseFusion.js";
import { createInternalHeading, unwrapInternalHeading } from "../dist/geometry/headingTypes.js";

function createMockLogger() {
  return {
    child: () => createMockLogger(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
  };
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
