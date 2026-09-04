import test from "node:test";
import assert from "node:assert/strict";
import { buildPegLayout } from "../scripts/peg-layout-geometry.mjs";

const rectangle = (width, height) => [
  { xMeters: 0, yMeters: 0 },
  { xMeters: width, yMeters: 0 },
  { xMeters: width, yMeters: height },
  { xMeters: 0, yMeters: height },
  { xMeters: 0, yMeters: 0 },
];

test("peg layout derives 83.25 square metre bands from the actual cross-lawn width", () => {
  const layout = buildPegLayout({
    areaPoints: rectangle(23, 10),
    obstaclePointsArray: [],
    headingDeg: 0,
    targetAreaSquareMeters: 83.25,
    edgeInsetMeters: 0.15,
    endpointStandoffMeters: 0.15,
  });

  assert.equal(layout.boundaries.length, 4);
  assert.equal(layout.bands.length, 3);
  assert.ok(Math.abs(layout.bands[0].usableAreaSquareMeters - 83.25) < 0.001);
  assert.ok(Math.abs(layout.bands[1].usableAreaSquareMeters - 83.25) < 0.001);
  assert.ok(Math.abs(layout.bands[0].depthMeters - (83.25 / 23)) < 0.001);
  assert.equal(Number(layout.boundaries[0].spanMeters.toFixed(2)), 23);
  assert.equal(Number(layout.boundaries[0].pegSpanMeters.toFixed(2)), 22.7);
  assert.ok(layout.bands[2].usableAreaSquareMeters < 83.25);
});

test("peg layout increases band depth where an exclusion removes usable area", () => {
  const obstacle = [
    { xMeters: 8, yMeters: 2 },
    { xMeters: 15, yMeters: 2 },
    { xMeters: 15, yMeters: 5 },
    { xMeters: 8, yMeters: 5 },
    { xMeters: 8, yMeters: 2 },
  ];
  const layout = buildPegLayout({
    areaPoints: rectangle(23, 12),
    obstaclePointsArray: [obstacle],
    headingDeg: 0,
    targetAreaSquareMeters: 83.25,
    edgeInsetMeters: 0.15,
    endpointStandoffMeters: 0.15,
  });

  const ordinaryDepth = 83.25 / 23;
  assert.ok(layout.bands.some((band) => band.depthMeters > ordinaryDepth + 0.1));
  for (const band of layout.bands.filter((candidate) => candidate.isFullTargetBand)) {
    assert.ok(Math.abs(band.usableAreaSquareMeters - 83.25) < 0.001);
  }
});

test("peg sequence starts upper-left, crosses right, and then alternates", () => {
  const layout = buildPegLayout({
    areaPoints: rectangle(23, 10),
    obstaclePointsArray: [],
    headingDeg: 0,
    targetAreaSquareMeters: 83.25,
    edgeInsetMeters: 0.15,
    endpointStandoffMeters: 0.15,
  });

  assert.deepEqual(layout.pegs.slice(0, 6).map((peg) => [peg.boundaryIndex, peg.side]), [
    [0, "left"],
    [0, "right"],
    [1, "right"],
    [1, "left"],
    [2, "left"],
    [2, "right"],
  ]);
  assert.ok(layout.pegs[0].point.yMeters > layout.pegs[2].point.yMeters);
});
