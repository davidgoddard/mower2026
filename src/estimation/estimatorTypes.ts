export interface Pose2D {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDegrees: number;
}

export interface PoseEstimate extends Pose2D {
  readonly speedMetersPerSecond: number;
  readonly yawRateDegreesPerSecond: number;
  readonly confidence: number;
  readonly timestampMillis: number;
}
