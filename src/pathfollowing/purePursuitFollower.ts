/**
 * Pure Pursuit Path Follower
 *
 * Implements the Pure Pursuit algorithm for smooth path following
 */

import {
  IPathFollower,
  PathFollowerOptions,
  PathFollowResult,
  PathFollowerState,
  PathPoint,
  StoredPath,
  IPathStore,
} from "./pathFollowerApi.js";
import { Pose, Position, createPosition, distanceBetween, unwrapMeters } from "../geometry/positionTypes.js";
import { LoggerScope } from "../logging/types.js";
import { unwrapInternalHeading } from "../geometry/headingTypes.js";

export interface PurePursuitDependencies {
  pathStore: IPathStore;
  motorController: {
    setWheelSpeeds(left: number, right: number): Promise<void>;
    stop(): Promise<void>;
  };
  getCurrentPose(): Pose;
  getCurrentSpeed(): number;
}

export class PurePursuitFollower implements IPathFollower {
  private readonly targetSpeed: number;
  private readonly wheelBase: number;
  private readonly controlRateHz: number;
  private readonly arrivalThreshold: number;
  private readonly logger: LoggerScope;
  private readonly deps: PurePursuitDependencies;

  // Pure pursuit parameters
  private readonly minLookahead: number = 0.5; // meters
  private readonly maxLookahead: number = 2.0; // meters
  private readonly baseLookahead: number = 1.0; // meters
  private readonly tightTurnRadius: number = 0.5; // meters - threshold for pivot

  // State
  private isFollowing: boolean = false;
  private stopRequested: boolean = false;
  private currentPath: StoredPath | null = null;
  private currentWaypointIndex: number = 0;

  constructor(options: PathFollowerOptions, dependencies: PurePursuitDependencies) {
    this.targetSpeed = options.targetSpeed;
    this.wheelBase = options.wheelBase;
    this.controlRateHz = options.controlRateHz;
    this.arrivalThreshold = options.arrivalThreshold;
    this.logger = options.logger;
    this.deps = dependencies;

    this.logger.info("pure_pursuit.initialized", {
      targetSpeed: this.targetSpeed,
      wheelBase: this.wheelBase,
      controlRateHz: this.controlRateHz,
      minLookahead: this.minLookahead,
      maxLookahead: this.maxLookahead,
    });
  }

  async followPath(pathName: string): Promise<PathFollowResult> {
    this.logger.info("pure_pursuit.follow_path_starting", { pathName });

    const path = await this.deps.pathStore.loadPath(pathName);
    return await this.followPathPoints(path.points);
  }

  async followPathPoints(points: PathPoint[]): Promise<PathFollowResult> {
    if (this.isFollowing) {
      const error = "Already following a path";
      this.logger.error("pure_pursuit.already_following", {});
      return { completed: false, reason: "error", error };
    }

    // Prepend current position to path
    const currentPose = this.deps.getCurrentPose();
    const waypoints: PathPoint[] = [
      {
        xMeters: unwrapMeters(currentPose.position.xMeters),
        yMeters: unwrapMeters(currentPose.position.yMeters),
        capturedAt: Date.now(),
      },
      ...points,
    ];

    this.currentPath = {
      name: "runtime_path",
      points: waypoints,
      createdAt: Date.now(),
      metadata: {
        totalDistance: this.calculateTotalDistance(waypoints),
        pointCount: waypoints.length,
      },
    };

    this.logger.info("pure_pursuit.path_prepared", {
      waypointCount: waypoints.length,
      totalDistance: this.currentPath.metadata.totalDistance,
    });

    return await this.executePathFollowing(waypoints);
  }

  async resumeFromWaypoint(waypointIndex: number): Promise<PathFollowResult> {
    if (!this.currentPath) {
      const error = "No current path to resume";
      this.logger.error("pure_pursuit.no_path_to_resume", {});
      return { completed: false, reason: "error", error };
    }

    this.logger.info("pure_pursuit.resuming_from_waypoint", { waypointIndex });

    const remainingPoints = this.currentPath.points.slice(waypointIndex);
    return await this.followPathPoints(remainingPoints);
  }

