import type { WheelTargets } from "./controlTypes.js";
import { clamp } from "../util/math.js";

export interface CommandLimiterOptions {
  readonly maxWheelSpeedMetersPerSecond: number;
  readonly maxWheelStepMetersPerSecond: number;
}

export class CommandLimiter {
  public constructor(private readonly options: CommandLimiterOptions) {}

  public limit(previous: WheelTargets, requested: WheelTargets): WheelTargets {
    return {
      leftMetersPerSecond: clampStep(
        clamp(requested.leftMetersPerSecond, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        previous.leftMetersPerSecond,
        this.options.maxWheelStepMetersPerSecond,
      ),
      rightMetersPerSecond: clampStep(
        clamp(requested.rightMetersPerSecond, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        previous.rightMetersPerSecond,
        this.options.maxWheelStepMetersPerSecond,
      ),
    };
  }
}

function clampStep(requested: number, previous: number, maxStep: number): number {
  return clamp(requested, previous - maxStep, previous + maxStep);
}
