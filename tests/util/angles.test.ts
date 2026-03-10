import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAngleDegrees } from "../../src/util/angles.js";

test("normalizeAngleDegrees wraps positive angles", () => {
  assert.equal(normalizeAngleDegrees(181), -179);
  assert.equal(normalizeAngleDegrees(540), 180);
});

test("normalizeAngleDegrees wraps negative angles", () => {
  assert.equal(normalizeAngleDegrees(-181), 179);
  assert.equal(normalizeAngleDegrees(-540), 180);
});
