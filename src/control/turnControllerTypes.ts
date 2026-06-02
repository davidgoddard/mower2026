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
  /** Optional per-turn output scale [0..1] applied to maxWheelOutputPercent. */
  readonly wheelOutputScale?: number;
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

export interface TurnLearningBin {
  requestedAngleDeg: number;
  brakeDistanceDeg: number;
  direction: TurnDirection;
}

export interface TurnLearningBucket {
  bucketAngleDeg: number;
  brakeFractionCcw: number;
  brakeFractionCw: number;
  sampleCountCcw: number;
  sampleCountCw: number;
  lastErrorCcwDeg: number;
  lastErrorCwDeg: number;
}

export interface TurnLearningParameters {
  version: number;
  smallAngleThresholdDeg: number;
  smallTurnBucketStepDeg: number;
  smallTurnMaxAngleDeg: number;
  largeTurnBrakeCcwDeg: number;
  largeTurnBrakeCwDeg: number;
  largeTurnSampleCountCcw: number;
  largeTurnSampleCountCw: number;
  lastLargeErrorCcwDeg: number;
  lastLargeErrorCwDeg: number;
  smallTurnBrakeFractionsCcw: number[];
  smallTurnBrakeFractionsCw: number[];
  smallTurnSampleCountsCcw: number[];
  smallTurnSampleCountsCw: number[];
  smallTurnLastErrorCcwDeg: number[];
  smallTurnLastErrorCwDeg: number[];
  lastUpdated: string;
  parameters?: TurnLearningBin[];
  smallTurnBuckets?: TurnLearningBucket[];
}