  async retraceToWaypoint(targetWaypointIndex: number): Promise<PathFollowResult> {
    if (!this.currentPath) {
      const error = "No current path to retrace";
      this.logger.error("pure_pursuit.no_path_to_retrace", {});
      return { completed: false, reason: "error", error };
    }

    this.logger.info("pure_pursuit.retracing_to_waypoint", {
      currentIndex: this.currentWaypointIndex,
      targetIndex: targetWaypointIndex,
    });

    // Extract path segment to retrace
    const startIndex = Math.max(0, targetWaypointIndex);
    const endIndex = Math.min(this.currentWaypointIndex, this.currentPath.points.length - 1);
    const retraceSegment = this.currentPath.points.slice(startIndex, endIndex + 1).reverse();

    if (retraceSegment.length === 0) {
      this.logger.warn("pure_pursuit.retrace_empty_segment", { startIndex, endIndex });
      return { completed: true, reason: "reached_end" };
    }

    return await this.followPathPoints(retraceSegment);
  }

  async stop(): Promise<void> {
    this.logger.info("pure_pursuit.stop_requested");
    this.stopRequested = true;
    await this.deps.motorController.stop();
  }

  getState(): PathFollowerState {
    const currentPose = this.deps.getCurrentPose();
    let distanceToTarget = 0;
    let crossTrackError = 0;

    if (this.currentPath && this.currentWaypointIndex < this.currentPath.points.length) {
      const targetPoint = this.currentPath.points[this.currentWaypointIndex];
      distanceToTarget = this.distanceToPoint(currentPose.position, targetPoint);
      crossTrackError = this.calculateCrossTrackError(currentPose, this.currentPath.points);
    }

    return {
      isFollowing: this.isFollowing,
      currentPath: this.currentPath,
      currentWaypointIndex: this.currentWaypointIndex,
      distanceToTarget,
      crossTrackError,
    };
  }

  getCurrentWaypointIndex(): number {
    return this.currentWaypointIndex;
  }

  getCurrentPath(): StoredPath | null {
    return this.currentPath;
  }

  /**
   * Main path following execution loop
   */
  private async executePathFollowing(waypoints: PathPoint[]): Promise<PathFollowResult> {
    this.isFollowing = true;
    this.stopRequested = false;
    this.currentWaypointIndex = 0;

    const startTime = Date.now();
    let distanceTraveled = 0;

    try {
      while (this.currentWaypointIndex < waypoints.length - 1 && !this.stopRequested) {
        const currentPose = this.deps.getCurrentPose();
        const currentSpeed = this.deps.getCurrentSpeed();

        // Update current waypoint index based on closest point
        this.currentWaypointIndex = this.findClosestWaypointIndex(currentPose, waypoints);

        // Check if reached end
        if (this.hasReachedEnd(currentPose, waypoints)) {
          this.logger.info("pure_pursuit.reached_end", {
            finalWaypointIndex: this.currentWaypointIndex,
            distanceTraveled,
          });

          await this.deps.motorController.stop();
          return {
            completed: true,
            reason: "reached_end",
            finalPose: currentPose,
            distanceTraveled,
          };
        }

        // Adapt lookahead distance based on speed and path curvature
        const pathCurvature = this.estimatePathCurvature(currentPose, waypoints);
        const lookahead = this.calculateAdaptiveLookahead(currentSpeed, pathCurvature);

        // Pure Pursuit: calculate curvature to lookahead point
        const curvature = this.calculateCurvature(currentPose, waypoints, lookahead);

        this.logger.debug("pure_pursuit.control_step", {
          waypointIndex: this.currentWaypointIndex,
          lookahead,
          curvature,
          currentSpeed,
        });

        // Convert curvature to wheel speeds
        const wheelSpeeds = this.calculateWheelSpeeds(curvature);

        // Apply wheel speeds
        await this.deps.motorController.setWheelSpeeds(wheelSpeeds.left, wheelSpeeds.right);

        // Control loop delay
        await this.sleep(1000 / this.controlRateHz);
      }

      // Check why loop exited
      if (this.stopRequested) {
        this.logger.info("pure_pursuit.stopped_by_user", { distanceTraveled });
        await this.deps.motorController.stop();
        return {
          completed: false,
          reason: "user_stopped",
          finalPose: this.deps.getCurrentPose(),
          distanceTraveled,
        };
      }

      // Completed normally
      await this.deps.motorController.stop();
      return {
        completed: true,
        reason: "reached_end",
        finalPose: this.deps.getCurrentPose(),
        distanceTraveled,
      };
    } catch (error) {
      this.logger.error("pure_pursuit.error", {
        error: error instanceof Error ? error.message : String(error),
      });

      await this.deps.motorController.stop();

      return {
        completed: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.isFollowing = false;
    }
  }

  /**
   * Core Pure Pursuit algorithm: calculate curvature to reach lookahead point
   */
  private calculateCurvature(pose: Pose, path: PathPoint[], lookahead: number): number {
    const lookaheadPoint = this.findLookaheadPoint(pose, path, lookahead);

    if (!lookaheadPoint) {
      // No lookahead point found (end of path) - return zero curvature
      return 0;
    }

    const dx = lookaheadPoint.xMeters - unwrapMeters(pose.position.xMeters);
    const dy = lookaheadPoint.yMeters - unwrapMeters(pose.position.yMeters);
    const angleToLookahead = Math.atan2(dy, dx);

    // Alpha: angle between heading and lookahead point
    const heading = unwrapInternalHeading(pose.heading);
    const headingRad = (heading * Math.PI) / 180;
    const alpha = this.normalizeAngle(angleToLookahead - headingRad);

    // Distance to lookahead point
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 0.01) {
      return 0; // Too close, go straight
    }

    // Pure pursuit curvature formula: κ = 2 * sin(α) / L
    const curvature = (2 * Math.sin(alpha)) / distance;

    return curvature;
  }

