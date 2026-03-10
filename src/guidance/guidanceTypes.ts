import type { Pose2D } from "../estimation/estimatorTypes.js";

export interface LineSegment {
  readonly start: Pose2D;
  readonly end: Pose2D;
}

export interface LineTrackingError {
  readonly crossTrackErrorMeters: number;
  readonly alongTrackMeters: number;
  readonly targetHeadingDegrees: number;
  readonly headingErrorDegrees: number;
}

export interface MotionIntent {
  readonly forwardSpeedMetersPerSecond: number;
  readonly yawRateDemandDegreesPerSecond: number;
}
