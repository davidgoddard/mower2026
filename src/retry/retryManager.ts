/**
 * Retry Manager - Event-driven recovery system for obstructions during a
 * perimeter follow.
 *
 * High-current, stall, and wheel-slip events trigger the path-context retry: walk the
 * recent-target trail backward by reverse-driving each completed target until
 * a configured retreat distance is reached, then restart the boundary follow
 * from the new pose.
 */

import { EventEmitter } from "node:events";
import { CheckpointStore } from "./checkpointStore.js";
import { ObstructionEvent, RecoveryResult, OperationContext, Checkpoint } from "./retryTypes.js";
import { LoggerScope } from "../logging/types.js";
import { Pose, unwrapMeters } from "../geometry/positionTypes.js";
import { PathPoint, RecentTargetSink } from "../pathfollowing/index.js";

export interface RetryManagerOptions {
  maxRetries?: number;
  reverseDurationMs?: number;
  /**
   * Reverse-travel distance the path-context retry tries to accumulate by
   * retracing recent targets backward before restarting the boundary follow.
   * Defaults to 0.5 m, matching `pathRetryReverseDistanceMeters` in the
   * persisted path-following config.
   */
  pathRetryReverseDistanceMeters?: number;
  logger: LoggerScope;
  checkpointStore: CheckpointStore;
}

export interface RetryManagerDependencies {
  motorController: {
    stop(): Promise<void>;
  };
  driveController: {
    /**
     * Drive a single segment in either direction. Used by the path-context
     * recovery to retrace recently completed targets in reverse before
     * restarting the boundary follow.
     */
    driveSegment(target: { xMeters: number; yMeters: number }, driveDirectionSign: 1 | -1): Promise<void>;
    /**
     * Reverse for a fixed duration. Used as the path-context fallback when no
     * recent targets are available (e.g. obstruction on the very first segment).
     */
    reverseForDuration(durationMs: number): Promise<void>;
  };
  /**
   * Restart a perimeter follow from the current pose using the recorded
   * boundary points. The segmented executor re-anchors to its nearest target
   * automatically, so this is "drive the same boundary again from here".
   */
  pathRestart: (waypoints: PathPoint[]) => Promise<void>;
  getCurrentPose(): Pose;
}

const DEFAULT_PATH_RETRY_REVERSE_DISTANCE_METERS = 0.5;
/** Cap on retained recent targets per path follow; bounded to keep the trail finite. */
const RECENT_TARGET_TRAIL_LIMIT = 64;

export class RetryManager extends EventEmitter implements RecentTargetSink {
  private readonly maxRetries: number;
  private readonly reverseDurationMs: number;
  private readonly pathRetryReverseDistanceMeters: number;
  private readonly logger: LoggerScope;
  private readonly checkpointStore: CheckpointStore;
  private readonly deps: RetryManagerDependencies;

  private retryCount: Map<string, number> = new Map();
  private currentSessionId: string | null = null;
  private isRecovering: boolean = false;
  /**
   * FIFO of targets the segmented executor has just completed during the
   * current path follow. Capped at RECENT_TARGET_TRAIL_LIMIT — the retry walks
   * this list backward when reversing out of a grass jam.
   */
  private recentTargets: PathPoint[] = [];

  constructor(options: RetryManagerOptions, dependencies: RetryManagerDependencies) {
    super();
    this.maxRetries = options.maxRetries ?? 3;
    this.reverseDurationMs = options.reverseDurationMs ?? 2000;
    this.pathRetryReverseDistanceMeters = options.pathRetryReverseDistanceMeters ?? DEFAULT_PATH_RETRY_REVERSE_DISTANCE_METERS;
    this.logger = options.logger;
    this.checkpointStore = options.checkpointStore;
    this.deps = dependencies;
  }

  /**
   * RecentTargetSink — the segmented executor calls this once per completed target.
   */
  recordCompletedTarget(target: PathPoint): void {
    this.recentTargets.push(target);
    if (this.recentTargets.length > RECENT_TARGET_TRAIL_LIMIT) {
      this.recentTargets.shift();
    }
  }

  /** Discard the recent-target trail. Call when a path follow ends or a fresh one starts. */
  clearRecentTargets(): void {
    this.recentTargets = [];
  }

  startSession(sessionId: string, context: OperationContext): void {
    this.currentSessionId = sessionId;
    this.retryCount.set(sessionId, 0);
    this.logger.info("retry.session_started", { sessionId, context });
  }

  endSession(): void {
    if (this.currentSessionId) {
      this.logger.info("retry.session_ended", { sessionId: this.currentSessionId });
      this.currentSessionId = null;
    }
  }

  async handleObstruction(event: ObstructionEvent): Promise<RecoveryResult> {
    if (this.isRecovering) {
      this.logger.warn("retry.already_recovering", { event });
      return { success: false, attemptNumber: 0, error: "already_recovering" };
    }

    if (!this.currentSessionId) {
      this.logger.error("retry.no_active_session", { event });
      return { success: false, attemptNumber: 0, error: "no_active_session" };
    }

    this.isRecovering = true;

    try {
      const sessionId = this.currentSessionId;
      const attempts = this.retryCount.get(sessionId) || 0;

      this.logger.warn("retry.recoverable_obstruction_detected", {
        type: event.type,
        context: event.context,
        attemptNumber: attempts + 1,
        maxRetries: this.maxRetries,
        motorCurrents: event.motorCurrents,
      });

      if (attempts >= this.maxRetries) {
        this.logger.error("retry.max_retries_exceeded", {
          sessionId,
          attempts,
          maxRetries: this.maxRetries,
        });
        await this.abortSession("max_retries_exceeded");
        return { success: false, attemptNumber: attempts, error: "max_retries_exceeded" };
      }

      const checkpoint = this.checkpointStore.getRecoveryCheckpoint();
      if (!checkpoint) {
        this.logger.error("retry.no_checkpoint_found", { context: event.context });
        await this.abortSession("no_checkpoint");
        return { success: false, attemptNumber: attempts, error: "no_checkpoint" };
      }

      const result = await this.executeRecovery(checkpoint, event);
      this.retryCount.set(sessionId, attempts + 1);
      return result;
    } finally {
      this.isRecovering = false;
    }
  }

