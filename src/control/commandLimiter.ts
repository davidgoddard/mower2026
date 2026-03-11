import type { WheelTargets } from "./controlTypes.js";
import { clamp } from "../util/math.js";

export interface CommandLimiterOptions {
  readonly maxWheelSpeedMetersPerSecond: number;
  readonly maxWheelAccelerationStepMetersPerSecond: number;
  readonly maxWheelDecelerationStepMetersPerSecond: number;
}

export class CommandLimiter {
  public constructor(private readonly options: CommandLimiterOptions) {}

  public limit(previous: WheelTargets, requested: WheelTargets): WheelTargets {
    return {
      leftMetersPerSecond: clampStep(
        clamp(requested.leftMetersPerSecond, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        previous.leftMetersPerSecond,
        this.options.maxWheelAccelerationStepMetersPerSecond,
        this.options.maxWheelDecelerationStepMetersPerSecond,
      ),
      rightMetersPerSecond: clampStep(
        clamp(requested.rightMetersPerSecond, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        previous.rightMetersPerSecond,
        this.options.maxWheelAccelerationStepMetersPerSecond,
        this.options.maxWheelDecelerationStepMetersPerSecond,
      ),
    };
  }
}

function clampStep(
  requested: number,
  previous: number,
  maxAccelerationStep: number,
  maxDecelerationStep: number,
): number {
  const movingFurtherFromZero = Math.abs(requested) > Math.abs(previous) && Math.sign(requested || 1) === Math.sign(previous || 1);
  const maxStep = movingFurtherFromZero ? maxAccelerationStep : maxDecelerationStep;
  return clamp(requested, previous - maxStep, previous + maxStep);
}
