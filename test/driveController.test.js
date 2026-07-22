import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DriveController } from "../dist/control/driveController.js";
import { DriveLineController } from "../dist/control/driveLineController.js";
import { DriveLearningModel } from "../dist/control/driveLearningModel.js";
import {
  DRIVE_LONG_SAMPLE_DISTANCES_METERS,
  DRIVE_SEGMENT_MAX_DISTANCE_METERS,
  DRIVE_SEGMENT_MIN_DISTANCE_METERS,
  DRIVE_SEGMENT_STEP_METERS,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
} from "../dist/constants.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";
import { createPosition, createMeters, unwrapMeters } from "../dist/geometry/positionTypes.js";

const STRAIGHT_LINE_TRAINING_DISTANCES_METERS = [
  ...DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  ...DRIVE_LONG_SAMPLE_DISTANCES_METERS,
];
const STRAIGHT_LINE_TRAINING_DRIVE_COUNT = STRAIGHT_LINE_TRAINING_DISTANCES_METERS.length * 2;
const SEGMENT_TRAINING_DISTANCE_COUNT =
  Math.floor((DRIVE_SEGMENT_MAX_DISTANCE_METERS - DRIVE_SEGMENT_MIN_DISTANCE_METERS + 1e-9) / DRIVE_SEGMENT_STEP_METERS) + 1;
