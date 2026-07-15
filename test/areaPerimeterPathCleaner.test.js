import test from "node:test";
import assert from "node:assert/strict";
import { buildAreaPerimeterGeometry } from "../dist/pathfollowing/areaPerimeterPathCleaner.js";

function makePoint(xMeters, yMeters, capturedAt) {
  return { xMeters, yMeters, capturedAt };
}

function segment(pointA, pointB, stepMeters, capturedAtStart) {
  const distanceMeters = Math.hypot(pointB.xMeters - pointA.xMeters, pointB.yMeters - pointA.yMeters);
  const steps = Math.max(1, Math.ceil(distanceMeters / stepMeters));
  const points = [];
  for (let index = 0; index < steps; index += 1) {
    const t = index / steps;
    points.push(makePoint(
      pointA.xMeters + ((pointB.xMeters - pointA.xMeters) * t),
      pointA.yMeters + ((pointB.yMeters - pointA.yMeters) * t),
      capturedAtStart + index,
    ));
  }
  return points;
}

function dot(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function normalize(vector) {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= 1e-9) {
    return { x: 0, y: 0 };
  }
  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

test("buildAreaPerimeterGeometry repairs a rough non-corner closure seam before smoothing", () => {
  let capturedAt = 1;
  const recordedLoop = [
    ...segment(makePoint(1.6, 0.02, capturedAt), makePoint(0, 0, capturedAt), 0.12, capturedAt),
    ...segment(makePoint(0, 0, capturedAt += 100), makePoint(0, 1, capturedAt), 0.12, capturedAt),
    ...segment(makePoint(0, 1, capturedAt += 100), makePoint(2, 1, capturedAt), 0.12, capturedAt),
    ...segment(makePoint(2, 1, capturedAt += 100), makePoint(2, 0, capturedAt), 0.12, capturedAt),
    ...segment(makePoint(2, 0, capturedAt += 100), makePoint(1.9, -0.02, capturedAt), 0.06, capturedAt),
  ];

  const geometry = buildAreaPerimeterGeometry(recordedLoop);
  const smoothedOpen = geometry.smoothedPoints.slice(0, -1);
  assert.ok(smoothedOpen.length > 8);

  const seamWindow = smoothedOpen.slice(0, 6);
  const overallDirection = normalize({
    x: seamWindow[seamWindow.length - 1].xMeters - seamWindow[0].xMeters,
    y: seamWindow[seamWindow.length - 1].yMeters - seamWindow[0].yMeters,
  });

  for (let index = 1; index < seamWindow.length; index += 1) {
    const stepDirection = normalize({
      x: seamWindow[index].xMeters - seamWindow[index - 1].xMeters,
      y: seamWindow[index].yMeters - seamWindow[index - 1].yMeters,
    });
    assert.ok(
      dot(stepDirection, overallDirection) > 0.2,
      `expected seam repair to avoid local backtracking, but segment ${index - 1}->${index} ran against the repaired seam direction`,
    );
  }
});
