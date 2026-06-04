/**
 * Retry system types
 */

import { Pose } from "../geometry/positionTypes.js";
import { PathPoint } from "../pathfollowing/pathFollowerApi.js";

export type ObstructionType = "high_current" | "wheel_slip" | "stall";

export type OperationContext = "line" | "path" | "turn";

export interface ObstructionEvent {
  type: ObstructionType;
  timestamp: number;
  context: OperationContext;
  motorCurrents: {
    left: number;
    right: number;
  };
  position: Pose;
}

export interface Checkpoint {
  id: string;
  timestamp: number;
  pose: Pose;
  context: OperationContext;
  metadata: CheckpointMetadata;
}

export type CheckpointMetadata = LineMetadata | PathMetadata | TurnMetadata;

export interface LineMetadata {
  type: "line";
  targetPosition: { xMeters: number; yMeters: number };
  lineStart: { xMeters: number; yMeters: number };
  lineEnd: { xMeters: number; yMeters: number };
}

export interface PathMetadata {
  type: "path";
  /** Recorded boundary points the segmented executor was following at the time of the obstruction. */
  waypoints: PathPoint[];
}

export interface TurnMetadata {
  type: "turn";
  targetHeading: number;
  turnDirection: number; // +1 or -1
  startHeading: number;
}

export interface RecoveryResult {
  success: boolean;
  attemptNumber: number;
  error?: string;
}
