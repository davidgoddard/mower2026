/**
 * Drive controller type definitions
 */

import { Position, Meters } from "../geometry/positionTypes.js";

export interface DriveRequest {
  readonly targetPosition: Position;
  readonly learningEnabled?: boolean; // Default true
  readonly timeoutMinimumMs?: number;
  readonly disableTimeout?: boolean;
  readonly maxCrossTrackErrorMeters?: number;
}

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
  readonly status: "success" | "error" | "stopped" | "timeout";
  readonly errorMessage?: string;
  readonly timestamp: string;
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
  readonly mode: "short-distance";
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
