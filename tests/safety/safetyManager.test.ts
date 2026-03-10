import test from "node:test";
import assert from "node:assert/strict";
import { RuleBasedSafetyManager } from "../../src/safety/safetyManager.js";

test("RuleBasedSafetyManager blocks motion on stale inputs", () => {
  const manager = new RuleBasedSafetyManager();

  const decision = manager.evaluate({
    gnss: { faultFlags: 0, stale: true },
    motor: { faultFlags: 0, stale: false },
  });

  assert.deepEqual(decision, {
    allowMotion: false,
    reason: "stale_input",
  });
});

test("RuleBasedSafetyManager blocks motion on fault flags", () => {
  const manager = new RuleBasedSafetyManager();

  const decision = manager.evaluate({
    gnss: { faultFlags: 0, stale: false },
    motor: { faultFlags: 4, stale: false },
  });

  assert.deepEqual(decision, {
    allowMotion: false,
    reason: "critical_fault",
  });
});
