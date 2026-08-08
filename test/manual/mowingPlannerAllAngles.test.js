import test from "node:test";
import assert from "node:assert/strict";

import { verifyMowingPlanAngles } from "../../scripts/verify-mowing-plan-angles.mjs";

test("Rear Lawn plans successfully at every integer mowing angle", async () => {
  const result = await verifyMowingPlanAngles();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures, null, 2));
});
