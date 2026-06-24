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

  assert.deepEqual(coords, [
    [0.00, 0.00],
    [0.00, 2.00],
    [4.00, 2.00],
    [4.00, 0.00],
    [0.00, 0.00],
  ]);
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

  assert.deepEqual(coords, [
    [0.00, 0.00],
    [0.01, 4.00],
    [3.00, 4.02],
    [3.02, 1.03],
    [5.00, 1.01],
    [5.01, 3.00],
    [8.00, 2.98],
    [7.99, -0.02],
    [0.00, 0.00],
  ]);
});
