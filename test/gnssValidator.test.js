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
  assert.equal(result.positionRejections.includes("position_jump_too_far"), false);
});

test("GnssValidator rejects a teleporting position sample at fast cadence", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const imuHeading = createInternalHeading(90);

  // First sample anchors at (10, 20).
  const first = validator.validate(makeTrustedSample(1000), imuHeading);
  assert.equal(first.positionRejections.length, 0);

  // 100ms later — at 1m/s × 4× safety = 0.4m allowed; floor is 0.3m so 0.4m allowed.
  // Sample at (200, 200) is 268m away — must be rejected.
  const teleport = {
    ...makeTrustedSample(1100),
    xMeters: 200,
    yMeters: 200,
  };
  const result = validator.validate(teleport, imuHeading);
  assert.equal(result.positionRejections.includes("position_jump_too_far"), true);
});

test("GnssValidator anchor does not drift across a string of rejected teleports", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const imuHeading = createInternalHeading(90);

  // Anchor at (10, 20).
  validator.validate(makeTrustedSample(1000), imuHeading);

  // Series of teleports — all should be rejected against the original anchor,
  // not against the previous (rejected) sample.
  const teleport1 = { ...makeTrustedSample(1100), xMeters: 200, yMeters: 200 };
  const teleport2 = { ...makeTrustedSample(1200), xMeters: 201, yMeters: 201 };
  const teleport3 = { ...makeTrustedSample(1300), xMeters: 202, yMeters: 202 };

  assert.equal(validator.validate(teleport1, imuHeading).positionRejections.includes("position_jump_too_far"), true);
  assert.equal(validator.validate(teleport2, imuHeading).positionRejections.includes("position_jump_too_far"), true);
  assert.equal(validator.validate(teleport3, imuHeading).positionRejections.includes("position_jump_too_far"), true);

  // Next sample close to the original anchor should still be accepted —
  // proving the anchor never moved despite three rejected samples in between.
  const close = { ...makeTrustedSample(1400), xMeters: 10.05, yMeters: 20.05 };
  const closeResult = validator.validate(close, imuHeading);
  assert.equal(closeResult.positionRejections.includes("position_jump_too_far"), false);
});

test("GnssValidator widens the gate after a long outage and re-primes", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const imuHeading = createInternalHeading(90);

  // Anchor at (10, 20) at t=1000ms.
  validator.validate(makeTrustedSample(1000), imuHeading);

  // 30 seconds later — well past the gate-widen threshold (5s default).
  // Even a far-away sample should bypass the jump check.
  const reprime = { ...makeTrustedSample(31_000), xMeters: 50, yMeters: 50 };
  const result = validator.validate(reprime, imuHeading);
  assert.equal(result.positionRejections.includes("position_jump_too_far"), false);
});

test("GnssValidator allows healthy small motion below the jump ceiling", () => {
  const validator = new GnssValidator({ logger: createMockLogger() });
  const imuHeading = createInternalHeading(90);

  validator.validate(makeTrustedSample(1000), imuHeading);

  // Within the floor (0.3m) — should never trip even if dt is very short.
  const tiny = { ...makeTrustedSample(1010), xMeters: 10.05, yMeters: 20.05 };
  const result = validator.validate(tiny, imuHeading);
  assert.equal(result.positionRejections.includes("position_jump_too_far"), false);
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
