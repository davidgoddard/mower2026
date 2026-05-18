/**
 * Drive controller type definitions
 */

import { Position, Meters } from "../geometry/positionTypes.js";

export interface DriveRequest {
  readonly targetPosition: Position;
  readonly learningEnabled?: boolean; // Default true
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
}
