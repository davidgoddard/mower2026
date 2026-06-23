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
