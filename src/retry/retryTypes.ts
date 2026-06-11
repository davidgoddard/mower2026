/**
 * Retry system types
 */

import { Pose } from "../geometry/positionTypes.js";
import { PathPoint } from "../pathfollowing/pathFollowerApi.js";

export type ObstructionType = "high_current" | "wheel_slip" | "stall";

/**
 * Active operation context. Only path-context retry is implemented today;
 * line and turn obstructions are not currently routed through the retry path.
 */
export type OperationContext = "path";

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
  metadata: PathMetadata;
}

export interface PathMetadata {
  type: "path";
  /** Recorded boundary points the segmented executor was following at the time of the obstruction. */
  waypoints: PathPoint[];
}

export interface RecoveryResult {
  success: boolean;
  attemptNumber: number;
  error?: string;
}
