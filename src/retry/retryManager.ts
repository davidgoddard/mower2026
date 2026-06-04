/**
 * Retry Manager - Event-driven recovery system for obstructions.
 *
 * High-current events trigger a context-specific retry (the mower may yet cut
 * through long/thick grass with another run-up). Wheel-slip and stall events
 * are treated as the mower being stuck and abort the session immediately.
 */

import { EventEmitter } from "node:events";
import { CheckpointStore } from "./checkpointStore.js";
import { ObstructionEvent, RecoveryResult, OperationContext, Checkpoint, PathMetadata, LineMetadata, TurnMetadata } from "./retryTypes.js";
import { LoggerScope } from "../logging/types.js";
import { Pose, unwrapMeters } from "../geometry/positionTypes.js";
import { PathPoint, RecentTargetSink } from "../pathfollowing/index.js";

export interface RetryManagerOptions {
  maxRetries?: number;
  reverseDurationMs?: number;
  escapeAngleDegrees?: number;
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
    setWheelSpeeds(left: number, right: number): Promise<void>;
  };
  driveController?: {
    reverseForDuration(durationMs: number): Promise<void>;
    driveToTarget(target: { xMeters: number; yMeters: number }): Promise<void>;
    /**
     * Drive a single segment in either direction. Used by the path-context
     * recovery to retrace recently completed targets in reverse before
     * restarting the boundary follow.
     */
    driveSegment(target: { xMeters: number; yMeters: number }, driveDirectionSign: 1 | -1): Promise<void>;
  };
  /**
   * Restart a perimeter follow from the current pose using the recorded
   * boundary points. The segmented executor re-anchors to its nearest target
   * automatically, so this is "drive the same boundary again from here".
   */
  pathRestart?: (waypoints: PathPoint[]) => Promise<void>;
  turnController?: {
    turn(angle: number): Promise<void>;
  };
  getCurrentPose(): Pose;
  getCurrentHeading(): number;
}

const DEFAULT_PATH_RETRY_REVERSE_DISTANCE_METERS = 0.5;
/** Cap on retained recent targets per path follow; bounded to keep the trail finite. */
const RECENT_TARGET_TRAIL_LIMIT = 64;

export class RetryManager extends EventEmitter implements RecentTargetSink {
  private readonly maxRetries: number;
  private readonly reverseDurationMs: number;
  private readonly escapeAngleDegrees: number;
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
    this.escapeAngleDegrees = options.escapeAngleDegrees ?? 45;
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

    if (event.type !== "high_current") {
      // Wheel slip and stall mean the mower is physically stuck — no point in
      // trying to drive through it. Abort the session.
      this.logger.error("retry.unrecoverable_obstruction", {
        type: event.type,
        context: event.context,
        motorCurrents: event.motorCurrents,
      });
      await this.abortSession(event.type);
      return { success: false, attemptNumber: 0, error: event.type };
    }

    this.isRecovering = true;

    try {
      const sessionId = this.currentSessionId;
      const attempts = this.retryCount.get(sessionId) || 0;

      this.logger.warn("retry.high_current_detected", {
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

      const checkpoint = this.checkpointStore.getRecoveryCheckpoint(event.context, 1);
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
      switch (event.context) {
        case "line":
          await this.recoverFromLine(checkpoint.metadata as LineMetadata);
          break;
        case "path":
          await this.recoverFromPath(checkpoint.metadata as PathMetadata);
          break;
        case "turn":
          await this.recoverFromTurn(checkpoint.metadata as TurnMetadata);
          break;
      }

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

  private async recoverFromLine(metadata: LineMetadata): Promise<void> {
    if (!this.deps.driveController) {
      throw new Error("DriveController not available");
    }

    this.logger.info("retry.line_recovery.reversing", { durationMs: this.reverseDurationMs });
    await this.deps.driveController.reverseForDuration(this.reverseDurationMs);
    await this.sleep(500);

    this.logger.info("retry.line_recovery.retrying_forward", { targetPosition: metadata.targetPosition });
    await this.deps.driveController.driveToTarget(metadata.targetPosition);
  }

  private async recoverFromPath(metadata: PathMetadata): Promise<void> {
    if (!this.deps.driveController) {
      throw new Error("DriveController not available");
    }
    if (!this.deps.driveController.driveSegment) {
      throw new Error("driveController.driveSegment not available");
    }
    if (!this.deps.pathRestart) {
      throw new Error("pathRestart callback not available");
    }

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

      this.logger.info("retry.path_recovery.reverse_leg", {
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
      // Fall back to a duration-based reverse so the mower at least clears the jam
      // before retrying.
      this.logger.warn("retry.path_recovery.no_recent_targets", {
        durationMs: this.reverseDurationMs,
      });
      await this.deps.driveController.reverseForDuration(this.reverseDurationMs);
    }

    await this.sleep(500);

    this.logger.info("retry.path_recovery.restarting_follow", {
      waypointCount: metadata.waypoints.length,
      reverseLegsDriven: legsDriven,
      reverseDistanceMeters: accumulatedDistance,
    });
    await this.deps.pathRestart(metadata.waypoints);
  }

  private async recoverFromTurn(metadata: TurnMetadata): Promise<void> {
    if (!this.deps.turnController) {
      throw new Error("TurnController not available");
    }

    const escapeTurn = -metadata.turnDirection * this.escapeAngleDegrees;
    this.logger.info("retry.turn_recovery.escaping", { escapeTurnDegrees: escapeTurn });
    await this.deps.turnController.turn(escapeTurn);
    await this.sleep(this.reverseDurationMs);
    await this.sleep(500);

    const currentHeading = this.deps.getCurrentHeading();
    const remainingAngle = this.normalizeAngle(metadata.targetHeading - currentHeading);
    this.logger.info("retry.turn_recovery.retrying_turn", {
      currentHeading,
      targetHeading: metadata.targetHeading,
      remainingAngle,
    });
    await this.deps.turnController.turn(remainingAngle);
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

  private normalizeAngle(angle: number): number {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
  }
}
