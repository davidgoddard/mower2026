/**
 * Path Following API
 *
 * Shared types for recorded paths and storage.
 * Runtime perimeter follow is implemented exclusively by the segmented executor.
 */

import { LoggerScope } from "../logging/types.js";

export interface PathPoint {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly capturedAt: number;
}

export interface StoredPath {
  readonly name: string;
  readonly points: PathPoint[];
  readonly createdAt: number;
  readonly metadata: {
    totalDistance: number;
    pointCount: number;
  };
}

/**
 * Outcome of running the segmented executor over a recorded perimeter.
 */
export interface PathFollowResult {
  completed: boolean;
  reason?: "reached_end" | "obstruction" | "user_stopped" | "error";
  finalPose?: import("../geometry/positionTypes.js").Pose;
  distanceTraveled?: number;
  error?: string;
}

/**
 * Path recording interface
 */
export interface PathRecorderOptions {
  distanceThreshold: number;
  maxSegmentDistanceMeters?: number;
  requireGnssQuality?: boolean;
  logger: LoggerScope;
}

export interface IPathRecorder {
  startRecording(pathName: string): void;
  stopAndSave(): Promise<StoredPath>;
  cancel(): void;
  isRecording(): boolean;
  getPointCount(): number;
}

/**
 * Path storage interface
 */
export interface IPathStore {
  savePath(name: string, points: PathPoint[]): Promise<void>;
  loadPath(name: string): Promise<StoredPath>;
  listPaths(): Promise<string[]>;
  deletePath(name: string): Promise<void>;
  pathExists(name: string): Promise<boolean>;
}
