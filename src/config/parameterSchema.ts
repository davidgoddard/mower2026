export interface ParameterSet {
  readonly controlLoopHz: number;
  readonly physicalCuttingWidthMeters: number;
  readonly effectivePlanningStripeWidthMeters: number;
  readonly estimatedLawnAreaSquareMeters: number;
  readonly wheelBaseMeters: number;
  readonly wheelCircumferenceMeters: number;
  readonly encoderCountsPerWheelRevolution: number;
  readonly antennaBaselineMeters: number;
  readonly frontAntennaForwardOfAxleMeters: number;
  readonly maxWheelSpeedMetersPerSecond: number;
  readonly maxWheelAccelerationMetersPerSecondSquared: number;
  readonly motorRampUpMillis: number;
  readonly motorRampDownMillis: number;
  readonly waypointArrivalToleranceMeters: number;
  readonly headingArrivalToleranceDegrees: number;
}
