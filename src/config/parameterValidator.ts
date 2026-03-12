import type { ParameterSet } from "./parameterSchema.js";

export interface ParameterValidationIssue {
  readonly field: keyof ParameterSet;
  readonly message: string;
}

export function validateParameters(parameters: ParameterSet): ParameterValidationIssue[] {
  const issues: ParameterValidationIssue[] = [];

  requirePositive(parameters, "controlLoopHz", issues);
  requirePositive(parameters, "physicalCuttingWidthMeters", issues);
  requirePositive(parameters, "effectivePlanningStripeWidthMeters", issues);
  requirePositive(parameters, "estimatedLawnAreaSquareMeters", issues);
  requirePositive(parameters, "wheelBaseMeters", issues);
  requirePositive(parameters, "wheelCircumferenceMeters", issues);
  requirePositive(parameters, "encoderCountsPerWheelRevolution", issues);
  requirePositive(parameters, "antennaBaselineMeters", issues);
  requirePositive(parameters, "maxWheelSpeedMetersPerSecond", issues);
  requirePositive(parameters, "maxWheelAccelerationMetersPerSecondSquared", issues);
  requirePositive(parameters, "maxWheelDecelerationMetersPerSecondSquared", issues);
  requirePositive(parameters, "motorRampUpMillis", issues);
  requirePositive(parameters, "motorRampDownMillis", issues);
  requirePositive(parameters, "leftMotorForwardScale", issues);
  requirePositive(parameters, "leftMotorReverseScale", issues);
  requirePositive(parameters, "rightMotorForwardScale", issues);
  requirePositive(parameters, "rightMotorReverseScale", issues);
  requirePositive(parameters, "calibrationTurnScale", issues);
  requirePositive(parameters, "calibrationLineGainScale", issues);
  requirePositive(parameters, "waypointArrivalToleranceMeters", issues);
  requirePositive(parameters, "headingArrivalToleranceDegrees", issues);

  if (parameters.effectivePlanningStripeWidthMeters > parameters.physicalCuttingWidthMeters) {
    issues.push({
      field: "effectivePlanningStripeWidthMeters",
      message: "effective planning stripe width must not exceed physical cutting width",
    });
  }

  if (parameters.frontAntennaForwardOfAxleMeters < 0) {
    issues.push({
      field: "frontAntennaForwardOfAxleMeters",
      message: "front antenna forward offset must be zero or positive",
    });
  }

  if (parameters.pivotAntennaExcursionMeters < 0) {
    issues.push({
      field: "pivotAntennaExcursionMeters",
      message: "pivot antenna excursion must be zero or positive",
    });
  }

  if (parameters.motorRampDownMillis > parameters.motorRampUpMillis * 2) {
    issues.push({
      field: "motorRampDownMillis",
      message: "motor ramp-down is unexpectedly large relative to ramp-up",
    });
  }

  if (!isDirectionSign(parameters.leftMotorForwardSign)) {
    issues.push({
      field: "leftMotorForwardSign",
      message: "left motor forward sign must be either -1 or 1",
    });
  }

  if (!isDirectionSign(parameters.rightMotorForwardSign)) {
    issues.push({
      field: "rightMotorForwardSign",
      message: "right motor forward sign must be either -1 or 1",
    });
  }

  if (!isDirectionSign(parameters.controllerSteeringSign)) {
    issues.push({
      field: "controllerSteeringSign",
      message: "controller steering sign must be either -1 or 1",
    });
  }

  if (!isDirectionSign(parameters.controllerSpeedSign)) {
    issues.push({
      field: "controllerSpeedSign",
      message: "controller speed sign must be either -1 or 1",
    });
  }

  if (parameters.headingArrivalToleranceDegrees > 10) {
    issues.push({
      field: "headingArrivalToleranceDegrees",
      message: "heading arrival tolerance is too loose for precision mowing",
    });
  }

  return issues;
}

function requirePositive(
  parameters: ParameterSet,
  field: keyof ParameterSet,
  issues: ParameterValidationIssue[],
): void {
  const value = parameters[field];
  if (typeof value === "number" && value <= 0) {
    issues.push({
      field,
      message: `${String(field)} must be positive`,
    });
  }
}

function isDirectionSign(value: number): boolean {
  return value === -1 || value === 1;
}
