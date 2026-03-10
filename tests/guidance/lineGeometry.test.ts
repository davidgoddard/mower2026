import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLineTrackingError,
  projectPointOntoSegment,
  segmentLength,
  signedCrossTrackErrorMeters,
  targetHeadingDegrees,
} from "../../src/guidance/lineGeometry.js";

test("segmentLength returns Euclidean distance", () => {
  assert.equal(
    segmentLength({
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: 3, yMeters: 4, headingDegrees: 0 },
    }),
    5,
  );
});

test("targetHeadingDegrees returns heading for positive x axis", () => {
  assert.equal(
    targetHeadingDegrees({
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: 10, yMeters: 0, headingDegrees: 0 },
    }),
    0,
  );
});

test("projectPointOntoSegment clamps beyond segment end", () => {
  const result = projectPointOntoSegment(
    { xMeters: 15, yMeters: 2, headingDegrees: 0 },
    {
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: 10, yMeters: 0, headingDegrees: 0 },
    },
  );

  assert.equal(result.alongTrackMeters, 15);
  assert.equal(result.clampedAlongTrackMeters, 10);
  assert.deepEqual(result.closestPoint, { xMeters: 10, yMeters: 0 });
});

test("signedCrossTrackErrorMeters is positive when point is left of travel direction", () => {
  const error = signedCrossTrackErrorMeters(
    { xMeters: 5, yMeters: 2, headingDegrees: 0 },
    {
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: 10, yMeters: 0, headingDegrees: 0 },
    },
  );

  assert.equal(error, 2);
});

test("evaluateLineTrackingError returns normalized heading error", () => {
  const result = evaluateLineTrackingError(
    { xMeters: -4, yMeters: -1, headingDegrees: 170 },
    {
      start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
      end: { xMeters: -10, yMeters: 0, headingDegrees: 0 },
    },
  );

  assert.equal(result.crossTrackErrorMeters, 1);
  assert.equal(result.alongTrackMeters, 4);
  assert.equal(result.targetHeadingDegrees, 180);
  assert.equal(result.headingErrorDegrees, 10);
});
