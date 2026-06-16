import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnController } from "../dist/control/turnController.js";
import { TurnLearningModel } from "../dist/control/turnLearningModel.js";
import { createRelativeAngle, createInternalHeading, unwrapRelativeAngle } from "../dist/geometry/headingTypes.js";
import { SENSOR_EVENTS } from "../dist/sensing/sensorEvents.js";

describe("TurnController", () => {
  function createMockLogger() {
    return {
      child: () => createMockLogger(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
      transition: mock.fn(),
      flush: mock.fn(),
      close: mock.fn(),
    };
  }

  function createMockSensorController() {
    let heading = createInternalHeading(0);
    let wheelSpeedLeft = 0;
    let wheelSpeedRight = 0;
    const emitter = new EventEmitter();

    // Create mock that extends EventEmitter behavior
    const controller = {
      getHeading: () => heading,
      setHeading: (h) => { heading = h; },
      setMotorWheelOutputs: mock.fn(async (left, right) => {
        wheelSpeedLeft = left;
        wheelSpeedRight = right;
      }),
      stopMotors: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      requestNeutralMotorOutputs: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      beginMotionSession: mock.fn(),
      endMotionSession: mock.fn(),
      _testSetHeading: (h) => { heading = h; },
      _testGetWheelSpeeds: () => ({ left: wheelSpeedLeft, right: wheelSpeedRight }),

      // EventEmitter methods
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      emit: (event, data) => emitter.emit(event, data),

      // Test helper to simulate sensor updates
      _testEmitHeadingUpdate: (headingValue, timestampMillis) => {
        emitter.emit(SENSOR_EVENTS.IMU_HEADING_UPDATE, {
          heading: headingValue,
          timestampMillis,
        });
      },
    };

    return controller;
  }

  function createMockLearningModel() {
    return {
      getBrakeAngle: mock.fn((angleDeg, direction) => {
        return createRelativeAngle(angleDeg * 0.7);
      }),
      getLargeBiasOffset: mock.fn(() => 0),
      getSmallTurnBrakeTimeMs: mock.fn((direction, angleDeg) => angleDeg * 45),
      getSmallAngleThreshold: () => 20,
      getSmallTurnBucketAngleDeg: (angleDeg) => Math.round(Math.abs(angleDeg) / 3) * 3,
      getLargeTurnBucketAngleDeg: (angleDeg) => Math.round(Math.abs(angleDeg) / 10) * 10,
      updateFromTurn: mock.fn(async () => {}),
      saveParameters: mock.fn(async () => {}),
      loadParameters: mock.fn(async () => {}),
      getParameters: mock.fn(() => ({ parameters: [] })),
      getLearningDiagnostics: mock.fn(() => ({})),
      resetToDefaults: mock.fn(async () => {}),
    };
  }

  // Motor calibration stub that makes coast-prediction maths simple:
  // decel = 250 %/s, crawl = 45% → effectiveRampMs = (45/250)*1000 = 180ms
  // → half-ramp window = 90ms.
  function createMockMotorCalibration() {
    return {
      getDecelPercentPerSecond: () => 250,
      getAccelPercentPerSecond: () => 217,
      getRampDownTime: () => 400,
      getRampUpTime: () => 600,
    };
  }

  function createTrainingResult(requestedAngleDeg, errorAngleDeg) {
    const achievedAngleDeg = requestedAngleDeg - errorAngleDeg;
    return {
      requestedAngle: createRelativeAngle(requestedAngleDeg),
      achievedAngle: createRelativeAngle(achievedAngleDeg),
      errorAngle: createRelativeAngle(errorAngleDeg),
      durationMs: 100,
      brakeDistanceUsed: createRelativeAngle(0),
      motorEngaged: true,
      status: "success",
      timestamp: new Date().toISOString(),
    };
  }

  it("executes a 90° CCW turn successfully", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      motorCalibration: createMockMotorCalibration(),
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    // Start turn and simulate heading updates.
    // With decel=250 %/s and crawl=0.45, effectiveRampMs = (45/250)×1000 = 180ms.
    // Rate window: 3° over 100ms → rate = 0.03 deg/ms.
    // predictedCoast = 0.03 × (180/2) = 0.03 × 90 = 2.7°.
    // At 87° progress: remaining = 3° ≤ 2.7° → brake fires.
    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: true,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    // First event: 84° progress
    mockSensor._testSetHeading(createInternalHeading(84));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(84), 900);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Second event: 87° progress, 100ms later — rate = 3/100 = 0.03 deg/ms,
    // remaining = 3° ≤ predictedCoast 2.7° → brake fires.
    mockSensor._testSetHeading(createInternalHeading(87));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(87), 1000);

    const result = await turnPromise;

    assert.equal(result.status, "success");
    assert.equal(mockSensor.setMotorWheelOutputs.mock.calls.length > 0, true);
    assert.equal(mockLearning.updateFromTurn.mock.calls.length, 1);
  });

  it("rate-based brake fires earlier when the mower is turning faster", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    // Model returns a static fallback of 10° (fires at 80° progress); bias zero.
    const mockLearning = {
      ...createMockLearningModel(),
      getBrakeAngle: mock.fn(() => createRelativeAngle(10)),
      getLargeBiasOffset: mock.fn(() => 0),
      getSmallAngleThreshold: () => 20,
    };

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      motorCalibration: createMockMotorCalibration(),
      nowMillis: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: false,
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // decel=250 %/s, crawl=0.45 → effectiveRampMs=180ms → half-ramp=90ms.
    // Aim: brake fires at 75° (remaining=15°).
    // Rate = 15°/90ms = 0.167 deg/ms → predictedCoast = 0.167×90 = 15°.
    // At 60° with a single sample: falls back to static (10°), remaining=30° → no brake.
    // At 75° with two-sample window: predictedCoast=15° = remaining=15° → brake fires.
    // Without rate fix the static 10° fallback would not fire until 80°.
    mockSensor._testSetHeading(createInternalHeading(60));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(60), 1000);
    await new Promise(resolve => setTimeout(resolve, 5));

    // 15° later in 90ms → rate = 15/90 ≈ 0.167 deg/ms; remaining = 15° ≤ 15° → brake fires.
    mockSensor._testSetHeading(createInternalHeading(75));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(75), 1090);

    const result = await turnPromise;

    // Turn must complete successfully, proving the rate-based prediction fired
    // before the 80° point that the static 10° fallback would have waited for.
    assert.equal(result.status, "success");
  });

  it("handles small angle turns (10°)", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      motorCalibration: createMockMotorCalibration(),
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(10),
      direction: "ccw",
      learningEnabled: true,
    });

    // Small turns now brake on learned elapsed time from turn start. The mock
    // model returns 45ms/deg, so a 10° request brakes after 450ms.
    await new Promise(resolve => setTimeout(resolve, 10));
    elapsed = 400;
    mockSensor._testSetHeading(createInternalHeading(4.5));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(4.5), 400);
    await new Promise(resolve => setTimeout(resolve, 5));
    elapsed = 450;
    mockSensor._testSetHeading(createInternalHeading(5.0));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(5.0), 425);

    const result = await turnPromise;

    assert.equal(result.status, "success");
    assert.equal(result.motorEngaged, true);
    assert.equal(result.controlMode, "small_timeout");
    assert.equal(result.triggerTimeUsedMs, 450);
    // Small turns use the same ramp-down path as large turns
    assert.equal(mockSensor.setMotorWheelOutputs.mock.calls.length > 0, true);
  });

  it("stops turn immediately on stopCurrentTurn()", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(180),
      direction: "ccw",
      learningEnabled: true,
    });

    // Request stop, then emit heading update to trigger the stop handler
    await new Promise(resolve => setTimeout(resolve, 10));
    await controller.stopCurrentTurn();
    mockSensor._testEmitHeadingUpdate(createInternalHeading(45), 500);

    const result = await turnPromise;

    assert.equal(result.status, "stopped");
    assert.equal(result.errorMessage, "Turn stopped by user request");
    assert.equal(mockSensor.requestNeutralMotorOutputs.mock.calls.length > 0, true);
  });

  it("watchdog fires when no IMU heading update arrives during the active turn", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      // Tiny watchdog window so the test does not need to wait long
      headingUpdateWatchdogTimeoutMs: 25,
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(180),
      direction: "ccw",
      learningEnabled: true,
    });

    // Deliberately do NOT emit any heading updates. The watchdog should fire.
    const result = await turnPromise;

    assert.equal(result.status, "error");
    assert.match(result.errorMessage ?? "", /watching|watchdog|IMU heading update/i);
  });

  it("tracks turn history", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: true,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    mockSensor._testSetHeading(createInternalHeading(63));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(63), 1000);

    await turnPromise;

    const history = controller.getTurnHistory();
    assert.equal(history.length, 1);
    assert.equal(unwrapRelativeAngle(history[0].requestedAngle), 90);

    const state = controller.getState();
    assert.equal(state.turnsCompleted, 1);
  });

  it("clears history", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(45),
      direction: "ccw",
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    mockSensor._testSetHeading(createInternalHeading(31.5));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(31.5), 500);

    await turnPromise;

    controller.clearHistory();
    const history = controller.getTurnHistory();
    assert.equal(history.length, 0);

    const state = controller.getState();
    assert.equal(state.turnsCompleted, 0);
  });

  it("repeats large-angle training until each angle is within target error", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const requestedAngles = [];
    const attemptsByAngle = new Map();
    controller.executeTurn = mock.fn(async (request) => {
      const angleDeg = unwrapRelativeAngle(request.targetAngle);
      requestedAngles.push(angleDeg);

      const attempt = attemptsByAngle.get(angleDeg) ?? 0;
      attemptsByAngle.set(angleDeg, attempt + 1);

      const errorSequence = angleDeg > 0 ? [5, 2] : [4, 1];
      const errorDeg = errorSequence[Math.min(attempt, errorSequence.length - 1)];
      return createTrainingResult(angleDeg, errorDeg);
    });

    await controller.runLargeAngleTraining(1, [70, -70]);

    assert.equal(attemptsByAngle.get(70), 2);
    assert.equal(attemptsByAngle.get(-70), 2);
    assert.deepEqual(requestedAngles, [70, 70, -70, -70]);
  });

  it("repeats small-angle training until each angle is within three degrees", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const attemptsByAngle = new Map();
    const requestedAngles = [];
    controller.executeTurn = mock.fn(async (request) => {
      const angleDeg = unwrapRelativeAngle(request.targetAngle);
      requestedAngles.push(angleDeg);

      const attempt = attemptsByAngle.get(angleDeg) ?? 0;
      attemptsByAngle.set(angleDeg, attempt + 1);

      const errorSequence = angleDeg > 0 ? [7, 2] : [5, 1];
      const errorDeg = errorSequence[Math.min(attempt, errorSequence.length - 1)];
      return createTrainingResult(angleDeg, errorDeg);
    });

    await controller.runSmallAngleTraining(2, [3, -3]);

    assert.equal(attemptsByAngle.get(3), 2);
    assert.equal(attemptsByAngle.get(-3), 2);
    assert.deepEqual(requestedAngles, [3, 3, -3, -3]);
  });
});

