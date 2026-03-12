import type { Pose2D, PoseEstimate } from "../estimation/estimatorTypes.js";
import type { LineSegment } from "../guidance/guidanceTypes.js";
import type { CoverageLane } from "../planning/coverageTypes.js";
import type { WheelTargets } from "../control/controlTypes.js";

export interface LaneMissionSequence {
  readonly lane: CoverageLane;
  readonly segments: readonly LaneMissionSegment[];
}

export type LaneMissionSegment =
  | {
      readonly id: string;
      readonly kind: "turn";
      readonly targetHeadingDegrees: number;
    }
  | {
      readonly id: string;
      readonly kind: "drive";
      readonly line: LineSegment;
      readonly targetPose: Pose2D;
    }
  | {
      readonly id: string;
      readonly kind: "arrive";
      readonly targetPose: Pose2D;
    };

export interface LaneExecutorOptions {
  readonly maxWheelSpeedMetersPerSecond: number;
  readonly headingToleranceDegrees: number;
  readonly arrivalToleranceMeters: number;
  readonly settleDurationMillis: number;
  readonly turnGain: number;
  readonly lineNominalSpeedMetersPerSecond: number;
  readonly lineMaxSpeedMetersPerSecond: number;
  readonly lineCrossTrackGain: number;
  readonly lineHeadingGain: number;
  readonly lineMaxYawRateDegreesPerSecond: number;
  readonly wheelBaseMeters: number;
}

export interface LaneExecutionSnapshot {
  readonly activeSegmentId: string | undefined;
  readonly phase: string;
  readonly segmentIndex: number;
  readonly completed: boolean;
  readonly wheelTargets: WheelTargets;
  readonly targetHeadingDegrees?: number;
  readonly targetPose?: Pose2D;
  readonly currentPose: PoseEstimate;
}
