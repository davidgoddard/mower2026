/**
 * Heading type system using branded types to prevent mixing incompatible angle representations.
 *
 * Conventions:
 * - FieldHeading: GNSS/navigation convention, clockwise from north, [0, 360)
 * - InternalHeading: Cartesian convention, counterclockwise from +X axis, (-180, 180]
 * - RelativeAngle: Signed angle difference, (-180, 180]
 * - RawAngle: Unnormalized angle that needs normalization
 */

// Angle normalization constants (implementation details)
const NORMALIZED_ANGLE_MIN = -180;
const NORMALIZED_ANGLE_MAX = 180;
const FIELD_ANGLE_MIN = 0;
const FIELD_ANGLE_MAX = 360;
const DEGREES_PER_CIRCLE = 360;

// Field to internal heading conversion offset
const FIELD_TO_INTERNAL_OFFSET_DEGREES = 90;

type Brand<T, B extends string> = T & { readonly __brand: B };

/**
 * GNSS/navigation heading: clockwise from north, range [0, 360)
 * Example: 0° = North, 90° = East, 180° = South, 270° = West
 */
export type FieldHeading = Brand<number, "FieldHeading">;

/**
 * Internal Cartesian heading: counterclockwise from +X axis, range (-180, 180]
 * Example: 0° = +X (East), 90° = +Y (North), ±180° = -X (West), -90° = -Y (South)
 */
export type InternalHeading = Brand<number, "InternalHeading">;

/**
 * Relative angle or heading difference, range (-180, 180]
 * Used for turn commands, heading errors, and angular deltas
 */
export type RelativeAngle = Brand<number, "RelativeAngle">;

/**
 * Raw unnormalized angle that needs normalization before use
 * Use this as input type for functions that will normalize
 */
export type RawAngle = Brand<number, "RawAngle">;

/**
 * Normalize an angle to the range (-180, 180]
 */
export function normalizeAngleTo180(degrees: number): number {
  let n = degrees % DEGREES_PER_CIRCLE;
  if (n <= NORMALIZED_ANGLE_MIN) n += DEGREES_PER_CIRCLE;
  else if (n > NORMALIZED_ANGLE_MAX) n -= DEGREES_PER_CIRCLE;
  return n;
}

/**
 * Normalize an angle to the range [0, 360)
 */
export function normalizeAngleTo360(degrees: number): number {
  let normalized = degrees % DEGREES_PER_CIRCLE;
  if (normalized < FIELD_ANGLE_MIN) {
    normalized += DEGREES_PER_CIRCLE;
  }
  return normalized;
}

/**
 * Create a FieldHeading from degrees, normalizing to [0, 360)
 */
export function createFieldHeading(degrees: number): FieldHeading {
  return normalizeAngleTo360(degrees) as FieldHeading;
}

/**
 * Create an InternalHeading from degrees, normalizing to (-180, 180]
 */
export function createInternalHeading(degrees: number): InternalHeading {
  return normalizeAngleTo180(degrees) as InternalHeading;
}

/**
 * Create a RelativeAngle from degrees, normalizing to (-180, 180]
 */
export function createRelativeAngle(degrees: number): RelativeAngle {
  return normalizeAngleTo180(degrees) as RelativeAngle;
}

/**
 * Mark a raw angle value that needs processing
 */
export function markRawAngle(degrees: number): RawAngle {
  return degrees as RawAngle;
}

/**
 * Convert field heading (clockwise from north) to internal heading (counterclockwise from +X)
 * Formula: internal = 90° - field
 *
 * Examples:
 * - Field 0° (North) → Internal 90° (+Y)
 * - Field 90° (East) → Internal 0° (+X)
 * - Field 180° (South) → Internal -90° (-Y)
 * - Field 270° (West) → Internal -180° (-X)
 */
export function fieldToInternal(fieldHeading: FieldHeading): InternalHeading {
  return createInternalHeading(FIELD_TO_INTERNAL_OFFSET_DEGREES - (fieldHeading as number));
}

/**
 * Convert internal heading (counterclockwise from +X) to field heading (clockwise from north)
 * Formula: field = 90° - internal
 */
export function internalToField(internalHeading: InternalHeading): FieldHeading {
  return createFieldHeading(FIELD_TO_INTERNAL_OFFSET_DEGREES - (internalHeading as number));
}

/**
 * Compute the signed angular difference from current heading to target heading
 * Result is in range (-180, 180], positive = counterclockwise turn needed
 */
export function headingDifference(
  current: InternalHeading,
  target: InternalHeading,
): RelativeAngle {
  return createRelativeAngle((target as number) - (current as number));
}

/**
 * Add a relative angle to an internal heading
 */
export function addRelativeAngle(
  heading: InternalHeading,
  delta: RelativeAngle,
): InternalHeading {
  return createInternalHeading((heading as number) + (delta as number));
}

/**
 * Extract the numeric value from a branded heading (use sparingly)
 * Prefer using typed functions over extracting raw values
 */
export function unwrapFieldHeading(heading: FieldHeading): number {
  return heading as number;
}

export function unwrapInternalHeading(heading: InternalHeading): number {
  return heading as number;
}

export function unwrapRelativeAngle(angle: RelativeAngle): number {
  return angle as number;
}

export function unwrapRawAngle(angle: RawAngle): number {
  return angle as number;
}

/**
 * Type guard to check if a number is within valid field heading range [0, 360)
 */
export function isValidFieldHeadingRange(degrees: number): boolean {
  return degrees >= FIELD_ANGLE_MIN && degrees < FIELD_ANGLE_MAX;
}

/**
 * Type guard to check if a number is within valid normalized range (-180, 180]
 */
export function isValidNormalizedRange(degrees: number): boolean {
  return degrees > NORMALIZED_ANGLE_MIN && degrees <= NORMALIZED_ANGLE_MAX;
}
