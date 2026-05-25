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

test("buildMowingPlan penalises connectors that cross already-mown strips", () => {
  // 6m wide x 1m tall area, strips run left-right (heading=0), spacing 2m
  // This gives 3 strips at y=0, y=0.5 (approx), ...
  // Use spacing=2m so we get strips at offset 0 and 2, forcing the connector
  // from strip 1 (y=0) to the next strip to not cut through strip at y=2.
  // More directly: 4 strips spaced evenly. We verify the connector sequence
  // never has a connector that geometrically crosses a strip placed between
  // the connector's source and target strip.
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 3, capturedAt: 3 },
    { xMeters: 0, yMeters: 3, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const plan = buildMowingPlan(area, {
    headingDeg: 0,       // strips run along X axis
    stripSpacingMeters: 1,
  });

  // strips at y=0, 1, 2, 3 — sequenced in order
  assert.equal(plan.stripCount, 4);

  // Verify the sequence is monotonically ordered by centerOffsetMeters —
  // no strip is skipped over (which would force the connector to cross a mown strip).
  const offsets = plan.strips.map((s) => s.centerOffsetMeters);
  const sorted = offsets.slice().sort((a, b) => a - b);
  assert.deepEqual(offsets, sorted, "strips should be sequenced in offset order, not skipping over mown strips");
});
