import type { MotorFeedbackSample } from "./motorProtocol.js";

export interface MotorDirectionMapping {
  readonly leftMotorForwardSign: 1 | -1;
  readonly rightMotorForwardSign: 1 | -1;
}

export interface PhysicalWheelTargets {
  readonly leftMetersPerSecond: number;
  readonly rightMetersPerSecond: number;
}

function normalizeDirectionSign(sign: number): 1 | -1 {
  return sign >= 0 ? 1 : -1;
}

export function buildMotorDirectionMapping(
  leftMotorForwardSign: number,
  rightMotorForwardSign: number,
): MotorDirectionMapping {
  return {
    leftMotorForwardSign: normalizeDirectionSign(leftMotorForwardSign),
    rightMotorForwardSign: normalizeDirectionSign(rightMotorForwardSign),
  };
}

export function mapPhysicalWheelTargetsToRaw(
  mapping: MotorDirectionMapping,
  physical: PhysicalWheelTargets,
): PhysicalWheelTargets {
  return {
    leftMetersPerSecond: physical.leftMetersPerSecond * mapping.leftMotorForwardSign,
    rightMetersPerSecond: physical.rightMetersPerSecond * mapping.rightMotorForwardSign,
  };
}

export function mapRawMotorFeedbackToPhysical(
  mapping: MotorDirectionMapping,
  raw: MotorFeedbackSample,
): MotorFeedbackSample {
  return {
    ...raw,
    leftWheelActualMetersPerSecond: raw.leftWheelActualMetersPerSecond * mapping.leftMotorForwardSign,
    rightWheelActualMetersPerSecond: raw.rightWheelActualMetersPerSecond * mapping.rightMotorForwardSign,
    leftEncoderDelta: raw.leftEncoderDelta * mapping.leftMotorForwardSign,
    rightEncoderDelta: raw.rightEncoderDelta * mapping.rightMotorForwardSign,
    leftPwmApplied: raw.leftPwmApplied * mapping.leftMotorForwardSign,
    rightPwmApplied: raw.rightPwmApplied * mapping.rightMotorForwardSign,
  };
}

