export interface PositionMeasurement {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly accuracyMeters: number;
  readonly timestampMillis: number;
  readonly fixQuality: "none" | "low" | "medium" | "high";
}

export interface HeadingMeasurement {
  readonly headingDegrees: number;
  readonly accuracyDegrees: number;
  readonly timestampMillis: number;
  readonly source: "gnss" | "imu" | "derived";
}

export interface WheelOdometryMeasurement {
  readonly leftDistanceMeters: number;
  readonly rightDistanceMeters: number;
  readonly timestampMillis: number;
  readonly leftSpeedMetersPerSecond: number;
  readonly rightSpeedMetersPerSecond: number;
}

export interface MeasurementBundle {
  readonly position?: PositionMeasurement;
  readonly heading?: HeadingMeasurement;
  readonly wheelOdometry?: WheelOdometryMeasurement;
  readonly faultFlags: number;
  readonly stale: boolean;
}
