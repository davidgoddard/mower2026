import test from "node:test";
import assert from "node:assert/strict";
import { decodeGnssSample, encodeGnssSample, gnssPayloadLength } from "../../src/protocols/gnssCodec.js";

test("GNSS codec uses a compact fixed payload length", () => {
  assert.equal(gnssPayloadLength(), 34);
});

test("GNSS codec round-trips optional and required fields", () => {
  const sample = {
    timestampMillis: 123456,
    xMeters: 12.345,
    yMeters: -6.789,
    headingDegrees: 179.99,
    pitchDegrees: -1.25,
    groundSpeedMetersPerSecond: 0.456,
    positionAccuracyMeters: 0.012,
    headingAccuracyDegrees: 0.5,
    fixType: "fixed" as const,
    satellitesInUse: 18,
    sampleAgeMillis: 40,
    debug: {
      receiverLineAgeMillis: 12,
      pvtslnaAgeMillis: 34,
      uniheadingAgeMillis: 56,
      rtcmAgeMillis: 78,
    },
  };

  const decoded = decodeGnssSample(encodeGnssSample(sample));
  assert.deepEqual(decoded, sample);
});

test("GNSS codec preserves undefined optional fields", () => {
  const sample = {
    timestampMillis: 50,
    xMeters: 0,
    yMeters: 0,
    positionAccuracyMeters: 1.2,
    fixType: "single" as const,
    satellitesInUse: 8,
    sampleAgeMillis: 100,
  };

  const decoded = decodeGnssSample(encodeGnssSample(sample));
  assert.equal(decoded.headingDegrees, undefined);
  assert.equal(decoded.pitchDegrees, undefined);
  assert.equal(decoded.groundSpeedMetersPerSecond, undefined);
  assert.equal(decoded.headingAccuracyDegrees, undefined);
  assert.equal(decoded.debug, undefined);
});
