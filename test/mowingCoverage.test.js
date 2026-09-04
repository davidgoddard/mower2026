import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPerpendicularCoverageGap,
  buildAdjacentTraceBisector,
} from "../dist/pathfollowing/mowingCoverage.js";

function pointsAt(yMeters, start = 0, end = 10, step = 0.1) {
  const points = [];
  for (let xMeters = start; xMeters <= end + 1e-9; xMeters += step) {
    points.push({ xMeters, yMeters, capturedAt: xMeters * 1000 });
  }
  return points;
}

test("coverage gap detection confirms a sustained perpendicular separation wider than the cutter", () => {
  const assessment = assessPerpendicularCoverageGap(
    { stripIndex: 3, points: pointsAt(0) },
    { stripIndex: 4, points: pointsAt(0.43) },
    0,
    0.4,
  );

  assert.equal(assessment.exceedsCutterWidth, true);
  assert.ok(assessment.maximumPerpendicularSeparationMeters > 0.42);
  assert.ok(assessment.longestOverWidthRunMeters > 9.5);
});

test("coverage gap detection does not repair adjacent traces within cutter width", () => {
  const assessment = assessPerpendicularCoverageGap(
    { stripIndex: 3, points: pointsAt(0) },
    { stripIndex: 4, points: pointsAt(0.38) },
    0,
    0.4,
  );

  assert.equal(assessment.exceedsCutterWidth, false);
  assert.ok(assessment.maximumPerpendicularSeparationMeters < 0.4);
});

test("coverage gap detection ignores an over-width deviation shorter than 20 cm", () => {
  const current = pointsAt(0.38);
  for (const point of current) {
    if (point.xMeters >= 5 && point.xMeters < 5.15) point.yMeters = 0.43;
  }
  const assessment = assessPerpendicularCoverageGap(
    { stripIndex: 3, points: pointsAt(0) },
    { stripIndex: 4, points: current },
    0,
    0.4,
  );

  assert.equal(assessment.exceedsCutterWidth, false);
  assert.ok(assessment.maximumPerpendicularSeparationMeters > 0.42);
  assert.ok(assessment.longestOverWidthRunMeters < 0.2);
});

test("coverage repair bisects corresponding actual trace ends and follows the previous trace direction", () => {
  const previous = { stripIndex: 3, points: pointsAt(0) };
  const current = { stripIndex: 4, points: pointsAt(0.4).reverse() };

  const repair = buildAdjacentTraceBisector(previous, current);

  assert.ok(Math.abs(repair.start.xMeters) < 1e-9);
  assert.ok(Math.abs(repair.start.yMeters - 0.2) < 1e-9);
  assert.ok(Math.abs(repair.end.xMeters - 10) < 1e-9);
  assert.ok(Math.abs(repair.end.yMeters - 0.2) < 1e-9);
  assert.deepEqual(repair.entryStandoff, repair.start);
  assert.deepEqual(repair.exitStandoff, repair.end);
  assert.ok(Math.abs(repair.headingDeg) < 1e-9);
});
