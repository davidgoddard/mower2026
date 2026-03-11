import type { ParameterSet } from "../config/parameterSchema.js";
import type { WheelTargets } from "./controlTypes.js";

function scaleForDirection(value: number, forwardScale: number, reverseScale: number): number {
  if (value > 0) {
    return value * forwardScale;
  }
  if (value < 0) {
    return value * reverseScale;
  }
  return 0;
}

export function applyMotorTrim(parameters: ParameterSet, targets: WheelTargets): WheelTargets {
  return {
    leftMetersPerSecond: scaleForDirection(
      targets.leftMetersPerSecond,
      parameters.leftMotorForwardScale,
      parameters.leftMotorReverseScale,
    ),
    rightMetersPerSecond: scaleForDirection(
      targets.rightMetersPerSecond,
      parameters.rightMotorForwardScale,
      parameters.rightMotorReverseScale,
    ),
  };
}