  /**
   * Find lookahead point on path
   */
  private findLookaheadPoint(pose: Pose, path: PathPoint[], lookahead: number): PathPoint | null {
    const closestIndex = this.findClosestWaypointIndex(pose, path);

    let accumulatedDistance = 0;

    // Search forward from closest point
    for (let i = closestIndex; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const segmentLength = this.distanceBetweenPoints(p1, p2);
      accumulatedDistance += segmentLength;

      if (accumulatedDistance >= lookahead) {
        // Interpolate along segment
        const excess = accumulatedDistance - lookahead;
        const t = 1 - excess / segmentLength; // interpolation factor
        return {
          xMeters: p1.xMeters + t * (p2.xMeters - p1.xMeters),
          yMeters: p1.yMeters + t * (p2.yMeters - p1.yMeters),
          capturedAt: Date.now(),
        };
      }
    }

    // Path shorter than lookahead - return last point
    return path[path.length - 1];
  }

  /**
   * Calculate adaptive lookahead distance
   */
  private calculateAdaptiveLookahead(currentSpeed: number, pathCurvature: number): number {
    const speedFactor = currentSpeed / this.targetSpeed;
    const curvatureFactor = 1.0 / (1.0 + Math.abs(pathCurvature) * 5.0);

    const lookahead = this.baseLookahead * Math.max(0.5, speedFactor) * curvatureFactor;
    return this.clamp(lookahead, this.minLookahead, this.maxLookahead);
  }

  /**
   * Estimate path curvature ahead
   */
  private estimatePathCurvature(pose: Pose, path: PathPoint[]): number {
    const closestIndex = this.findClosestWaypointIndex(pose, path);

    if (closestIndex >= path.length - 2) {
      return 0; // End of path
    }

    // Estimate curvature from next few waypoints
    const p1 = path[closestIndex];
    const p2 = path[closestIndex + 1];
    const p3 = path[Math.min(closestIndex + 2, path.length - 1)];

    // Simple curvature estimate using three points
    const dx1 = p2.xMeters - p1.xMeters;
    const dy1 = p2.yMeters - p1.yMeters;
    const dx2 = p3.xMeters - p2.xMeters;
    const dy2 = p3.yMeters - p2.yMeters;

    const angle1 = Math.atan2(dy1, dx1);
    const angle2 = Math.atan2(dy2, dx2);
    const angleDiff = this.normalizeAngle(angle2 - angle1);

    const distance = Math.sqrt(dx1 * dx1 + dy1 * dy1) + Math.sqrt(dx2 * dx2 + dy2 * dy2);

    if (distance < 0.01) {
      return 0;
    }

    return angleDiff / distance;
  }

