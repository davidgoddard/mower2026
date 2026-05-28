import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGnssSample } from '../dist/gnss/gnssCodec.js';

test('decodeGnssSample rejects sentinel local position coordinates', () => {
  const payload = new Uint8Array(38);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1234, true);
  view.setInt32(4, 1000, true);
  view.setInt32(8, 0x7fffffff, true);
  view.setUint16(20, 20, true);
  view.setUint8(24, 3);
  view.setUint8(25, 12);
  view.setUint16(26, 10, true);

  assert.throws(() => decodeGnssSample(payload), /Invalid GNSS local position/);
});

test('decodeGnssSample rejects implausibly distant local position coordinates', () => {
  const payload = new Uint8Array(38);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1234, true);
  view.setInt32(4, 10_001_000, true);
  view.setInt32(8, 0, true);
  view.setUint16(20, 20, true);
  view.setUint8(24, 3);
  view.setUint8(25, 12);
  view.setUint16(26, 10, true);

  assert.throws(() => decodeGnssSample(payload), /Invalid GNSS local position/);
});
