import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBusAdapter } from "../../src/bus/busAdapter.js";
import { decodeFrame } from "../../src/bus/frameCodec.js";
import { PollingGnssNodeClient } from "../../src/nodes/gnssNodeClient.js";
import { MessageType, NodeId } from "../../src/protocols/commonProtocol.js";

test("PollingGnssNodeClient requests and decodes GNSS samples", async () => {
  const bus = new InMemoryBusAdapter();
  const client = new PollingGnssNodeClient(bus);
  const sample = {
    timestampMillis: 1000,
    xMeters: 1.234,
    yMeters: -5.678,
    headingDegrees: 90,
    positionAccuracyMeters: 0.02,
    fixType: "fixed" as const,
    satellitesInUse: 20,
    sampleAgeMillis: 30,
  };

  bus.setResponder(NodeId.Gnss, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    assert.equal(request.header.messageType, MessageType.GnssSample);
    return PollingGnssNodeClient.encodeResponse(sample, request.header.sequence, 0x02);
  });

  const refreshed = await client.refresh();
  assert.deepEqual(refreshed, sample);
  assert.deepEqual(client.latestSample(), sample);
  assert.deepEqual(client.health(), {
    online: true,
    stale: false,
    lastSeenMillis: 1000,
    faultFlags: 0x02,
  });
});
