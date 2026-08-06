import test from "node:test";
import assert from "node:assert/strict";
import { buildMowingInitialEntryPlan, buildMowingPlan, normalizeAxisHeading } from "../dist/pathfollowing/mowingPlanner.js";

const square = [
  { xMeters: 0, yMeters: 0, capturedAt: 1 },
  { xMeters: 1, yMeters: 0, capturedAt: 2 },
  { xMeters: 1, yMeters: 1, capturedAt: 3 },
  { xMeters: 0, yMeters: 1, capturedAt: 4 },
  { xMeters: 0, yMeters: 0, capturedAt: 5 },
];

function samplePathStaysInsidePolygon(points, polygon, stepMeters = 0.05) {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = Math.hypot(end.xMeters - start.xMeters, end.yMeters - start.yMeters);
    const steps = Math.max(1, Math.ceil(segmentLength / stepMeters));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const point = {
        x: start.xMeters + ((end.xMeters - start.xMeters) * t),
        y: start.yMeters + ((end.yMeters - start.yMeters) * t),
      };
      assert.equal(pointInPolygonOrOnBoundary(point, polygon), true, `connector sample left area at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`);
    }
  }
}

function pointInPolygonOrOnBoundary(point, polygon) {
  return pointOnPolygonBoundary(point, polygon) || pointInPolygon(point, polygon);
}

function pointOnPolygonBoundary(point, polygon) {
  for (let index = 0; index < polygon.length - 1; index += 1) {
    if (pointToSegmentDistance(point, polygon[index], polygon[index + 1]) <= 0.01) {
      return true;
    }
  }
  return false;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    const intersects = ((current.yMeters > point.y) !== (prior.yMeters > point.y))
      && (point.x < (((prior.xMeters - current.xMeters) * (point.y - current.yMeters)) / (prior.yMeters - current.yMeters)) + current.xMeters);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.xMeters - start.xMeters;
  const dy = end.yMeters - start.yMeters;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-9) {
    return Math.hypot(point.x - start.xMeters, point.y - start.yMeters);
  }
  const t = Math.max(0, Math.min(1, (((point.x - start.xMeters) * dx) + ((point.y - start.yMeters) * dy)) / lengthSquared));
  return Math.hypot(
    point.x - (start.xMeters + (dx * t)),
    point.y - (start.yMeters + (dy * t)),
  );
}

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
  assert.ok(plan.performance);
  assert.equal(plan.performance.stripCount, plan.stripCount);
  assert.equal(plan.performance.connectorCount, plan.connectors.length);
  assert.ok(plan.performance.totalMs >= 0);
  assert.ok(plan.performance.sequenceMs >= 0);
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
  assert.deepEqual(
    plan.strips.map((strip) => strip.traversalReversed),
    [true, false, true],
  );
  assert.deepEqual(
    plan.connectors.map((connector) => connector.map((point) => [
      Number(point.xMeters.toFixed(2)),
      Number(point.yMeters.toFixed(2)),
    ])),
    [
      [
        [1, 0.15],
        [0.5, 0.15],
      ],
      [
        [0.5, 0.85],
        [0, 0.85],
      ],
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
  // Strip fragments at the same offset are unordered: compare order-insensitively.
  const segmentSpans = stripAtOneAndHalf
    .map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
    ])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(segmentSpans, [
    [0, 0.5],
    [1.5, 2],
  ]);
});

test("buildMowingPlan keeps preview connectors inside a concave mowing area", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 5, yMeters: 0, capturedAt: 2 },
    { xMeters: 5, yMeters: 5, capturedAt: 3 },
    { xMeters: 3.5, yMeters: 5, capturedAt: 4 },
    { xMeters: 3.5, yMeters: 1.5, capturedAt: 5 },
    { xMeters: 1.5, yMeters: 1.5, capturedAt: 6 },
    { xMeters: 1.5, yMeters: 5, capturedAt: 7 },
    { xMeters: 0, yMeters: 5, capturedAt: 8 },
    { xMeters: 0, yMeters: 0, capturedAt: 9 },
  ];

  const plan = buildMowingPlan(area, {
    headingDeg: 0,
    stripSpacingMeters: 0.5,
  });

  assert.ok(plan.connectors.length > 0);
  for (const connector of plan.connectors) {
    samplePathStaysInsidePolygon(connector, area);
  }
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
  // Strip fragments around an obstacle are unordered: compare order-insensitively.
  const segmentSpans = stripsAtOne
    .map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
    ])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(segmentSpans, [
    [0, 1.5],
    [2.5, 4],
  ]);
  assert.equal(plan.connectors.some((connector) => connector.length > 2), true);
});

