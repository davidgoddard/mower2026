import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DriveController } from "../dist/control/driveController.js";
import { DriveLineController } from "../dist/control/driveLineController.js";
import { DriveLearningModel } from "../dist/control/driveLearningModel.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPosition, createMeters, unwrapMeters } from "../dist/geometry/positionTypes.js";

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
      setMotorWheelOutputs: mock.fn(async (left, right) => {
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

  function createMockLineDriveController() {
    return {
      executeLineDrive: mock.fn(async (request) => ({
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      })),
      runShortDistanceTraining: mock.fn(async () => {
        const results = [];
        for (let distance = 0.05; distance <= 1.0 + 1e-9; distance += 0.05) {
          for (const directionSign of [1, -1]) {
            results.push({
              startPosition: createPosition(0, 0),
              targetPosition: createPosition(directionSign * distance, 0),
              finalPosition: createPosition(directionSign * distance, 0),
              errorX: createMeters(0.01),
              errorY: createMeters(0),
              maxCteMeters: createMeters(0.01),
              avgCteMeters: createMeters(0.005),
              durationMs: 100,
              brakeDistanceUsed: createMeters(0.15),
              status: "success",
              timestamp: new Date().toISOString(),
            });
          }
        }
        return results;
      }),
      stopCurrentDrive: mock.fn(async () => {}),
      getState: mock.fn(() => ({
        status: "idle",
        currentDrive: null,
        drivesCompleted: 0,
        averageErrorXMeters: 0,
        averageErrorYMeters: 0,
        shortTrainingProgress: null,
        shortTrainingProgressFeed: [],
        shortTrainingResults: [],
      })),
      getDriveHistory: mock.fn(() => []),
      clearHistory: mock.fn(() => {}),
    };
  }

  function createMockLearningModel() {
    return {
      getBrakeDistanceForDrive: mock.fn(() => createMeters(2.0)),
      getCteGainForDirection: () => 0.3,
      getMotorRampDownTime: () => 700,
      updateFromDrive: mock.fn(async () => {}),
      saveParameters: mock.fn(async () => {}),
      loadParameters: mock.fn(async () => {}),
      getParameters: mock.fn(() => ({
        version: 3,
        longDriveBrakeDistanceMeters: 2.0,
        forwardCteGain: 0.3,
        reverseCteGain: 0.3,
        longDriveMinDistanceMeters: 1.0,
        shortDriveBucketStepMeters: 0.05,
        shortDriveMaxDistanceMeters: 4.0,
        shortDriveBrakeFractionsPositive: Array(21).fill(0.5),
        shortDriveBrakeFractionsNegative: Array(21).fill(0.5),
        shortDriveSampleCountsPositive: Array(21).fill(0),
        shortDriveSampleCountsNegative: Array(21).fill(0),
        shortDriveLastErrorPositiveMeters: Array(21).fill(0),
        shortDriveLastErrorNegativeMeters: Array(21).fill(0),
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
    assert.equal(mockSensor.setMotorWheelOutputs.mock.calls.length > 0, true);
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

  it("runs short distance training forward and reverse around the same anchor", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
      sleep: async () => {},
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 40);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls.length, 1);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].targetXErrorMeters, 0.04);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].includeReverseLegs, true);
    assert.equal(controller.getDriveHistory().length, 40);
    assert.equal(controller.getState().drivesCompleted, 40);
  });

  it("surfaces short-distance training progress to the controller state while training", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    const progressMessages = [];
    const mockLineDrive = {
      executeLineDrive: mock.fn(async () => ({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0.05, 0),
        finalPosition: createPosition(0.05, 0),
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      })),
      runShortDistanceTraining: mock.fn(async (options) => {
        options.progressReporter?.({
          mode: "short-distance",
          phase: "started",
          distanceMeters: 0.05,
          pairAttempt: 0,
          legAttempt: 0,
          directionSign: null,
          targetXErrorMeters: 0.04,
          completedDrives: 0,
          totalPlannedDrives: 54,
          message: "starting",
          timestamp: new Date().toISOString(),
        });
        progressMessages.push("starting");
        options.progressReporter?.({
          mode: "short-distance",
          phase: "completed",
          distanceMeters: 4.0,
          pairAttempt: 1,
          legAttempt: 2,
          directionSign: null,
          targetXErrorMeters: 0.04,
          completedDrives: 54,
          totalPlannedDrives: 54,
          message: "completed",
          timestamp: new Date().toISOString(),
          resultStatus: "success",
        });
        progressMessages.push("completed");
        return new Array(54).fill(null).map(() => ({
          startPosition: createPosition(0, 0),
          targetPosition: createPosition(0.05, 0),
          finalPosition: createPosition(0.05, 0),
          errorX: createMeters(0.01),
          errorY: createMeters(0),
          maxCteMeters: createMeters(0.01),
          avgCteMeters: createMeters(0.005),
          durationMs: 100,
          brakeDistanceUsed: createMeters(0.15),
          status: "success",
          timestamp: new Date().toISOString(),
        }));
      }),
      stopCurrentDrive: mock.fn(async () => {}),
      getState: mock.fn(() => ({
        status: "idle",
        currentDrive: null,
        drivesCompleted: 0,
        averageErrorXMeters: 0,
        averageErrorYMeters: 0,
        shortTrainingProgress: null,
        shortTrainingProgressFeed: [],
        shortTrainingResults: [],
      })),
      getDriveHistory: mock.fn(() => []),
      clearHistory: mock.fn(() => {}),
    };

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
      sleep: async () => {},
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 54);
    const state = controller.getState();
    assert.equal(state.shortTrainingProgress?.message, "completed");
    assert.equal(progressMessages.length, 2);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls.length, 1);
  });

  it("runs segment training forward and reverse along a fixed line", async () => {
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

    const calls = [];
    controller.executeDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runSegmentTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 50);
    assert.equal(calls.length, 50);
    assert.ok(Math.abs(calls[0].x - 1.05) < 1e-9);
    assert.ok(Math.abs(calls[0].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].x + 1.05) < 1e-9);
    assert.ok(Math.abs(calls[1].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[2].x - 1.25) < 1e-9);
    assert.ok(Math.abs(calls[3].x + 1.25) < 1e-9);

    const state = controller.getState();
    assert.equal(state.segmentTrainingProgress?.message.includes("complete"), true);
    assert.equal(state.segmentTrainingResults.length, 50);
  });

  it("keeps segment targets projected onto the initial line A even if the mower pose changes during training", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();

    mockPose._testSetPose({
      position: createPosition(1, 2),
      heading: createInternalHeading(30),
      quality: "gnss",
    });

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const calls = [];
    let mutatedPose = false;
    controller.executeDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
      });

      if (!mutatedPose) {
        mutatedPose = true;
        mockPose._testSetPose({
          position: createPosition(100, 100),
          heading: createInternalHeading(180),
          quality: "gnss",
        });
      }

      return {
        startPosition: createPosition(1, 2),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runSegmentTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 50);
    const cos30 = Math.cos((30 * Math.PI) / 180);
    const sin30 = Math.sin((30 * Math.PI) / 180);

    assert.ok(Math.abs(calls[0].x - (1 + (1.05 * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[0].y - (2 + (1.05 * sin30))) < 1e-9);
    assert.ok(Math.abs(calls[1].x - (1 - (1.05 * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[1].y - (2 - (1.05 * sin30))) < 1e-9);
    assert.ok(Math.abs(calls[2].x - (1 + (1.25 * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[2].y - (2 + (1.25 * sin30))) < 1e-9);
    assert.ok(Math.abs(calls[3].x - (1 - (1.25 * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[3].y - (2 - (1.25 * sin30))) < 1e-9);
  });
});

describe("DriveLineController", () => {
  function createMockLogger() {
    return {
      child: () => createMockLogger(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    };
  }

  function createMockSensorController() {
    return {
      setMotorWheelOutputs: mock.fn(async () => {}),
      stopMotors: mock.fn(async () => {}),
      beginMotorOperation: mock.fn(() => {}),
      endMotorOperation: mock.fn(async () => {}),
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
    };
  }

  function createMockPoseFusion(initialHeading = 0) {
    return {
      getCurrentPose: () => ({
        position: createPosition(0, 0),
        heading: createInternalHeading(initialHeading),
        quality: "gnss",
      }),
      getEncoderCalibration: () => 0.001,
      setEncoderCalibration: mock.fn(async () => {}),
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
    };
  }

  function createEventDrivenMockPoseFusion(initialPose = createPosition(0, 0)) {
    const emitter = new EventEmitter();
    let currentPose = {
      position: initialPose,
      heading: createInternalHeading(0),
      quality: "gnss",
    };

    return Object.assign(emitter, {
      getCurrentPose: () => currentPose,
      getEncoderCalibration: () => 0.001,
      setEncoderCalibration: mock.fn(async () => {}),
      setPose: (pose) => {
        currentPose = pose;
      },
    });
  }

  function createSequencedMockPoseFusion(poses) {
    let index = 0;
    return {
      getCurrentPose: mock.fn(() => poses[Math.min(index++, poses.length - 1)]),
      getEncoderCalibration: () => 0.001,
      setEncoderCalibration: mock.fn(async () => {}),
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
    };
  }

  function createMockLearningModel() {
    return {
      getBrakeDistanceForDrive: mock.fn(() => createMeters(0.15)),
      getCteGainForDirection: () => 0.3,
      getParameters: mock.fn(() => ({
        version: 3,
        longDriveBrakeDistanceMeters: 2.0,
        forwardCteGain: 0.3,
        reverseCteGain: 0.3,
        longDriveMinDistanceMeters: 1.0,
        shortDriveBucketStepMeters: 0.05,
        shortDriveMaxDistanceMeters: 4.0,
        shortDriveBrakeFractionsPositive: Array(21).fill(0.5),
        shortDriveBrakeFractionsNegative: Array(21).fill(0.5),
        shortDriveSampleCountsPositive: Array(21).fill(0),
        shortDriveSampleCountsNegative: Array(21).fill(0),
        shortDriveLastErrorPositiveMeters: Array(21).fill(0),
        shortDriveLastErrorNegativeMeters: Array(21).fill(0),
      })),
      updateFromDrive: mock.fn(async () => {}),
    };
  }

  it("runs short distance training forward and reverse with signed drive directions", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        x: request.targetPosition.xMeters,
        y: request.targetPosition.yMeters,
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 54);
    assert.equal(calls.length, 54);
    assert.equal(calls[0].x, 0.05);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.equal(calls[1].x, -0.05);
    assert.equal(calls[1].driveDirectionSign, -1);
    assert.equal(calls[2].x, 0.1);
    assert.equal(calls[2].driveDirectionSign, 1);
    assert.equal(calls[3].x, -0.1);
    assert.equal(calls[3].driveDirectionSign, -1);
  });

  it("waits before starting each short-distance leg", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        elapsed,
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "stopped",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: false,
      startDistanceMeters: 0.05,
    });

    assert.equal(results.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].elapsed >= 2000, true);
    assert.equal(calls[0].driveDirectionSign, 1);
  });

  it("retries short distance training as a forward/reverse pair when either leg misses", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      const callNumber = calls.length + 1;
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      if (callNumber === 5) {
        return {
          startPosition: createPosition(0, 0),
          targetPosition: request.targetPosition,
          finalPosition: request.targetPosition,
          errorX: createMeters(0.01),
          errorY: createMeters(0),
          maxCteMeters: createMeters(0.01),
          avgCteMeters: createMeters(0.005),
          durationMs: 100,
          brakeDistanceUsed: createMeters(0.15),
          status: "stopped",
          timestamp: new Date().toISOString(),
        };
      }

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(callNumber === 1 ? 0.08 : 0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 5);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.slice(0, 4).map((call) => call.driveDirectionSign), [1, -1, 1, -1]);
    assert.equal(calls[0].x, 0.05);
    assert.equal(calls[1].x, -0.05);
    assert.equal(calls[2].x, 0.05);
    assert.equal(calls[3].x, -0.05);
    assert.equal(calls[4].x, 0.1);
    assert.equal(calls[4].driveDirectionSign, 1);
  });

  it("stops a line drive when cross-track error exceeds the configured limit", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createEventDrivenMockPoseFusion(createPosition(0, 0));
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const drivePromise = controller.executeLineDrive({
      targetPosition: createPosition(1, 0),
      learningEnabled: true,
      disableTimeout: true,
      maxCrossTrackErrorMeters: 0.1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(0, 0.25),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    const result = await drivePromise;

    assert.equal(result.status, "stopped");
    assert.equal(result.errorMessage, "Cross-track error exceeded limit");
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
  });

  it("runs short distance training along the mower heading rather than world X", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion(90);
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 54);
    assert.equal(calls.length, 54);
    assert.ok(Math.abs(calls[0].x - 0) < 1e-9);
    assert.equal(calls[0].y, 0.05);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.ok(Math.abs(calls[1].x - 0) < 1e-9);
    assert.equal(calls[1].y, -0.05);
    assert.equal(calls[1].driveDirectionSign, -1);
  });

  it("applies cross-track correction in the same world direction when driving in reverse", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createEventDrivenMockPoseFusion(createPosition(0, 0));
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const drivePromise = controller.executeLineDrive({
      targetPosition: createPosition(-1.05, 0),
      driveDirectionSign: -1,
      learningEnabled: true,
      disableTimeout: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(0, 0.1),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const commanded = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];
    assert.ok(commanded.length >= 2);
    assert.equal(Number(commanded[0]) < Number(commanded[1]), true);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("keeps a reverse-aligned line straight when the mower is facing the reverse travel heading", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createEventDrivenMockPoseFusion(createPosition(0, 0));
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const drivePromise = controller.executeLineDrive({
      targetPosition: createPosition(-1.05, 0),
      driveDirectionSign: -1,
      learningEnabled: true,
      disableTimeout: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const commanded = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(commanded.length >= 2);
    assert.equal(Math.abs(Number(commanded[0]) - Number(commanded[1])) < 1e-9, true);
    assert.equal(Number(commanded[0]) < 0, true);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("uses heading preview to tighten steering when far from the target but fades it near arrival", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createEventDrivenMockPoseFusion(createPosition(0, 0));
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const drivePromise = controller.executeLineDrive({
      targetPosition: createPosition(5, 0),
      learningEnabled: true,
      disableTimeout: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(1, 0),
      heading: createInternalHeading(30),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const farCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(4.92, 0),
      heading: createInternalHeading(30),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const nearCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(farCommand.length >= 2);
    assert.ok(nearCommand.length >= 2);
    const farAsymmetry = Math.abs(Number(farCommand[0]) - Number(farCommand[1]));
    const nearAsymmetry = Math.abs(Number(nearCommand[0]) - Number(nearCommand[1]));

    assert.ok(farAsymmetry > nearAsymmetry);
    assert.ok(nearAsymmetry < 0.1);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(5, 0),
      heading: createInternalHeading(30),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("re-samples pose and heading for each short-drive leg", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createSequencedMockPoseFusion([
      {
        position: createPosition(0, 0),
        heading: createInternalHeading(0),
        quality: "gnss",
      },
      {
        position: createPosition(0, 0),
        heading: createInternalHeading(90),
        quality: "gnss",
      },
    ]);
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
    });

    assert.equal(results.length, 54);
    assert.ok(calls.length >= 2);
    assert.ok(Math.abs(calls[0].x - 0.05) < 1e-9);
    assert.ok(Math.abs(calls[0].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].x - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].y + 0.05) < 1e-9);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.equal(calls[1].driveDirectionSign, -1);
  });

  it("starts a fresh short-distance training run after a prior stop request", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    await controller.stopCurrentDrive();

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
        driveDirectionSign: request.driveDirectionSign ?? 1,
      });

      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0.01),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0.01),
        avgCteMeters: createMeters(0.005),
        durationMs: 100,
        brakeDistanceUsed: createMeters(0.15),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: false,
      startDistanceMeters: 4.0,
    });

    assert.equal(results.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.equal(calls[0].x, 4.0);
  });

  it("stops at arrival even when brake distance exceeds the target distance", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createEventDrivenMockPoseFusion(createPosition(0, 0));
    const mockLearning = createMockLearningModel();
    mockLearning.getBrakeDistanceForDrive = mock.fn(() => createMeters(0.5));

    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {},
    });

    const resultPromise = controller.executeLineDrive({
      targetPosition: createPosition(0.05, 0),
      learningEnabled: true,
      disableTimeout: true,
    });

    setTimeout(() => {
      mockPose.setPose({
        position: createPosition(0.05, 0),
        heading: createInternalHeading(0),
        quality: "gnss",
      });
      mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    }, 0);

    const result = await resultPromise;

    assert.equal(result.status, "success");
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
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

    assert.equal(params.version, 3);
    assert.equal(params.longDriveBrakeDistanceMeters, 2.0);
    assert.equal(params.forwardCteGain, 0.3);
    assert.equal(params.reverseCteGain, 0.3);
    assert.equal(params.shortDriveBuckets?.length, 21);
  });

  it("updates brake distance from error", async () => {
    const mockLogger = createMockLogger();
    const model = new DriveLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/test-drive-learning.json",
    });

    await model.loadParameters();
    await model.resetToDefaults();
    const initialBrakeDistance = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(5, 0),
    );

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

    const newBrakeDistance = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(5, 0),
    );
    const initialValue = unwrapMeters(initialBrakeDistance);
    const newValue = unwrapMeters(newBrakeDistance);

    // Brake distance should have increased
    assert.equal(newValue > initialValue, true);
  });

  it("learns forward and reverse CTE gains independently", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-cte-"));
    const parametersPath = join(dir, "drive-learning.json");

    try {
      const model = new DriveLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();

      await model.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(5, 0),
        finalPosition: createPosition(5, 0),
        driveDirectionSign: 1,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCte: createMeters(0.2),
        avgCte: createMeters(0.05),
        brakeDistanceUsed: createMeters(0.3),
      });

      const afterForward = model.getParameters();
      assert.equal(afterForward.forwardCteGain > before.forwardCteGain, true);
      assert.equal(afterForward.reverseCteGain, before.reverseCteGain);

      await model.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(-5, 0),
        finalPosition: createPosition(-5, 0),
        driveDirectionSign: -1,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCte: createMeters(0.2),
        avgCte: createMeters(0.05),
        brakeDistanceUsed: createMeters(0.3),
      });

      const afterReverse = model.getParameters();
      assert.equal(afterReverse.reverseCteGain > afterForward.reverseCteGain, true);
      assert.equal(afterReverse.forwardCteGain, afterForward.forwardCteGain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the 1.05 m bucket for longer short straight drives", async () => {
    const mockLogger = createMockLogger();
    const model = new DriveLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/test-drive-learning-bucket.json",
    });

    await model.loadParameters();
    const nearBucketBrake = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(1.05, 0),
    );
    const longDriveBrake = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(2.4, 0),
    );

    assert.equal(longDriveBrake, nearBucketBrake);
  });

  it("learns faster from larger short-drive errors than smaller ones", async () => {
    const mockLogger = createMockLogger();
    const dirSmall = await mkdtemp(join(tmpdir(), "mower-drive-learning-small-"));
    const dirLarge = await mkdtemp(join(tmpdir(), "mower-drive-learning-large-"));
    const smallPath = join(dirSmall, "drive-learning.json");
    const largePath = join(dirLarge, "drive-learning.json");

    try {
      const smallModel = new DriveLearningModel({
        logger: mockLogger,
        parametersPath: smallPath,
      });
      await smallModel.loadParameters();
      const smallBefore = smallModel.getParameters().shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(smallBefore);
      const smallStart = smallBefore.brakeFractionPositive;

      await smallModel.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0.30, 0),
        finalPosition: createPosition(0.26, 0),
        errorX: createMeters(-0.04),
        errorY: createMeters(0),
        maxCte: createMeters(0.01),
        avgCte: createMeters(0.005),
        brakeDistanceUsed: createMeters(0.15),
      });

      const smallAfter = smallModel.getParameters().shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(smallAfter);
      const smallDelta = Math.abs(smallAfter.brakeFractionPositive - smallStart);

      const largeModel = new DriveLearningModel({
        logger: mockLogger,
        parametersPath: largePath,
      });
      await largeModel.loadParameters();
      const largeBefore = largeModel.getParameters().shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(largeBefore);
      const largeStart = largeBefore.brakeFractionPositive;

      await largeModel.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0.30, 0),
        finalPosition: createPosition(0.20, 0),
        errorX: createMeters(-0.10),
        errorY: createMeters(0),
        maxCte: createMeters(0.01),
        avgCte: createMeters(0.005),
        brakeDistanceUsed: createMeters(0.15),
      });

      const largeAfter = largeModel.getParameters().shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(largeAfter);
      const largeDelta = Math.abs(largeAfter.brakeFractionPositive - largeStart);

      assert.equal(largeDelta > smallDelta, true);
    } finally {
      await rm(dirSmall, { recursive: true, force: true });
      await rm(dirLarge, { recursive: true, force: true });
    }
  });

  it("learns a short drive bucket and persists it", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-"));
    const parametersPath = join(dir, "drive-learning.json");

    try {
      const model = new DriveLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();
      const bucket = before.shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(bucket);
      const startFraction = bucket.brakeFractionPositive;

      await model.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0.30, 0),
        finalPosition: createPosition(0.28, 0),
        errorX: createMeters(-0.02),
        errorY: createMeters(0),
        maxCte: createMeters(0.01),
        avgCte: createMeters(0.005),
        brakeDistanceUsed: createMeters(0.15),
      });

      const after = model.getParameters();
      const updatedBucket = after.shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(updatedBucket);
      assert.equal(updatedBucket.sampleCountPositive, bucket.sampleCountPositive + 1);
      assert.equal(updatedBucket.brakeFractionPositive < startFraction, true);
      assert.equal(after.forwardCteGain < before.forwardCteGain, true);
      assert.equal(after.reverseCteGain, before.reverseCteGain);

      const reloaded = new DriveLearningModel({
        logger: mockLogger,
        parametersPath,
      });
      await reloaded.loadParameters();
      const persisted = reloaded.getParameters();
      const persistedBucket = persisted.shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(persistedBucket);
      assert.equal(persistedBucket.sampleCountPositive, updatedBucket.sampleCountPositive);
      assert.equal(persistedBucket.brakeFractionPositive, updatedBucket.brakeFractionPositive);
      assert.equal(persisted.forwardCteGain, after.forwardCteGain);
      assert.equal(persisted.reverseCteGain, after.reverseCteGain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the commanded drive direction for non-X-aligned short drives", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-direction-"));
    const parametersPath = join(dir, "drive-learning.json");

    try {
      const model = new DriveLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();
      const before = model.getParameters();
      const bucket = before.shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(bucket);

      await model.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(0, 0.30),
        driveDirectionSign: -1,
        finalPosition: createPosition(0, 0.25),
        errorX: createMeters(-0.05),
        errorY: createMeters(0),
        maxCte: createMeters(0.01),
        avgCte: createMeters(0.005),
        brakeDistanceUsed: createMeters(0.15),
      });

      const after = model.getParameters();
      const updatedBucket = after.shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(updatedBucket);
      assert.equal(updatedBucket.sampleCountNegative, bucket.sampleCountNegative + 1);
      assert.equal(updatedBucket.sampleCountPositive, bucket.sampleCountPositive);
      assert.equal(after.reverseCteGain < before.reverseCteGain, true);
      assert.equal(after.forwardCteGain, before.forwardCteGain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