const SEGMENT_TRAINING_DRIVE_COUNT = SEGMENT_TRAINING_DISTANCE_COUNT * 2;

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
      requestNeutralMotorOutputs: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      emergencyStopMotors: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      beginMotionSession: mock.fn(),
      endMotionSession: mock.fn(),
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
      getWheelbaseMeters: () => 0.55,
      getDiagnosticSnapshot: () => ({
        calibration: {
          leftMetersPerTick: 0.001,
          rightMetersPerTick: 0.001,
          wheelbaseMeters: 0.55,
        },
      }),
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
        for (const distance of STRAIGHT_LINE_TRAINING_DISTANCES_METERS) {
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
      getLongHeadingBiasForDirection: () => 0,
      getLongHeadingGainForDirection: () => 0.01,
      getMotorRampDownTime: () => 700,
      updateFromDrive: mock.fn(async () => {}),
      saveParameters: mock.fn(async () => {}),
      loadParameters: mock.fn(async () => {}),
      getParameters: mock.fn(() => ({
        version: 6,
        longDriveBrakeDistanceForwardMeters: 2.0,
        longDriveBrakeDistanceReverseMeters: 2.0,
        longHeadingBiasForwardPercent: 0,
        longHeadingBiasReversePercent: 0,
        longHeadingGainForwardPerDeg: 0.01,
        longHeadingGainReversePerDeg: 0.01,
        forwardCteGain: 0.3,
        reverseCteGain: 0.3,
        longDriveMinDistanceMeters: 1.0,
        shortDriveBrakeDistancesPositive: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0.2),
        shortDriveBrakeDistancesNegative: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0.2),
        shortDriveSampleCountsPositive: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0),
        shortDriveSampleCountsNegative: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0),
        shortDriveLastErrorPositiveMeters: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0),
        shortDriveLastErrorNegativeMeters: Array(DRIVE_SHORT_BUCKET_DISTANCES_METERS.length).fill(0),
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
    const mockLineDrive = createMockLineDriveController();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
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
    assert.equal(mockLineDrive.executeLineDrive.mock.calls.length, 1);
  });

  it("executes drive with initial turn when >5 degrees off", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

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
      lineDriveController: mockLineDrive,
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

  it("pivots before a short hop when heading error is large", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

    mockPose._testSetPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
      sleep: async () => {},
    });

    const result = await controller.executeDrive({
      targetPosition: createPosition(0, 0.1),
      learningEnabled: true,
    });

    assert.equal(result.status, "success");
    assert.equal(mockTurn.executeTurn.mock.calls.length, 1);
    assert.equal(mockLineDrive.executeLineDrive.mock.calls.length, 1);
  });

  it("reverse recovery segments do not force a pre-turn before backing out", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

    mockPose._testSetPose({
      position: createPosition(1, 0),
      heading: createInternalHeading(90),
      quality: "gnss",
    });

    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
      sleep: async () => {},
    });

    await controller.driveSegment({ xMeters: 0, yMeters: 0 }, -1);

    assert.equal(mockTurn.executeTurn.mock.calls.length, 0);
    assert.equal(mockLineDrive.executeLineDrive.mock.calls.length, 1);
    assert.equal(mockLineDrive.executeLineDrive.mock.calls[0].arguments[0].driveDirectionSign, -1);
    assert.equal(mockLineDrive.executeLineDrive.mock.calls[0].arguments[0].allowRotateToHeading, false);
  });

  it("forwards stopCurrentDrive() to the line drive controller", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });

    const drivePromise = controller.executeDrive({
      targetPosition: createPosition(10, 0),
      learningEnabled: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await controller.stopCurrentDrive();

    const result = await drivePromise;

    assert.equal(mockLineDrive.stopCurrentDrive.mock.calls.length > 0, true);
    assert.equal(["success", "stopped"].includes(result.status), true);
  });

  it("tracks drive history", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockPose = createMockPoseFusion();
    const mockTurn = createMockTurnController();
    const mockLearning = createMockLearningModel();
    const mockLineDrive = createMockLineDriveController();

    let elapsed = 0;
    const controller = new DriveController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      turnController: mockTurn,
      logger: mockLogger,
      learningModel: mockLearning,
      lineDriveController: mockLineDrive,
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

    assert.equal(results.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls.length, 1);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].targetXErrorMeters, 0.04);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].includeReverseLegs, true);
    assert.equal(controller.getDriveHistory().length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.equal(controller.getState().drivesCompleted, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
  });

  it("forwards a requested max short-distance training distance to the line controller", async () => {
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

    await controller.runShortDistanceTraining({
      targetXErrorMeters: 0.04,
      includeReverseLegs: true,
      startDistanceMeters: 2,
      maxDistanceMeters: 8,
    });

    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls.length, 1);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].startDistanceMeters, 2);
    assert.equal(mockLineDrive.runShortDistanceTraining.mock.calls[0].arguments[0].maxDistanceMeters, 8);
  });

  it("builds a single long-distance short-training leg when the requested distance is above 4m", async () => {
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
      calls.push(Number(request.targetPosition.xMeters));
      return {
        startPosition: createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: request.targetPosition,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: 0,
        brakeDistanceUsed: createMeters(0),
        status: "success",
        timestamp: new Date().toISOString(),
      };
    });

    const results = await controller.runShortDistanceTraining({
      startDistanceMeters: 6,
      maxDistanceMeters: 6,
      includeReverseLegs: true,
      pauseBeforeDriveMs: 0,
    });

    assert.equal(results.length, 2);
    assert.deepEqual(calls, [6, -6]);
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
          distanceMeters: DRIVE_SHORT_BUCKET_DISTANCES_METERS[0],
          pairAttempt: 0,
          legAttempt: 0,
          directionSign: null,
          targetXErrorMeters: 0.04,
          completedDrives: 0,
          totalPlannedDrives: STRAIGHT_LINE_TRAINING_DRIVE_COUNT,
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
          completedDrives: STRAIGHT_LINE_TRAINING_DRIVE_COUNT,
          totalPlannedDrives: STRAIGHT_LINE_TRAINING_DRIVE_COUNT,
          message: "completed",
          timestamp: new Date().toISOString(),
          resultStatus: "success",
        });
        progressMessages.push("completed");
        return new Array(STRAIGHT_LINE_TRAINING_DRIVE_COUNT).fill(null).map(() => ({
          startPosition: createPosition(0, 0),
          targetPosition: createPosition(DRIVE_SHORT_BUCKET_DISTANCES_METERS[0], 0),
          finalPosition: createPosition(DRIVE_SHORT_BUCKET_DISTANCES_METERS[0], 0),
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

    assert.equal(results.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
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

    assert.equal(results.length, SEGMENT_TRAINING_DRIVE_COUNT);
    assert.equal(calls.length, SEGMENT_TRAINING_DRIVE_COUNT);
    assert.ok(Math.abs(calls[0].x - DRIVE_SEGMENT_MIN_DISTANCE_METERS) < 1e-9);
    assert.ok(Math.abs(calls[0].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].x + DRIVE_SEGMENT_MIN_DISTANCE_METERS) < 1e-9);
    assert.ok(Math.abs(calls[1].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[2].x - (DRIVE_SEGMENT_MIN_DISTANCE_METERS + DRIVE_SEGMENT_STEP_METERS)) < 1e-9);
    assert.ok(Math.abs(calls[3].x + (DRIVE_SEGMENT_MIN_DISTANCE_METERS + DRIVE_SEGMENT_STEP_METERS)) < 1e-9);

    const state = controller.getState();
    assert.equal(state.segmentTrainingProgress?.message.includes("complete"), true);
    assert.equal(state.segmentTrainingResults.length, SEGMENT_TRAINING_DRIVE_COUNT);
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

    assert.equal(results.length, SEGMENT_TRAINING_DRIVE_COUNT);
    const cos30 = Math.cos((30 * Math.PI) / 180);
    const sin30 = Math.sin((30 * Math.PI) / 180);

    assert.ok(Math.abs(calls[0].x - (1 + (DRIVE_SEGMENT_MIN_DISTANCE_METERS * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[0].y - (2 + (DRIVE_SEGMENT_MIN_DISTANCE_METERS * sin30))) < 1e-9);
    assert.ok(Math.abs(calls[1].x - (1 - (DRIVE_SEGMENT_MIN_DISTANCE_METERS * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[1].y - (2 - (DRIVE_SEGMENT_MIN_DISTANCE_METERS * sin30))) < 1e-9);
    const secondSegmentDistance = DRIVE_SEGMENT_MIN_DISTANCE_METERS + DRIVE_SEGMENT_STEP_METERS;
    assert.ok(Math.abs(calls[2].x - (1 + (secondSegmentDistance * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[2].y - (2 + (secondSegmentDistance * sin30))) < 1e-9);
    assert.ok(Math.abs(calls[3].x - (1 - (secondSegmentDistance * cos30))) < 1e-9);
    assert.ok(Math.abs(calls[3].y - (2 - (secondSegmentDistance * sin30))) < 1e-9);
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
    const requestNeutralMotorOutputs = mock.fn(async () => {});
    const emergencyStopMotors = mock.fn(async () => {});
    return {
      setMotorWheelOutputs: mock.fn(async () => {}),
      requestNeutralMotorOutputs,
      emergencyStopMotors,
      stopMotors: requestNeutralMotorOutputs,
      beginMotionSession: mock.fn(() => {}),
      endMotionSession: mock.fn(async () => {}),
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
      getWheelbaseMeters: () => 0.55,
      getDiagnosticSnapshot: () => ({
        calibration: {
          leftMetersPerTick: 0.001,
          rightMetersPerTick: 0.001,
          wheelbaseMeters: 0.55,
        },
      }),
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
      getWheelbaseMeters: () => 0.55,
      getDiagnosticSnapshot: () => ({
        calibration: {
          leftMetersPerTick: 0.001,
          rightMetersPerTick: 0.001,
          wheelbaseMeters: 0.55,
        },
      }),
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
      getWheelbaseMeters: () => 0.55,
      getDiagnosticSnapshot: () => ({
        calibration: {
          leftMetersPerTick: 0.001,
          rightMetersPerTick: 0.001,
          wheelbaseMeters: 0.55,
        },
      }),
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
    };
  }

  function createMockLearningModel() {
    return {
      getBrakeDistanceForDrive: mock.fn(() => createMeters(0.15)),
      getCteGainForDirection: () => 0.3,
      getLongHeadingBiasForDirection: () => 0,
      getLongHeadingGainForDirection: () => 0.01,
      getParameters: mock.fn(() => ({
        version: 6,
        longDriveBrakeDistanceForwardMeters: 2.0,
        longDriveBrakeDistanceReverseMeters: 2.0,
        longHeadingBiasForwardPercent: 0,
        longHeadingBiasReversePercent: 0,
        longHeadingGainForwardPerDeg: 0.01,
        longHeadingGainReversePerDeg: 0.01,
        forwardCteGain: 0.3,
        reverseCteGain: 0.3,
        longDriveMinDistanceMeters: 1.0,
        shortDriveBrakeDistancesPositive: Array(20).fill(0.2),
        shortDriveBrakeDistancesNegative: Array(20).fill(0.2),
        shortDriveSampleCountsPositive: Array(20).fill(0),
        shortDriveSampleCountsNegative: Array(20).fill(0),
        shortDriveLastErrorPositiveMeters: Array(20).fill(0),
        shortDriveLastErrorNegativeMeters: Array(20).fill(0),
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

    assert.equal(results.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.equal(calls.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.equal(calls[0].x, DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.equal(calls[1].x, -DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[1].driveDirectionSign, -1);
    assert.equal(calls[2].x, DRIVE_SHORT_BUCKET_DISTANCES_METERS[1]);
    assert.equal(calls[2].driveDirectionSign, 1);
    assert.equal(calls[3].x, -DRIVE_SHORT_BUCKET_DISTANCES_METERS[1]);
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
    assert.equal(calls[0].x, DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[1].x, -DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[2].x, DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[3].x, -DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[4].x, DRIVE_SHORT_BUCKET_DISTANCES_METERS[1]);
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

  it("samples the short-training anchor after the pre-drive pause", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    let currentPose = {
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    };
    const mockPose = {
      getCurrentPose: () => currentPose,
      getEncoderCalibration: () => 0.001,
      setEncoderCalibration: mock.fn(async () => {}),
      on: mock.fn(() => {}),
      off: mock.fn(() => {}),
    };
    const mockLearning = createMockLearningModel();
    const controller = new DriveLineController({
      sensorController: mockSensor,
      poseFusion: mockPose,
      logger: mockLogger,
      learningModel: mockLearning,
      sleep: async () => {
        currentPose = {
          position: createPosition(5, 5),
          heading: createInternalHeading(0),
          quality: "gnss",
        };
      },
    });

    const calls = [];
    controller.executeLineDrive = mock.fn(async (request) => {
      calls.push({
        x: Number(request.targetPosition.xMeters),
        y: Number(request.targetPosition.yMeters),
      });

      return {
        startPosition: currentPose.position,
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
      startDistanceMeters: 0.75,
      maxDistanceMeters: 0.75,
      pauseBeforeDriveMs: 50,
    });

    assert.equal(results.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].x, 5.75);
    assert.equal(calls[0].y, 5);
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

    assert.equal(results.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.equal(calls.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.ok(Math.abs(calls[0].x - 0) < 1e-9);
    assert.equal(calls[0].y, DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
    assert.equal(calls[0].driveDirectionSign, 1);
    assert.ok(Math.abs(calls[1].x - 0) < 1e-9);
    assert.equal(calls[1].y, -DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]);
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
    // stopCurrentDrive brings the wheels to rest under the ramp profile
    // (stopMotors), not the H-bridge disable.  The emergency-disable
    // path is reserved for the operator stop button and stall events.
    assert.equal(mockSensor.stopMotors.mock.calls.length > 0, true);
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

  it("pivots in the correct world direction when reverse travel heading is badly misaligned", async () => {
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
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(90),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const commanded = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(commanded.length >= 2);
    assert.equal(Number(commanded[0]) > 0, true);
    assert.equal(Number(commanded[1]) < 0, true);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(0, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("turns on the spot instead of issuing one-wheel line-drive corrections", () => {
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

    controller.driveDirectionSign = 1;
    const forwardCommand = controller.enforceMinimumActiveArcCommands(0.8, 0, 1);
    assert.equal(forwardCommand.leftCommand < 0, true);
    assert.equal(forwardCommand.rightCommand > 0, true);
    assert.equal(Math.abs(forwardCommand.leftCommand) >= 0.3, true);
    assert.equal(Math.abs(forwardCommand.rightCommand) >= 0.3, true);

    controller.driveDirectionSign = -1;
    const reverseCommand = controller.enforceMinimumActiveArcCommands(-0.8, 0, 1);
    assert.equal(reverseCommand.leftCommand > 0, true);
    assert.equal(reverseCommand.rightCommand < 0, true);
    assert.equal(Math.abs(reverseCommand.leftCommand) >= 0.3, true);
    assert.equal(Math.abs(reverseCommand.rightCommand) >= 0.3, true);
  });

  it("holds cruise speed on a straight line until the brake trigger is reached", async () => {
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
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(1, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const farCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(4.7, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const nearCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(farCommand.length >= 2);
    assert.ok(nearCommand.length >= 2);
    const farLeft = Number(farCommand[0]);
    const farRight = Number(farCommand[1]);
    const nearLeft = Number(nearCommand[0]);
    const nearRight = Number(nearCommand[1]);

    assert.equal(Math.abs(farLeft - farRight) < 1e-9, true);
    assert.equal(Math.abs(nearLeft - nearRight) < 1e-9, true);
    assert.ok(Math.abs(Math.abs(farLeft) - Math.abs(nearLeft)) < 1e-9);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(5, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("stops steering toward the target inside the final 50cm while keeping line-following active", async () => {
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
      learningEnabled: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(4.45, 0.1),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const outsideFinalZone = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(4.55, 0.1),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const insideFinalZone = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(4.97, 0.1),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const nearTarget = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(outsideFinalZone.length >= 2);
    assert.ok(insideFinalZone.length >= 2);
    assert.ok(nearTarget.length >= 2);

    const outsideDiff = Math.abs(Number(outsideFinalZone[0]) - Number(outsideFinalZone[1]));
    const insideDiff = Math.abs(Number(insideFinalZone[0]) - Number(insideFinalZone[1]));
    const nearTargetDiff = Math.abs(Number(nearTarget[0]) - Number(nearTarget[1]));

    assert.equal(nearTargetDiff <= outsideDiff, true);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(5, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("applies a stronger proportional correction as cross-track drift grows", async () => {
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
      learningEnabled: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(1, 0.02),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const smallCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(1, 0.12),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const largeCommand = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(smallCommand.length >= 2);
    assert.ok(largeCommand.length >= 2);

    const smallAsymmetry = Math.abs(Number(smallCommand[0]) - Number(smallCommand[1]));
    const largeAsymmetry = Math.abs(Number(largeCommand[0]) - Number(largeCommand[1]));
    assert.ok(largeAsymmetry > smallAsymmetry);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(5, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("adds heading-based steering trim on longer runs even when cross-track error is zero", async () => {
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
      learningEnabled: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(1, 0),
      heading: createInternalHeading(10),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const commanded = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(commanded.length >= 2);
    assert.ok(Math.abs(Number(commanded[0]) - Number(commanded[1])) > 1e-9);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(5, 0),
      heading: createInternalHeading(0),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());
    await drivePromise;
  });

  it("keeps the existing cte-only steering on 1m runs", async () => {
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
      learningEnabled: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPose.setPose({
      position: createPosition(0.25, 0),
      heading: createInternalHeading(10),
      quality: "gnss",
    });
    mockPose.emit("poseUpdate", mockPose.getCurrentPose());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const commanded = mockSensor.setMotorWheelOutputs.mock.calls.at(-1)?.arguments ?? [];

    assert.ok(commanded.length >= 2);
    assert.equal(Math.abs(Number(commanded[0]) - Number(commanded[1])) < 1e-9, true);

    await controller.stopCurrentDrive();
    mockPose.setPose({
      position: createPosition(1, 0),
      heading: createInternalHeading(0),
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

    assert.equal(results.length, STRAIGHT_LINE_TRAINING_DRIVE_COUNT);
    assert.ok(calls.length >= 2);
    assert.ok(Math.abs(calls[0].x - DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]) < 1e-9);
    assert.ok(Math.abs(calls[0].y - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].x - 0) < 1e-9);
    assert.ok(Math.abs(calls[1].y + DRIVE_SHORT_BUCKET_DISTANCES_METERS[0]) < 1e-9);
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

  it("honors a stop request between short-training legs", async () => {
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

    let callCount = 0;
    controller.executeLineDrive = mock.fn(async (request) => {
      callCount += 1;
      if (callCount === 1) {
        await controller.stopCurrentDrive();
      }

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
      startDistanceMeters: 0.05,
      maxDistanceMeters: 0.05,
    });

    assert.equal(callCount, 1);
    assert.equal(results.length, 1);
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

    assert.equal(params.version, 6);
    assert.equal(params.longDriveBrakeDistanceForwardMeters, 0.2);
    assert.equal(params.longDriveBrakeDistanceReverseMeters, 0.2);
    assert.equal(params.forwardCteGain, 0.3);
    assert.equal(params.reverseCteGain, 0.3);
    assert.equal(params.shortDriveBuckets?.length, DRIVE_SHORT_BUCKET_DISTANCES_METERS.length);
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

  it("allows CTE gain to rise materially when drift remains high without exploding", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-cte-strong-"));
    const parametersPath = join(dir, "drive-learning.json");

    try {
      const model = new DriveLearningModel({
        logger: mockLogger,
        parametersPath,
      });

      await model.loadParameters();

      for (let i = 0; i < 12; i += 1) {
        await model.updateFromDrive({
          startPosition: createPosition(0, 0),
          targetPosition: createPosition(5, 0),
          finalPosition: createPosition(5, 0),
          driveDirectionSign: 1,
          errorX: createMeters(0),
          errorY: createMeters(0),
          maxCte: createMeters(0.4),
          avgCte: createMeters(0.3),
          brakeDistanceUsed: createMeters(0.3),
        });
      }

      const after = model.getParameters();
      assert.equal(after.forwardCteGain > 0.7, true);
      assert.equal(after.forwardCteGain <= 1.5, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("learns brake distance and CTE gain together on a short drive", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-y-drift-"));
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
        finalPosition: createPosition(5.1, 0.12),
        driveDirectionSign: 1,
        errorX: createMeters(0.1),
        errorY: createMeters(0.12),
        maxCte: createMeters(0.2),
        avgCte: createMeters(0.1),
        brakeDistanceUsed: createMeters(0.3),
      });

      const after = model.getParameters();
      assert.equal(after.longDriveBrakeDistanceForwardMeters > before.longDriveBrakeDistanceForwardMeters, true);
      assert.equal(after.longDriveBrakeDistanceReverseMeters, before.longDriveBrakeDistanceReverseMeters);
      assert.equal(after.forwardCteGain > before.forwardCteGain, true);
      assert.equal(after.reverseCteGain, before.reverseCteGain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses explicit short/long classification to avoid 1 m boundary flips", async () => {
    const mockLogger = createMockLogger();
    const model = new DriveLearningModel({
      logger: mockLogger,
      parametersPath: "/tmp/test-drive-learning-bucket.json",
    });

    await model.loadParameters();
    const shortBucketBrake = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(1.0, 0),
      1,
      "short",
    );
    const longDriveBrake = model.getBrakeDistanceForDrive(
      createPosition(0, 0),
      createPosition(1.0, 0),
      1,
      "long",
    );

    assert.notEqual(longDriveBrake, shortBucketBrake);
  });

  it("learns long forward and reverse brake distances independently", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-long-dir-"));
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
        targetPosition: createPosition(2, 0),
        finalPosition: createPosition(2.2, 0),
        driveDirectionSign: 1,
        learningDistanceClass: "long",
        errorX: createMeters(0.2),
        errorY: createMeters(0),
        maxCte: createMeters(0.02),
        avgCte: createMeters(0.01),
        brakeDistanceUsed: createMeters(0.2),
      });

      const afterForward = model.getParameters();
      assert.equal(
        afterForward.longDriveBrakeDistanceForwardMeters > before.longDriveBrakeDistanceForwardMeters,
        true,
      );
      assert.equal(
        afterForward.longDriveBrakeDistanceReverseMeters,
        before.longDriveBrakeDistanceReverseMeters,
      );

      await model.updateFromDrive({
        startPosition: createPosition(0, 0),
        targetPosition: createPosition(-2, 0),
        finalPosition: createPosition(-1.8, 0),
        driveDirectionSign: -1,
        learningDistanceClass: "long",
        errorX: createMeters(-0.2),
        errorY: createMeters(0),
        maxCte: createMeters(0.02),
        avgCte: createMeters(0.01),
        brakeDistanceUsed: createMeters(0.2),
      });

      const afterReverse = model.getParameters();
      assert.equal(
        afterReverse.longDriveBrakeDistanceReverseMeters < afterForward.longDriveBrakeDistanceReverseMeters,
        true,
      );
      assert.equal(
        afterReverse.longDriveBrakeDistanceForwardMeters,
        afterForward.longDriveBrakeDistanceForwardMeters,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      const smallStart = smallBefore.brakeDistancePositiveMeters;

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
      const smallDelta = Math.abs(smallAfter.brakeDistancePositiveMeters - smallStart);

      const largeModel = new DriveLearningModel({
        logger: mockLogger,
        parametersPath: largePath,
      });
      await largeModel.loadParameters();
      const largeBefore = largeModel.getParameters().shortDriveBuckets?.find((entry) => entry.bucketDistanceMeters === 0.30);
      assert.ok(largeBefore);
      const largeStart = largeBefore.brakeDistancePositiveMeters;

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
      const largeDelta = Math.abs(largeAfter.brakeDistancePositiveMeters - largeStart);

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
      const startBrake = bucket.brakeDistancePositiveMeters;

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
      // Undershoot (negative errorX) → brake distance decreases
      assert.equal(updatedBucket.brakeDistancePositiveMeters < startBrake, true);
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
      assert.equal(persistedBucket.brakeDistancePositiveMeters, updatedBucket.brakeDistancePositiveMeters);
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
      assert.equal(updatedBucket.brakeDistanceNegativeMeters < bucket.brakeDistanceNegativeMeters, true);
      assert.equal(after.reverseCteGain < before.reverseCteGain, true);
      assert.equal(after.forwardCteGain, before.forwardCteGain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can train only the long heading bias without changing long brake distance", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-long-bias-"));
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
        targetPosition: createPosition(2, 0),
        finalPosition: createPosition(2, 0.08),
        driveDirectionSign: 1,
        learningDistanceClass: "long",
        longHeadingLearningMode: "bias-only",
        errorX: createMeters(0),
        errorY: createMeters(0.08),
        maxCte: createMeters(0.04),
        avgCte: createMeters(0.02),
        brakeDistanceUsed: createMeters(0.2),
      });

      const after = model.getParameters();
      assert.equal(after.longDriveBrakeDistanceForwardMeters, before.longDriveBrakeDistanceForwardMeters);
      assert.equal(after.longHeadingBiasForwardPercent > before.longHeadingBiasForwardPercent, true);
      assert.equal(after.longHeadingGainForwardPerDeg, before.longHeadingGainForwardPerDeg);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can train only the long heading gain without changing long brake distance", async () => {
    const mockLogger = createMockLogger();
    const dir = await mkdtemp(join(tmpdir(), "mower-drive-learning-long-gain-"));
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
        targetPosition: createPosition(2, 0),
        finalPosition: createPosition(2, 0.08),
        driveDirectionSign: 1,
        learningDistanceClass: "long",
        longHeadingLearningMode: "gain-only",
        errorX: createMeters(0),
        errorY: createMeters(0.08),
        maxCte: createMeters(0.04),
        avgCte: createMeters(0.02),
        brakeDistanceUsed: createMeters(0.2),
      });

      const after = model.getParameters();
      assert.equal(after.longDriveBrakeDistanceForwardMeters, before.longDriveBrakeDistanceForwardMeters);
      assert.equal(after.longHeadingGainForwardPerDeg > before.longHeadingGainForwardPerDeg, true);
      assert.equal(after.longHeadingBiasForwardPercent, before.longHeadingBiasForwardPercent);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
