import test from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame } from "../../src/bus/frameCodec.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../../src/protocols/commonProtocol.js";

test("encodeFrame and decodeFrame round-trip header and payload", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = encodeFrame(
    {
      nodeId: NodeId.Gnss,
      messageType: MessageType.GnssSample,
      flags: 0x03,
      sequence: 42,
    },
    payload,
  );

  const decoded = decodeFrame(frame);
  assert.deepEqual(decoded.header, {
    version: PROTOCOL_VERSION,
    nodeId: NodeId.Gnss,
    messageType: MessageType.GnssSample,
    flags: 0x03,
    sequence: 42,
  });
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 4]);
});

test("decodeFrame rejects a corrupted CRC", () => {
  const frame = encodeFrame(
    {
      nodeId: NodeId.Motor,
      messageType: MessageType.MotorFeedbackSample,
      flags: 0,
      sequence: 1,
    },
    new Uint8Array([9, 8, 7]),
  );

  frame[4] ^= 0xff;
  assert.throws(() => decodeFrame(frame), /CRC mismatch/);
});
