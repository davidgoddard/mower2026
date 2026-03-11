import type { ParameterSet } from "../config/parameterSchema.js";
import type { WheelTargets } from "./controlTypes.js";
import { applyMotorTrim } from "./motorTrim.js";

function toRawWheelTarget(physicalMetersPerSecond: number, forwardSign: number): number {
  return physicalMetersPerSecond * forwardSign;
}

export function mapPhysicalWheelTargetsToRaw(parameters: ParameterSet, targets: WheelTargets): WheelTargets {
  const trimmed = applyMotorTrim(parameters, targets);
  return {
    leftMetersPerSecond: toRawWheelTarget(trimmed.leftMetersPerSecond, parameters.leftMotorForwardSign),
    rightMetersPerSecond: toRawWheelTarget(trimmed.rightMetersPerSecond, parameters.rightMotorForwardSign),
  };
}
