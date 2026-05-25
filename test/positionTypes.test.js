import test from "node:test";
import assert from "node:assert/strict";
import {
  createPosition,
  createBodyFrameOffset,
  translatePositionByHeading,
  projectWorldDeltaToBodyFrame,
  unwrapMeters,
} from "../dist/geometry/positionTypes.js";
import { createInternalHeading } from "../dist/geometry/headingTypes.js";

test("translatePositionByHeading applies forward/right offsets in body frame", () => {
  const position = createPosition(10, 20);
  const heading = createInternalHeading(90);
  const translated = translatePositionByHeading(position, heading, createBodyFrameOffset(1.5, 0.5));

  assert.equal(unwrapMeters(translated.xMeters), 10.5);
  assert.equal(unwrapMeters(translated.yMeters), 21.5);
});

test("projectWorldDeltaToBodyFrame and translatePositionByHeading round-trip", () => {
  const heading = createInternalHeading(30);
  const offset = createBodyFrameOffset(2.25, -0.75);
  const original = createPosition(4, 5);
  const translated = translatePositionByHeading(original, heading, offset);
  const projected = projectWorldDeltaToBodyFrame(
    unwrapMeters(translated.xMeters) - unwrapMeters(original.xMeters),
    unwrapMeters(translated.yMeters) - unwrapMeters(original.yMeters),
    heading,
  );

  assert.equal(Number(unwrapMeters(projected.forwardMeters).toFixed(6)), 2.25);
  assert.equal(Number(unwrapMeters(projected.rightMeters).toFixed(6)), -0.75);
});
