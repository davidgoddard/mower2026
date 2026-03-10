import type { ParameterSet } from "./parameterSchema.js";

export const defaultParameters: ParameterSet = {
  controlLoopHz: 20,
  physicalCuttingWidthMeters: 0.4,
  effectivePlanningStripeWidthMeters: 0.3,
  estimatedLawnAreaSquareMeters: 500,
  wheelBaseMeters: 0.52,
  wheelCircumferenceMeters: 0.7,
  encoderCountsPerWheelRevolution: 1620,
  antennaBaselineMeters: 0.3,
  frontAntennaForwardOfAxleMeters: 0.07,
  maxWheelSpeedMetersPerSecond: 0.75,
  maxWheelAccelerationMetersPerSecondSquared: 0.5,
  motorRampUpMillis: 1200,
  motorRampDownMillis: 300,
  waypointArrivalToleranceMeters: 0.05,
  headingArrivalToleranceDegrees: 2,
};
