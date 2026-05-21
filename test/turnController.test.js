import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
      getMotorRampDownTime: () => 700,
      getMotorRampUpTime: () => 460,
      getSmallAngleThreshold: () => 20,
      updateFromTurn: mock.fn(async () => {}),
      saveParameters: mock.fn(async () => {}),
      loadParameters: mock.fn(async () => {}),
      getParameters: mock.fn(() => ({ parameters: [] })),
      resetToDefaults: mock.fn(async () => {}),
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
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    // Start turn and simulate heading updates
    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: true,
    });

    // Simulate heading updates at brake angle (63 degrees = 90 * 0.7)
    await new Promise(resolve => setTimeout(resolve, 10));
    mockSensor._testSetHeading(createInternalHeading(63));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(63), 1000);

    const result = await turnPromise;

    assert.equal(result.status, "success");
    assert.equal(mockSensor.setMotorWheelOutputs.mock.calls.length > 0, true);
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
    assert.equal(mockLearning.updateFromTurn.mock.calls.length, 1);
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

    // Small angle brakes at 50% (5 degrees)
    await new Promise(resolve => setTimeout(resolve, 10));
    mockSensor._testSetHeading(createInternalHeading(5));
    mockSensor._testEmitHeadingUpdate(createInternalHeading(5), 500);

    const result = await turnPromise;

    assert.equal(result.status, "success");
    assert.equal(result.motorEngaged, true);
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
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
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

  it("runs large-angle training through the requested sweep", async () => {
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
    controller.executeTurn = mock.fn(async (request) => {
      const angleDeg = unwrapRelativeAngle(request.targetAngle);
      requestedAngles.push(angleDeg);
      return createTrainingResult(angleDeg, 4);
    });

    await controller.runLargeAngleTraining(1, [70, -70]);

    assert.deepEqual(requestedAngles, [70, -70]);
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

    assert.equal(params.version, 1);
    assert.equal(params.parameters.length > 0, true);
    assert.equal(params.parameters[0].requestedAngleDeg, 10);
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

  it("maps angles to nearest bin", () => {
    const mockLogger = createMockLogger();
    const model = new TurnLearningModel({
      logger: mockLogger,
    });

    // 91 and 90 degrees should both map to 90 degree bin
    const brake91 = model.getBrakeAngle(91, "ccw");
    const brake90 = model.getBrakeAngle(90, "ccw");

    // Should get identical brake angles since they map to same bin
    const diff = Math.abs(unwrapRelativeAngle(brake91) - unwrapRelativeAngle(brake90));
    assert.equal(diff < 0.01, true, `Expected diff < 0.01 but got ${diff}`);
  });

  it("learns the small-angle brake fraction and persists it", async () => {
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
      const startFraction = bucket.brakeFractionCcw;

      await model.updateFromTurn({
        requestedAngle: createRelativeAngle(20),
        achievedAngle: createRelativeAngle(3),
        errorAngle: createRelativeAngle(-17),
        brakeDistanceUsed: createRelativeAngle(0),
        direction: "ccw",
      });

      const after = model.getParameters();
      const updatedBucket = after.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 21);
      assert.ok(updatedBucket);
      assert.equal(updatedBucket.sampleCountCcw, bucket.sampleCountCcw + 1);
      assert.equal(updatedBucket.brakeFractionCcw > startFraction, true);

      const reloaded = new TurnLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await reloaded.loadParameters();
      const persisted = reloaded.getParameters();
      const persistedBucket = persisted.smallTurnBuckets.find((entry) => entry.bucketAngleDeg === 21);
      assert.ok(persistedBucket);
      assert.equal(persistedBucket.sampleCountCcw, updatedBucket.sampleCountCcw);
      assert.equal(persistedBucket.brakeFractionCcw, updatedBucket.brakeFractionCcw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
