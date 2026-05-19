/**
 * Type definitions for turn controller
 */

import { RelativeAngle } from "../geometry/headingTypes.js";

export type TurnDirection = "ccw" | "cw";

export type TurnStatus =
  | "idle"
  | "starting"
  | "turning"
  | "braking"
  | "settling"
  | "measuring"
  | "learning"
  | "stopped";

export interface TurnRequest {
  readonly targetAngle: RelativeAngle;
  readonly direction: TurnDirection;
  readonly learningEnabled?: boolean;
}

export interface TurnResult {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly durationMs: number;
  readonly brakeDistanceUsed: RelativeAngle;
  readonly motorEngaged: boolean;
  readonly status: "success" | "timeout" | "error" | "stopped";
  readonly errorMessage?: string;
  readonly timestamp: string;
}

export interface TurnControllerState {
  readonly status: TurnStatus;
  readonly currentTurn: TurnRequest | null;
  readonly turnsCompleted: number;
  readonly averageErrorDeg: number;
}

export interface TurnLearningInput {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly brakeDistanceUsed: RelativeAngle;
  readonly direction: TurnDirection;
}

export interface TurnLearningParameters {
  version: number;
  smallAngleThresholdDeg: number;
  motorRampDownTimeMs: number;
  motorRampUpTimeMs: number;
  largeTurnBrakeCcwDeg: number;
  largeTurnBrakeCwDeg: number;
  smallTurnBrakeFractionCcw: number;
  smallTurnBrakeFractionCw: number;
  largeTurnSampleCountCcw: number;
  largeTurnSampleCountCw: number;
  smallTurnSampleCountCcw: number;
  smallTurnSampleCountCw: number;
  lastLargeErrorCcwDeg: number;
  lastLargeErrorCwDeg: number;
  lastSmallErrorCcwDeg: number;
  lastSmallErrorCwDeg: number;
  lastUpdated: string;
}
