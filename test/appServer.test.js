import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFatalReason } from '../dist/server/appServer.js';

test('describeFatalReason preserves error details', async () => {
  const error = new Error('boom');
  error.name = 'RangeError';
  error.stack = 'RangeError: boom\n    at test.js:1:1';

  const fatal = describeFatalReason(error);

  assert.equal(fatal.message, 'boom');
  assert.equal(fatal.name, 'RangeError');
  assert.equal(fatal.stack, 'RangeError: boom\n    at test.js:1:1');
});

test('describeFatalReason handles non-error values', async () => {
  assert.deepEqual(describeFatalReason('plain failure'), { message: 'plain failure' });
  assert.deepEqual(describeFatalReason(null), { message: 'null' });
  assert.deepEqual(describeFatalReason(undefined), { message: 'undefined' });
});
