import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TurnController } from "../dist/control/turnController.js";
import { TurnLearningModel } from "../dist/control/turnLearningModel.js";
import { createRelativeAngle, createInternalHeading, unwrapRelativeAngle } from "../dist/geometry/headingTypes.js";

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

    return {
      getHeading: () => heading,
      setHeading: (h) => { heading = h; },
      setMotorWheelSpeeds: mock.fn(async (left, right) => {
        wheelSpeedLeft = left;
        wheelSpeedRight = right;
      }),
      stopMotors: mock.fn(async () => {
        wheelSpeedLeft = 0;
        wheelSpeedRight = 0;
      }),
      _testSetHeading: (h) => { heading = h; },
      _testGetWheelSpeeds: () => ({ left: wheelSpeedLeft, right: wheelSpeedRight }),
    };
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
        // Simulate turn progress
        if (elapsed >= 100 && elapsed < 1500) {
          const progress = (elapsed - 100) / 1400 * 90;
          mockSensor._testSetHeading(createInternalHeading(progress));
        }
      },
    });

    const result = await controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: true,
    });

    assert.equal(result.status, "success");
    assert.equal(mockSensor.setMotorWheelSpeeds.mock.calls.length > 0, true);
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
        if (elapsed >= 50 && elapsed < 300) {
          const progress = (elapsed - 50) / 250 * 10;
          mockSensor._testSetHeading(createInternalHeading(progress));
        }
      },
    });

    const result = await controller.executeTurn({
      targetAngle: createRelativeAngle(10),
      direction: "ccw",
      learningEnabled: true,
    });

    assert.equal(result.status, "success");
    assert.equal(result.motorEngaged, true);
  });

  it("stops turn immediately on stopCurrentTurn()", async () => {
    const mockLogger = createMockLogger();
    const mockSensor = createMockSensorController();
    const mockLearning = createMockLearningModel();

    let elapsed = 0;
    let sleepCount = 0;
    const controller = new TurnController({
      sensorController: mockSensor,
      logger: mockLogger,
      learningModel: mockLearning,
      nowMillis: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
        sleepCount++;
        // Call stop after second sleep (during turning phase)
        if (sleepCount === 2) {
          await controller.stopCurrentTurn();
        }
        // Simulate partial turn
        if (elapsed >= 100) {
          mockSensor._testSetHeading(createInternalHeading(45));
        }
      },
    });

    const result = await controller.executeTurn({
      targetAngle: createRelativeAngle(180),
      direction: "ccw",
      learningEnabled: true,
    });

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
        if (elapsed >= 50) {
          mockSensor._testSetHeading(createInternalHeading(90));
        }
      },
    });

    await controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
      learningEnabled: true,
    });

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

    await controller.executeTurn({
      targetAngle: createRelativeAngle(45),
      direction: "ccw",
    });

    controller.clearHistory();
    const history = controller.getTurnHistory();
    assert.equal(history.length, 0);

    const state = controller.getState();
    assert.equal(state.turnsCompleted, 0);
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
});
