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

test("buildMowingPlan does not skip lanes in the 90 degree seeded test area plan", () => {
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
  for (let index = 1; index < plan.strips.length; index += 1) {
    const previous = plan.strips[index - 1];
    const current = plan.strips[index];
    const offsetDelta = current.centerOffsetMeters - previous.centerOffsetMeters;
    assert.ok(offsetDelta >= -1e-9, "90 degree test plan should keep progressing across offsets");
    assert.ok(offsetDelta <= 0.300000001, "90 degree test plan should not skip intermediate lanes");
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
  assert.equal(plan.strips[1].traversalReversed, false);
  assert.equal(plan.strips[2].traversalReversed, true);
  assert.deepEqual(
    [
      Number(plan.strips[1].start.xMeters.toFixed(2)),
      Number(plan.strips[1].start.yMeters.toFixed(2)),
      Number(plan.strips[1].end.xMeters.toFixed(2)),
      Number(plan.strips[1].end.yMeters.toFixed(2)),
    ],
    [0, 0, 0, 1],
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
