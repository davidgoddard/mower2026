import type { PoseEstimate } from "../estimation/estimatorTypes.js";
import { clamp } from "../util/math.js";
import { evaluateLineTrackingError } from "./lineGeometry.js";
import type { LineSegment, MotionIntent } from "./guidanceTypes.js";

export interface LineTrackerOptions {
  readonly nominalSpeedMetersPerSecond: number;
  readonly maxSpeedMetersPerSecond: number;
  readonly crossTrackGain: number;
  readonly headingGain: number;
  readonly maxYawRateDegreesPerSecond: number;
}

export class LineTracker {
  public constructor(private readonly options: LineTrackerOptions) {}

  public track(segment: LineSegment, estimate: PoseEstimate): MotionIntent {
    const error = evaluateLineTrackingError(estimate, segment);
    const yawRateDemandDegreesPerSecond = clamp(
      this.options.crossTrackGain * error.crossTrackErrorMeters + this.options.headingGain * error.headingErrorDegrees,
      -this.options.maxYawRateDegreesPerSecond,
      this.options.maxYawRateDegreesPerSecond,
    );

    const speedReduction = Math.min(Math.abs(error.crossTrackErrorMeters), 1) * 0.4;
    const confidenceReduction = (1 - estimate.confidence) * 0.5;
    const forwardSpeedMetersPerSecond = clamp(
      this.options.nominalSpeedMetersPerSecond * (1 - speedReduction - confidenceReduction),
      0.1,
      this.options.maxSpeedMetersPerSecond,
    );

    return {
      forwardSpeedMetersPerSecond,
      yawRateDemandDegreesPerSecond,
    };
  }
}
