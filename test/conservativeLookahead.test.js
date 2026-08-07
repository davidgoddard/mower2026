import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planConservativeRouteLookahead } from "../dist/pathfollowing/conservativeLookahead.js";

const OPTIONS = {
  minimumLookaheadMeters: 0.25,
  maximumLookaheadMeters: 1,
  maximumPathDeviationMeters: 0.05,
  loopPath: true,
};

test("complete-route analysis gives the drain a conservative short lookahead", async () => {
  const obstacle = JSON.parse(await readFile(new URL("../paths/Obstacle_1.path.json", import.meta.url)));
  const plan = planConservativeRouteLookahead(obstacle.points, OPTIONS);

  assert.equal(plan.lookaheadMeters, 0.35);
  assert.equal(plan.maximumDeviationMeters <= 0.05, true);
  assert.equal(plan.requiresCornerStops, false);
});

test("complete-route analysis gives the trampoline a longer stable lookahead", async () => {
  const obstacle = JSON.parse(await readFile(new URL("../paths/Trampolene.path.json", import.meta.url)));
  const plan = planConservativeRouteLookahead(obstacle.points, OPTIONS);

  assert.equal(plan.lookaheadMeters, 0.65);
  assert.equal(plan.maximumDeviationMeters <= 0.05, true);
  assert.equal(plan.requiresCornerStops, false);
});

test("a genuine square corner requires the stop-and-pivot fallback", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 1, yMeters: 0, capturedAt: 2 },
    { xMeters: 1, yMeters: 1, capturedAt: 3 },
  ];
  const plan = planConservativeRouteLookahead(points, { ...OPTIONS, loopPath: false });

  assert.equal(plan.lookaheadMeters, 0.25);
  assert.equal(plan.requiresCornerStops, true);
  assert.equal(plan.maximumDeviationMeters > 0.05, true);
});

test("a straight route uses the configured one metre maximum", () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 2, yMeters: 0, capturedAt: 2 },
  ];
  const plan = planConservativeRouteLookahead(points, { ...OPTIONS, loopPath: false });

  assert.equal(plan.lookaheadMeters, 1);
  assert.equal(plan.maximumDeviationMeters, 0);
  assert.equal(plan.requiresCornerStops, false);
});
