/**
 * Turn controller - executes on-the-spot turns with self-learning brake points
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { TurnLearningModel } from "./turnLearningModel.js";
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
} from "./turnControllerTypes.js";
import {
  MAX_WHEEL_SPEED_MPS_DEFAULT,
  TURN_SETTLE_TIME_MS,
  TURN_HISTORY_MAX_SIZE,
  TURN_SMALL_CRAWL_SPEED_FACTOR,
} from "../constants.js";
import { SENSOR_EVENTS, ImuHeadingUpdateEvent } from "../sensing/sensorEvents.js";

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface TurnControllerOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  learningModel: TurnLearningModel;
  maxWheelSpeedMetersPerSecond?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class TurnController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly learningModel: TurnLearningModel;
  private readonly maxWheelSpeed: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private status: TurnStatus = "idle";
  private currentTurn: TurnRequest | null = null;
  private stopRequested = false;
  private tuningStopRequested = false;
  private tuningSequenceActive = false;
  private turnHistory: TurnResult[] = [];
  private turnsCompleted = 0;
  private totalErrorDeg = 0;

  // Event-driven turn state
  private turnStartHeading: InternalHeading | null = null;
  private turnStartTime: number = 0;
  private turnBrakeDistance: RelativeAngle | null = null;
  private turnResolve: ((result: TurnResult) => void) | null = null;
  private turnIsSmallAngle: boolean = false;

  constructor(options: TurnControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnController" });
    this.sensorController = options.sensorController;
    this.learningModel = options.learningModel;
    this.maxWheelSpeed = options.maxWheelSpeedMetersPerSecond ?? MAX_WHEEL_SPEED_MPS_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? TURN_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;

    // Bind event handler to maintain 'this' context
    this.onHeadingUpdate = this.onHeadingUpdate.bind(this);
  }

  /**
   * Execute a turn maneuver (event-driven)
   */
  async executeTurn(request: TurnRequest): Promise<TurnResult> {
    return new Promise<TurnResult>(async (resolve) => {
      let subscribed = false;

      try {
        // 1. STARTING - Record initial state
        this.currentTurn = request;
        this.status = "starting";
        this.turnStartHeading = this.sensorController.getHeading();
        this.turnStartTime = this.nowMillis();
        this.turnResolve = resolve;

        this.logger.info("turn.started", {
          targetAngle: unwrapRelativeAngle(request.targetAngle),
          direction: request.direction,
          startHeading: unwrapInternalHeading(this.turnStartHeading),
        });

        // 2. Get predicted brake angle from learning model
        const absAngle = Math.abs(unwrapRelativeAngle(request.targetAngle));
        this.turnBrakeDistance = this.learningModel.getBrakeDistance(request.direction);

        // 3. Check if this is a "small angle" case
        this.turnIsSmallAngle = absAngle < this.learningModel.getSmallAngleThreshold();

        this.logger.info("turn.brake_plan", {
          requestedAngle: absAngle,
          largeBrakeDistanceDeg: unwrapRelativeAngle(this.turnBrakeDistance),
          smallCrawlSpeedMetersPerSecond: this.maxWheelSpeed * TURN_SMALL_CRAWL_SPEED_FACTOR,
          smallAngleThreshold: this.learningModel.getSmallAngleThreshold(),
          turnIsSmallAngle: this.turnIsSmallAngle,
        });

        // 4. Subscribe to IMU heading update events
        this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
        subscribed = true;

        // 5. TURNING - Engage motors at the configured turn speed
        this.status = "turning";
        const wheelSpeed = this.turnIsSmallAngle
          ? this.maxWheelSpeed * TURN_SMALL_CRAWL_SPEED_FACTOR
          : this.maxWheelSpeed;
        const initialSpeeds = this.getTurnWheelSpeeds(request.direction, wheelSpeed);
        await this.sensorController.setMotorWheelSpeeds(initialSpeeds.left, initialSpeeds.right);
      } catch (error) {
        // Cleanup on error
        if (subscribed) {
          this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
        }
        this.status = "idle";
        this.currentTurn = null;

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("turn.error", { error: errorMessage });

        resolve({
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
    });
  }

  /**
   * Event handler for IMU heading updates (called at 30Hz by sensor controller)
   */
  private async onHeadingUpdate(event: ImuHeadingUpdateEvent): Promise<void> {
    if (this.status !== "turning" || !this.turnStartHeading || !this.turnBrakeDistance || !this.currentTurn) {
      return;
    }

    // Check for emergency stop
    if (this.stopRequested) {
      this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
      await this.sensorController.stopMotors();
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
    if (this.turnIsSmallAngle && absProgress >= absAngle) {
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
      await this.completeTurn(this.currentTurn);
    }
  }

  /**
   * Complete turn after brake point reached
   */
  private async completeTurn(request: TurnRequest): Promise<void> {
    if (!this.turnStartHeading || !this.turnBrakeDistance) {
      return;
    }

    try {
      const brakeDistanceUsed = this.turnIsSmallAngle ? createRelativeAngle(0) : this.turnBrakeDistance;

      // 6. BRAKING - Command motors to zero or halt, depending on turn size
      this.status = "braking";
      this.logger.info("turn.braking", {
        requestedAngle: unwrapRelativeAngle(request.targetAngle),
        brakeDistanceUsed: unwrapRelativeAngle(brakeDistanceUsed ?? createRelativeAngle(0)),
        mode: this.turnIsSmallAngle ? "small_crawl_halt" : "large_zero_speed",
        leftWheelTargetMetersPerSecond: 0,
        rightWheelTargetMetersPerSecond: 0,
        driveEnabled: !this.turnIsSmallAngle,
      });
      if (this.turnIsSmallAngle) {
        await this.sensorController.stopMotors();
      } else {
        await this.sensorController.setMotorWheelSpeeds(0, 0);

        // 7. Wait for motor ramp-down (2x ramp-down time per spec)
        const rampDownTime = this.learningModel.getMotorRampDownTime();
        this.logger.info("turn.ramp_down_wait", {
          durationMs: 2 * rampDownTime,
        });
        const rampDownCompleted = await this.sleepWithStopChecks(2 * rampDownTime);
        if (!rampDownCompleted || this.stopRequested || this.tuningStopRequested) {
          await this.finishStoppedTurn(request, "Turn stopped during ramp-down");
          return;
        }
      }

      // 8. SETTLING - Additional settle for stability
      this.status = "settling";
      this.logger.info("turn.settling_wait", {
        durationMs: this.settleTimeMs,
      });
      const settleCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
      if (!settleCompleted || this.stopRequested || this.tuningStopRequested) {
        await this.finishStoppedTurn(request, "Turn stopped during settle");
        return;
      }

      // 9. MEASURING - Read final heading
      this.status = "measuring";
      const finalHeading = this.sensorController.getHeading();
      const achievedAngle = headingDifference(this.turnStartHeading, finalHeading);
      const errorAngle = createRelativeAngle(
        unwrapRelativeAngle(achievedAngle) - unwrapRelativeAngle(request.targetAngle)
      );
      this.logger.info("turn.final_measurement", {
        startHeading: unwrapInternalHeading(this.turnStartHeading),
        finalHeading: unwrapInternalHeading(finalHeading),
        achievedAngle: unwrapRelativeAngle(achievedAngle),
        requestedAngle: unwrapRelativeAngle(request.targetAngle),
        errorAngle: unwrapRelativeAngle(errorAngle),
      });

      this.logger.info("turn.completed", {
        requestedAngle: unwrapRelativeAngle(request.targetAngle),
        achievedAngle: unwrapRelativeAngle(achievedAngle),
        errorAngle: unwrapRelativeAngle(errorAngle),
        durationMs: this.nowMillis() - this.turnStartTime,
      });

      // 10. LEARNING - Update model if enabled
      if (request.learningEnabled !== false) {
        this.status = "learning";
        await this.learningModel.updateFromTurn({
          requestedAngle: request.targetAngle,
          achievedAngle,
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
      // Error during completion - ensure cleanup
      this.status = "idle";
      this.currentTurn = null;

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("turn.completion_error", { error: errorMessage });

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
   * Stop current turn immediately (emergency stop)
   */
  async stopCurrentTurn(): Promise<void> {
    this.tuningStopRequested = this.tuningSequenceActive;
    if (this.currentTurn) {
      this.stopRequested = true;
    }
    this.logger.warn("turn.stop_requested", {
      currentTurn: this.currentTurn,
      tuningStopRequested: this.tuningStopRequested,
      activeTurn: Boolean(this.currentTurn),
    });
  }

  /**
   * Run tuning sequence through multiple test angles
   */
  async runTuningSequence(iterations: number = 1, anglesToTest?: number[]): Promise<TurnResult[]> {
    this.tuningSequenceActive = true;
    this.tuningStopRequested = false;
    const testAngles = anglesToTest ?? [50, -50, 60, -60, 70, -70, 80, -80, 90, -90, 120, -120, 150, -150, 180, -180];
    const results: TurnResult[] = [];

    this.logger.info("turn.tuning.started", { iterations, angles: testAngles.length });

    try {
      for (let i = 0; i < iterations; i++) {
        this.logger.info("turn.tuning.iteration", { iteration: i + 1, of: iterations });

        for (const angleDeg of testAngles) {
          if (this.stopRequested || this.tuningStopRequested) {
            this.logger.warn("turn.tuning.stopped", { completed: results.length });
            return results;
          }

          const result = await this.executeTurn({
            targetAngle: createRelativeAngle(angleDeg),
            direction: angleDeg > 0 ? "ccw" : "cw",
            learningEnabled: true,
          });
          results.push(result);

          if (this.stopRequested || this.tuningStopRequested) {
            this.logger.warn("turn.tuning.stopped", { completed: results.length });
            return results;
          }

          // Small pause between turns
          const pauseCompleted = await this.sleepWithStopChecks(500);
          if (!pauseCompleted || this.stopRequested || this.tuningStopRequested) {
            this.logger.warn("turn.tuning.stopped", { completed: results.length });
            return results;
          }
        }
      }

      this.logger.info("turn.tuning.completed", { totalTurns: results.length });
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
  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    const endTime = this.nowMillis() + delayMs;

    while (this.nowMillis() < endTime) {
      if (this.stopRequested || this.tuningStopRequested) {
        return false;
      }

      const remaining = endTime - this.nowMillis();
      await this.sleep(Math.min(50, Math.max(0, remaining)));
    }

    return true;
  }

  /**
   * Finish a turn in the stopped state after braking has started.
   */
  private async finishStoppedTurn(request: TurnRequest, errorMessage: string): Promise<void> {
    this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.onHeadingUpdate);
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
  private getTurnWheelSpeeds(direction: "ccw" | "cw", wheelSpeed: number): { left: number; right: number } {
    return direction === "ccw"
      ? { left: -wheelSpeed, right: wheelSpeed }
      : { left: wheelSpeed, right: -wheelSpeed };
  }
}