test("buildMowingPlan ignores obstacles that do not overlap the active strip offsets", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 2, capturedAt: 3 },
    { xMeters: 0, yMeters: 2, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const farObstacle = [
    { xMeters: 10, yMeters: 10, capturedAt: 6 },
    { xMeters: 11, yMeters: 10, capturedAt: 7 },
    { xMeters: 11, yMeters: 11, capturedAt: 8 },
    { xMeters: 10, yMeters: 11, capturedAt: 9 },
    { xMeters: 10, yMeters: 10, capturedAt: 10 },
  ];

  const withoutObstacle = buildMowingPlan(area, {
    headingDeg: 0,
    stripSpacingMeters: 1,
  });
  const withFarObstacle = buildMowingPlan(area, {
    headingDeg: 0,
    stripSpacingMeters: 1,
    obstacles: [farObstacle],
  });

  assert.equal(withFarObstacle.stripCount, withoutObstacle.stripCount);
  assert.deepEqual(
    withFarObstacle.strips.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.start.yMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
      Number(strip.end.yMeters.toFixed(2)),
      Number(strip.centerOffsetMeters.toFixed(2)),
    ]),
    withoutObstacle.strips.map((strip) => [
      Number(strip.start.xMeters.toFixed(2)),
      Number(strip.start.yMeters.toFixed(2)),
      Number(strip.end.xMeters.toFixed(2)),
      Number(strip.end.yMeters.toFixed(2)),
      Number(strip.centerOffsetMeters.toFixed(2)),
    ]),
  );
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

test("buildMowingPlan keeps the 90 degree seeded test area on the strip-spacing grid even when smoothing revisits prior lanes", () => {
  const capturedAt = 1;
  const area = [
    { xMeters: 0.5, yMeters: 0.5, capturedAt },
    { xMeters: 9.5, yMeters: 0.5, capturedAt: capturedAt + 1 },
    { xMeters: 9.5, yMeters: 5.5, capturedAt: capturedAt + 2 },
    { xMeters: 0.5, yMeters: 5.5, capturedAt: capturedAt + 3 },
    { xMeters: 0.5, yMeters: 0.5, capturedAt: capturedAt + 4 },
  ];
  const obstacle = [
    { xMeters: 4.1, yMeters: 2.0, capturedAt: capturedAt + 5 },
    { xMeters: 5.7, yMeters: 2.0, capturedAt: capturedAt + 6 },
    { xMeters: 6.0, yMeters: 3.0, capturedAt: capturedAt + 7 },
    { xMeters: 5.4, yMeters: 4.0, capturedAt: capturedAt + 8 },
    { xMeters: 3.9, yMeters: 3.7, capturedAt: capturedAt + 9 },
    { xMeters: 3.6, yMeters: 2.7, capturedAt: capturedAt + 10 },
    { xMeters: 4.1, yMeters: 2.0, capturedAt: capturedAt + 11 },
  ];

  const plan = buildMowingPlan(area, {
    headingDeg: 90,
    stripSpacingMeters: 0.3,
    obstacles: [obstacle],
  });

  assert.ok(plan.stripCount > 20);
  const uniqueOffsets = [...new Set(
    plan.strips.map((strip) => Number(strip.centerOffsetMeters.toFixed(6))),
  )].sort((a, b) => a - b);
  for (let index = 1; index < uniqueOffsets.length; index += 1) {
    const offsetDelta = Number((uniqueOffsets[index] - uniqueOffsets[index - 1]).toFixed(6));
    assert.ok(
      Math.abs(offsetDelta - 0.3) <= 0.000001,
      `90 degree test plan should stay on the 0.3m strip grid; saw delta ${offsetDelta}`,
    );
  }
});

test("buildMowingPlan uses configured mowing standoff for same-boundary connectors", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
    mowingStandoffMeters: 0.25,
  });

  assert.deepEqual(
    plan.connectors[0].map((point) => [
      Number(point.xMeters.toFixed(2)),
      Number(point.yMeters.toFixed(2)),
    ]),
    [
      [1, 0.25],
      [0.5, 0.25],
    ],
  );
});

