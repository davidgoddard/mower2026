import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createInternalHeading, createRelativeAngle, unwrapRelativeAngle } from "../dist/index.js";
import { createPose } from "../dist/geometry/positionTypes.js";
import { TurnValidationRunner } from "../dist/control/turnValidationRunner.js";
import { systemStop } from "../dist/control/systemStop.js";

describe("TurnValidationRunner", () => {
  function createMockLogger() {
    return {
      child: () => createMockLogger(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    };
  }

  it("runs a real-pose sweep and records the mower pose alongside IMU results", async () => {
    systemStop.clearStop("test");

    const poses = [
      createPose(0, 0, createInternalHeading(0), "gnss"),
      createPose(0, 0, createInternalHeading(50), "gnss"),
      createPose(0, 0, createInternalHeading(10), "gnss"),
      createPose(0, 0, createInternalHeading(60), "gnss"),
    ];
    let poseIndex = 0;

    const turnController = {
      executeTurn: mock.fn(async (request) => {
        const targetAngle = unwrapRelativeAngle(request.targetAngle);
        const achievedAngle = targetAngle - 2;
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: createRelativeAngle(achievedAngle),
          errorAngle: createRelativeAngle(-2),
          durationMs: 100,
          brakeDistanceUsed: createRelativeAngle(0),
          motorEngaged: true,
          status: "success",
          timestamp: new Date().toISOString(),
        };
      }),
    };

    const randomValues = [
      0, 0.75,
      0, 0.75,
    ];

    const runner = new TurnValidationRunner({
      turnController,
      poseProvider: () => poses[Math.min(poseIndex++, poses.length - 1)],
      logger: createMockLogger(),
      random: () => randomValues.shift() ?? 0.75,
    });

    const results = await runner.run(2);

    assert.equal(results.length, 2);
    assert.equal(turnController.executeTurn.mock.calls.length, 2);
    assert.ok(Math.abs(results[0].targetAngle) > 45);
    assert.ok(Math.abs(results[1].targetAngle) > 45);

    assert.equal(results[0].startHeading, 0);
    assert.equal(results[0].targetHeading, 45.000001);
    assert.equal(results[0].targetAngle, 45.000001);
    assert.equal(results[0].imuAchievedAngle, 43.000001);
    assert.equal(results[0].realPoseHeading, 50);
    assert.equal(results[0].realPoseChange, 50);
    assert.ok(Math.abs(results[0].poseErrorAngle - (-5)) < 1e-6);

    assert.equal(results[1].startHeading, 10);
    assert.equal(results[1].targetHeading, 55.000001);
    assert.equal(results[1].targetAngle, 45.000001);
    assert.equal(results[1].imuAchievedAngle, 43.000001);
    assert.equal(results[1].realPoseHeading, 60);
    assert.equal(results[1].realPoseChange, 50);
    assert.ok(Math.abs(results[1].poseErrorAngle - (-5)) < 1e-6);

    assert.equal(runner.getHistory().length, 2);
    systemStop.clearStop("test");
  });

  it("uses the live pose provider for the start and end pose of each validation turn", async () => {
    systemStop.clearStop("test");

    const poses = [
      createPose(0, 0, createInternalHeading(0), "gnss"),
      createPose(0, 0, createInternalHeading(50), "gnss"),
    ];
    let poseIndex = 0;

    const turnController = {
      executeTurn: mock.fn(async (request) => {
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: createRelativeAngle(50),
          errorAngle: createRelativeAngle(0),
          durationMs: 100,
          brakeDistanceUsed: createRelativeAngle(0),
          motorEngaged: true,
          status: "success",
          timestamp: new Date().toISOString(),
        };
      }),
    };

    const poseProvider = mock.fn(() => poses[Math.min(poseIndex++, poses.length - 1)]);

    const runner = new TurnValidationRunner({
      turnController,
      poseProvider,
      logger: createMockLogger(),
      random: () => 0.75,
    });

    await runner.run(1);

    assert.equal(poseProvider.mock.calls.length, 2);
    assert.equal(poseProvider.mock.calls[0].arguments.length, 0);
    assert.equal(poseProvider.mock.calls[1].arguments.length, 0);

    systemStop.clearStop("test");
  });

  it("exposes live sweep progress while running", async () => {
    systemStop.clearStop("test");

    const poses = [
      createPose(0, 0, createInternalHeading(0), "gnss"),
      createPose(0, 0, createInternalHeading(5), "gnss"),
    ];
    let poseIndex = 0;
    let releaseFirstIteration;
    const firstIteration = new Promise((resolve) => {
      releaseFirstIteration = resolve;
    });

    const turnController = {
      executeTurn: mock.fn(async (request) => {
        await firstIteration;
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: createRelativeAngle(5),
          errorAngle: createRelativeAngle(0),
          durationMs: 100,
          brakeDistanceUsed: createRelativeAngle(0),
          motorEngaged: true,
          status: "success",
          timestamp: new Date().toISOString(),
        };
      }),
    };

    const runner = new TurnValidationRunner({
      turnController,
      poseProvider: () => poses[Math.min(poseIndex++, poses.length - 1)],
      logger: createMockLogger(),
      random: () => 0.5,
    });

    const runPromise = runner.run(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stateWhileRunning = runner.getState();
    assert.equal(stateWhileRunning.running, true);
    assert.equal(stateWhileRunning.totalIterations, 1);
    assert.equal(stateWhileRunning.completedIterations, 0);

    releaseFirstIteration();
    await runPromise;

    const stateAfterRun = runner.getState();
    assert.equal(stateAfterRun.running, false);
    assert.equal(stateAfterRun.completedIterations, 1);

    systemStop.clearStop("test");
  });
});
