import test from "node:test";
import assert from "node:assert/strict";
import { buildMowingPlan, normalizeAxisHeading } from "../dist/pathfollowing/mowingPlanner.js";

const square = [
  { xMeters: 0, yMeters: 0, capturedAt: 1 },
  { xMeters: 1, yMeters: 0, capturedAt: 2 },
  { xMeters: 1, yMeters: 1, capturedAt: 3 },
  { xMeters: 0, yMeters: 1, capturedAt: 4 },
  { xMeters: 0, yMeters: 0, capturedAt: 5 },
];

test("buildMowingPlan clips 30cm strips to a square perimeter", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 0,
    stripSpacingMeters: 0.3,
  });

  assert.equal(plan.headingDeg, 0);
  assert.equal(plan.stripSpacingMeters, 0.3);
  assert.equal(plan.bladeWidthMeters, 0.4);
  assert.equal(plan.stripCount, 4);
  assert.deepEqual(
    plan.strips.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.start.yMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
      Number(strip.end.yMeters.toFixed(2)),
    ]),
    [
      [0, 0, 1, 0],
      [0, 0.3, 1, 0.3],
      [0, 0.6, 1, 0.6],
      [0, 0.9, 1, 0.9],
    ],
  );
});

test("buildMowingPlan rotates strip direction with heading", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
  });

  assert.equal(plan.stripCount, 3);
  assert.deepEqual(
    plan.strips.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.start.yMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
      Number(strip.end.yMeters.toFixed(2)),
    ]),
    [
      [1, 0, 1, 1],
      [0.5, 0, 0.5, 1],
      [0, 0, 0, 1],
    ],
  );
});

test("buildMowingPlan pairs multiple intersections for concave perimeters", () => {
  const concave = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
    { xMeters: 2, yMeters: 2, capturedAt: 3 },
    { xMeters: 1, yMeters: 1, capturedAt: 4 },
    { xMeters: 0, yMeters: 2, capturedAt: 5 },
    { xMeters: 0, yMeters: 0, capturedAt: 6 },
  ];

  const plan = buildMowingPlan(concave, {
    headingDeg: 0,
    stripSpacingMeters: 0.5,
  });

  const stripAtOneAndHalf = plan.strips.filter((strip) => Math.abs(strip.centerOffsetMeters - 1.5) < 1e-9);
  assert.equal(stripAtOneAndHalf.length, 2);
  assert.deepEqual(
    stripAtOneAndHalf.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
    ]),
    [
      [1.5, 2],
      [0, 0.5],
    ],
  );
});

test("buildMowingPlan removes strip sections inside obstacle perimeters", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 2, capturedAt: 3 },
    { xMeters: 0, yMeters: 2, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const obstacle = [
    { xMeters: 1.5, yMeters: 0.75, capturedAt: 6 },
    { xMeters: 2.5, yMeters: 0.75, capturedAt: 7 },
    { xMeters: 2.5, yMeters: 1.25, capturedAt: 8 },
    { xMeters: 1.5, yMeters: 1.25, capturedAt: 9 },
    { xMeters: 1.5, yMeters: 0.75, capturedAt: 10 },
  ];

  const plan = buildMowingPlan(area, {
    headingDeg: 0,
    stripSpacingMeters: 1,
    obstacles: [obstacle],
  });

  const stripsAtOne = plan.strips.filter((strip) => Math.abs(strip.centerOffsetMeters - 1) < 1e-9);
  assert.equal(stripsAtOne.length, 2);
  assert.deepEqual(
    stripsAtOne.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
    ]),
    [
      [2.5, 4],
      [0, 1.5],
    ],
  );
  assert.equal(plan.connectors.some((connector) => connector.length > 2), true);
});

test("normalizeAxisHeading treats opposite directions as the same strip axis", () => {
  assert.equal(normalizeAxisHeading(315), 135);
  assert.equal(normalizeAxisHeading(-45), 135);
  assert.equal(normalizeAxisHeading(180), 0);
});