test("buildMowingPlan prefers adjacent strips over routed same-offset continuation across an obstacle", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const obstacle = [
    { xMeters: 1.6, yMeters: 1.4, capturedAt: 6 },
    { xMeters: 2.4, yMeters: 1.4, capturedAt: 7 },
    { xMeters: 2.4, yMeters: 2.6, capturedAt: 8 },
    { xMeters: 1.6, yMeters: 2.6, capturedAt: 9 },
    { xMeters: 1.6, yMeters: 1.4, capturedAt: 10 },
  ];

  const plan = buildMowingPlan(area, {
    headingDeg: 90,
    stripSpacingMeters: 0.4,
    obstacles: [obstacle],
  });

  for (let index = 0; index < plan.strips.length - 1; index += 1) {
    const current = plan.strips[index];
    const next = plan.strips[index + 1];
    assert.notEqual(
      Math.abs(current.centerOffsetMeters - next.centerOffsetMeters) <= 1e-9,
      true,
    );
  }

  const offsets = plan.strips.map((strip) => Number(strip.centerOffsetMeters.toFixed(6)));
  const duplicateOffsetIndex = offsets.findIndex((offset, index) => offsets.indexOf(offset) !== index);
  assert.notEqual(duplicateOffsetIndex, -1, "expected an isolated region to force a later return to a prior offset");

  const seenBeforeDuplicate = new Set(offsets.slice(0, duplicateOffsetIndex));
  const uniqueOffsets = new Set(offsets);
  assert.equal(
    seenBeforeDuplicate.size,
    uniqueOffsets.size,
    "planner should exhaust the locally adjacent non-routed offsets before returning around the obstacle to a deferred fragment",
  );
});

test("buildMowingPlan reanchors strip order around the preferred perimeter start point", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
    preferredStartPoint: { xMeters: 0.5, yMeters: 0 },
  });

  assert.equal(plan.stripCount, 3);
  assert.deepEqual(
    [
      Number(plan.strips[0].start.xMeters.toFixed(2)),
      Number(plan.strips[0].start.yMeters.toFixed(2)),
      Number(plan.strips[0].end.xMeters.toFixed(2)),
      Number(plan.strips[0].end.yMeters.toFixed(2)),
      plan.strips[0].traversalReversed,
    ],
    [0.5, 0, 0.5, 1, false],
  );
  assert.deepEqual(
    plan.strips.map((strip) => Number(strip.centerOffsetMeters.toFixed(2))),
    [-0.5, 0, -1],
  );
  assert.equal(plan.connectors.length, 2);
});

test("buildMowingPlan reanchors to the nearest strip end when that end is closer than the stored strip start", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
    preferredStartPoint: { xMeters: 0.45, yMeters: 1.02 },
  });

  assert.equal(plan.stripCount, 3);
  assert.deepEqual(
    [
      Number(plan.strips[0].start.xMeters.toFixed(2)),
      Number(plan.strips[0].start.yMeters.toFixed(2)),
      Number(plan.strips[0].end.xMeters.toFixed(2)),
      Number(plan.strips[0].end.yMeters.toFixed(2)),
      plan.strips[0].traversalReversed,
    ],
    [0.5, 0, 0.5, 1, true],
  );
});

test("buildMowingPlan reanchors with a consistent traversal after choosing the opposite strip end", () => {
  const plan = buildMowingPlan(square, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
    preferredStartPoint: { xMeters: 0.45, yMeters: 1.02 },
  });

  assert.equal(plan.stripCount, 3);
  assert.equal(plan.strips[0].traversalReversed, true);
  assert.equal(typeof plan.strips[1].traversalReversed, "boolean");
  assert.equal(typeof plan.strips[2].traversalReversed, "boolean");
  assert.deepEqual(
    [
      Number(plan.strips[1].start.xMeters.toFixed(2)),
      Number(plan.strips[1].start.yMeters.toFixed(2)),
      Number(plan.strips[1].end.xMeters.toFixed(2)),
      Number(plan.strips[1].end.yMeters.toFixed(2)),
    ],
    [1, 0, 1, 1],
  );
});

test("buildMowingPlan uses a preferred middle start only for the first strip then sweeps adjacent offsets", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 8, yMeters: 0, capturedAt: 2 },
    { xMeters: 8, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const plan = buildMowingPlan(area, {
    headingDeg: 90,
    stripSpacingMeters: 0.5,
    preferredStartPoint: { xMeters: 4, yMeters: 0 },
  });

  assert.ok(plan.stripCount > 10);
  const offsets = plan.strips.map((strip) => strip.centerOffsetMeters);
  const offsetDeltas = offsets.slice(1).map((offset, index) => Math.abs(offset - offsets[index]));
  const nonAdjacentTransitions = offsetDeltas.filter((delta) => delta > 0.500001);

  assert.equal(
    nonAdjacentTransitions.length,
    1,
    "a middle start should sweep adjacent strips to one edge before crossing the exhausted region once",
  );
  assert.equal(
    offsetDeltas.every((delta) => Math.abs(delta - 0.5) <= 0.000001 || delta > 0.500001),
    true,
  );
});

