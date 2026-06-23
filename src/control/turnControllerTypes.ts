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
  readonly controlMode?: "small_timeout" | "large_rate_scalar";
  readonly learningBucketAngleDeg?: number;
  readonly triggerProgressUsedDeg?: number;
  readonly triggerTimeUsedMs?: number;
  readonly smallTurnBrakeTimeUsedMs?: number;
  readonly largeTurnBrakeScalarUsedMs?: number;
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
  readonly brakeTimeUsedMs?: number;
  readonly brakeRateUsedDegPerMs?: number;
  readonly direction: TurnDirection;
}

export interface TurnLearningBin {
  requestedAngleDeg: number;
  brakeScalarMs: number;
  direction: TurnDirection;
  sampleCount?: number;
  lastErrorDeg?: number;
}

export interface TurnLearningBucket {
  bucketAngleDeg: number;
  brakeTimeCcwMs: number;
  brakeTimeCwMs: number;
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
  largeTurnBrakeScalarsCcwMs: number[];
  largeTurnBrakeScalarsCwMs: number[];
  largeTurnSampleCountsCcw: number[];
  largeTurnSampleCountsCw: number[];
  largeTurnLastErrorsCcwDeg: number[];
  largeTurnLastErrorsCwDeg: number[];
  smallTurnBrakeTimesCcwMs: number[];
  smallTurnBrakeTimesCwMs: number[];
  smallTurnSampleCountsCcw: number[];
  smallTurnSampleCountsCw: number[];
  smallTurnLastErrorCcwDeg: number[];
  smallTurnLastErrorCwDeg: number[];
  lastUpdated: string;
  parameters?: TurnLearningBin[];
  smallTurnBuckets?: TurnLearningBucket[];
}
