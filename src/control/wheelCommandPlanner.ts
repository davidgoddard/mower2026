import type { MotionIntent } from "../guidance/guidanceTypes.js";
import type { WheelPlannerOptions, WheelTargets } from "./controlTypes.js";
import { clamp } from "../util/math.js";

export class WheelCommandPlanner {
  public constructor(private readonly options: WheelPlannerOptions) {}

  public plan(intent: MotionIntent): WheelTargets {
    const yawRateRadiansPerSecond = (intent.yawRateDemandDegreesPerSecond * Math.PI) / 180;
    const differentialSpeed = (yawRateRadiansPerSecond * this.options.wheelBaseMeters) / 2;

    return {
      leftMetersPerSecond: clamp(
        intent.forwardSpeedMetersPerSecond - differentialSpeed,
        -this.options.maxWheelSpeedMetersPerSecond,
        this.options.maxWheelSpeedMetersPerSecond,
      ),
      rightMetersPerSecond: clamp(
        intent.forwardSpeedMetersPerSecond + differentialSpeed,
        -this.options.maxWheelSpeedMetersPerSecond,
        this.options.maxWheelSpeedMetersPerSecond,
      ),
    };
  }
}
