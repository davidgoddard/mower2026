import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { decodeGnssDebugLine, gnssDebugPayloadLength } from '../dist/gnss/gnssDebugCodec.js';

const PAYLOAD_LENGTH = 116;

test('gnssDebugPayloadLength reports the debug layout length', () => {
  assert.equal(gnssDebugPayloadLength(), PAYLOAD_LENGTH);
});

test('decodeGnssDebugLine decodes a raw low-satellite payload', () => {
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  const text = 'COM2,0,0,FINESTEERING,0,0,0,0';
  const bytes = Buffer.from(text, 'utf8');

  payload[0] = 0x01;
  payload[1] = 5;
  payload[2] = 3;
  payload[3] = bytes.length;
  payload.set(bytes.subarray(0, PAYLOAD_LENGTH - 4), 4);

  const decoded = decodeGnssDebugLine(payload);
  assert.ok(decoded);
  assert.equal(decoded.satellitesInUse, 5);
  assert.equal(decoded.fixType, 'fixed');
  assert.equal(decoded.rawPayload, text);
  assert.equal(decoded.truncated, false);
});

test('decodeGnssDebugLine returns null when no sentence is present', () => {
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  assert.equal(decodeGnssDebugLine(payload), null);
});
