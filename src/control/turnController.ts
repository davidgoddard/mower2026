/**
 * Turn controller - executes on-the-spot turns with self-learning brake points
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { TurnLearningModel } from "./turnLearningModel.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import {
  InternalHeading,
  RelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  TurnRequest,
  TurnResult,
  TurnControllerState,
  TurnStatus,
  TurnDirection,
} from "./turnControllerTypes.js";
import {
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  TURN_SETTLE_TIME_MS,
  TURN_TRAINING_INTER_TURN_PAUSE_MS,
  TURN_HISTORY_MAX_SIZE,
  MOTOR_RAMP_DOWN_TIME_MS,
  TURN_SMALL_CRAWL_SPEED_FACTOR,
  TURN_HEADING_UPDATE_WATCHDOG_TIMEOUT_MS,
} from "../constants.js";
import { SENSOR_EVENTS, ImuHeadingUpdateEvent } from "../sensing/sensorEvents.js";
import { systemStop } from "./systemStop.js";
import { defaultSleep, sleepWithStopChecks } from "./sleep.js";

export interface TurnControllerOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  learningModel: TurnLearningModel;
  motorCalibration?: MotorCalibration;
  maxWheelOutputPercent?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * Maximum time without an IMU heading update during the active turning
   * phase before the watchdog fires. Defaults to
   * `TURN_HEADING_UPDATE_WATCHDOG_TIMEOUT_MS`.
   */
  headingUpdateWatchdogTimeoutMs?: number;
}

