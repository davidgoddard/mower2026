import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalHeading, unwrapInternalHeading } from '../dist/index.js';

test('createInternalHeading keeps heading in (-180, 180]', () => {
  assert.equal(unwrapInternalHeading(createInternalHeading(0)), 0);
  assert.equal(unwrapInternalHeading(createInternalHeading(360)), 0);
  assert.equal(unwrapInternalHeading(createInternalHeading(725)), 5);
  assert.equal(unwrapInternalHeading(createInternalHeading(-10)), -10);
  assert.equal(unwrapInternalHeading(createInternalHeading(181)), -179);
  assert.equal(unwrapInternalHeading(createInternalHeading(-181)), 179);
});
