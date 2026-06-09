import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { GnssValidator } from "../dist/sensing/gnssValidator.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";

function createMockLogger() {
  const logger = {
    child: null,
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
  };
  logger.child = mock.fn(() => logger);
  return logger;
}

function makeTrustedSample(timestampMillis, headingDeg = 90) {
  return {
    xMeters: 10,
    yMeters: 20,
    heading: createInternalHeading(headingDeg),
    positionAccuracyMeters: 0.02,
    headingAccuracyDeg: 0.4,
    fixType: "fixed",
    satellitesInUse: 20,
    timestampMillis,
    sampleAgeMillis: 10,
    headingBaselineMeters: 0.3,
    headingValid: true,
    groundSpeedMetersPerSecond: 0,
    rawSample: undefined,
  };
}

function makeRejectedSample(timestampMillis) {
  return {
    xMeters: 10,
    yMeters: 20,
    heading: createInternalHeading(90),
    positionAccuracyMeters: 0.02,
    headingAccuracyDeg: 0.4,
    fixType: "single",
    satellitesInUse: 20,
    timestampMillis,
    sampleAgeMillis: 10,
    headingBaselineMeters: 0.3,
    headingValid: true,
    groundSpeedMetersPerSecond: 0,
    rawSample: undefined,
  };
}

test("GnssValidator accepts a first sample with no previous anchor (cold start)", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const result = validator.validate(makeTrustedSample(1000), createInternalHeading(90));
  assert.equal(result.positionRejections.length, 0);
});

test("GnssValidator keeps heading trusted through short glitches and only demotes after the longer failure window", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const imuHeading = createInternalHeading(90);

  for (let i = 0; i < 5; i++) {
    const result = validator.validate(makeTrustedSample(1000 + i * 100), imuHeading);
    if (i < 4) {
      assert.notEqual(result.heading, "TRUSTED");
    }
  }

  assert.equal(validator.isPositionTrusted(), true);
  assert.equal(validator.isHeadingTrusted(), true);

  for (let i = 0; i < 39; i++) {
    const result = validator.validate(makeRejectedSample(2000 + i * 100), imuHeading);
    assert.equal(result.heading, "TRUSTED");
    assert.equal(validator.isHeadingTrusted(), true);
  }

  const finalResult = validator.validate(makeRejectedSample(6000), imuHeading);
  assert.equal(finalResult.heading, "REJECTED");
  assert.equal(validator.isHeadingTrusted(), false);
});
