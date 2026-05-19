import type { MotorFeedbackSample } from "./motorProtocol.js";

export interface MotorDirectionMapping {
  readonly leftMotorForwardSign: 1 | -1;
  readonly rightMotorForwardSign: 1 | -1;
}

export interface WheelOutputTargets {
  readonly leftPercent: number;
  readonly rightPercent: number;
}

export interface NormalizedWheelTargets {
  readonly leftPercent: number;
  readonly rightPercent: number;
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

export function clampNormalizedWheelTargets(
  wheelOutputs: WheelOutputTargets,
): NormalizedWheelTargets {
  return {
    leftPercent: Math.max(-1, Math.min(1, wheelOutputs.leftPercent)),
    rightPercent: Math.max(-1, Math.min(1, wheelOutputs.rightPercent)),
  };
}

export function mapNormalizedWheelTargetsToRaw(
  mapping: MotorDirectionMapping,
  normalized: NormalizedWheelTargets,
): NormalizedWheelTargets {
  return {
    leftPercent: normalized.leftPercent * mapping.leftMotorForwardSign,
    rightPercent: normalized.rightPercent * mapping.rightMotorForwardSign,
  };
}

export function mapRawMotorFeedbackToAppConvention(
  mapping: MotorDirectionMapping,
  raw: MotorFeedbackSample,
): MotorFeedbackSample {
  return {
    ...raw,
    leftEncoderDelta: raw.leftEncoderDelta * mapping.leftMotorForwardSign,
    rightEncoderDelta: raw.rightEncoderDelta * mapping.rightMotorForwardSign,
    leftPwmAppliedPercent: raw.leftPwmAppliedPercent * mapping.leftMotorForwardSign,
    rightPwmAppliedPercent: raw.rightPwmAppliedPercent * mapping.rightMotorForwardSign,
  };
}
