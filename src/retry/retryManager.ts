/**
 * Retry Manager - Event-driven recovery system for obstructions
 *
 * Design B: Event-Driven Recovery with Checkpoint System
 */

import { EventEmitter } from "node:events";
import { CheckpointStore } from "./checkpointStore.js";
import { ObstructionEvent, RecoveryResult, OperationContext } from "./retryTypes.js";
import { LoggerScope } from "../logging/types.js";
import { Pose } from "../geometry/positionTypes.js";

export interface RetryManagerOptions {
  maxRetries?: number;
  reverseDurationMs?: number;
  escapeAngleDegrees?: number;
  pathWaypointsToRetrace?: number;
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
  };
  pathFollower?: {
    retraceToWaypoint(waypointIndex: number): Promise<void>;
    resumeFromWaypoint(waypointIndex: number): Promise<void>;
  };
  turnController?: {
    turn(angle: number): Promise<void>;
  };
  getCurrentPose(): Pose;
  getCurrentHeading(): number;
}

export class RetryManager extends EventEmitter {
  private readonly maxRetries: number;
  private readonly reverseDurationMs: number;
  private readonly escapeAngleDegrees: number;
  private readonly pathWaypointsToRetrace: number;
  private readonly logger: LoggerScope;
  private readonly checkpointStore: CheckpointStore;
  private readonly deps: RetryManagerDependencies;

  // Session tracking
  private retryCount: Map<string, number> = new Map();
  private currentSessionId: string | null = null;
  private isRecovering: boolean = false;

  constructor(options: RetryManagerOptions, dependencies: RetryManagerDependencies) {
    super();
    this.maxRetries = options.maxRetries ?? 3;
    this.reverseDurationMs = options.reverseDurationMs ?? 2000;
    this.escapeAngleDegrees = options.escapeAngleDegrees ?? 45;
    this.pathWaypointsToRetrace = options.pathWaypointsToRetrace ?? 5;
    this.logger = options.logger;
    this.checkpointStore = options.checkpointStore;
    this.deps = dependencies;
  }

  /**
   * Start a new operation session
   * Resets retry counter for this session
   */
  startSession(sessionId: string, context: OperationContext): void {
    this.currentSessionId = sessionId;
    this.retryCount.set(sessionId, 0);
    this.logger.info("retry.session_started", { sessionId, context });
  }

  /**
   * End the current session
   */
  endSession(): void {
    if (this.currentSessionId) {
      this.logger.info("retry.session_ended", { sessionId: this.currentSessionId });
      this.currentSessionId = null;
    }
  }

  /**
   * Handle obstruction event
   * Main entry point called when obstruction is detected
   */
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

      this.logger.warn("retry.obstruction_detected", {
        type: event.type,
        context: event.context,
        attemptNumber: attempts + 1,
        maxRetries: this.maxRetries,
        motorCurrents: event.motorCurrents,
      });

      // Check if max retries exceeded
      if (attempts >= this.maxRetries) {
        this.logger.error("retry.max_retries_exceeded", {
          sessionId,
          attempts,
          maxRetries: this.maxRetries,
        });

        await this.abortSession("max_retries_exceeded");
        return { success: false, attemptNumber: attempts, error: "max_retries_exceeded" };
      }

      // Get appropriate checkpoint
      const stepsBack = event.context === "path" ? this.pathWaypointsToRetrace : 1;
      const checkpoint = this.checkpointStore.getRecoveryCheckpoint(event.context, stepsBack);

      if (!checkpoint) {
        this.logger.error("retry.no_checkpoint_found", { context: event.context });
        await this.abortSession("no_checkpoint");
        return { success: false, attemptNumber: attempts, error: "no_checkpoint" };
      }

      // Execute recovery
      const result = await this.executeRecovery(checkpoint, event);

      // Increment attempt counter
      this.retryCount.set(sessionId, attempts + 1);

