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
  readonly status: "success" | "error" | "stopped";
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
  readonly achievedAngleUnwrappedDeg?: number;
  readonly errorAngle: RelativeAngle;
  readonly brakeDistanceUsed: RelativeAngle;
  readonly direction: TurnDirection;
}

export interface TurnLearningBin {
  requestedAngleDeg: number;
  brakeDistanceDeg: number;
  /** Residual bias added to the rate-based brake prediction (degrees). */
  biasOffsetDeg: number;
  direction: TurnDirection;
  sampleCount?: number;
  lastErrorDeg?: number;
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
  largeTurnBucketStepDeg: number;
  largeTurnMinAngleDeg: number;
  largeTurnMaxAngleDeg: number;
  largeTurnBrakeDistancesCcwDeg: number[];
  largeTurnBrakeDistancesCwDeg: number[];
  /** Per-bucket residual bias for rate-based brake prediction (CCW). */
  largeTurnBiasOffsetsCcwDeg: number[];
  /** Per-bucket residual bias for rate-based brake prediction (CW). */
  largeTurnBiasOffsetsCwDeg: number[];
  largeTurnSampleCountsCcw: number[];
  largeTurnSampleCountsCw: number[];
  largeTurnLastErrorsCcwDeg: number[];
  largeTurnLastErrorsCwDeg: number[];
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
