import test from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame } from "../dist/bus/frameCodec.js";
import { GnssNodeClient } from "../dist/gnss/gnssNodeClient.js";
import { MessageType, NodeId } from "../dist/protocols/commonProtocol.js";

function availableSamplePayload() {
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  view.setInt32(16, 0x7fffffff, true);
  view.setInt16(20, 0x7fff, true);
  view.setUint16(22, 0xffff, true);
  view.setUint16(24, 65_000, true);
  view.setUint16(26, 0xffff, true);
  view.setUint16(28, 0xffff, true);
  view.setUint16(30, 10, true);
  return payload;
}

test("GNSS client accepts only the response belonging to its request", async () => {
  const controller = {
    queueRead: async ({ requestPayload }) => {
      const request = decodeFrame(requestPayload);
      return encodeFrame({
        nodeId: NodeId.Gnss,
        messageType: MessageType.GnssSample,
        flags: 0,
        sequence: request.header.sequence,
      }, availableSamplePayload());
    },
  };
  const client = new GnssNodeClient(controller, { address: 0x52, maxAttempts: 1, nowMillis: () => 123 });
  const sample = await client.refresh();
  assert.equal(sample.timestampMillis, 123);
  assert.equal(sample.sampleAgeMillis, 10);
});

test("GNSS client rejects a stale response from an earlier transaction", async () => {
  const controller = {
    queueRead: async () => encodeFrame({
      nodeId: NodeId.Gnss,
      messageType: MessageType.GnssSample,
      flags: 0,
      sequence: 99,
    }, availableSamplePayload()),
  };
  const client = new GnssNodeClient(controller, { address: 0x52, maxAttempts: 1 });
  await assert.rejects(client.refresh(), /Stale GNSS response sequence/);
});
