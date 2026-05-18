/**
 * Type definitions for turn controller
 */

import { RelativeAngle } from "../geometry/headingTypes.js";

/**
 * Turn direction
 */
export type TurnDirection = "ccw" | "cw";

/**
 * Turn controller status
 */
export type TurnStatus =
  | "idle"
  | "starting"
  | "turning"
  | "braking"
  | "settling"
  | "measuring"
  | "learning"
  | "stopped";  // Emergency stop state

/**
 * Turn execution request
 */
export interface TurnRequest {
  readonly targetAngle: RelativeAngle;
  readonly direction: TurnDirection;
  readonly learningEnabled?: boolean;
}

/**
 * Turn execution result
 */
export interface TurnResult {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly durationMs: number;
  readonly brakeAngleUsed: RelativeAngle;
  readonly motorEngaged: boolean;
  readonly status: "success" | "timeout" | "error" | "stopped";
  readonly errorMessage?: string;
  readonly timestamp: string;
}

/**
 * Turn controller state snapshot
 */
export interface TurnControllerState {
  readonly status: TurnStatus;
  readonly currentTurn: TurnRequest | null;
  readonly turnsCompleted: number;
  readonly averageErrorDeg: number;
}

/**
 * Turn learning input data
 */
export interface TurnLearningInput {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly brakeAngleUsed: RelativeAngle;
  readonly direction: TurnDirection;
}

/**
 * Single turn parameter entry
 */
export interface TurnParameterEntry {
  requestedAngleDeg: number;       // Bin center (10, 20, 30...)
  brakeAngleCcwDeg: number;        // Learned brake angle for CCW
  brakeAngleCwDeg: number;         // Learned brake angle for CW
  sampleCountCcw: number;          // Number of CCW turns used for learning
  sampleCountCw: number;           // Number of CW turns used for learning
  lastErrorCcwDeg: number;         // Most recent error for diagnostics
  lastErrorCwDeg: number;          // Most recent error for diagnostics
  lastUpdated: string;             // ISO timestamp
}

/**
 * Complete turn learning parameters structure
 */
export interface TurnLearningParameters {
  version: number;
  motorRampDownTimeMs: number;
  motorRampUpTimeMs: number;
  smallAngleThresholdDeg: number;
  learningRate: number;
  parameters: TurnParameterEntry[];
}
