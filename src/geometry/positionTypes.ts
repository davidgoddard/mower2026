/**
 * Position and distance types for planar X/Y coordinate system
 */

import { InternalHeading, unwrapInternalHeading } from "./headingTypes.js";

// Branded types for type safety
export type Meters = number & { readonly __brand: "Meters" };

export interface Position {
  readonly xMeters: Meters;
  readonly yMeters: Meters;
}

export interface Pose {
  readonly position: Position;
  readonly heading: InternalHeading;
  readonly quality: "gnss" | "dead-reckoning" | "unknown";
}

// Constructors
export function createMeters(value: number): Meters {
  return value as Meters;
}

export function unwrapMeters(m: Meters): number {
  return m as number;
}

export function createPosition(x: number, y: number): Position {
  return {
    xMeters: createMeters(x),
    yMeters: createMeters(y),
  };
}

export function createPose(
  x: number,
  y: number,
  heading: InternalHeading,
  quality: "gnss" | "dead-reckoning" | "unknown" = "unknown"
): Pose {
  return {
    position: createPosition(x, y),
    heading,
    quality,
  };
}

// Geometry functions

/**
 * Calculate Euclidean distance between two positions
 */
export function distanceBetween(a: Position, b: Position): Meters {
  const dx = unwrapMeters(b.xMeters) - unwrapMeters(a.xMeters);
  const dy = unwrapMeters(b.yMeters) - unwrapMeters(a.yMeters);
  return createMeters(Math.sqrt(dx * dx + dy * dy));
}

/**
 * Calculate angle from position A to position B (in internal heading convention)
 * Returns heading in range [-180, 180] where:
 * - 0 degrees points along +X axis
 * - positive angles rotate counterclockwise toward +Y
 */
export function angleTo(from: Position, to: Position): InternalHeading {
  const dx = unwrapMeters(to.xMeters) - unwrapMeters(from.xMeters);
  const dy = unwrapMeters(to.yMeters) - unwrapMeters(from.yMeters);
  const angleRad = Math.atan2(dy, dx);
  const angleDeg = (angleRad * 180) / Math.PI;

  // Import createInternalHeading but avoid circular dependency
  // We know the result of atan2 is already in correct range
  return angleDeg as any; // Will be properly typed when imported
}

/**
 * Calculate cross-track error: perpendicular distance from point to line
 * Positive CTE = point is to the right of the line (when facing from start to end)
 * Negative CTE = point is to the left of the line
 */
export function crossTrackError(
  point: Position,
  lineStart: Position,
  lineEnd: Position
): Meters {
  const x = unwrapMeters(point.xMeters);
  const y = unwrapMeters(point.yMeters);
  const x1 = unwrapMeters(lineStart.xMeters);
  const y1 = unwrapMeters(lineStart.yMeters);
  const x2 = unwrapMeters(lineEnd.xMeters);
  const y2 = unwrapMeters(lineEnd.yMeters);

  // Line direction vector
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lineLength = Math.sqrt(dx * dx + dy * dy);

  if (lineLength === 0) {
    // Start and end are the same point - return distance to that point
    return distanceBetween(point, lineStart);
  }

  // Perpendicular distance from point to line (signed)
  // Using cross product: (P - P1) × (P2 - P1) / |P2 - P1|
  const cte = ((x - x1) * dy - (y - y1) * dx) / lineLength;
  return createMeters(cte);
}

/**
 * Calculate point along line at given distance from start
 */
export function pointAlongLine(
  start: Position,
  end: Position,
  distanceFromStart: Meters
): Position {
  const x1 = unwrapMeters(start.xMeters);
  const y1 = unwrapMeters(start.yMeters);
  const x2 = unwrapMeters(end.xMeters);
  const y2 = unwrapMeters(end.yMeters);

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lineLength = Math.sqrt(dx * dx + dy * dy);

  if (lineLength === 0) {
    return start;
  }

  const fraction = unwrapMeters(distanceFromStart) / lineLength;
  const x = x1 + dx * fraction;
  const y = y1 + dy * fraction;

  return createPosition(x, y);
}

/**
 * Calculate X error: signed distance along line from target to final position
 * Positive X error = overshot target
 * Negative X error = undershot target
 */
export function calculateXError(
  finalPosition: Position,
  lineStart: Position,
  lineEnd: Position
): Meters {
  const dx = unwrapMeters(finalPosition.xMeters) - unwrapMeters(lineEnd.xMeters);
  const dy = unwrapMeters(finalPosition.yMeters) - unwrapMeters(lineEnd.yMeters);

  // Line direction (unit vector from start to end)
  const lineLength = unwrapMeters(distanceBetween(lineStart, lineEnd));
  if (lineLength === 0) {
    return createMeters(Math.sqrt(dx * dx + dy * dy));
  }

  const lineDx = (unwrapMeters(lineEnd.xMeters) - unwrapMeters(lineStart.xMeters)) / lineLength;
  const lineDy = (unwrapMeters(lineEnd.yMeters) - unwrapMeters(lineStart.yMeters)) / lineLength;

  // Dot product gives signed distance along line
  const xError = dx * lineDx + dy * lineDy;
  return createMeters(xError);
}
