import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGnssSample, gnssPayloadLength } from '../dist/gnss/gnssCodec.js';

const PAYLOAD_LENGTH = 40;

function makePayload() {
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  // Defaults that yield a syntactically valid sample (none-fix, no heading,
  // no UTC, no baseline).  Tests overlay specific fields on top.
  const view = new DataView(payload.buffer);
  // off 16..19 heading sentinel
  view.setInt32(16, 0x7fffffff, true);
  // off 20..21 pitch sentinel
  view.setInt16(20, 0x7fff, true);
  // off 22..23 ground speed sentinel
  view.setUint16(22, 0xffff, true);
  // off 26..27 heading accuracy sentinel
  view.setUint16(26, 0xffff, true);
  // off 28..29 baseline sentinel
  view.setUint16(28, 0xffff, true);
  return { payload, view };
}

test('gnssPayloadLength reports the single layout length', () => {
  assert.equal(gnssPayloadLength(), PAYLOAD_LENGTH);
});

test('decodeGnssSample rejects payloads of the wrong length', () => {
  const wrong = new Uint8Array(PAYLOAD_LENGTH - 1);
  assert.throws(() => decodeGnssSample(wrong), /Invalid GNSS payload length/);
});

test('decodeGnssSample rejects implausibly distant local position coordinates', () => {
  const { payload, view } = makePayload();
  view.setInt32(8, 10_001_000, true);  // x = 10 001 m
  view.setInt32(12, 0, true);
  view.setUint16(24, 30, true);        // 30 mm position accuracy
  view.setUint8(32, 3);                // fixed
  view.setUint8(33, 12);
  assert.throws(() => decodeGnssSample(payload), /Invalid GNSS local position/);
});

test('decodeGnssSample rejects unknown fix codes', () => {
  const { payload, view } = makePayload();
  view.setInt32(8, 0, true);
  view.setInt32(12, 0, true);
  view.setUint16(24, 30, true);
  view.setUint8(32, 9);                // bogus fix code
  view.setUint8(33, 12);
  assert.throws(() => decodeGnssSample(payload), /Unknown GNSS fix code/);
});

test('decodeGnssSample maps a fully populated RTK fixed sample', () => {
  const { payload, view } = makePayload();
  // off 0..7: UTC ms since Unix epoch.  Use 1_700_000_000_000 = 2023-11-14T22:13:20Z.
  const utcLow  = 1_700_000_000_000 & 0xffffffff;
  const utcHigh = Math.floor(1_700_000_000_000 / 0x100000000);
  view.setUint32(0, utcLow >>> 0, true);
  view.setUint32(4, utcHigh, true);
  view.setInt32(8, 12_345, true);             // x = 12.345 m
  view.setInt32(12, -7_890, true);            // y = -7.890 m
  view.setInt32(16, 9000, true);              // heading 90.00°
  view.setInt16(20, -123, true);              // pitch -1.23°
  view.setUint16(22, 750, true);              // ground speed 0.750 m/s
  view.setUint16(24, 18, true);               // position accuracy 0.018 m
  view.setUint16(26, 50, true);               // heading accuracy 0.50°
  view.setUint16(28, 300, true);              // baseline 0.300 m
  view.setUint16(30, 47, true);               // sample age 47 ms
  view.setUint8(32, 3);                       // fixed
  view.setUint8(33, 14);
  view.setUint8(34, 0x07);                    // utc + heading + baseline valid
  view.setUint8(35, 0x07);                    // log config: pvt + rectime + uniheading active

  const sample = decodeGnssSample(payload, { nowMillis: 1_700_000_001_234 });

  assert.equal(sample.timestampMillis, 1_700_000_001_234);
  assert.equal(sample.xMeters, 12.345);
  assert.equal(sample.yMeters, -7.890);
  assert.equal(sample.fixType, 'fixed');
  assert.equal(sample.satellitesInUse, 14);
  assert.equal(sample.sampleAgeMillis, 47);
  assert.equal(sample.headingDegrees, 90);
  assert.equal(sample.pitchDegrees, -1.23);
  assert.equal(sample.groundSpeedMetersPerSecond, 0.75);
  assert.equal(sample.positionAccuracyMeters, 0.018);
  assert.equal(sample.headingAccuracyDegrees, 0.5);
  assert.equal(sample.headingBaselineMeters, 0.3);
  assert.equal(sample.gpsTimeMillis, 1_700_000_000_000);
  assert.equal(sample.headingValid, true);
});

test('decodeGnssSample omits sentinel-valued optional fields', () => {
  const { payload, view } = makePayload();
  view.setInt32(8, 0, true);
  view.setInt32(12, 0, true);
  view.setUint16(24, 50, true);
  view.setUint8(32, 1);                       // single
  view.setUint8(33, 9);
  view.setUint8(34, 0x00);                    // no flags

  const sample = decodeGnssSample(payload, { nowMillis: 100 });

  assert.equal(sample.fixType, 'single');
  assert.equal(sample.headingDegrees, undefined);
  assert.equal(sample.pitchDegrees, undefined);
  assert.equal(sample.groundSpeedMetersPerSecond, undefined);
  assert.equal(sample.headingAccuracyDegrees, undefined);
  assert.equal(sample.headingBaselineMeters, undefined);
  assert.equal(sample.gpsTimeMillis, undefined);
  assert.equal(sample.headingValid, false);
});
