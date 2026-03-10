import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEventLogger } from "../../src/logging/eventLogger.js";

test("MemoryEventLogger records structured event entries", () => {
  const logger = new MemoryEventLogger();
  logger.log("runtime.initialised", { revision: "defaults" });
  logger.log("runtime.motion_inhibited", { reason: "stale_input" });

  assert.deepEqual(logger.entries(), [
    {
      eventName: "runtime.initialised",
      fields: { revision: "defaults" },
    },
    {
      eventName: "runtime.motion_inhibited",
      fields: { reason: "stale_input" },
    },
  ]);
});
