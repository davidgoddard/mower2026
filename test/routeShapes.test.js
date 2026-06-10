import test from "node:test";
import assert from "node:assert/strict";

import { PrimitivesStore, routeServerRequest, shouldClearSystemStopForPost } from "../dist/index.js";

const APP = "mower-core-test";

function snapshot() {
  return new PrimitivesStore().snapshot();
}

test("/health returns ok envelope with state, app, and ISO timestamp", () => {
  const route = routeServerRequest("GET", "/health", "running", APP, snapshot());
  assert.equal(route.statusCode, 200);
  assert.equal(route.contentType.startsWith("application/json"), true);

  const body = JSON.parse(route.body);
  assert.equal(body.ok, true);
  assert.equal(body.app, APP);
  assert.equal(body.state, "running");
  assert.ok(typeof body.timestamp === "string");
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
});

test("/api/primitives wraps the snapshot in a {state, primitives} envelope", () => {
  const route = routeServerRequest("GET", "/api/primitives", "running", APP, snapshot());
  assert.equal(route.statusCode, 200);

  const body = JSON.parse(route.body);
  assert.equal(body.state, "running");
  assert.ok(typeof body.primitives === "object" && body.primitives !== null);
  assert.ok("imu" in body.primitives);
  assert.ok("gnss" in body.primitives);
  assert.ok("motors" in body.primitives);
  assert.ok("poseFusion" in body.primitives);
  assert.equal(typeof body.primitives.poseFusion.usingGnssHeading, "boolean");
});

test("/api/turn/status returns 503 with error code when controller is missing", () => {
  const route = routeServerRequest("GET", "/api/turn/status", "running", APP, snapshot(), null);
  assert.equal(route.statusCode, 503);

  const body = JSON.parse(route.body);
  assert.equal(body.error, "turn_controller_not_available");
});

test("/api/turn/status returns full envelope when controller and validation runner present", () => {
  const turnState = { phase: "idle" };
  const turnHistory = [];
  const validationHistory = [{ requestedAngle: 30, achievedAngle: 28 }];
  const validationState = { running: false };

  const turnController = {
    getState: () => turnState,
    getTurnHistory: () => turnHistory,
  };
  const turnValidationRunner = {
    getHistory: () => validationHistory,
    getState: () => validationState,
  };

  const route = routeServerRequest("GET", "/api/turn/status", "running", APP, snapshot(), turnController, turnValidationRunner);
  assert.equal(route.statusCode, 200);

  const body = JSON.parse(route.body);
  assert.deepEqual(body.state, turnState);
  assert.deepEqual(body.history, turnHistory);
  assert.deepEqual(body.realPoseHistory, validationHistory);
  assert.deepEqual(body.realPoseValidation, validationState);
});

test("/api/drive/status returns 503 when any required dependency is missing", () => {
  const route = routeServerRequest("GET", "/api/drive/status", "running", APP, snapshot(), null, null, null, null, null, null, null);
  assert.equal(route.statusCode, 503);

  const body = JSON.parse(route.body);
  assert.equal(body.error, "drive_controller_not_available");
});

test("/api/drive/status returns 503 when only some dependencies are present", () => {
  const driveController = { getState: () => ({}), getDriveHistory: () => [] };
  const route = routeServerRequest(
    "GET", "/api/drive/status", "running", APP, snapshot(),
    null, null, driveController, null, null, null, null,
  );
  assert.equal(route.statusCode, 503);
});

test("/api/drive/status merges learning, encoder calibration, and motor ramp times into parameters", () => {
  const driveController = {
    getState: () => ({ phase: "idle" }),
    getDriveHistory: () => [{ id: 1 }],
  };
  const driveLearningModel = {
    getParameters: () => ({ brakeDistanceMeters: 0.18, learningRate: 0.1 }),
  };
  const poseFusion = {
    getEncoderCalibration: () => ({ leftMetersPerTick: 0.0001, rightMetersPerTick: 0.0001 }),
  };
  const motorCalibration = {
    getRampDownTime: () => 700,
    getRampUpTime: () => 460,
  };

  const route = routeServerRequest(
    "GET", "/api/drive/status", "running", APP, snapshot(),
    null, null, driveController, driveLearningModel, poseFusion, motorCalibration, null,
  );

  assert.equal(route.statusCode, 200);
  const body = JSON.parse(route.body);
  assert.deepEqual(body.state, { phase: "idle" });
  assert.equal(body.history.length, 1);
  assert.equal(body.parameters.brakeDistanceMeters, 0.18);
  assert.equal(body.parameters.learningRate, 0.1);
  assert.equal(body.parameters.motorRampDownTimeMs, 700);
  assert.equal(body.parameters.motorRampUpTimeMs, 460);
  assert.deepEqual(body.parameters.encoderMetersPerTick, { leftMetersPerTick: 0.0001, rightMetersPerTick: 0.0001 });
});

test("/api/segment/status returns 503 when runner missing and 200 envelope when present", () => {
  const route503 = routeServerRequest(
    "GET", "/api/segment/status", "running", APP, snapshot(),
    null, null, null, null, null, null, null, null,
  );
  assert.equal(route503.statusCode, 503);
  assert.equal(JSON.parse(route503.body).error, "segment_test_runner_not_available");

  const segmentTestRunner = {
    getState: () => ({ phase: "idle", running: false }),
    getHistory: () => [],
  };
  const route200 = routeServerRequest(
    "GET", "/api/segment/status", "running", APP, snapshot(),
    null, null, null, null, null, null, null, segmentTestRunner,
  );
  assert.equal(route200.statusCode, 200);
  const body = JSON.parse(route200.body);
  assert.deepEqual(body.state, { phase: "idle", running: false });
  assert.deepEqual(body.history, []);
});

test("unknown routes return a 404 not_found envelope", () => {
  const route = routeServerRequest("GET", "/api/does-not-exist", "running", APP, snapshot());
  assert.equal(route.statusCode, 404);
  const body = JSON.parse(route.body);
  assert.equal(body.error, "not_found");
});

test("non-stop POST actions clear the stop latch while stop actions do not", () => {
  assert.equal(shouldClearSystemStopForPost("/api/turn/execute"), true);
  assert.equal(shouldClearSystemStopForPost("/api/drive/execute"), true);
  assert.equal(shouldClearSystemStopForPost("/api/path/record/start"), true);
  assert.equal(shouldClearSystemStopForPost("/api/mowing/start"), true);

  assert.equal(shouldClearSystemStopForPost("/api/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/turn/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/drive/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/path/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/segment/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/mowing/stop"), false);
  assert.equal(shouldClearSystemStopForPost("/api/dead-reckoning/stop"), false);
});