describe("TurnLearningModel", () => {
  function createMockLogger() {
    return {
      child: () => createMockLogger(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    };
  }

  it("creates default parameters", async () => {
    const mockLogger = createMockLogger();
    const model = new TurnLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/nonexistent-test-params.json",
    });

    await model.loadParameters();
    const params = model.getParameters();

    assert.equal(params.version, 2);
    assert.equal(params.parameters.length > 0, true);
    assert.equal(params.parameters[0].requestedAngleDeg, 70);
    assert.equal(params.parameters[0].direction, "ccw");
    assert.equal(params.parameters[0].brakeDistanceDeg, 25);
  });

  it("returns brake angle for requested turn", () => {
    const mockLogger = createMockLogger();
    const model = new TurnLearningModel({
      logger: mockLogger,
    });

    const brakeAngle = model.getBrakeAngle(90, "ccw");
    const brakeValue = unwrapRelativeAngle(brakeAngle);

    assert.equal(brakeValue > 0, true);
    assert.equal(brakeValue < 90, true);
  });

  it("returns no brake angle for small-angle timeout buckets", () => {
    const mockLogger = createMockLogger();
    const model = new TurnLearningModel({
      logger: mockLogger,
    });

    const brakeAngle = model.getBrakeAngle(6, "ccw");
    const brakeValue = unwrapRelativeAngle(brakeAngle);

    assert.equal(brakeValue, 0);
  });

  it("interpolates small-angle brake times between neighboring 3° buckets", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-turn-learning-interp-"));
    const parametersPath = join(dir, "turn-learning.json");

    try {
      const smallTurnBrakeTimesCcwMs = Array.from({ length: 20 }, (_, index) => (index + 1) * 45);
      const model = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await writeFile(parametersPath, JSON.stringify({
        version: 3,
        smallAngleThresholdDeg: 60,
        smallTurnBucketStepDeg: 3,
        smallTurnMaxAngleDeg: 60,
        largeTurnBucketStepDeg: 10,
        largeTurnMinAngleDeg: 70,
        largeTurnMaxAngleDeg: 180,
        largeTurnBrakeDistancesCcwDeg: Array.from({ length: 12 }, () => 25),
        largeTurnBrakeDistancesCwDeg: Array.from({ length: 12 }, () => 25),
        largeTurnBiasOffsetsCcwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnBiasOffsetsCwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnSampleCountsCcw: Array.from({ length: 12 }, () => 0),
        largeTurnSampleCountsCw: Array.from({ length: 12 }, () => 0),
        largeTurnLastErrorsCcwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnLastErrorsCwDeg: Array.from({ length: 12 }, () => 0),
        smallTurnBrakeTimesCcwMs,
        smallTurnBrakeTimesCwMs: [...smallTurnBrakeTimesCcwMs],
        smallTurnSampleCountsCcw: Array.from({ length: 20 }, () => 0),
        smallTurnSampleCountsCw: Array.from({ length: 20 }, () => 0),
        smallTurnLastErrorCcwDeg: Array.from({ length: 20 }, () => 0),
        smallTurnLastErrorCwDeg: Array.from({ length: 20 }, () => 0),
        lastUpdated: new Date().toISOString(),
      }), "utf-8");
      await model.loadParameters();

      const brakeTime10Ms = model.getSmallTurnBrakeTimeMs("ccw", 10);
      assert.equal(brakeTime10Ms, 400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not learn a 10° small turn because it is not a bucket angle", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-turn-learning-single-bucket-"));
    const parametersPath = join(dir, "turn-learning.json");

    try {
      const smallTurnBrakeTimesCcwMs = Array.from({ length: 20 }, (_, index) => (index + 1) * 45);
      const model = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await writeFile(parametersPath, JSON.stringify({
        version: 3,
        smallAngleThresholdDeg: 60,
        smallTurnBucketStepDeg: 3,
        smallTurnMaxAngleDeg: 60,
        largeTurnBucketStepDeg: 10,
        largeTurnMinAngleDeg: 70,
        largeTurnMaxAngleDeg: 180,
        largeTurnBrakeDistancesCcwDeg: Array.from({ length: 12 }, () => 25),
        largeTurnBrakeDistancesCwDeg: Array.from({ length: 12 }, () => 25),
        largeTurnBiasOffsetsCcwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnBiasOffsetsCwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnSampleCountsCcw: Array.from({ length: 12 }, () => 0),
        largeTurnSampleCountsCw: Array.from({ length: 12 }, () => 0),
        largeTurnLastErrorsCcwDeg: Array.from({ length: 12 }, () => 0),
        largeTurnLastErrorsCwDeg: Array.from({ length: 12 }, () => 0),
        smallTurnBrakeTimesCcwMs,
        smallTurnBrakeTimesCwMs: [...smallTurnBrakeTimesCcwMs],
        smallTurnSampleCountsCcw: Array.from({ length: 20 }, () => 0),
        smallTurnSampleCountsCw: Array.from({ length: 20 }, () => 0),
        smallTurnLastErrorCcwDeg: Array.from({ length: 20 }, () => 0),
        smallTurnLastErrorCwDeg: Array.from({ length: 20 }, () => 0),
        lastUpdated: new Date().toISOString(),
      }), "utf-8");
      await model.loadParameters();

      const before = model.getParameters();
      const bucket9Before = before.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 9);
      const bucket12Before = before.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 12);
      assert.ok(bucket9Before);
      assert.ok(bucket12Before);

      await model.updateFromTurn({
        requestedAngle: createRelativeAngle(10),
        achievedAngle: createRelativeAngle(8),
        errorAngle: createRelativeAngle(-2),
        brakeDistanceUsed: createRelativeAngle(0),
        brakeTimeUsedMs: 400,
        direction: "ccw",
      });

      const after = model.getParameters();
      const bucket9After = after.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 9);
      const bucket12After = after.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 12);
      assert.ok(bucket9After);
      assert.ok(bucket12After);
      assert.equal(bucket9After.brakeTimeCcwMs, bucket9Before.brakeTimeCcwMs);
      assert.equal(bucket12After.brakeTimeCcwMs, bucket12Before.brakeTimeCcwMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps large angles to nearest 10° bin", async () => {
    const mockLogger = createMockLogger();
    const model = new TurnLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/nonexistent-test-turn-bins.json",
    });
    await model.loadParameters();

    await model.updateFromTurn({
      requestedAngle: createRelativeAngle(90),
      achievedAngle: createRelativeAngle(100),
      errorAngle: createRelativeAngle(10),
      brakeDistanceUsed: createRelativeAngle(25),
      direction: "ccw",
    });

    const brake89 = model.getBrakeAngle(89, "ccw");
    const brake91 = model.getBrakeAngle(91, "ccw");
    const brake120 = model.getBrakeAngle(120, "ccw");

    const sameBucketDiff = Math.abs(unwrapRelativeAngle(brake89) - unwrapRelativeAngle(brake91));
    const differentBucketDiff = Math.abs(unwrapRelativeAngle(brake91) - unwrapRelativeAngle(brake120));
    assert.equal(sameBucketDiff < 0.01, true, `Expected same-bucket diff < 0.01 but got ${sameBucketDiff}`);
    assert.equal(differentBucketDiff > 0.01, true, `Expected different-bucket diff > 0.01 but got ${differentBucketDiff}`);
  });

  it("learns the small-angle brake time and persists it", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-turn-learning-"));
    const parametersPath = join(dir, "turn-learning.json");

    try {
      const model = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();
      const bucket = before.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 21);
      assert.ok(bucket);
      const startBrakeTimeMs = bucket.brakeTimeCcwMs;

      await model.updateFromTurn({
        requestedAngle: createRelativeAngle(20),
        achievedAngle: createRelativeAngle(3),
        errorAngle: createRelativeAngle(-17),
        brakeDistanceUsed: createRelativeAngle(0),
        brakeTimeUsedMs: startBrakeTimeMs,
        direction: "ccw",
      });

      const after = model.getParameters();
      const updatedBucket = after.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 21);
      assert.ok(updatedBucket);
      assert.equal(updatedBucket.sampleCountCcw, bucket.sampleCountCcw + 1);
      assert.equal(updatedBucket.brakeTimeCcwMs > startBrakeTimeMs, true);

      const reloaded = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await reloaded.loadParameters();
      const persisted = reloaded.getParameters();
      const persistedBucket = persisted.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 21);
      assert.ok(persistedBucket);
      assert.equal(persistedBucket.sampleCountCcw, updatedBucket.sampleCountCcw);
      assert.equal(persistedBucket.brakeTimeCcwMs, updatedBucket.brakeTimeCcwMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("learns a large-angle brake bucket and persists it", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-turn-learning-large-"));
    const parametersPath = join(dir, "turn-learning.json");

    try {
      const model = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();
      const startBucket = before.parameters.find((entry) => entry.requestedAngleDeg === 120 && entry.direction === "ccw");
      const untouchedBucket = before.parameters.find((entry) => entry.requestedAngleDeg === 90 && entry.direction === "ccw");
      assert.ok(startBucket);
      assert.ok(untouchedBucket);
      assert.equal(startBucket.brakeDistanceDeg, 25);

      await model.updateFromTurn({
        requestedAngle: createRelativeAngle(121),
        achievedAngle: createRelativeAngle(131),
        errorAngle: createRelativeAngle(10),
        brakeDistanceUsed: createRelativeAngle(25),
        direction: "ccw",
      });

      const after = model.getParameters();
      const updatedBucket = after.parameters.find((entry) => entry.requestedAngleDeg === 120 && entry.direction === "ccw");
      const unchangedBucket = after.parameters.find((entry) => entry.requestedAngleDeg === 90 && entry.direction === "ccw");
      assert.ok(updatedBucket);
      assert.ok(unchangedBucket);
      assert.equal(updatedBucket.sampleCount, (startBucket.sampleCount ?? 0) + 1);
      assert.equal(updatedBucket.brakeDistanceDeg > startBucket.brakeDistanceDeg, true);
      assert.equal(unchangedBucket.brakeDistanceDeg, untouchedBucket.brakeDistanceDeg);

      const reloaded = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await reloaded.loadParameters();
      const persisted = reloaded.getParameters();
      const persistedBucket = persisted.parameters.find((entry) => entry.requestedAngleDeg === 120 && entry.direction === "ccw");
      assert.ok(persistedBucket);
      assert.equal(persistedBucket.sampleCount, updatedBucket.sampleCount);
      assert.equal(persistedBucket.brakeDistanceDeg, updatedBucket.brakeDistanceDeg);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats wrapped 180° overshoot as overshoot when an unwrapped learning angle is provided", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-turn-learning-wrap-"));
    const parametersPath = join(dir, "turn-learning.json");

    try {
      const model = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();
      const startBucket = before.parameters.find((entry) => entry.requestedAngleDeg === 180 && entry.direction === "ccw");
      assert.ok(startBucket);
      assert.equal(startBucket.brakeDistanceDeg, 25);

      await model.updateFromTurn({
        requestedAngle: createRelativeAngle(180),
        achievedAngle: createRelativeAngle(-175),
        achievedAngleUnwrappedDeg: 185,
        errorAngle: createRelativeAngle(5),
        brakeDistanceUsed: createRelativeAngle(25),
        direction: "ccw",
      });

      const after = model.getParameters();
      const updatedBucket = after.parameters.find((entry) => entry.requestedAngleDeg === 180 && entry.direction === "ccw");
      assert.ok(updatedBucket);
      assert.equal(updatedBucket.brakeDistanceDeg > startBucket.brakeDistanceDeg, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
