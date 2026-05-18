/**
 * Path Following API
 *
 * Abstract interface that supports multiple path following algorithms
 * (Pure Pursuit, Arc Interpolation, etc.)
 */

import { Position, Pose } from "../geometry/positionTypes.js";
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

export interface PathFollowResult {
  completed: boolean;
  reason?: "reached_end" | "obstruction" | "user_stopped" | "error";
  finalPose?: Pose;
  distanceTraveled?: number;
  error?: string;
}

export interface PathFollowerOptions {
  targetSpeed: number; // meters per second
  wheelBase: number; // meters
  controlRateHz: number; // control loop frequency
  arrivalThreshold: number; // meters - how close to consider "arrived"
  logger: LoggerScope;
}

export interface PathFollowerState {
  isFollowing: boolean;
  currentPath: StoredPath | null;
  currentWaypointIndex: number;
  distanceToTarget: number;
  crossTrackError: number;
}

/**
 * Abstract interface for path following algorithms
 */
export interface IPathFollower {
  /**
   * Follow a stored path from current position to end
   * @param pathName - name of the path to follow
   * @returns result indicating completion status
   */
  followPath(pathName: string): Promise<PathFollowResult>;

  /**
   * Follow a path defined by an array of points
   * @param points - array of path points to follow
   * @returns result indicating completion status
   */
  followPathPoints(points: PathPoint[]): Promise<PathFollowResult>;

  /**
   * Resume path following from a specific waypoint index
   * Used by retry system after obstruction recovery
   * @param waypointIndex - index to resume from
   * @returns result indicating completion status
   */
  resumeFromWaypoint(waypointIndex: number): Promise<PathFollowResult>;

  /**
   * Retrace path backwards to a specific waypoint
   * Used by retry system for obstruction recovery
   * @param targetWaypointIndex - waypoint to retrace back to
   * @returns result indicating completion status
   */
  retraceToWaypoint(targetWaypointIndex: number): Promise<PathFollowResult>;

  /**
   * Stop path following immediately
   */
  stop(): Promise<void>;

  /**
   * Get current path follower state
   */
  getState(): PathFollowerState;

  /**
   * Get current position on path (closest waypoint index)
   */
  getCurrentWaypointIndex(): number;

  /**
   * Get the current path being followed (or null if not following)
   */
  getCurrentPath(): StoredPath | null;
}

/**
 * Path recording interface
 */
export interface PathRecorderOptions {
  distanceThreshold: number; // minimum distance to record next point (meters)
  logger: LoggerScope;
}

export interface IPathRecorder {
  /**
   * Start recording a new path
   * @param pathName - name for the path being recorded
   */
  startRecording(pathName: string): void;

  /**
   * Stop recording and save the path
   * @returns the saved path
   */
  stopAndSave(): Promise<StoredPath>;

  /**
   * Cancel recording without saving
   */
  cancel(): void;

  /**
   * Check if currently recording
   */
  isRecording(): boolean;

  /**
   * Get current point count
   */
  getPointCount(): number;
}

/**
 * Path storage interface
 */
export interface IPathStore {
  /**
   * Save a path to persistent storage
   */
  savePath(name: string, points: PathPoint[]): Promise<void>;

  /**
   * Load a path from storage
   */
  loadPath(name: string): Promise<StoredPath>;

  /**
   * List all stored paths
   */
  listPaths(): Promise<string[]>;

  /**
   * Delete a path
   */
  deletePath(name: string): Promise<void>;

  /**
   * Check if a path exists
   */
  pathExists(name: string): Promise<boolean>;
}
