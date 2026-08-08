import test from "node:test";
import assert from "node:assert/strict";

import { verifyMowingPlanAngles } from "../../scripts/verify-mowing-plan-angles.mjs";

test("Rear Lawn formerly failing mowing angles remain connected", async () => {
  const result = await verifyMowingPlanAngles({ headings: [84, 94, 163] });
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures, null, 2));
});
