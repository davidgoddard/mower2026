import test from "node:test";
import assert from "node:assert/strict";
import { fitPathToStraightAndArcPrimitives } from "../dist/pathfollowing/pathPrimitiveFitter.js";

function point(xMeters, yMeters, capturedAt) {
  return { xMeters, yMeters, capturedAt };
}

function circlePoints(radius, startDeg, endDeg, stepDeg) {
  const points = [];
  let capturedAt = 1;
  for (let angleDeg = startDeg; angleDeg <= endDeg + 1e-9; angleDeg += stepDeg) {
    const angle = angleDeg * (Math.PI / 180);
    points.push(point(radius * Math.cos(angle), radius * Math.sin(angle), capturedAt++));
  }
  return points;
}

test("primitive fitter collapses a long nearly straight run to one chord", () => {
  const fitted = fitPathToStraightAndArcPrimitives([
    point(0, 0, 1),
    point(1, 0.01, 2),
    point(2, -0.015, 3),
    point(3, 0.005, 4),
    point(4, 0, 5),
  ], 0.05);

  assert.equal(fitted.primitives.length, 1);
  assert.equal(fitted.primitives[0].kind, "straight");
  assert.equal(fitted.primitives[0].endIndex, 4);
  assert.deepEqual(fitted.points, [point(0, 0, 1), point(4, 0, 5)]);
});

test("primitive fitter retains a long smooth circular run as one fitted arc", () => {
  const source = circlePoints(2, 0, 90, 10);
  const fitted = fitPathToStraightAndArcPrimitives(source, 0.05);

  assert.equal(fitted.primitives.length, 1);
  assert.equal(fitted.primitives[0].kind, "arc");
  assert.equal(fitted.primitives[0].endIndex, source.length - 1);
  assert.equal(fitted.points.length, source.length);
  for (const fittedPoint of fitted.points) {
    assert.equal(Math.abs(Math.hypot(fittedPoint.xMeters, fittedPoint.yMeters) - 2) < 1e-9, true);
  }
});

test("primitive fitter keeps a sharp corner as two straight primitives", () => {
  const fitted = fitPathToStraightAndArcPrimitives([
    point(0, 0, 1),
    point(1, 0, 2),
    point(2, 0, 3),
    point(2, 1, 4),
    point(2, 2, 5),
  ], 0.05);

  assert.deepEqual(fitted.primitives.map(({ kind, startIndex, endIndex }) => ({
    kind,
    startIndex,
    endIndex,
  })), [
    { kind: "straight", startIndex: 0, endIndex: 2 },
    { kind: "straight", startIndex: 2, endIndex: 4 },
  ]);
  assert.deepEqual(fitted.points, [
    point(0, 0, 1),
    point(2, 0, 3),
    point(2, 2, 5),
  ]);
});

test("primitive fitter prefers a straight when it reaches as far as an arc within tolerance", () => {
  const fitted = fitPathToStraightAndArcPrimitives(circlePoints(10, 0, 5, 1), 0.05);

  assert.equal(fitted.primitives.length, 1);
  assert.equal(fitted.primitives[0].kind, "straight");
});