      return result;
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Execute context-specific recovery
   */
  private async executeRecovery(
    checkpoint: any,
    event: ObstructionEvent
  ): Promise<RecoveryResult> {
    const attempts = this.retryCount.get(this.currentSessionId!) || 0;

    this.logger.info("retry.starting_recovery", {
      context: event.context,
      checkpointId: checkpoint.id,
      attemptNumber: attempts + 1,
    });

    // Stop motors immediately
    await this.deps.motorController.stop();
    await this.sleep(500); // settle

    try {
      // Execute context-specific recovery
      switch (event.context) {
        case "line":
          await this.recoverFromLine(checkpoint);
          break;
        case "path":
          await this.recoverFromPath(checkpoint);
          break;
        case "turn":
          await this.recoverFromTurn(checkpoint);
          break;
      }

      this.logger.info("retry.recovery_completed", {
        context: event.context,
        attemptNumber: attempts + 1,
      });

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

  /**
   * Recover from line driving obstruction
   */
  private async recoverFromLine(checkpoint: any): Promise<void> {
    this.logger.info("retry.line_recovery.starting", { checkpointId: checkpoint.id });

    if (!this.deps.driveController) {
      throw new Error("DriveController not available");
    }

    // Reverse for configured duration
    this.logger.info("retry.line_recovery.reversing", { durationMs: this.reverseDurationMs });
    await this.deps.driveController.reverseForDuration(this.reverseDurationMs);

    await this.sleep(500); // settle

    // Retry forward to original target
    const targetPosition = checkpoint.metadata.targetPosition;
    this.logger.info("retry.line_recovery.retrying_forward", { targetPosition });
    await this.deps.driveController.driveToTarget(targetPosition);

    this.logger.info("retry.line_recovery.completed");
  }

  /**
   * Recover from path following obstruction
   */
  private async recoverFromPath(checkpoint: any): Promise<void> {
    this.logger.info("retry.path_recovery.starting", {
      checkpointId: checkpoint.id,
      waypointsToRetrace: this.pathWaypointsToRetrace,
    });

    if (!this.deps.pathFollower) {
      throw new Error("PathFollower not available");
    }

    const waypointIndex = checkpoint.metadata.currentWaypointIndex;
    const targetIndex = Math.max(0, waypointIndex - this.pathWaypointsToRetrace);

    // Retrace path backwards to safe waypoint
    this.logger.info("retry.path_recovery.retracing", {
      fromIndex: waypointIndex,
      toIndex: targetIndex,
    });
    await this.deps.pathFollower.retraceToWaypoint(targetIndex);

    await this.sleep(500); // settle

    // Resume forward from safe waypoint
    this.logger.info("retry.path_recovery.resuming_forward", { fromIndex: targetIndex });
    await this.deps.pathFollower.resumeFromWaypoint(targetIndex);

    this.logger.info("retry.path_recovery.completed");
  }

  /**
   * Recover from turn obstruction
   */
  private async recoverFromTurn(checkpoint: any): Promise<void> {
    this.logger.info("retry.turn_recovery.starting", { checkpointId: checkpoint.id });

    if (!this.deps.turnController) {
      throw new Error("TurnController not available");
    }

    // Turn opposite direction briefly to escape
    const turnDirection = checkpoint.metadata.turnDirection;
    const escapeTurn = -turnDirection * this.escapeAngleDegrees;

    this.logger.info("retry.turn_recovery.escaping", {
      escapeTurnDegrees: escapeTurn,
      durationMs: this.reverseDurationMs,
    });

    await this.deps.turnController.turn(escapeTurn);
    await this.sleep(this.reverseDurationMs);

    await this.sleep(500); // settle

    // Retry original turn accounting for already-turned angle
    const currentHeading = this.deps.getCurrentHeading();
    const targetHeading = checkpoint.metadata.targetHeading;
    const remainingAngle = this.normalizeAngle(targetHeading - currentHeading);

    this.logger.info("retry.turn_recovery.retrying_turn", {
      currentHeading,
      targetHeading,
      remainingAngle,
    });

    await this.deps.turnController.turn(remainingAngle);

    this.logger.info("retry.turn_recovery.completed");
  }

  /**
   * Abort current session and power off motors
   */
  private async abortSession(reason: string): Promise<void> {
    this.logger.error("retry.aborting_session", {
      sessionId: this.currentSessionId,
      reason,
    });

    await this.deps.motorController.stop();

    this.emit("session_aborted", { sessionId: this.currentSessionId, reason });

    this.endSession();
  }

  /**
   * Get retry count for current session
   */
  getRetryCount(): number {
    if (!this.currentSessionId) {
      return 0;
    }
    return this.retryCount.get(this.currentSessionId) || 0;
  }

  /**
   * Check if currently recovering
   */
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
