import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAngleTo180,
  normalizeAngleTo360,
  createFieldHeading,
  createInternalHeading,
  createRelativeAngle,
  fieldToInternal,
  internalToField,
  headingDifference,
  addRelativeAngle,
  unwrapFieldHeading,
  unwrapInternalHeading,
  unwrapRelativeAngle,
  isValidFieldHeadingRange,
  isValidNormalizedRange,
} from "../dist/geometry/headingTypes.js";

describe("Heading Types", () => {
  describe("normalizeAngleTo180", () => {
    it("should normalize angles to (-180, 180]", () => {
      assert.equal(normalizeAngleTo180(0), 0);
      assert.equal(normalizeAngleTo180(90), 90);
      assert.equal(normalizeAngleTo180(180), 180);
      assert.equal(normalizeAngleTo180(-180), 180); // wraps to 180
      assert.equal(normalizeAngleTo180(270), -90);
      assert.equal(normalizeAngleTo180(-270), 90);
      assert.equal(normalizeAngleTo180(360), 0);
      assert.equal(normalizeAngleTo180(450), 90);
      assert.equal(normalizeAngleTo180(-450), -90);
    });

    it("should handle multiple wraps", () => {
      assert.equal(normalizeAngleTo180(720), 0);
      assert.equal(normalizeAngleTo180(-720), 0);
      assert.equal(normalizeAngleTo180(1080), 0);
    });
  });

  describe("normalizeAngleTo360", () => {
    it("should normalize angles to [0, 360)", () => {
      assert.equal(normalizeAngleTo360(0), 0);
      assert.equal(normalizeAngleTo360(90), 90);
      assert.equal(normalizeAngleTo360(180), 180);
      assert.equal(normalizeAngleTo360(270), 270);
      assert.equal(normalizeAngleTo360(360), 0);
      assert.equal(normalizeAngleTo360(-90), 270);
      assert.equal(normalizeAngleTo360(-180), 180);
      assert.equal(normalizeAngleTo360(-270), 90);
    });

    it("should handle multiple wraps", () => {
      // Use Math.abs to handle -0 vs 0 difference
      assert.equal(Math.abs(normalizeAngleTo360(720)), 0);
      assert.equal(Math.abs(normalizeAngleTo360(-720)), 0);
      assert.equal(normalizeAngleTo360(450), 90);
    });
  });

  describe("createFieldHeading", () => {
    it("should create field headings normalized to [0, 360)", () => {
      const h1 = createFieldHeading(45);
      assert.equal(unwrapFieldHeading(h1), 45);

      const h2 = createFieldHeading(360);
      assert.equal(unwrapFieldHeading(h2), 0);

      const h3 = createFieldHeading(-90);
      assert.equal(unwrapFieldHeading(h3), 270);
    });
  });

  describe("createInternalHeading", () => {
    it("should create internal headings normalized to (-180, 180]", () => {
      const h1 = createInternalHeading(90);
      assert.equal(unwrapInternalHeading(h1), 90);

      const h2 = createInternalHeading(180);
      assert.equal(unwrapInternalHeading(h2), 180);

      const h3 = createInternalHeading(270);
      assert.equal(unwrapInternalHeading(h3), -90);

      const h4 = createInternalHeading(-180);
      assert.equal(unwrapInternalHeading(h4), 180);
    });
  });

  describe("createRelativeAngle", () => {
    it("should create relative angles normalized to (-180, 180]", () => {
      const a1 = createRelativeAngle(45);
      assert.equal(unwrapRelativeAngle(a1), 45);

      const a2 = createRelativeAngle(200);
      assert.equal(unwrapRelativeAngle(a2), -160);

      const a3 = createRelativeAngle(-200);
      assert.equal(unwrapRelativeAngle(a3), 160);
    });
  });

  describe("fieldToInternal", () => {
    it("should convert GNSS field heading to internal heading", () => {
      // North (0°) → +Y (90°)
      const north = createFieldHeading(0);
      const northInternal = fieldToInternal(north);
      assert.equal(unwrapInternalHeading(northInternal), 90);

      // East (90°) → +X (0°)
      const east = createFieldHeading(90);
      const eastInternal = fieldToInternal(east);
      assert.equal(unwrapInternalHeading(eastInternal), 0);

      // South (180°) → -Y (-90°)
      const south = createFieldHeading(180);
      const southInternal = fieldToInternal(south);
      assert.equal(unwrapInternalHeading(southInternal), -90);

      // West (270°) → -X (180° or -180°, both are equivalent at the boundary)
      const west = createFieldHeading(270);
      const westInternal = fieldToInternal(west);
      const westValue = unwrapInternalHeading(westInternal);
      assert.equal(Math.abs(westValue), 180); // Accept either 180 or -180
    });

    it("should handle arbitrary field headings", () => {
      const field45 = createFieldHeading(45);
      const internal45 = fieldToInternal(field45);
      assert.equal(unwrapInternalHeading(internal45), 45);

      const field135 = createFieldHeading(135);
      const internal135 = fieldToInternal(field135);
      assert.equal(unwrapInternalHeading(internal135), -45);

      const field315 = createFieldHeading(315);
      const internal315 = fieldToInternal(field315);
      // 90 - 315 = -225, normalized to range gives 135
      assert.equal(unwrapInternalHeading(internal315), 135);
    });
  });

  describe("internalToField", () => {
    it("should convert internal heading to GNSS field heading", () => {
      // +Y (90°) → North (0°)
      const north = createInternalHeading(90);
      const northField = internalToField(north);
      assert.equal(unwrapFieldHeading(northField), 0);

      // +X (0°) → East (90°)
      const east = createInternalHeading(0);
      const eastField = internalToField(east);
      assert.equal(unwrapFieldHeading(eastField), 90);

      // -Y (-90°) → South (180°)
      const south = createInternalHeading(-90);
      const southField = internalToField(south);
      assert.equal(unwrapFieldHeading(southField), 180);

      // -X (-180°) → West (270°)
      const west = createInternalHeading(-180);
      const westField = internalToField(west);
      assert.equal(unwrapFieldHeading(westField), 270);
    });

    it("should round-trip correctly", () => {
      const originalField = createFieldHeading(123);
      const internal = fieldToInternal(originalField);
      const backToField = internalToField(internal);
      assert.equal(unwrapFieldHeading(backToField), unwrapFieldHeading(originalField));
    });
  });

  describe("headingDifference", () => {
    it("should compute shortest angular distance", () => {
      const h1 = createInternalHeading(10);
      const h2 = createInternalHeading(20);
      const diff1 = headingDifference(h1, h2);
      assert.equal(unwrapRelativeAngle(diff1), 10);

      const h3 = createInternalHeading(170);
      const h4 = createInternalHeading(-170);
      const diff2 = headingDifference(h3, h4);
      assert.equal(unwrapRelativeAngle(diff2), 20); // shortest path is 20° CCW, not 340° CW
    });

    it("should handle wrap-around cases", () => {
      const h1 = createInternalHeading(-170);
      const h2 = createInternalHeading(170);
      const diff1 = headingDifference(h1, h2);
      assert.equal(unwrapRelativeAngle(diff1), -20); // -20° is shorter than +340°

      const h3 = createInternalHeading(0);
      const h4 = createInternalHeading(180);
      const diff2 = headingDifference(h3, h4);
      assert.equal(unwrapRelativeAngle(diff2), 180);
    });

    it("should return zero for same heading", () => {
      const h1 = createInternalHeading(45);
      const h2 = createInternalHeading(45);
      const diff = headingDifference(h1, h2);
      assert.equal(unwrapRelativeAngle(diff), 0);
    });

    it("should show positive = CCW turn needed", () => {
      // Current heading: 0° (+X, East)
      // Target heading: 90° (+Y, North)
      // Need +90° CCW turn
      const current = createInternalHeading(0);
      const target = createInternalHeading(90);
      const diff = headingDifference(current, target);
      assert.equal(unwrapRelativeAngle(diff), 90);
    });
  });

  describe("addRelativeAngle", () => {
    it("should add relative angle to heading", () => {
      const h1 = createInternalHeading(45);
      const delta = createRelativeAngle(30);
      const result = addRelativeAngle(h1, delta);
      assert.equal(unwrapInternalHeading(result), 75);
    });

    it("should normalize result", () => {
      const h1 = createInternalHeading(170);
      const delta = createRelativeAngle(30);
      const result = addRelativeAngle(h1, delta);
      assert.equal(unwrapInternalHeading(result), -160);
    });

    it("should handle negative deltas", () => {
      const h1 = createInternalHeading(45);
      const delta = createRelativeAngle(-90);
      const result = addRelativeAngle(h1, delta);
      assert.equal(unwrapInternalHeading(result), -45);
    });
  });

  describe("isValidFieldHeadingRange", () => {
    it("should validate field heading range [0, 360)", () => {
      assert.equal(isValidFieldHeadingRange(0), true);
      assert.equal(isValidFieldHeadingRange(90), true);
      assert.equal(isValidFieldHeadingRange(359.9), true);
      assert.equal(isValidFieldHeadingRange(360), false);
      assert.equal(isValidFieldHeadingRange(-1), false);
      assert.equal(isValidFieldHeadingRange(-90), false);
    });
  });

  describe("isValidNormalizedRange", () => {
    it("should validate normalized range (-180, 180]", () => {
      assert.equal(isValidNormalizedRange(0), true);
      assert.equal(isValidNormalizedRange(90), true);
      assert.equal(isValidNormalizedRange(180), true);
      assert.equal(isValidNormalizedRange(-90), true);
      assert.equal(isValidNormalizedRange(-179.9), true);
      assert.equal(isValidNormalizedRange(-180), false);
      assert.equal(isValidNormalizedRange(180.1), false);
      assert.equal(isValidNormalizedRange(270), false);
    });
  });

  describe("Real-world mower scenarios", () => {
    it("should handle mower pointing East, GNSS reports 90°", () => {
      const gnssHeading = createFieldHeading(90); // East
      const internal = fieldToInternal(gnssHeading);
      assert.equal(unwrapInternalHeading(internal), 0); // +X axis
    });

    it("should handle mower turning from East to North", () => {
      const current = createInternalHeading(0); // East, +X
      const target = createInternalHeading(90); // North, +Y
      const turnAngle = headingDifference(current, target);
      assert.equal(unwrapRelativeAngle(turnAngle), 90); // 90° CCW turn
    });

    it("should handle mower turning from North to West", () => {
      const current = createInternalHeading(90); // North, +Y
      const target = createInternalHeading(180); // West, -X
      const turnAngle = headingDifference(current, target);
      assert.equal(unwrapRelativeAngle(turnAngle), 90); // 90° CCW turn
    });

    it("should handle IMU yaw integration", () => {
      const initialHeading = createInternalHeading(45);
      const yawDelta = createRelativeAngle(15); // 15° CCW measured by IMU
      const newHeading = addRelativeAngle(initialHeading, yawDelta);
      assert.equal(unwrapInternalHeading(newHeading), 60);
    });

    it("should handle correction angle from GNSS to IMU", () => {
      const gnssFieldHeading = createFieldHeading(45); // NE direction
      const gnssInternal = fieldToInternal(gnssFieldHeading); // Convert to internal
      const imuHeading = createInternalHeading(50); // IMU drifted 5° off

      const correction = headingDifference(imuHeading, gnssInternal);
      // Should tell us how much to adjust IMU to match GNSS
      const correctedHeading = addRelativeAngle(imuHeading, correction);

      assert.equal(
        unwrapInternalHeading(correctedHeading),
        unwrapInternalHeading(gnssInternal),
      );
    });
  });
});
