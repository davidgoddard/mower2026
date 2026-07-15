import test from "node:test";
import assert from "node:assert/strict";
import {
  decimateSmoothedAreaPerimeter,
  smoothAreaPerimeterAdaptively,
} from "../dist/pathfollowing/experimentalAdaptiveAreaSmoothing.js";

test("smoothAreaPerimeterAdaptively preserves a stepped boundary inside the original perimeter", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.1, yMeters: 1.0, capturedAt: 2 },
    { xMeters: 0, yMeters: 2.0, capturedAt: 3 },
    { xMeters: 0, yMeters: 4.0, capturedAt: 4 },
    { xMeters: 3.0, yMeters: 4.0, capturedAt: 5 },
    { xMeters: 3.0, yMeters: 1.0, capturedAt: 6 },
    { xMeters: 5.0, yMeters: 1.0, capturedAt: 7 },
    { xMeters: 5.0, yMeters: 3.0, capturedAt: 8 },
    { xMeters: 8.0, yMeters: 3.0, capturedAt: 9 },
    { xMeters: 8.0, yMeters: 0.0, capturedAt: 10 },
    { xMeters: 0, yMeters: 0, capturedAt: 11 },
  ];

  const result = smoothAreaPerimeterAdaptively(points, {
    resampleSpacingMeters: 0.2,
    maxDeviationMeters: 0.1,
    passes: 3,
  });

  assert.equal(result.outsidePointCount, 0);
  assert.equal(result.invalidSegmentCount, 0);
  assert.equal(result.maxDeviationMeters <= 0.100001, true);
  assert.equal(result.smoothedPoints.length > 20, true);

  const decimated = decimateSmoothedAreaPerimeter(result.smoothedPoints, points, {
    maxDeviationMeters: 0.1,
    segmentValidationSpacingMeters: 0.05,
  });

  assert.equal(decimated.outsidePointCount, 0);
  assert.equal(decimated.invalidSegmentCount, 0);
  assert.equal(decimated.maxDeviationMeters <= 0.100001, true);
  assert.equal(decimated.decimatedPointCount < result.smoothedPointCount, true);
});
