import test from "node:test";
import assert from "node:assert/strict";
import { GnssAdapter } from "../../src/sensing/gnssAdapter.js";
import { GnssFaultFlag } from "../../src/protocols/faultFlags.js";

test("GnssAdapter converts a fixed RTK sample into position and heading measurements", () => {
  const adapter = new GnssAdapter({
    staleAfterMillis: 250,
    now: () => 1_100,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    xMeters: 10,
    yMeters: -2,
    headingDegrees: 45,
    positionAccuracyMeters: 0.01,
    headingAccuracyDegrees: 0.5,
    fixType: "fixed",
    satellitesInUse: 18,
    sampleAgeMillis: 50,
  });

  assert.deepEqual(bundle.position, {
    xMeters: 10,
    yMeters: -2,
    accuracyMeters: 0.01,
    timestampMillis: 1_000,
    fixQuality: "high",
  });
  assert.deepEqual(bundle.heading, {
    headingDegrees: 45,
    accuracyDegrees: 0.5,
    timestampMillis: 1_000,
    source: "gnss",
  });
  assert.equal(bundle.faultFlags, 0);
  assert.equal(bundle.stale, false);
});

test("GnssAdapter rejects invalid fix and missing heading appropriately", () => {
  const adapter = new GnssAdapter({
    staleAfterMillis: 250,
    now: () => 2_000,
  });

  const bundle = adapter.adapt({
    timestampMillis: 1_000,
    xMeters: 0,
    yMeters: 0,
    positionAccuracyMeters: 5,
    fixType: "none",
    satellitesInUse: 5,
    sampleAgeMillis: 600,
  });

  assert.equal(bundle.position, undefined);
  assert.equal(bundle.heading, undefined);
  assert.equal(bundle.stale, true);
  assert.equal(
    bundle.faultFlags,
    GnssFaultFlag.StaleSample | GnssFaultFlag.InvalidFix | GnssFaultFlag.HeadingUnavailable,
  );
});
