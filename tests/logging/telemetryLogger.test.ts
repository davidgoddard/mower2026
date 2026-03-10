import test from "node:test";
import assert from "node:assert/strict";
import { MemoryTelemetryLogger } from "../../src/logging/telemetryLogger.js";

test("MemoryTelemetryLogger stores telemetry records and filters by stream", () => {
  const logger = new MemoryTelemetryLogger();
  logger.append("pose.estimate", { xMeters: 1 });
  logger.append("pose.estimate", { xMeters: 2 });
  logger.append("control.intent", { speed: 0.4 });

  assert.equal(logger.entries().length, 3);
  assert.deepEqual(logger.entries("pose.estimate"), [
    {
      streamName: "pose.estimate",
      sample: { xMeters: 1 },
    },
    {
      streamName: "pose.estimate",
      sample: { xMeters: 2 },
    },
  ]);
});
