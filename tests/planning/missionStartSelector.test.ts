import test from "node:test";
import assert from "node:assert/strict";
import { MissionStartSelector } from "../../src/planning/missionStartSelector.js";
import type { CoveragePlan } from "../../src/planning/coverageTypes.js";

const plan: CoveragePlan = {
  site: {
    capturedAtMillis: 0,
    perimeter: {
      id: "perimeter-1",
      kind: "perimeter",
      rawPoints: [],
      simplifiedPoints: [],
      rawAreaSquareMeters: 0,
      simplifiedAreaSquareMeters: 0,
    },
    obstacles: [],
    warnings: [],
  },
  generatedAtMillis: 1,
  areas: [{
    id: "area-1",
    orientationDegrees: 0,
    polygon: {
      id: "perimeter-1",
      kind: "perimeter",
      rawPoints: [],
      simplifiedPoints: [],
      rawAreaSquareMeters: 0,
      simplifiedAreaSquareMeters: 0,
    },
    lanes: [
      {
        id: "lane-1",
        start: { xMeters: 1, yMeters: 1, headingDegrees: 0 },
        end: { xMeters: 5, yMeters: 1, headingDegrees: 0 },
        lengthMeters: 4,
        headingDegrees: 0,
      },
      {
        id: "lane-2",
        start: { xMeters: 1, yMeters: 2, headingDegrees: 180 },
        end: { xMeters: 5, yMeters: 2, headingDegrees: 180 },
        lengthMeters: 4,
        headingDegrees: 180,
      },
    ],
  }],
  metrics: {
    candidateOrientationDegrees: 0,
    totalLaneLengthMeters: 8,
    averageLaneLengthMeters: 4,
    fragmentCount: 2,
    turnCount: 1,
    score: 10,
  },
  warnings: [],
};

test("MissionStartSelector chooses the nearest lane endpoint with heading tie-break", () => {
  const selector = new MissionStartSelector();
  const selection = selector.select(plan, {
    timestampMillis: 10,
    xMeters: 0.8,
    yMeters: 1.1,
    headingDegrees: 5,
    speedMetersPerSecond: 0,
    yawRateDegreesPerSecond: 0,
    confidence: 1,
  });

  assert.equal(selection.laneId, "lane-1");
  assert.equal(selection.endpoint, "start");
  assert.equal(selection.distanceMeters < 0.5, true);
});