test("buildMowingInitialEntryPlan selects nearest projected area perimeter point", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 3, capturedAt: 3 },
    { xMeters: 0, yMeters: 3, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 2, yMeters: 1 });

  assert.ok(plan);
  assert.equal(plan.segmentIndex, 0);
  assert.deepEqual(
    [
      Number(plan.entryPoint.xMeters.toFixed(2)),
      Number(plan.entryPoint.yMeters.toFixed(2)),
      Number(plan.approachTarget.xMeters.toFixed(2)),
      Number(plan.approachTarget.yMeters.toFixed(2)),
      Number(plan.distanceMeters.toFixed(2)),
    ],
    [2, 0, 2, 0.15, 1],
  );
});

test("buildMowingInitialEntryPlan shifts entry away from perimeter corners", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 0.05, yMeters: 0.2 });

  assert.ok(plan);
  assert.equal(plan.segmentIndex, 3);
  assert.equal(Number(plan.entryPoint.yMeters.toFixed(2)) >= 0.3, true);
  assert.equal(Number(plan.entryPoint.yMeters.toFixed(2)) <= 3.7, true);
});

test("buildMowingInitialEntryPlan allows inside-area starts to pick a stable nearby edge join", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 6, yMeters: 0, capturedAt: 2 },
    { xMeters: 6, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 3, yMeters: 0.2 });

  assert.ok(plan);
  assert.equal(plan.segmentIndex, 0);
  assert.equal(Number(plan.entryPoint.xMeters.toFixed(2)) >= 0.3, true);
  assert.equal(Number(plan.entryPoint.xMeters.toFixed(2)) <= 5.7, true);
  assert.equal(Number(plan.entryPoint.yMeters.toFixed(2)), 0);
});

test("buildMowingInitialEntryPlan allows outside-area starts to select a direct boundary join", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 3, capturedAt: 3 },
    { xMeters: 0, yMeters: 3, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 4.8, yMeters: 1.2 });

  assert.ok(plan);
  assert.equal(plan.segmentIndex, 1);
  assert.deepEqual(
    [
      Number(plan.entryPoint.xMeters.toFixed(2)),
      Number(plan.entryPoint.yMeters.toFixed(2)),
    ],
    [4, 1.2],
  );
});

test("buildMowingInitialEntryPlan rejects obstacle-blocked perimeter approaches", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 3, capturedAt: 3 },
    { xMeters: 0, yMeters: 3, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const blockingObstacle = [
    { xMeters: 1.8, yMeters: 0.3, capturedAt: 6 },
    { xMeters: 2.2, yMeters: 0.3, capturedAt: 7 },
    { xMeters: 2.2, yMeters: 0.7, capturedAt: 8 },
    { xMeters: 1.8, yMeters: 0.7, capturedAt: 9 },
    { xMeters: 1.8, yMeters: 0.3, capturedAt: 10 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 2, yMeters: 1 }, {
    obstacles: [blockingObstacle],
  });

  assert.ok(plan);
  assert.equal(plan.segmentIndex, 1);
  assert.deepEqual(
    [
      Number(plan.entryPoint.xMeters.toFixed(2)),
      Number(plan.entryPoint.yMeters.toFixed(2)),
    ],
    [4, 1],
  );
});

test("buildMowingInitialEntryPlan returns null when no line-of-sight perimeter point exists", () => {
  const area = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 4, yMeters: 0, capturedAt: 2 },
    { xMeters: 4, yMeters: 4, capturedAt: 3 },
    { xMeters: 0, yMeters: 4, capturedAt: 4 },
    { xMeters: 0, yMeters: 0, capturedAt: 5 },
  ];
  const enclosingObstacle = [
    { xMeters: 1, yMeters: 1, capturedAt: 6 },
    { xMeters: 3, yMeters: 1, capturedAt: 7 },
    { xMeters: 3, yMeters: 3, capturedAt: 8 },
    { xMeters: 1, yMeters: 3, capturedAt: 9 },
    { xMeters: 1, yMeters: 1, capturedAt: 10 },
  ];

  const plan = buildMowingInitialEntryPlan(area, { xMeters: 2, yMeters: 2 }, {
    obstacles: [enclosingObstacle],
  });

  assert.equal(plan, null);
});