  private async executeRecovery(checkpoint: Checkpoint, event: ObstructionEvent): Promise<RecoveryResult> {
    const attempts = this.retryCount.get(this.currentSessionId!) || 0;

    this.logger.info("retry.starting_recovery", {
      context: event.context,
      checkpointId: checkpoint.id,
      attemptNumber: attempts + 1,
    });

    await this.deps.motorController.stop();
    await this.sleep(500);

    try {
      await this.recoverFromPath(checkpoint.metadata.waypoints, event.position);

      this.logger.info("retry.recovery_completed", { context: event.context, attemptNumber: attempts + 1 });
      this.emit("recovery_completed", { context: event.context, attemptNumber: attempts + 1 });
      return { success: true, attemptNumber: attempts + 1 };
    } catch (error) {
      this.logger.error("retry.recovery_failed", {
        context: event.context,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit("recovery_failed", { context: event.context, error });
      return {
        success: false,
        attemptNumber: attempts + 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async recoverFromPath(waypoints: PathPoint[], obstructionPose: Pose): Promise<void> {
    // Walk the recent-target trail backward, reverse-driving each completed
    // target in turn until we have travelled at least the configured retreat
    // distance. The executor's nearest-target re-anchor will pick up forward
    // travel from wherever we end up.
    const targetDistance = this.pathRetryReverseDistanceMeters;
    const startPose = this.deps.getCurrentPose();
    let originX = unwrapMeters(startPose.position.xMeters);
    let originY = unwrapMeters(startPose.position.yMeters);
    let accumulatedDistance = 0;
    let legsDriven = 0;

    this.logger.info("retry.path_recovery.starting_reverse", {
      targetDistanceMeters: targetDistance,
      recentTargetCount: this.recentTargets.length,
    });

    while (accumulatedDistance < targetDistance && this.recentTargets.length > 0) {
      const previousTarget = this.recentTargets.pop()!;
      const dx = previousTarget.xMeters - originX;
      const dy = previousTarget.yMeters - originY;
      const legDistance = Math.hypot(dx, dy);

      this.logger.debug("retry.path_recovery.reverse_leg", {
        legIndex: legsDriven + 1,
        target: { x: previousTarget.xMeters, y: previousTarget.yMeters },
        legDistanceMeters: legDistance,
        accumulatedDistanceMeters: accumulatedDistance,
      });

      await this.deps.driveController.driveSegment(
        { xMeters: previousTarget.xMeters, yMeters: previousTarget.yMeters },
        -1,
      );
      await this.sleep(200);

      accumulatedDistance += legDistance;
      legsDriven += 1;
      originX = previousTarget.xMeters;
      originY = previousTarget.yMeters;
    }

    if (legsDriven === 0) {
      // No recent targets recorded (e.g. obstruction on the very first segment).
      // Fall back to a duration-based reverse so the mower at least clears the
      // jam, then drive a direct recovery segment back to the obstruction pose.
      // That return line must be judged against its own start/end geometry,
      // not against the perimeter CTE envelope.
      this.logger.warn("retry.path_recovery.no_recent_targets", {
        durationMs: this.reverseDurationMs,
      });
      await this.deps.driveController.reverseForDuration(this.reverseDurationMs);

      const returnPose = this.deps.getCurrentPose();
      const returnOriginXMeters = unwrapMeters(returnPose.position.xMeters);
      const returnOriginYMeters = unwrapMeters(returnPose.position.yMeters);
      const obstructionXMeters = unwrapMeters(obstructionPose.position.xMeters);
      const obstructionYMeters = unwrapMeters(obstructionPose.position.yMeters);
      const returnDistanceMeters = Math.hypot(
        obstructionXMeters - returnOriginXMeters,
        obstructionYMeters - returnOriginYMeters,
      );

      this.logger.info("retry.path_recovery.returning_to_obstruction_pose", {
        from: { xMeters: returnOriginXMeters, yMeters: returnOriginYMeters },
        to: { xMeters: obstructionXMeters, yMeters: obstructionYMeters },
        returnDistanceMeters,
      });

      await this.deps.driveController.driveSegment(
        { xMeters: obstructionXMeters, yMeters: obstructionYMeters },
        1,
      );
    }

    await this.sleep(500);

    this.logger.info("retry.path_recovery.restarting_follow", {
      waypointCount: waypoints.length,
      reverseLegsDriven: legsDriven,
      reverseDistanceMeters: accumulatedDistance,
    });
    await this.deps.pathRestart(waypoints);
  }

  private async abortSession(reason: string): Promise<void> {
    this.logger.error("retry.aborting_session", {
      sessionId: this.currentSessionId,
      reason,
    });

    await this.deps.motorController.stop();
    this.emit("session_aborted", { sessionId: this.currentSessionId, reason });
    this.endSession();
  }

  getRetryCount(): number {
    if (!this.currentSessionId) {
      return 0;
    }
    return this.retryCount.get(this.currentSessionId) || 0;
  }

  isCurrentlyRecovering(): boolean {
    return this.isRecovering;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
