export interface WheelTargets {
  readonly leftMetersPerSecond: number;
  readonly rightMetersPerSecond: number;
}

export interface WheelPlannerOptions {
  readonly wheelBaseMeters: number;
  readonly maxWheelSpeedMetersPerSecond: number;
}
