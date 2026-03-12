import test from "node:test";
import assert from "node:assert/strict";
import { CoveragePlanner } from "../../src/planning/coveragePlanner.js";
import type { SiteModel } from "../../src/site/siteTypes.js";

function rectangularSite(widthMeters: number, heightMeters: number): SiteModel {
  const perimeter = [
    { xMeters: 0, yMeters: 0, headingDegrees: 0, timestampMillis: 0 },
    { xMeters: widthMeters, yMeters: 0, headingDegrees: 0, timestampMillis: 1 },
    { xMeters: widthMeters, yMeters: heightMeters, headingDegrees: 90, timestampMillis: 2 },
    { xMeters: 0, yMeters: heightMeters, headingDegrees: 180, timestampMillis: 3 },
    { xMeters: 0, yMeters: 0, headingDegrees: 0, timestampMillis: 4 },
  ];

  return {
    capturedAtMillis: 10,
    perimeter: {
      id: "perimeter-1",
      kind: "perimeter",
      rawPoints: perimeter,
      simplifiedPoints: perimeter,
      rawAreaSquareMeters: widthMeters * heightMeters,
      simplifiedAreaSquareMeters: widthMeters * heightMeters,
    },
    obstacles: [],
    warnings: [],
  };
}

test("CoveragePlanner prefers long lanes along the major rectangle axis", () => {
  const planner = new CoveragePlanner({
    stripeWidthMeters: 1,
    coarseStepDegrees: 15,
  });

  const plan = planner.plan(rectangularSite(10, 4));

  assert.equal(plan.areas.length, 1);
  assert.equal(plan.areas[0]!.lanes.length > 0, true);
  assert.equal(plan.metrics.candidateOrientationDegrees, 0);
  assert.equal(plan.metrics.averageLaneLengthMeters > 8, true);
});

test("CoveragePlanner clips lanes around simple rectangular obstacles", () => {
  const planner = new CoveragePlanner({
    stripeWidthMeters: 1,
  });
  const baselinePlan = planner.plan(rectangularSite(6, 4));
  const site: SiteModel = {
    ...rectangularSite(6, 4),
    obstacles: [{
      id: "obstacle-1",
      kind: "obstacle",
      rawPoints: [
        { xMeters: 2, yMeters: 1, headingDegrees: 0, timestampMillis: 0 },
        { xMeters: 4, yMeters: 1, headingDegrees: 0, timestampMillis: 1 },
        { xMeters: 4, yMeters: 3, headingDegrees: 0, timestampMillis: 2 },
        { xMeters: 2, yMeters: 3, headingDegrees: 0, timestampMillis: 3 },
        { xMeters: 2, yMeters: 1, headingDegrees: 0, timestampMillis: 4 },
      ],
      simplifiedPoints: [
        { xMeters: 2, yMeters: 1, headingDegrees: 0, timestampMillis: 0 },
        { xMeters: 4, yMeters: 1, headingDegrees: 0, timestampMillis: 1 },
        { xMeters: 4, yMeters: 3, headingDegrees: 0, timestampMillis: 2 },
        { xMeters: 2, yMeters: 3, headingDegrees: 0, timestampMillis: 3 },
        { xMeters: 2, yMeters: 1, headingDegrees: 0, timestampMillis: 4 },
      ],
      rawAreaSquareMeters: 4,
      simplifiedAreaSquareMeters: 4,
    }],
  };

  const plan = planner.plan(site);

  assert.equal(plan.warnings.includes("Obstacle clipping is not implemented yet; obstacles are ignored in lane generation."), false);
  assert.equal(plan.metrics.totalLaneLengthMeters < baselinePlan.metrics.totalLaneLengthMeters, true);
  assert.equal(plan.areas[0]!.lanes.some((lane) => lane.lengthMeters < baselinePlan.metrics.averageLaneLengthMeters), true);
});
