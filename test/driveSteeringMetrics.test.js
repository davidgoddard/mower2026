import test from "node:test";
import assert from "node:assert/strict";

import { calculateDriveSteeringMetrics } from "../dist/control/driveSteeringMetrics.js";

test("steering metrics distinguish one convergence crossing from repeated oscillation", () => {
  const convergent = calculateDriveSteeringMetrics([
    { alongTrackMeters: 0, cteMeters: 0.12 },
    { alongTrackMeters: 1, cteMeters: 0.06 },
    { alongTrackMeters: 2, cteMeters: -0.03 },
    { alongTrackMeters: 3, cteMeters: -0.01 },
  ], 0.025, 0.015);
  assert.equal(convergent.baselineCrossings, 1);

  const oscillating = calculateDriveSteeringMetrics([
    { alongTrackMeters: 0, cteMeters: 0.10 },
    { alongTrackMeters: 1, cteMeters: -0.11 },
    { alongTrackMeters: 2, cteMeters: 0.12 },
    { alongTrackMeters: 3, cteMeters: -0.13 },
  ], 0.025, 0.015);
  assert.equal(oscillating.baselineCrossings, 3);
  assert.equal(oscillating.nonDecayingCrossings >= 2, true);
  assert.equal(oscillating.cteIntegralMetersSquared > 0, true);
});

test("steering metrics report distance until CTE remains in target band", () => {
  const metrics = calculateDriveSteeringMetrics([
    { alongTrackMeters: 0, cteMeters: 0.10 },
    { alongTrackMeters: 0.5, cteMeters: 0.04 },
    { alongTrackMeters: 1.0, cteMeters: 0.02 },
    { alongTrackMeters: 1.2, cteMeters: 0.01 },
  ], 0.025, 0.015);

  assert.equal(metrics.distanceToTargetBandMeters, 1);
  assert.equal(metrics.sampledAlongTrackMeters, 1.2);
});