export class TurnController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly learningModel: TurnLearningModel;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly maxWheelOutputPercent: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly headingUpdateWatchdogTimeoutMs: number;
  private headingUpdateWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private status: TurnStatus = "idle";
  private currentTurn: TurnRequest | null = null;
  private stopRequested = false;
  private tuningStopRequested = false;
  private tuningSequenceActive = false;
  private turnHistory: TurnResult[] = [];
  private turnsCompleted = 0;
  private totalErrorDeg = 0;
  private turnStartHeading: InternalHeading | null = null;
  private turnStartTime: number = 0;
  private turnBrakeDistance: RelativeAngle | null = null;
  private turnResolve: ((result: TurnResult) => void) | null = null;
  private turnIsSmallAngle: boolean = false;
  private headingUpdateInFlight = false;

  constructor(options: TurnControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnController" });
    this.sensorController = options.sensorController;
    this.learningModel = options.learningModel;
    this.motorCalibration = options.motorCalibration ?? null;
    this.maxWheelOutputPercent = options.maxWheelOutputPercent ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? TURN_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.headingUpdateWatchdogTimeoutMs =
      options.headingUpdateWatchdogTimeoutMs ?? TURN_HEADING_UPDATE_WATCHDOG_TIMEOUT_MS;

    // Bind event handler to maintain 'this' context
    this.onHeadingUpdate = this.onHeadingUpdate.bind(this);
  }

  private armHeadingUpdateWatchdog(request: TurnRequest): void {
    this.clearHeadingUpdateWatchdog();
    this.headingUpdateWatchdogTimer = setTimeout(() => {
      this.headingUpdateWatchdogTimer = null;
      this.onHeadingUpdateWatchdogExpired(request);
    }, this.headingUpdateWatchdogTimeoutMs);
  }

  private clearHeadingUpdateWatchdog(): void {
    if (this.headingUpdateWatchdogTimer !== null) {
      clearTimeout(this.headingUpdateWatchdogTimer);
      this.headingUpdateWatchdogTimer = null;
    }
  }

  private onHeadingUpdateWatchdogExpired(request: TurnRequest): void {
    if (this.status !== "turning") {
      return;
    }
    this.logger.error("turn.heading_update_watchdog_expired", {
      requestedAngle: unwrapRelativeAngle(request.targetAngle),
      timeoutMs: this.headingUpdateWatchdogTimeoutMs,
      durationMs: this.nowMillis() - this.turnStartTime,
    });
    this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
    this.status = "idle";
    const stalledTurn = this.currentTurn ?? request;
    this.currentTurn = null;
    // IMU watchdog expired: bring the wheels to rest under the ramp
    // profile.  We do not raise systemStop because the H-bridge disable
    // is reserved for the operator stop button and confirmed-stall
    // detections; a stalled IMU update stream is bad but not motor-side.
    void this.sensorController.requestNeutralMotorOutputs().catch(() => {});
    const r = this.turnResolve;
    this.turnResolve = null;
    r?.({
      requestedAngle: stalledTurn.targetAngle,
      achievedAngle: createRelativeAngle(0),
      errorAngle: stalledTurn.targetAngle,
      durationMs: this.nowMillis() - this.turnStartTime,
      brakeDistanceUsed: this.turnBrakeDistance ?? createRelativeAngle(0),
      motorEngaged: false,
      status: "error",
      errorMessage: "Turn timed out waiting for IMU heading update",
      timestamp: new Date().toISOString(),
    });
  }

  executeTurn(request: TurnRequest): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      this.turnResolve = resolve;
      this.startTurnAsync(request).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("turn.error", { error: errorMessage });
        const r = this.turnResolve;
        this.turnResolve = null;
        r?.({
          requestedAngle: request.targetAngle,
          achievedAngle: createRelativeAngle(0),
          errorAngle: request.targetAngle,
          durationMs: this.nowMillis() - this.turnStartTime,
          brakeDistanceUsed: this.turnBrakeDistance ?? createRelativeAngle(0),
          motorEngaged: false,
          status: "error",
          errorMessage,
          timestamp: new Date().toISOString(),
        });
      });
    });
  }

  private async startTurnAsync(request: TurnRequest): Promise<void> {
    let subscribed = false;
    this.sensorController.beginMotionSession();
    try {
      systemStop.clearStop("turn-execute");
      this.currentTurn = request;
      this.status = "starting";
      this.turnStartHeading = this.sensorController.getHeading();
      this.turnStartTime = this.nowMillis();

      this.logger.info("turn.started", {
        targetAngle: unwrapRelativeAngle(request.targetAngle),
        direction: request.direction,
        startHeading: unwrapInternalHeading(this.turnStartHeading),
      });

      const absAngle = Math.abs(unwrapRelativeAngle(request.targetAngle));
      this.turnBrakeDistance = this.learningModel.getBrakeAngle(absAngle, request.direction);

      this.turnIsSmallAngle = absAngle <= this.learningModel.getSmallAngleThreshold();
      const brakeDistance = this.turnBrakeDistance ?? createRelativeAngle(0);
      const smallTurnBrakeFraction = this.learningModel.getSmallTurnBrakeFraction(request.direction, absAngle);

      this.logger.info("turn.brake_plan", {
        requestedAngle: absAngle,
        largeBrakeDistanceDeg: unwrapRelativeAngle(brakeDistance),
        smallCrawlWheelOutputPercent: this.maxWheelOutputPercent * TURN_SMALL_CRAWL_SPEED_FACTOR,
        smallTurnBrakeFraction,
        smallAngleThreshold: this.learningModel.getSmallAngleThreshold(),
        turnIsSmallAngle: this.turnIsSmallAngle,
        wheelOutputScale: request.wheelOutputScale ?? 1,
      });

      this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
      subscribed = true;

      const wheelScale = request.wheelOutputScale === undefined
        ? 1
        : Math.max(0.1, Math.min(1, request.wheelOutputScale));
      const scaledMaxWheelOutputPercent = this.maxWheelOutputPercent * wheelScale;
      this.status = "turning";
      this.armHeadingUpdateWatchdog(request);
      const wheelOutputPercent = scaledMaxWheelOutputPercent * TURN_SMALL_CRAWL_SPEED_FACTOR;
      const initialSpeeds = this.getTurnWheelSpeeds(request.direction, wheelOutputPercent);
      await this.sensorController.setMotorWheelOutputs(initialSpeeds.left, initialSpeeds.right);
    } catch (error) {
      if (subscribed) {
        this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
      }
      this.clearHeadingUpdateWatchdog();
      try {
        await this.sensorController.stopMotors();
      } catch {
        // Best-effort ramp during a turn-start failure.
      }
      this.status = "idle";
      this.currentTurn = null;
      throw error;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  private async onHeadingUpdate(event: ImuHeadingUpdateEvent): Promise<void> {
    if (this.headingUpdateInFlight) return;
    if (
      this.status !== "turning" ||
      this.turnStartHeading === null ||
      this.turnBrakeDistance === null ||
      !this.currentTurn
    ) {
      return;
    }
    this.headingUpdateInFlight = true;
    try {
      await this.onHeadingUpdateInner(event);
    } finally {
      this.headingUpdateInFlight = false;
    }
  }

  private async onHeadingUpdateInner(event: ImuHeadingUpdateEvent): Promise<void> {
    if (
      this.status !== "turning" ||
      this.turnStartHeading === null ||
      this.turnBrakeDistance === null ||
      !this.currentTurn
    ) {
      return;
    }

    // Re-arm the watchdog: a heading update has arrived, so the IMU stream
    // is alive. Petting the timer keeps the turn from timing out.
    this.armHeadingUpdateWatchdog(this.currentTurn);

    // Check for emergency stop
    if (this.stopRequested) {
      this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
      this.clearHeadingUpdateWatchdog();
      try {
        await this.sensorController.requestNeutralMotorOutputs();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("turn.stop_failed", { error: message });
      }
      this.status = "stopped";
      const stoppedTurn = this.currentTurn;
      this.currentTurn = null;
      this.stopRequested = false;
      this.logger.warn("turn.stopped", { durationMs: this.nowMillis() - this.turnStartTime });
      this.turnResolve?.({
        requestedAngle: stoppedTurn.targetAngle,
        achievedAngle: createRelativeAngle(0),
        errorAngle: createRelativeAngle(0),
        durationMs: this.nowMillis() - this.turnStartTime,
        brakeDistanceUsed: this.turnBrakeDistance,
        motorEngaged: false,
        status: "stopped",
        errorMessage: "Turn stopped by user request",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Calculate angular progress
    const angularProgress = headingDifference(this.turnStartHeading, event.heading);
    const absProgress = Math.abs(unwrapRelativeAngle(angularProgress));
    const absAngle = Math.abs(unwrapRelativeAngle(this.currentTurn.targetAngle));

    // Check for brake condition
    let shouldBrake = false;

    // For small angles, stop at the target using crawl speed and a hard halt.
    const smallTurnBrakeFraction = this.learningModel.getSmallTurnBrakeFraction(this.currentTurn.direction, absAngle);
    const smallTurnBrakeProgress = absAngle * smallTurnBrakeFraction;
    if (this.turnIsSmallAngle && absProgress >= smallTurnBrakeProgress) {
      shouldBrake = true;
    }

    // Normal case: brake once the remaining angle is within the learned
    // large-turn stop distance.
    if (!this.turnIsSmallAngle && absProgress >= absAngle - unwrapRelativeAngle(this.turnBrakeDistance)) {
      shouldBrake = true;
    }

    // If brake condition met, complete the turn
    if (shouldBrake) {
      this.status = "braking";
      this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
      this.clearHeadingUpdateWatchdog();
      await this.completeTurn(this.currentTurn);
    }
  }

  /**
   * Complete turn after brake point reached
   */
  private async completeTurn(request: TurnRequest): Promise<void> {
    if (this.turnStartHeading === null || this.turnBrakeDistance === null) {
      return;
    }

    try {
      const absAngle = Math.abs(unwrapRelativeAngle(request.targetAngle));
      const smallTurnBrakeFraction = this.learningModel.getSmallTurnBrakeFraction(request.direction, absAngle);
      const brakeDistanceUsed = this.turnIsSmallAngle
        ? createRelativeAngle(absAngle * smallTurnBrakeFraction)
        : this.turnBrakeDistance;

      // 6. BRAKING - Command motors to zero or halt, depending on turn size
      this.status = "braking";
      if (this.turnIsSmallAngle) {
        await this.sensorController.requestNeutralMotorOutputs();
      } else {
        await this.sensorController.setMotorWheelOutputs(0, 0);

        // 7. Wait for motor ramp-down (2x ramp-down time per spec)
        const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
        const rampDownCompleted = await this.sleepWithStopChecks(2 * rampDownTime);
        if (!rampDownCompleted || this.stopRequested || this.tuningStopRequested) {
          await this.finishStoppedTurn(request, "Turn stopped during ramp-down");
          return;
        }
      }

      // 8. SETTLING - Additional settle for stability
      this.status = "settling";
      const settleCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
      if (!settleCompleted || this.stopRequested || this.tuningStopRequested) {
        await this.finishStoppedTurn(request, "Turn stopped during settle");
        return;
      }

      // 9. MEASURING - Read final heading
      this.status = "measuring";
      const finalHeading = this.sensorController.getHeading();
      const startHeadingDeg = unwrapInternalHeading(this.turnStartHeading);
      const finalHeadingDeg = unwrapInternalHeading(finalHeading);
      const achievedAngle = headingDifference(this.turnStartHeading, finalHeading);
      const achievedAngleUnwrappedDeg = this.getDirectionAwareAchievedAngleDeg(
        startHeadingDeg,
        finalHeadingDeg,
        request.direction,
      );
      const errorAngle = createRelativeAngle(
        unwrapRelativeAngle(achievedAngle) - unwrapRelativeAngle(request.targetAngle)
      );

      this.logger.info("turn.completed", {
        requestedAngle: unwrapRelativeAngle(request.targetAngle),
        achievedAngle: unwrapRelativeAngle(achievedAngle),
        errorAngle: unwrapRelativeAngle(errorAngle),
        startHeading: startHeadingDeg,
        finalHeading: finalHeadingDeg,
        achievedAngleUnwrappedDeg,
        brakeDistanceUsed: unwrapRelativeAngle(brakeDistanceUsed ?? createRelativeAngle(0)),
        mode: this.turnIsSmallAngle ? "small_crawl_halt" : "large_zero_speed",
        durationMs: this.nowMillis() - this.turnStartTime,
      });

      // 10. LEARNING - Update model if enabled
      if (request.learningEnabled !== false) {
        this.status = "learning";
        await this.learningModel.updateFromTurn({
          requestedAngle: request.targetAngle,
          achievedAngle,
          achievedAngleUnwrappedDeg,
          errorAngle,
          brakeDistanceUsed,
          direction: request.direction,
        });
      }

      // 11. Return to idle and resolve promise
      this.status = "idle";
      this.currentTurn = null;
      const result: TurnResult = {
        requestedAngle: request.targetAngle,
        achievedAngle,
        errorAngle,
        durationMs: this.nowMillis() - this.turnStartTime,
        brakeDistanceUsed: brakeDistanceUsed ?? createRelativeAngle(0),
        motorEngaged: true,
        status: "success",
        timestamp: new Date().toISOString(),
      };

      // Update history
      this.addToHistory(result);

      // Resolve the promise
      this.turnResolve?.(result);
    } catch (error) {
      // Error during completion - ensure cleanup. Ramped stop only; the
      // emergency-disable path is reserved for genuine emergencies.
      this.status = "idle";
      this.currentTurn = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("turn.completion_error", { error: errorMessage });
      try {
        await this.sensorController.stopMotors();
      } catch {
        // Best-effort ramp during a completion error.
      }

      this.turnResolve?.({
        requestedAngle: request.targetAngle,
        achievedAngle: createRelativeAngle(0),
        errorAngle: request.targetAngle,
        durationMs: this.nowMillis() - this.turnStartTime,
        brakeDistanceUsed: this.turnBrakeDistance ?? createRelativeAngle(0),
        motorEngaged: false,
        status: "error",
        errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Cancel the in-flight turn and bring the wheels to rest under the
   * deceleration profile. Does NOT raise systemStop — the H-bridge
   * disable is reserved for the operator stop button, stall detection,
   * and other genuine emergencies.
   */
  async stopCurrentTurn(): Promise<void> {
    this.tuningStopRequested = this.tuningSequenceActive;
    if (this.currentTurn) {
      this.stopRequested = true;
    }
  }

  /**
   * Run the large-angle turn training sequence.
   */
  async runLargeAngleTraining(iterations: number = 1, anglesToTest: number[] = this.getLargeTrainingAngles()): Promise<TurnResult[]> {
    return this.runTrainingSequence({
      mode: "large",
      iterations,
      anglesToTest,
      targetErrorDeg: 2,
    });
  }

  /**
   * Run the small-angle turn training sequence until each bucket is within target error.
   */
  async runSmallAngleTraining(targetErrorDeg: number = 2, anglesToTest: number[] = this.getSmallTrainingAngles()): Promise<TurnResult[]> {
    return this.runTrainingSequence({
      mode: "small",
      anglesToTest,
      targetErrorDeg,
    });
  }

  /**
   * Run a tuning sequence through multiple test angles.
   */
  private async runTrainingSequence(options: {
    mode: "large" | "small";
    iterations?: number;
    anglesToTest: number[];
    targetErrorDeg: number;
  }): Promise<TurnResult[]> {
    this.tuningSequenceActive = true;
    this.tuningStopRequested = false;
    const testAngles = options.anglesToTest;
    const results: TurnResult[] = [];

    this.logger.info("turn.training.started", {
      mode: options.mode,
      iterations: options.iterations ?? 1,
      angles: testAngles.length,
      targetErrorDeg: options.targetErrorDeg,
    });

    try {
      if (options.mode === "large") {
        const iterations = options.iterations ?? 1;
        const MAX_ATTEMPTS_PER_ANGLE = 10;

        for (let i = 0; i < iterations; i += 1) {
          if (systemStop.isStopped()) {
            this.logger.warn("turn.training.stopped", { completed: results.length, reason: "system_stop" });
            return results;
          }
          this.logger.info("turn.training.iteration", { iteration: i + 1, of: iterations, mode: options.mode });

          for (const angleDeg of testAngles) {
            if (systemStop.isStopped()) {
              this.logger.warn("turn.training.stopped", { completed: results.length, reason: "system_stop" });
              return results;
            }
            let attempt = 0;

            while (attempt < MAX_ATTEMPTS_PER_ANGLE) {
              if (this.stopRequested || this.tuningStopRequested) {
                this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
                return results;
              }

              attempt += 1;
              this.logger.info("turn.training.large_iteration", {
                angleDeg,
                attempt,
                maxAttempts: MAX_ATTEMPTS_PER_ANGLE,
                targetErrorDeg: options.targetErrorDeg,
                sweepIteration: i + 1,
                totalSweepIterations: iterations,
              });

              const result = await this.executeTurn({
                targetAngle: createRelativeAngle(angleDeg),
                direction: angleDeg > 0 ? "ccw" : "cw",
                learningEnabled: true,
              });
              results.push(result);

              const absErrorDeg = Math.abs(unwrapRelativeAngle(result.errorAngle));
              this.logger.info("turn.training.large_result", {
                angleDeg,
                attempt,
                achievedAngleDeg: unwrapRelativeAngle(result.achievedAngle),
                errorDeg: unwrapRelativeAngle(result.errorAngle),
                absErrorDeg,
                targetErrorDeg: options.targetErrorDeg,
              });

              if (this.stopRequested || this.tuningStopRequested) {
                this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
                return results;
              }

              if (systemStop.isStopped()) {
                this.logger.warn("turn.training.stopped", { completed: results.length, reason: "system_stop" });
                return results;
              }

              if (absErrorDeg <= options.targetErrorDeg) {
                break;
              }

              if (attempt >= MAX_ATTEMPTS_PER_ANGLE) {
                this.logger.warn("turn.training.max_attempts_reached", {
                  angleDeg,
                  attempt,
                  absErrorDeg,
                  targetErrorDeg: options.targetErrorDeg,
                });
                break;
              }

              const pauseCompleted = await this.sleepWithStopChecks(TURN_TRAINING_INTER_TURN_PAUSE_MS);
              if (!pauseCompleted || this.stopRequested || this.tuningStopRequested) {
                this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
                return results;
              }
            }
          }
        }
      } else {
        for (const angleDeg of testAngles) {
          if (systemStop.isStopped()) {
            this.logger.warn("turn.training.stopped", { completed: results.length, reason: "system_stop" });
            return results;
          }

          let attempt = 0;
          const MAX_ATTEMPTS_PER_ANGLE = 10;
          let angleResult: TurnResult | null = null;

          while (attempt < MAX_ATTEMPTS_PER_ANGLE) {
            if (systemStop.isStopped()) {
              this.logger.warn("turn.training.stopped", { completed: results.length, reason: "system_stop" });
              return results;
            }
            if (this.stopRequested || this.tuningStopRequested) {
              this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
              return results;
            }

            attempt += 1;
            this.logger.info("turn.training.small_iteration", {
              angleDeg,
              attempt,
              maxAttempts: MAX_ATTEMPTS_PER_ANGLE,
              targetErrorDeg: options.targetErrorDeg,
            });

            angleResult = await this.executeTurn({
              targetAngle: createRelativeAngle(angleDeg),
              direction: angleDeg > 0 ? "ccw" : "cw",
              learningEnabled: true,
            });
            results.push(angleResult);

            const absErrorDeg = Math.abs(unwrapRelativeAngle(angleResult.errorAngle));
            this.logger.info("turn.training.small_result", {
              angleDeg,
              attempt,
              achievedAngleDeg: unwrapRelativeAngle(angleResult.achievedAngle),
              errorDeg: unwrapRelativeAngle(angleResult.errorAngle),
              absErrorDeg,
              targetErrorDeg: options.targetErrorDeg,
            });

            if (absErrorDeg <= options.targetErrorDeg) {
              break;
            }

            if (attempt >= MAX_ATTEMPTS_PER_ANGLE) {
              this.logger.warn("turn.training.max_attempts_reached", {
                angleDeg, attempt, absErrorDeg, targetErrorDeg: options.targetErrorDeg,
              });
              break;
            }

            if (this.stopRequested || this.tuningStopRequested || systemStop.isStopped()) {
              this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
              return results;
            }

            const pauseCompleted = await this.sleepWithStopChecks(TURN_TRAINING_INTER_TURN_PAUSE_MS);
            if (!pauseCompleted || this.stopRequested || this.tuningStopRequested) {
              this.logger.warn("turn.training.stopped", { completed: results.length, mode: options.mode });
              return results;
            }
          }
        }
      }

      this.logger.info("turn.training.completed", { totalTurns: results.length, mode: options.mode });
      return results;
    } finally {
      this.tuningSequenceActive = false;
      this.tuningStopRequested = false;
    }
  }

  /**
   * Get current controller state
   */
  getState(): TurnControllerState {
    return {
      status: this.status,
      currentTurn: this.currentTurn,
      turnsCompleted: this.turnsCompleted,
      averageErrorDeg: this.turnsCompleted > 0 ? this.totalErrorDeg / this.turnsCompleted : 0,
    };
  }

  /**
   * Get turn history
   */
  getTurnHistory(): TurnResult[] {
    return [...this.turnHistory];
  }

  /**
   * Clear turn history
   */
  clearHistory(): void {
    this.turnHistory = [];
    this.turnsCompleted = 0;
    this.totalErrorDeg = 0;
  }

  /**
   * Add result to history with size limit
   */
  private addToHistory(result: TurnResult): void {
    this.turnHistory.push(result);
    if (this.turnHistory.length > TURN_HISTORY_MAX_SIZE) {
      this.turnHistory.shift();
    }
    this.turnsCompleted++;
    this.totalErrorDeg += Math.abs(unwrapRelativeAngle(result.errorAngle));
  }

  /**
   * Sleep in short chunks so stop requests can interrupt long waits.
   */
  private sleepWithStopChecks(delayMs: number): Promise<boolean> {
    return sleepWithStopChecks(
      delayMs,
      () => this.stopRequested || this.tuningStopRequested,
      this.sleep,
    );
  }

  /**
   * Finish a turn in the stopped state after braking has started.
   */
  private async finishStoppedTurn(request: TurnRequest, errorMessage: string): Promise<void> {
    this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
    this.clearHeadingUpdateWatchdog();
    this.status = "stopped";
    const stoppedTurn = this.currentTurn ?? request;
    this.currentTurn = null;
    this.stopRequested = false;
    this.logger.warn("turn.stopped", {
      durationMs: this.nowMillis() - this.turnStartTime,
      reason: errorMessage,
    });
    this.turnResolve?.({
      requestedAngle: stoppedTurn.targetAngle,
      achievedAngle: createRelativeAngle(0),
      errorAngle: createRelativeAngle(0),
      durationMs: this.nowMillis() - this.turnStartTime,
      brakeDistanceUsed: this.turnBrakeDistance ?? createRelativeAngle(0),
      motorEngaged: false,
      status: "stopped",
      errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Map a turn direction to wheel speeds.
   */
  private getTurnWheelSpeeds(direction: "ccw" | "cw", wheelOutputPercent: number): { left: number; right: number } {
    return direction === "ccw"
      ? { left: -wheelOutputPercent, right: wheelOutputPercent }
      : { left: wheelOutputPercent, right: -wheelOutputPercent };
  }

  private getDirectionAwareAchievedAngleDeg(
    startHeadingDeg: number,
    finalHeadingDeg: number,
    direction: TurnDirection,
  ): number {
    const normalize360 = (angleDeg: number): number => {
      const wrapped = angleDeg % 360;
      return wrapped < 0 ? wrapped + 360 : wrapped;
    };

    if (direction === "ccw") {
      return normalize360(finalHeadingDeg - startHeadingDeg);
    }

    return normalize360(startHeadingDeg - finalHeadingDeg);
  }

  private getLargeTrainingAngles(): number[] {
    const angles: number[] = [];
    for (let angleDeg = 70; angleDeg <= 180; angleDeg += 10) {
      angles.push(angleDeg, -angleDeg);
    }
    return angles;
  }

  private getSmallTrainingAngles(): number[] {
    const angles: number[] = [];
    for (let angleDeg = 3; angleDeg <= 60; angleDeg += 3) {
      angles.push(angleDeg, -angleDeg);
    }
    return angles;
  }

}
