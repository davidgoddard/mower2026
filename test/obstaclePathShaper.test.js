import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeAreaRecordedPath } from '../dist/pathfollowing/obstaclePathShaper.js';

test('shapeAreaRecordedPath removes local wiggles but preserves real corners', () => {
  const points = [
    { xMeters: 0, yMeters: 0, capturedAt: 1 },
    { xMeters: 0.02, yMeters: 0.04, capturedAt: 2 },
    { xMeters: 0.01, yMeters: 1.0, capturedAt: 3 },
    { xMeters: 0, yMeters: 2.0, capturedAt: 4 },
    { xMeters: 2.0, yMeters: 2.02, capturedAt: 5 },
    { xMeters: 4.0, yMeters: 2.0, capturedAt: 6 },
    { xMeters: 4.02, yMeters: 1.02, capturedAt: 7 },
    { xMeters: 4.0, yMeters: 0, capturedAt: 8 },
    { xMeters: 0, yMeters: 0, capturedAt: 9 },
  ];

  const shaped = shapeAreaRecordedPath(points);
  const coords = shaped.map((point) => [Number(point.xMeters.toFixed(2)), Number(point.yMeters.toFixed(2))]);

  assert.equal(coords.length >= 5, true);
  assert.deepEqual(coords[0], coords.at(-1));
  assert.equal(coords.some(([x, y]) => x <= 0.15 && y <= 0.15), true);
  assert.equal(coords.some(([x, y]) => x <= 0.15 && y >= 1.85), true);
  assert.equal(coords.some(([x, y]) => x >= 3.85 && y >= 1.85), true);
  assert.equal(coords.some(([x, y]) => x >= 3.85 && y <= 0.15), true);
});

test('shapeAreaRecordedPath preserves genuine stepped boundary changes', () => {
  const points = [
    { xMeters: 0.00, yMeters: 0.00, capturedAt: 1 },
    { xMeters: 0.02, yMeters: 1.00, capturedAt: 2 },
    { xMeters: -0.01, yMeters: 2.00, capturedAt: 3 },
    { xMeters: 0.01, yMeters: 4.00, capturedAt: 4 },
    { xMeters: 3.00, yMeters: 4.02, capturedAt: 5 },
    { xMeters: 3.02, yMeters: 1.03, capturedAt: 6 },
    { xMeters: 5.00, yMeters: 1.01, capturedAt: 7 },
    { xMeters: 5.01, yMeters: 3.00, capturedAt: 8 },
    { xMeters: 8.00, yMeters: 2.98, capturedAt: 9 },
    { xMeters: 7.99, yMeters: -0.02, capturedAt: 10 },
    { xMeters: 0.00, yMeters: 0.00, capturedAt: 11 },
  ];

  const shaped = shapeAreaRecordedPath(points);
  const coords = shaped.map((point) => [Number(point.xMeters.toFixed(2)), Number(point.yMeters.toFixed(2))]);

  assert.equal(coords.length >= 7, true);
  assert.deepEqual(coords[0], coords.at(-1));
  assert.equal(coords.some(([x, y]) => x <= 0.2 && y >= 3.8), true);
  assert.equal(coords.some(([x, y]) => x >= 2.8 && x <= 3.2 && y >= 3.8), true);
  assert.equal(coords.some(([x, y]) => x >= 4.8 && x <= 5.2 && y >= 0.8 && y <= 1.2), true);
  assert.equal(coords.some(([x, y]) => x >= 4.8 && x <= 5.2 && y >= 2.8), true);
  assert.equal(coords.some(([x, y]) => x >= 7.8 && y <= 0.2), true);
});

test('shapeAreaRecordedPath trims overlapping start end sections into one clean loop', () => {
  const points = [
    { xMeters: 0.0, yMeters: 0.0, capturedAt: 1 },
    { xMeters: 2.0, yMeters: 0.0, capturedAt: 2 },
    { xMeters: 2.0, yMeters: 2.0, capturedAt: 3 },
    { xMeters: 0.0, yMeters: 2.0, capturedAt: 4 },
    { xMeters: 0.0, yMeters: 0.4, capturedAt: 5 },
    { xMeters: 0.0, yMeters: 0.1, capturedAt: 6 },
    { xMeters: 0.0, yMeters: 0.0, capturedAt: 7 },
  ];

  const shaped = shapeAreaRecordedPath(points);
  const coords = shaped.map((point) => [Number(point.xMeters.toFixed(2)), Number(point.yMeters.toFixed(2))]);

  assert.equal(coords.length >= 5, true);
  assert.deepEqual(coords[0], coords.at(-1));
  assert.equal(coords.some(([x, y]) => x >= 1.85 && y <= 0.15), true);
  assert.equal(coords.some(([x, y]) => x >= 1.85 && y >= 1.85), true);
  assert.equal(coords.some(([x, y]) => x <= 0.15 && y >= 1.85), true);
});

test('shapeAreaRecordedPath removes short inward double backs without leaving the recorded perimeter', () => {
  const points = [
    { xMeters: 0.0, yMeters: 0.0, capturedAt: 1 },
    { xMeters: 3.0, yMeters: 0.0, capturedAt: 2 },
    { xMeters: 3.0, yMeters: 1.0, capturedAt: 3 },
    { xMeters: 2.92, yMeters: 1.08, capturedAt: 4 },
    { xMeters: 2.98, yMeters: 0.96, capturedAt: 5 },
    { xMeters: 3.0, yMeters: 3.0, capturedAt: 6 },
    { xMeters: 0.0, yMeters: 3.0, capturedAt: 7 },
    { xMeters: 0.0, yMeters: 0.0, capturedAt: 8 },
  ];

  const shaped = shapeAreaRecordedPath(points);

  assert.equal(shaped.some((point) => point.xMeters > 3.01), false);
  assert.equal(shaped.some((point) => point.yMeters < -0.01), false);
  assert.equal(shaped[0].xMeters, shaped.at(-1).xMeters);
  assert.equal(shaped[0].yMeters, shaped.at(-1).yMeters);
});
