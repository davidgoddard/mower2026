import type { Pose2D, PoseEstimate } from "../estimation/estimatorTypes.js";

export type CalibrationStage =
  | "static_sensing"
  | "spin_left"
  | "spin_right"
  | "straight_forward"
  | "straight_reverse"
  | "target_arrival";

export type CalibrationTrialMotion = "hold" | "spin" | "drive_line" | "arrive_target";

export interface CalibrationArea {
  readonly safeRadiusMeters: number;
  readonly straightRunDistanceMeters: number;
  readonly arrivalTargetDistanceMeters: number;
}

export interface CalibrationControlProfile {
  readonly speedScale: number;
  readonly turnScale: number;
  readonly lineGainScale: number;
}

export interface CalibrationTrialDefinition {
  readonly id: string;
  readonly stage: CalibrationStage;
  readonly motion: CalibrationTrialMotion;
  readonly description: string;
  readonly direction?: "left" | "right" | "forward" | "reverse";
  readonly targetHeadingChangeDegrees?: number;
  readonly distanceMeters?: number;
  readonly holdDurationMillis?: number;
  readonly targetPose?: Pose2D;
  readonly maxDurationMillis: number;
  readonly profile: CalibrationControlProfile;
}

export interface CalibrationSample {
  readonly timestampMillis: number;
  readonly estimate: PoseEstimate;
  readonly imuRollDegrees?: number;
  readonly imuPitchDegrees?: number;
  readonly motorFaultFlags?: number;
  readonly gnssFixType?: string;
}

export interface CompletedCalibrationTrial {
  readonly definition: CalibrationTrialDefinition;
  readonly samples: ReadonlyArray<CalibrationSample>;
  readonly completed: boolean;
  readonly abortReason?: string;
}

export interface StaticCalibrationMetrics {
  readonly durationMillis: number;
  readonly rollDriftDegrees: number;
  readonly pitchDriftDegrees: number;
  readonly headingDriftDegrees: number;
}

export interface SpinCalibrationMetrics {
  readonly targetHeadingChangeDegrees: number;
  readonly achievedHeadingChangeDegrees: number;
  readonly finalHeadingErrorDegrees: number;
  readonly peakOvershootDegrees: number;
  readonly antennaPositionExcursionMeters: number;
  readonly durationMillis: number;
}

export interface StraightCalibrationMetrics {
  readonly targetDistanceMeters: number;
  readonly achievedDistanceMeters: number;
  readonly rmsCrossTrackErrorMeters: number;
  readonly peakCrossTrackErrorMeters: number;
  readonly meanSignedCrossTrackErrorMeters: number;
  readonly finalCrossTrackErrorMeters: number;
  readonly headingRmsErrorDegrees: number;
  readonly durationMillis: number;
}

export interface ArrivalCalibrationMetrics {
  readonly targetDistanceMeters: number;
  readonly finalPositionErrorMeters: number;
  readonly finalHeadingErrorDegrees: number;
  readonly peakCrossTrackErrorMeters: number;
  readonly durationMillis: number;
}

export interface CalibrationTrialAnalysis {
  readonly trial: CompletedCalibrationTrial;
  readonly staticMetrics?: StaticCalibrationMetrics;
  readonly spinMetrics?: SpinCalibrationMetrics;
  readonly straightMetrics?: StraightCalibrationMetrics;
  readonly arrivalMetrics?: ArrivalCalibrationMetrics;
}

export interface CalibrationRecommendations {
  readonly pivotAntennaExcursionMeters: number;
  readonly recommendedTurnScale: number;
  readonly recommendedLineGainScale: number;
  readonly recommendedArrivalToleranceMeters: number;
}

export type CalibrationGoalQuality = "red" | "orange" | "green";

export interface CalibrationGoalStatus {
  readonly quality: CalibrationGoalQuality;
  readonly value: number;
  readonly target: number;
  readonly label: string;
}

export interface CalibrationProgressSummary {
  readonly turn: CalibrationGoalStatus;
  readonly line: CalibrationGoalStatus;
  readonly arrival: CalibrationGoalStatus;
}

export interface CalibrationReport {
  readonly area: CalibrationArea;
  readonly trials: ReadonlyArray<CalibrationTrialAnalysis>;
  readonly recommendations: CalibrationRecommendations;
  readonly summary?: CalibrationProgressSummary;
}

export interface CalibrationExecutor {
  runTrial(definition: CalibrationTrialDefinition): Promise<CompletedCalibrationTrial>;
}
