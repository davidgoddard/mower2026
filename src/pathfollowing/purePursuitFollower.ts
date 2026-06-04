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
import { systemStop } from "../control/systemStop.js";
import { MAX_WHEEL_SPEED_MPS_DEFAULT, MOTOR_MIN_ACTIVE_OUTPUT_PERCENT } from "../constants.js";

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
  private readonly minLookahead: number;
  private readonly maxLookahead: number;
  private readonly baseLookahead: number;
  private readonly tightTurnRadius: number = 0.5; // meters - threshold for pivot
  private readonly minActiveWheelSpeed: number = MAX_WHEEL_SPEED_MPS_DEFAULT * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT;
  private readonly retraceDurationMs: number = 3000;
  private readonly retraceTrailRetentionMs: number = 5000;
  private readonly retraceTrailMinSpacingMeters: number = 0.05;

  // State
  private isFollowing: boolean = false;
  private stopRequested: boolean = false;
  private currentPath: StoredPath | null = null;
  private currentWaypointIndex: number = 0;
  private hasBeenAwayFromFinalPoint: boolean = false;
  private recentTrail: PathPoint[] = [];
  private passedWaypointIndexes: Set<number> = new Set();

  constructor(options: PathFollowerOptions, dependencies: PurePursuitDependencies) {
    this.targetSpeed = options.targetSpeed;
    this.wheelBase = options.wheelBase;
    this.controlRateHz = options.controlRateHz;
    this.arrivalThreshold = options.arrivalThreshold;
    this.minLookahead = options.minLookaheadMeters ?? 0.5;
    this.baseLookahead = options.baseLookaheadMeters ?? 1.0;
    this.maxLookahead = options.maxLookaheadMeters ?? 2.0;
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
        driveAlgorithm: "pure_pursuit",
      },
    };

    const currentPath = this.currentPath;
    this.logger.info("pure_pursuit.path_prepared", {
      waypointCount: waypoints.length,
      totalDistance: currentPath.metadata.totalDistance,
    });

    systemStop.clearStop("path-following-start");
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
    this.stopRequested = true;
    systemStop.requestStop("path-following", "path_stop_requested");
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
    this.hasBeenAwayFromFinalPoint = false;
    this.recentTrail = [];
    this.passedWaypointIndexes = new Set([0]);

    const startTime = Date.now();
    let distanceTraveled = 0;

    try {
      while (this.currentWaypointIndex < waypoints.length - 1 && !this.stopRequested && !systemStop.isStopped()) {
        const currentPose = this.deps.getCurrentPose();
        const currentSpeed = this.deps.getCurrentSpeed();
        this.recordRecentTrail(currentPose);

        // Update current waypoint index based on closest point
        const previousWaypointIndex = this.currentWaypointIndex;
        this.currentWaypointIndex = this.findClosestWaypointIndex(
          currentPose,
          waypoints,
          this.currentWaypointIndex,
        );
        this.markWaypointCoverage(previousWaypointIndex, this.currentWaypointIndex);

        // Check if reached end
        if (this.hasReachedEnd(currentPose, waypoints, true)) {
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

        // Convert curvature to wheel speeds
        const wheelSpeeds = this.calculateWheelSpeeds(curvature);

        // Apply wheel speeds
        await this.deps.motorController.setWheelSpeeds(wheelSpeeds.left, wheelSpeeds.right);

        // Control loop delay
        const loopDelayCompleted = await this.sleepWithStopChecks(1000 / this.controlRateHz);
        if (!loopDelayCompleted || this.stopRequested || systemStop.isStopped()) {
          const stopState = systemStop.snapshot();
          const obstructed = stopState.reason === "motor_stall_detected";
          this.logger.info(obstructed ? "pure_pursuit.stopped_by_obstruction" : "pure_pursuit.stopped_by_user", {
            distanceTraveled,
            systemStopSource: stopState.source,
            systemStopReason: stopState.reason,
          });
          await this.deps.motorController.stop();
          if (obstructed) {
            await this.reverseRetraceRecentTrail();
          }
          return {
            completed: false,
            reason: obstructed ? "obstruction" : "user_stopped",
            finalPose: this.deps.getCurrentPose(),
            distanceTraveled,
          };
        }
      }

      // Check why loop exited
      if (this.stopRequested || systemStop.isStopped()) {
        const stopState = systemStop.snapshot();
        const obstructed = stopState.reason === "motor_stall_detected";
        this.logger.info(obstructed ? "pure_pursuit.stopped_by_obstruction" : "pure_pursuit.stopped_by_user", {
          distanceTraveled,
          systemStopSource: stopState.source,
          systemStopReason: stopState.reason,
        });
        await this.deps.motorController.stop();
        if (obstructed) {
          await this.reverseRetraceRecentTrail();
        }
        return {
          completed: false,
          reason: obstructed ? "obstruction" : "user_stopped",
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

      systemStop.requestStop("path-following", "path_error");
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

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    const endTime = Date.now() + delayMs;

    while (Date.now() < endTime) {
      if (this.stopRequested || systemStop.isStopped()) {
        return false;
      }

      const remaining = endTime - Date.now();
      await this.sleep(Math.min(50, Math.max(0, remaining)));
    }

    return true;
  }

  /**
   * Core Pure Pursuit algorithm: calculate curvature to reach lookahead point
   */
  private calculateCurvature(
    pose: Pose,
    path: PathPoint[],
    lookahead: number,
    travelDirectionSign: 1 | -1 = 1,
  ): number {
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
    const headingRad = ((heading + (travelDirectionSign < 0 ? 180 : 0)) * Math.PI) / 180;
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
  private calculateWheelSpeeds(curvature: number, travelDirectionSign: 1 | -1 = 1): { left: number; right: number } {
    if (Math.abs(curvature) < 0.001) {
      // Straight line
      return {
        left: this.applyMinimumActiveWheelSpeed(this.targetSpeed * travelDirectionSign),
        right: this.applyMinimumActiveWheelSpeed(this.targetSpeed * travelDirectionSign),
      };
    }

    // Turning radius from curvature
    const radius = 1.0 / curvature;

    // Check if turn is too tight - use an in-place turn.
    if (Math.abs(radius) < this.tightTurnRadius) {
      return this.calculatePivotSpeeds(radius, travelDirectionSign);
    }

    const signedLinearSpeed = this.targetSpeed * travelDirectionSign;
    const angularSpeed = this.targetSpeed * curvature;
    const leftSpeed = signedLinearSpeed - (angularSpeed * this.wheelBase / 2);
    const rightSpeed = signedLinearSpeed + (angularSpeed * this.wheelBase / 2);

    // Clamp to reasonable values
    const maxSpeed = this.targetSpeed * 1.2;
    const wheelSpeeds = {
      left: this.clamp(leftSpeed, -maxSpeed, maxSpeed),
      right: this.clamp(rightSpeed, -maxSpeed, maxSpeed),
    };
    return this.enforceMinimumActiveArc(wheelSpeeds, radius, travelDirectionSign);
  }

  /**
   * Calculate in-place turn speeds. One-wheel pivots are intentionally avoided
   * because the mower can stall when only one motor is active.
   */
  private calculatePivotSpeeds(radius: number, travelDirectionSign: 1 | -1 = 1): { left: number; right: number } {
    const turnSign = radius > 0 ? 1 : -1;
    const speed = Math.max(this.targetSpeed, this.minActiveWheelSpeed);

    return {
      left: -turnSign * speed * travelDirectionSign,
      right: turnSign * speed * travelDirectionSign,
    };
  }

  private enforceMinimumActiveArc(
    wheelSpeeds: { left: number; right: number },
    radius: number,
    travelDirectionSign: 1 | -1,
  ): { left: number; right: number } {
    const leftSign = Math.sign(wheelSpeeds.left);
    const rightSign = Math.sign(wheelSpeeds.right);

    if (leftSign === 0 || rightSign === 0 || leftSign !== rightSign) {
      return this.calculatePivotSpeeds(radius, travelDirectionSign);
    }

    return {
      left: this.applyMinimumActiveWheelSpeed(wheelSpeeds.left),
      right: this.applyMinimumActiveWheelSpeed(wheelSpeeds.right),
    };
  }

  private applyMinimumActiveWheelSpeed(value: number): number {
    if (value === 0 || Math.abs(value) >= this.minActiveWheelSpeed) {
      return value;
    }

    return Math.sign(value) * this.minActiveWheelSpeed;
  }

  private recordRecentTrail(pose: Pose): void {
    const nowMs = Date.now();
    const point: PathPoint = {
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
      capturedAt: nowMs,
    };

    const lastPoint = this.recentTrail[this.recentTrail.length - 1];
    if (lastPoint) {
      const dx = point.xMeters - lastPoint.xMeters;
      const dy = point.yMeters - lastPoint.yMeters;
      if (Math.hypot(dx, dy) < this.retraceTrailMinSpacingMeters) {
        this.pruneRecentTrail(nowMs);
        return;
      }
    }

    this.recentTrail.push(point);
    this.pruneRecentTrail(nowMs);
  }

  private pruneRecentTrail(nowMs: number): void {
    const cutoff = nowMs - this.retraceTrailRetentionMs;
    while (this.recentTrail.length > 0 && this.recentTrail[0].capturedAt < cutoff) {
      this.recentTrail.shift();
    }
  }

  private async reverseRetraceRecentTrail(): Promise<void> {
    const cutoff = Date.now() - this.retraceDurationMs;
    const retraceSegment = this.recentTrail
      .filter((point) => point.capturedAt >= cutoff)
      .reverse();

    if (retraceSegment.length < 2) {
      this.logger.warn("pure_pursuit.obstruction_retrace_skipped", {
        availablePointCount: this.recentTrail.length,
      });
      return;
    }

    this.logger.info("pure_pursuit.obstruction_retrace_starting", {
      pointCount: retraceSegment.length,
      durationMs: this.retraceDurationMs,
    });

    systemStop.clearStop("path-obstruction-retrace");
    this.hasBeenAwayFromFinalPoint = false;
    this.currentWaypointIndex = 0;
    this.passedWaypointIndexes = new Set([0]);

    while (!this.stopRequested && !systemStop.isStopped()) {
      const currentPose = this.deps.getCurrentPose();
      const currentSpeed = Math.abs(this.deps.getCurrentSpeed());
      const previousWaypointIndex = this.currentWaypointIndex;
      this.currentWaypointIndex = this.findClosestWaypointIndex(
        currentPose,
        retraceSegment,
        this.currentWaypointIndex,
      );
      this.markWaypointCoverage(previousWaypointIndex, this.currentWaypointIndex);

      if (this.hasReachedEnd(currentPose, retraceSegment, false)) {
        break;
      }

      const pathCurvature = this.estimatePathCurvature(currentPose, retraceSegment);
      const lookahead = this.calculateAdaptiveLookahead(currentSpeed, pathCurvature);
      const curvature = this.calculateCurvature(currentPose, retraceSegment, lookahead, -1);
      const wheelSpeeds = this.calculateWheelSpeeds(curvature, -1);

      await this.deps.motorController.setWheelSpeeds(wheelSpeeds.left, wheelSpeeds.right);

      const loopDelayCompleted = await this.sleepWithStopChecks(1000 / this.controlRateHz);
      if (!loopDelayCompleted) {
        break;
      }
    }

    await this.deps.motorController.stop();
    this.logger.info("pure_pursuit.obstruction_retrace_completed", {
      pointCount: retraceSegment.length,
    });
  }

  /**
   * Find closest waypoint to current position
   */
  private findClosestWaypointIndex(pose: Pose, path: PathPoint[], startIndex = 0): number {
    let minDistance = Infinity;
    const boundedStartIndex = this.clamp(Math.floor(startIndex), 0, Math.max(0, path.length - 1));
    let closestIndex = boundedStartIndex;

    for (let i = boundedStartIndex; i < path.length; i++) {
      const distance = this.distanceToPoint(pose.position, path[i]);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  private markWaypointCoverage(previousIndex: number, currentIndex: number): void {
    if (currentIndex < 0) {
      return;
    }

    this.passedWaypointIndexes.add(currentIndex);
    if (currentIndex <= previousIndex) {
      return;
    }

    for (let index = previousIndex + 1; index <= currentIndex; index += 1) {
      this.passedWaypointIndexes.add(index);
    }
  }

  /**
   * Check if reached end of path
   */
  private hasReachedEnd(pose: Pose, path: PathPoint[], requireWaypointCoverage: boolean): boolean {
    if (path.length === 0) {
      return true;
    }

    const finalWaypointIndex = path.length - 1;
    const nearFinalSegment = this.currentWaypointIndex >= Math.max(0, finalWaypointIndex - 1);
    if (!nearFinalSegment) {
      return false;
    }

    const lastPoint = path[path.length - 1];
    const distance = this.distanceToPoint(pose.position, lastPoint);

    if (distance >= this.arrivalThreshold) {
      this.hasBeenAwayFromFinalPoint = true;
      return false;
    }

    if (requireWaypointCoverage && this.passedWaypointIndexes.size < path.length) {
      return false;
    }

    return this.hasBeenAwayFromFinalPoint;
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
