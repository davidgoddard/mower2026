import test from "node:test";
import assert from "node:assert/strict";
import { CalibrationSupervisor } from "../../src/calibration/calibrationSupervisor.js";
import type { CalibrationExecutor, CalibrationTrialDefinition } from "../../src/calibration/calibrationTypes.js";
import { MemoryEventLogger } from "../../src/logging/eventLogger.js";
import { MemoryTelemetryLogger } from "../../src/logging/telemetryLogger.js";

class FakeExecutor implements CalibrationExecutor {
  public readonly trialIds: string[] = [];

  public async runTrial(definition: CalibrationTrialDefinition) {
    this.trialIds.push(definition.id);
    return {
      definition,
      completed: true,
      samples: [
        {
          timestampMillis: 0,
          estimate: {
            timestampMillis: 0,
            xMeters: 0,
            yMeters: 0,
            headingDegrees: 0,
            speedMetersPerSecond: 0,
            yawRateDegreesPerSecond: 0,
            confidence: 1,
          },
        },
        {
          timestampMillis: 1_000,
          estimate: {
            timestampMillis: 1_000,
            xMeters: definition.targetPose?.xMeters ?? 0.5,
            yMeters: definition.targetPose?.yMeters ?? 0,
            headingDegrees: definition.targetHeadingChangeDegrees ?? definition.targetPose?.headingDegrees ?? 0,
            speedMetersPerSecond: 0,
            yawRateDegreesPerSecond: 0,
            confidence: 1,
          },
        },
      ],
    };
  }
}

test("CalibrationSupervisor runs the full sequence and produces a report", async () => {
  const executor = new FakeExecutor();
  const telemetryLogger = new MemoryTelemetryLogger();
  const eventLogger = new MemoryEventLogger();
  const supervisor = new CalibrationSupervisor(executor, telemetryLogger, eventLogger);

  const report = await supervisor.run({
    safeRadiusMeters: 2,
    straightRunDistanceMeters: 1.5,
    arrivalTargetDistanceMeters: 1.2,
  });

  assert.equal(report.trials.length, 8);
  assert.equal(executor.trialIds.length, 8);
  assert.equal(telemetryLogger.entries("calibration.trial").length, 8);
  assert.equal(telemetryLogger.entries("calibration.report").length, 1);
  assert.equal(eventLogger.entries()[0]?.eventName, "calibration.sequence_started");
  assert.equal(report.recommendations.recommendedArrivalToleranceMeters > 0, true);
});
