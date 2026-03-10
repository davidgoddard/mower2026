import type { Pose2D } from "../estimation/estimatorTypes.js";
import type { LineSegment, LineTrackingError } from "./guidanceTypes.js";
import { clamp } from "../util/math.js";
import { normalizeAngleDegrees } from "../util/angles.js";

export function segmentLength(segment: LineSegment): number {
  const dx = segment.end.xMeters - segment.start.xMeters;
  const dy = segment.end.yMeters - segment.start.yMeters;
  return Math.hypot(dx, dy);
}

export function targetHeadingDegrees(segment: LineSegment): number {
  const dx = segment.end.xMeters - segment.start.xMeters;
  const dy = segment.end.yMeters - segment.start.yMeters;
  return normalizeAngleDegrees((Math.atan2(dy, dx) * 180) / Math.PI);
}

export function projectPointOntoSegment(point: Pose2D, segment: LineSegment): {
  readonly alongTrackMeters: number;
  readonly clampedAlongTrackMeters: number;
  readonly closestPoint: { readonly xMeters: number; readonly yMeters: number };
} {
  const dx = segment.end.xMeters - segment.start.xMeters;
  const dy = segment.end.yMeters - segment.start.yMeters;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return {
      alongTrackMeters: 0,
      clampedAlongTrackMeters: 0,
      closestPoint: {
        xMeters: segment.start.xMeters,
        yMeters: segment.start.yMeters,
      },
    };
  }

  const px = point.xMeters - segment.start.xMeters;
  const py = point.yMeters - segment.start.yMeters;
  const projection = (px * dx + py * dy) / lengthSquared;
  const clampedProjection = clamp(projection, 0, 1);
  const length = Math.sqrt(lengthSquared);

  return {
    alongTrackMeters: projection * length,
    clampedAlongTrackMeters: clampedProjection * length,
    closestPoint: {
      xMeters: segment.start.xMeters + clampedProjection * dx,
      yMeters: segment.start.yMeters + clampedProjection * dy,
    },
  };
}

export function signedCrossTrackErrorMeters(point: Pose2D, segment: LineSegment): number {
  const dx = segment.end.xMeters - segment.start.xMeters;
  const dy = segment.end.yMeters - segment.start.yMeters;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return 0;
  }

  const px = point.xMeters - segment.start.xMeters;
  const py = point.yMeters - segment.start.yMeters;
  return (dx * py - dy * px) / length;
}

export function evaluateLineTrackingError(point: Pose2D, segment: LineSegment): LineTrackingError {
  const desiredHeading = targetHeadingDegrees(segment);
  const projection = projectPointOntoSegment(point, segment);

  return {
    crossTrackErrorMeters: signedCrossTrackErrorMeters(point, segment),
    alongTrackMeters: projection.clampedAlongTrackMeters,
    targetHeadingDegrees: desiredHeading,
    headingErrorDegrees: normalizeAngleDegrees(desiredHeading - point.headingDegrees),
  };
}
