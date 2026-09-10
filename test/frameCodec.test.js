import test from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame } from "../dist/bus/frameCodec.js";

const HEADER = { nodeId: 0x10, messageType: 0x01, flags: 0, sequence: 42 };

test("frame codec round-trips the exact current protocol frame", () => {
  const frame = encodeFrame(HEADER, new Uint8Array([1, 2, 3]));
  const decoded = decodeFrame(frame);
  assert.equal(decoded.header.sequence, 42);
  assert.deepEqual([...decoded.payload], [1, 2, 3]);
});

test("frame codec rejects a different protocol version", () => {
  const frame = encodeFrame({ ...HEADER, version: 2 }, new Uint8Array());
  assert.throws(() => decodeFrame(frame), /Unsupported protocol version/);
});

test("frame codec rejects trailing bytes rather than accepting a partial frame contract", () => {
  const frame = encodeFrame(HEADER, new Uint8Array());
  const extended = new Uint8Array(frame.length + 1);
  extended.set(frame);
  assert.throws(() => decodeFrame(extended), /Frame length mismatch/);
});
