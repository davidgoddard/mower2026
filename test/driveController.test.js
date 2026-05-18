import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DriveController } from "../dist/control/driveController.js";
import { DriveLearningModel } from "../dist/control/driveLearningModel.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPosition, createMeters } from "../dist/geometry/positionTypes.js";

describe("DriveController", () => {
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
    let wheelSpeedLeft = 0;
    let wheelSpeedRight = 0;

    return {
      setMotorWheelSpeeds: mock.fn(async (left, right) => {
        wheelSpeedLeft = left;
        wheelSpeedRight = right;
      }),
      stopMotors: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      _testGetWheelSpeeds: () => ({ left: wheelSpeedLeft, right: wheelSpeedRight }),
    };
  }

  function createMockPoseFusion() {
    const emitter = new EventEmitter();
    let currentPose = {
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    };
    let encoderCalibration = 0.001;

    const fusion = {
      getCurrentPose: () => currentPose,
      setPosition: (pos) => {
        currentPose.position = pos;
      },
      getEncoderCalibration: () => encoderCalibration,
      setEncoderCalibration: (val) => {
        encoderCalibration = val;
      },
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      _testEmitPoseUpdate: (pose) => {
        currentPose = pose;
        emitter.emit("poseUpdate", pose);
      },
      _testSetPose: (pose) => {
        currentPose = pose;
      },
    };

    return fusion;
  }

  function createMockTurnController() {
    return {
      executeTurn: mock.fn(async (request) => {
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: request.targetAngle,
          errorAngle: createInternalHeading(0),
          durationMs: 1000,
          brakeAngleUsed: createInternalHeading(50),
          motorEngaged: true,
          status: "success",
          timestamp: new Date().toISOString(),
        };
      }),
    };
  }

  function createMockLearningModel() {
    return {
      getBrakeDistance: mock.fn(() => createMeters(2.0)),
      getCteGain: () => 0.3,
      getMotorRampDownTime: () => 700,
      updateFromDrive: mock.fn(async () => {}),
      saveParameters: mock.fn(async () => {}),
      loadParameters: mock.fn(async () => {}),
      getParameters: mock.fn(() => ({
        version: 1,
        brakeDistanceMeters: 2.0,
        cteGain: 0.3,
      })),
      resetToDefaults: mock.fn(async () => {}),
    };
  }

  it("executes a 5m straight drive successfully", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    // Start drive to (5, 0)
    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(5, 0),
      learningEnabled: true,
    });

    // Simulate pose updates as mower approaches target
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose._testEmitPoseUpdate({
      position: createPosition(1, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose._testEmitPoseUpdate({
      position: createPosition(2, 0.05),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // At brake distance (3m from target)
    mockPose._testEmitPoseUpdate({
      position: createPosition(3, 0.02),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    const result = await drivePromise;

    assert.equal(result.status, "success");
    assert.equal(mockSensor.setMotorWheelSpeeds.mock.calls.length > 0, true);
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
    assert.equal(mockLearning.updateFromDrive.mock.calls.length, 1);
  });

  it("executes drive with initial turn when >5 degrees off", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    // Start facing east (0 degrees) but target is north (90 degrees)
    mockPose._testSetPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(0, 5),
      learningEnabled: true,
    });

    // Wait for turn to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // After turn, update heading
    mockPose._testSetPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(90),
      quality: "gnss",
    });

    // Simulate driving north
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose._testEmitPoseUpdate({
      position: createPosition(0, 3),
      heading: createInternalHeading(90),
      quality: "gnss",
    });

    const result = await drivePromise;

    assert.equal(result.status, "success");
    assert.equal(mockTurn.executeTurn.mock.calls.length, 1);
  });

  it("stops drive immediately on stopCurrentDrive()", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(10, 0),
      learningEnabled: true,
    });

    // Request stop, then emit pose update to trigger stop handler
    await new Promise((resolve) => setTimeout(resolve, 10));
    await controller.stopCurrentDrive();
    mockPose._testEmitPoseUpdate({
      position: createPosition(1, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    const result = await drivePromise;

    assert.equal(result.status, "stopped");
    assert.equal(result.errorMessage, "Drive stopped by user request");
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
  });

  it("tracks drive history", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(5, 0),
      learningEnabled: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose._testEmitPoseUpdate({
      position: createPosition(3, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    await drivePromise;

    const history = controller.getDriveHistory();
    assert.equal(history.length, 1);

    const state = controller.getState();
    assert.equal(state.drivesCompleted, 1);
  });

  it("clears history", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(5, 0),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose._testEmitPoseUpdate({
      position: createPosition(3, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    await drivePromise;

    controller.clearHistory();
    const history = controller.getDriveHistory();
    assert.equal(history.length, 0);

    const state = controller.getState();
    assert.equal(state.drivesCompleted, 0);
  });
});

describe("DriveLearningModel", () => {
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
    const model = new DriveLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/nonexistent-test-drive-params.json",
    });

    await model.loadParameters();
    const params = model.getParameters();

    assert.equal(params.version, 1);
    assert.equal(params.brakeDistanceMeters, 2.0);
    assert.equal(params.cteGain, 0.3);
  });

  it("updates brake distance from error", async () => {
    const mockLogger = createMockLogger();
    const model = new DriveLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/test-drive-learning.json",
    });

    await model.loadParameters();
    const initialBrakeDistance = model.getBrakeDistance();

    // Simulate overshot (positive X error) - should increase brake distance
    await model.updateFromDrive({
      startPosition: createPosition(0, 0),
      targetPosition: createPosition(5, 0),
      finalPosition: createPosition(5.5, 0),
      errorX: createMeters(0.5), // Overshot by 0.5m
      errorY: createMeters(0),
      maxCte: createMeters(0.1),
      avgCte: createMeters(0.05),
      brakeDistanceUsed: initialBrakeDistance,
    });

    const newBrakeDistance = model.getBrakeDistance();
    const initialValue = initialBrakeDistance;
    const newValue = newBrakeDistance;

    // Brake distance should have increased
    assert.equal(newValue > initialValue, true);
  });
});
