import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeadingDegrees } from '../dist/index.js';

test('normalizeHeadingDegrees keeps heading in (-180, 180]', () => {
  assert.equal(normalizeHeadingDegrees(0), 0);
  assert.equal(normalizeHeadingDegrees(360), 0);
  assert.equal(normalizeHeadingDegrees(725), 5);
  assert.equal(normalizeHeadingDegrees(-10), -10);
  assert.equal(normalizeHeadingDegrees(181), -179);
  assert.equal(normalizeHeadingDegrees(-181), 179);
});
