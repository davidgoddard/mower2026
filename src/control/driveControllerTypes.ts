/**
 * Drive controller type definitions
 */

import { Position, Meters } from "../geometry/positionTypes.js";

export interface DriveRequest {
  readonly targetPosition: Position;
  readonly learningEnabled?: boolean; // Default true
  readonly maxCrossTrackErrorMeters?: number;
  readonly alwaysTurnToFaceTarget?: boolean; // When true, always pivot to face the target regardless of heading error magnitude
  /**
   * Optional explicit learning-class override. Training flows should set this
   * from the intended bucket/sample type so a nominal 100 cm run never flips
   * between short and long learning due to floating-point distance noise.
   */
  readonly learningDistanceClass?: "short" | "long";
  /**
   * Direction of travel along the segment.
   *  +1 (default) = forward; the mower turns to face the target then drives toward it.
   *  -1           = reverse; the mower turns so its rear points along the line then drives backward to the target.
   * Used by the obstruction-recovery path to retrace the recently driven targets without
   * spinning the mower around mid-jam.
   */
  readonly driveDirectionSign?: 1 | -1;
  /**
   * Optional long-run heading learner mode. Short-distance training leaves
   * this unset; dedicated long-run tuning stages use it to update only the
   * requested long-run heading parameter family.
   */
  readonly longHeadingLearningMode?: "standard" | "bias-only" | "gain-only";
}

export type DrivePoseQuality = "gnss" | "dead-reckoning" | "unknown";

export interface DriveResult {
  readonly startPosition: Position;
  readonly targetPosition: Position;
  readonly finalPosition: Position;
  readonly errorX: Meters; // Along-track error (positive = overshot)
  readonly errorY: Meters; // Cross-track error at arrival
  readonly maxCteMeters: Meters; // Maximum CTE during drive
  readonly avgCteMeters: Meters; // Average absolute CTE
  readonly durationMs: number;
  readonly brakeDistanceUsed: Meters;
  readonly status: "success" | "error" | "stopped";
  readonly errorMessage?: string;
  readonly timestamp: string;
  /**
   * Did this drive's measurements feed the brake-distance / CTE-gain learner?
   * False for any non-success status, for drives whose `learningEnabled` flag
   * was off, and for drives where any of the three pose-quality samples
   * (start, brake-decision, final) was not GNSS.
   */
  readonly learnApplied?: boolean;
  /**
   * Short reason the learner was not applied — populated only when
   * `learnApplied` is false and the run otherwise succeeded. Examples:
   * `"learning_disabled"`, `"non_gnss_pose_sample"`.
   */
  readonly learnSkipReason?: string;
  /**
   * Pose-quality samples taken at the three points the learner cares about.
   * Surfaced on the result so operators can see why a run was skipped.
   */
  readonly startPoseQuality?: DrivePoseQuality;
  readonly brakeDecisionPoseQuality?: DrivePoseQuality;
  readonly finalPoseQuality?: DrivePoseQuality;
  /**
   * Phase-1 instrumentation. Distance the mower coasted from the moment the
   * controller fired `requestNeutralMotorOutputs()` to the settled pose,
   * projected along the drive line.  Direction-aware: positive means the
   * mower kept moving toward the target after brake; negative means it
   * slid back (rare).  Drives the coast-distance learner that replaces
   * the legacy bucket-fraction model.
   */
  readonly coastDistanceMeasuredMeters?: Meters;
  /**
   * Peak left+right encoder ticks per motor-feedback sample observed
   * during the drive.  Cruise-reached evidence in tick units — never m/s.
   */
  readonly peakTickRate?: number;
  /**
   * Milliseconds since the last accepted GNSS sample at the moment the
   * brake-trigger fired.  Phase-3 will reject runs above 100 ms here.
   */
  readonly brakeTriggerPoseAgeMs?: number | null;
}

export type SegmentTrainingPhase =
  | "started"
  | "pair_attempt"
  | "segment_attempt"
  | "segment_result"
  | "pair_retry"
  | "stopped"
  | "completed";

export interface SegmentTrainingProgress {
  readonly mode: "segment";
  readonly phase: SegmentTrainingPhase;
  readonly distanceMeters: number;
  readonly pairAttempt: number;
  readonly segmentAttempt: number;
  readonly directionSign: 1 | -1 | null;
  readonly targetXErrorMeters: number;
  readonly completedSegments: number;
  readonly totalPlannedSegments: number;
  readonly message: string;
  readonly timestamp: string;
  readonly resultStatus?: DriveResult["status"] | null;
  readonly errorXMeters?: number | null;
  readonly absErrorXMeters?: number | null;
}

export type SegmentTrainingProgressReporter = (progress: SegmentTrainingProgress) => void;

export interface SegmentTrainingResult extends DriveResult {
  readonly distanceMeters: number;
  readonly directionSign: 1 | -1;
  readonly pairAttempt: number;
  readonly segmentAttempt: number;
  readonly anchorHeadingDeg: number;
}

export type DriveTrainingPhase =
  | "started"
  | "waiting"
  | "pair_attempt"
  | "leg_attempt"
  | "leg_result"
  | "pair_retry"
  | "stopped"
  | "completed";

export interface DriveTrainingProgress {
  readonly mode: "short-distance" | "long-heading-bias" | "long-heading-gain";
  readonly phase: DriveTrainingPhase;
  readonly distanceMeters: number;
  readonly pairAttempt: number;
  readonly legAttempt: number;
  readonly directionSign: 1 | -1 | null;
  readonly targetXErrorMeters: number;
  readonly completedDrives: number;
  readonly totalPlannedDrives: number;
  readonly message: string;
  readonly timestamp: string;
  readonly resultStatus?: DriveResult["status"] | null;
  readonly errorXMeters?: number | null;
  readonly absErrorXMeters?: number | null;
}

export type DriveTrainingProgressReporter = (progress: DriveTrainingProgress) => void;

export type DriveStatus =
  | "idle"
  | "turning"
  | "settling"
  | "driving"
  | "braking"
  | "measuring"
  | "learning"
  | "stopped";

export interface DriveControllerState {
  readonly status: DriveStatus;
  readonly currentDrive: DriveRequest | null;
  readonly drivesCompleted: number;
  readonly averageErrorXMeters: number;
  readonly averageErrorYMeters: number;
  readonly shortTrainingProgress: DriveTrainingProgress | null;
  readonly shortTrainingProgressFeed: readonly DriveTrainingProgress[];
  readonly shortTrainingResults: readonly DriveResult[];
  readonly segmentTrainingProgress: SegmentTrainingProgress | null;
  readonly segmentTrainingProgressFeed: readonly SegmentTrainingProgress[];
  readonly segmentTrainingResults: readonly SegmentTrainingResult[];
}