  /**
   * Convert curvature to differential wheel speeds
   */
  private calculateWheelSpeeds(curvature: number): { left: number; right: number } {
    if (Math.abs(curvature) < 0.001) {
      // Straight line
      return { left: this.targetSpeed, right: this.targetSpeed };
    }

    // Turning radius from curvature
    const radius = 1.0 / curvature;

    // Check if turn is too tight - use pivot
    if (Math.abs(radius) < this.tightTurnRadius) {
      return this.calculatePivotSpeeds(radius);
    }

    // Differential drive arc
    const leftRadius = radius - this.wheelBase / 2;
    const rightRadius = radius + this.wheelBase / 2;

    const leftSpeed = this.targetSpeed * (leftRadius / radius);
    const rightSpeed = this.targetSpeed * (rightRadius / radius);

    // Clamp to reasonable values
    const maxSpeed = this.targetSpeed * 1.2;
    return {
      left: this.clamp(leftSpeed, -maxSpeed, maxSpeed),
      right: this.clamp(rightSpeed, -maxSpeed, maxSpeed),
    };
  }

  /**
   * Calculate pivot speeds (one wheel stationary)
   */
  private calculatePivotSpeeds(radius: number): { left: number; right: number } {
    const turnDirection = radius > 0 ? "left" : "right";

    if (turnDirection === "left") {
      // Left turn - left wheel slower/stopped
      return { left: 0, right: this.targetSpeed };
    } else {
      // Right turn - right wheel slower/stopped
      return { left: this.targetSpeed, right: 0 };
    }
  }

  /**
   * Find closest waypoint to current position
   */
  private findClosestWaypointIndex(pose: Pose, path: PathPoint[]): number {
    let minDistance = Infinity;
    let closestIndex = 0;

    for (let i = 0; i < path.length; i++) {
      const distance = this.distanceToPoint(pose.position, path[i]);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  /**
   * Check if reached end of path
   */
  private hasReachedEnd(pose: Pose, path: PathPoint[]): boolean {
    if (path.length === 0) {
      return true;
    }

    const lastPoint = path[path.length - 1];
    const distance = this.distanceToPoint(pose.position, lastPoint);

    return distance < this.arrivalThreshold;
  }

  /**
   * Calculate cross-track error (for state reporting)
   */
  private calculateCrossTrackError(pose: Pose, path: PathPoint[]): number {
    const closestIndex = this.findClosestWaypointIndex(pose, path);

    if (closestIndex >= path.length - 1) {
      return 0;
    }

    const p1 = path[closestIndex];
    const p2 = path[closestIndex + 1];

    // Cross-track error using point-to-line distance
    const dx = p2.xMeters - p1.xMeters;
    const dy = p2.yMeters - p1.yMeters;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength < 0.01) {
      return 0;
    }

    const x = unwrapMeters(pose.position.xMeters);
    const y = unwrapMeters(pose.position.yMeters);

    const cte = ((x - p1.xMeters) * dy - (y - p1.yMeters) * dx) / lineLength;
    return cte;
  }

  /**
   * Helper: distance between position and path point
   */
  private distanceToPoint(position: Position, point: PathPoint): number {
    const dx = unwrapMeters(position.xMeters) - point.xMeters;
    const dy = unwrapMeters(position.yMeters) - point.yMeters;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Helper: distance between two path points
   */
  private distanceBetweenPoints(p1: PathPoint, p2: PathPoint): number {
    const dx = p2.xMeters - p1.xMeters;
    const dy = p2.yMeters - p1.yMeters;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Calculate total path distance
   */
  private calculateTotalDistance(points: PathPoint[]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += this.distanceBetweenPoints(points[i], points[i + 1]);
    }
    return total;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
